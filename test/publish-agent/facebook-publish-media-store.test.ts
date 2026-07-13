import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  FacebookPublishMediaStore,
  FacebookPublishMediaError,
} from '../../src/publish-agent/facebook-publish-media-store.js';
import type { ObjectStore } from '../../src/storage/object-store.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

function makePool(platform: string | null = 'facebook'): { pool: pg.Pool; putKeys: string[] } {
  const sets: any[] = [];
  const images: any[] = [];
  const putKeys: string[] = [];
  let nextSetId = 1;
  let nextImageId = 1;
  const queryImpl = async (text: string, params?: unknown[]) => {
    if (/SELECT platform FROM accounts/.test(text)) {
      if (platform === null) return { rows: [], rowCount: 0 };
      return { rows: [{ platform }], rowCount: 1 };
    }
    if (/SELECT coalesce\(max\(sort_order\)/.test(text)) return { rows: [{ n: String(sets.length) }], rowCount: 1 };
    if (/JOIN account_facebook_publish_image_set/.test(text) && /i\.sha256/.test(text)) return { rows: [], rowCount: 0 };
    if (/SELECT \* FROM account_facebook_publish_image_set WHERE account_id = \$1 AND id = \$2/.test(text)) {
      return { rows: sets.filter((s) => s.account_id === params?.[0] && Number(s.id) === params?.[1]), rowCount: 1 };
    }
    if (/SELECT \* FROM account_facebook_publish_image_set/.test(text)) {
      return { rows: sets.filter((s) => s.account_id === params?.[0] && s.status !== 'deleted'), rowCount: sets.length };
    }
    if (/SELECT status, count/.test(text)) {
      const counts = new Map<string, number>();
      for (const s of sets.filter((row) => row.account_id === params?.[0])) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
      return { rows: [...counts.entries()].map(([status, n]) => ({ status, n: String(n) })), rowCount: counts.size };
    }
    if (/UPDATE account_facebook_publish_image_set\s+SET status = 'quarantine'/.test(text)) {
      const row = sets.find((s) => Number(s.id) === params?.[0] && s.status !== 'deleted');
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'quarantine';
      row.last_error = params?.[1] ?? null;
      row.updated_at = '2026-07-12T00:01:00.000Z';
      return { rows: [], rowCount: 1 };
    }
    if (/FROM account_facebook_publish_image/.test(text) && /set_id = ANY/.test(text)) {
      const ids = new Set(params?.[0] as number[]);
      return { rows: images.filter((img) => ids.has(Number(img.set_id))), rowCount: images.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO account_facebook_publish_image_set/.test(text)) {
        const row = {
          id: nextSetId++,
          account_id: params?.[0],
          status: 'available',
          caption_hint: params?.[1] ?? null,
          sort_order: params?.[2] ?? sets.length + 1,
          reserved_by: null,
          reserved_at: null,
          used_by_publish_log_id: null,
          last_error: null,
          created_at: '2026-07-12T00:00:00.000Z',
          updated_at: '2026-07-12T00:00:00.000Z',
        };
        sets.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/INSERT INTO account_facebook_publish_image/.test(text)) {
        const row = {
          id: nextImageId++,
          set_id: params?.[0],
          url: params?.[1],
          object_key: params?.[2],
          filename: params?.[3],
          content_type: params?.[4],
          byte_size: params?.[5],
          sha256: params?.[6],
          sort_order: 1,
          duplicate_of_image_id: params?.[7] ?? null,
          created_at: '2026-07-12T00:00:00.000Z',
        };
        images.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/UPDATE account_facebook_publish_image_set\s+SET caption_hint = \$3, status = \$4/.test(text)) {
        const row = sets.find((s) => s.account_id === params?.[0] && Number(s.id) === params?.[1]);
        if (!row) return { rows: [], rowCount: 0 };
        row.caption_hint = params?.[2] ?? null;
        row.status = params?.[3];
        row.updated_at = '2026-07-12T00:02:00.000Z';
        return { rows: [row], rowCount: 1 };
      }
      if (/UPDATE account_facebook_publish_image_set\s+SET status = 'deleted'/.test(text)) {
        const row = sets.find((s) => s.account_id === params?.[0] && Number(s.id) === params?.[1]);
        if (!row) return { rows: [], rowCount: 0 };
        row.status = 'deleted';
        row.updated_at = '2026-07-12T00:03:00.000Z';
        return { rows: [row], rowCount: 1 };
      }
      return queryImpl(text, params);
    },
    release() {},
  };
  const pool = {
    query: queryImpl,
    connect: async () => client,
  } as unknown as pg.Pool;
  return { pool, putKeys };
}

test('FacebookPublishMediaStore: rejects missing and non-Facebook accounts before upload', async () => {
  const missing = new FacebookPublishMediaStore({ pool: makePool(null).pool });
  await assert.rejects(() => missing.listForAccount('ghost'), (err) => err instanceof FacebookPublishMediaError && err.reason === 'account_not_found');

  const xhs = new FacebookPublishMediaStore({ pool: makePool('xiaohongshu').pool });
  await assert.rejects(() => xhs.listForAccount('xhs-1'), (err) => err instanceof FacebookPublishMediaError && err.reason === 'non_facebook_account');
});

test('FacebookPublishMediaStore: upload validates images, uses account-isolated object keys, returns true state', async () => {
  const backing = makePool('facebook');
  const objectStore: ObjectStore = {
    put: async (key, _bytes, opts) => {
      backing.putKeys.push(`${key}|${opts?.contentType ?? ''}`);
      return { url: `https://oss.example/${key}` };
    },
  };
  const store = new FacebookPublishMediaStore({
    pool: backing.pool,
    objectStore,
    clock: () => Date.parse('2026-07-12T12:00:00Z'),
    idGen: () => 'fixed',
  });
  const result = await store.uploadFiles('fb acc', [
    { filename: 'cover.png', contentType: 'image/png', bytes: PNG_BYTES, captionHint: ' first ' },
    { filename: 'bad.txt', contentType: 'text/plain', bytes: Buffer.from('nope') },
  ]);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[1].reason, 'invalid_file');
  assert.equal(result.view.sets.length, 1);
  assert.equal(result.view.sets[0].captionHint, 'first');
  assert.equal(result.view.statusCounts.available, 1);
  assert.match(backing.putKeys[0], /^facebook-publish-media\/fb-acc\/20260712120000\/01-fixed\.png\|image\/png$/);
});

test('FacebookPublishMediaStore: upload fails honestly when object store is unavailable', async () => {
  const store = new FacebookPublishMediaStore({ pool: makePool('facebook').pool });
  const result = await store.uploadFiles('fb-1', [
    { filename: 'cover.png', contentType: 'image/png', bytes: PNG_BYTES },
  ]);
  assert.deepEqual(result.results, [{ ok: false, filename: 'cover.png', reason: 'object_store_unavailable' }]);
  assert.equal(result.view.sets.length, 0);
});

test('FacebookPublishMediaStore: quarantined media can be manually confirmed, edited, and deleted', async () => {
  const backing = makePool('facebook');
  const store = new FacebookPublishMediaStore({
    pool: backing.pool,
    objectStore: {
      put: async (key) => ({ url: `https://oss.example/${key}` }),
    },
    idGen: () => 'fixed',
  });

  const uploaded = await store.uploadFiles('fb-1', [
    { filename: 'cover.png', contentType: 'image/png', bytes: PNG_BYTES },
  ]);
  assert.equal(uploaded.results[0].ok, true);
  const setId = uploaded.view.sets[0].id;

  assert.equal(await store.quarantine(setId, 'submitted_unconfirmed'), true);
  const quarantined = await store.listForAccount('fb-1');
  assert.equal(quarantined.sets[0].status, 'quarantine');

  const confirmed = await store.updateSet('fb-1', setId, {
    status: 'available',
    captionHint: ' reviewed ',
  });
  assert.equal(confirmed?.status, 'available');
  assert.equal(confirmed?.captionHint, 'reviewed');

  assert.equal(await store.quarantine(setId, 'operator_review'), true);
  const deleted = await store.deleteSet('fb-1', setId);
  assert.equal(deleted?.status, 'deleted');
  const afterDelete = await store.listForAccount('fb-1');
  assert.equal(afterDelete.sets.length, 0);
  assert.equal(afterDelete.statusCounts.deleted, 1);
});
