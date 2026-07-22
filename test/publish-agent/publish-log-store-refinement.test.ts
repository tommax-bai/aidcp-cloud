import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PublishLogStore } from '../../src/publish-agent/publish-log-store.js';

const metadata = {
  topics: ['旧话题'], visibility: 'public', mode: 'immediate', publishTime: null,
  compliance: { ai: true, aiEnforced: true },
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    status: 'pending_approval', content_version: 2, title: '旧标题', content: '开头需要调整的文字结尾',
    publish_metadata: metadata, image_url: 'a', images: ['a', 'b'], ...overrides,
  };
}

function fixture(current: Record<string, unknown> | null) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes('FOR UPDATE')) return { rows: current ? [current] : [], rowCount: current ? 1 : 0 };
      if (sql.trimStart().startsWith('UPDATE publish_log')) {
        return {
          rowCount: 1,
          rows: [{
            content_version: params[7], title: params[2], content: params[3],
            publish_metadata: params[4], images: params[5],
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const store = new PublishLogStore({ pool: { connect: async () => client } as never });
  return { store, calls };
}

describe('PublishLogStore.refineDraft', () => {
  test('scope allowlist rejects widened patch before touching database', async () => {
    const store = new PublishLogStore({ pool: { connect: async () => { throw new Error('must not connect'); } } as never });
    assert.deepEqual(
      await store.refineDraft(1, 'account-a', 2, 'body', null, { content: '新正文', title: '越界标题' }, 'worker'),
      { ok: false, reason: 'invalid_scope' },
    );
    assert.deepEqual(
      await store.refineDraft(1, 'account-a', 2, 'whole', null, { content: '只有正文' }, 'worker'),
      { ok: false, reason: 'invalid_scope' },
    );
  });

  test('selected text preserves exact prefix/suffix and writes once', async () => {
    const fx = fixture(row());
    const content = '开头更自然的表达结尾';
    const result = await fx.store.refineDraft(
      17, 'account-a', 2, 'selected_text',
      { start: 2, end: 9, text: '需要调整的文字' },
      { content }, 'refinement:job-1',
    );
    assert.equal(result.ok, true);
    const update = fx.calls.find((call) => call.sql.trimStart().startsWith('UPDATE publish_log'))!;
    assert.equal(update.params[1], 'account-a');
    assert.equal(update.params[3], content);
    assert.equal(update.params[9], 2);
    assert.equal(fx.calls.filter((call) => call.sql.trimStart().startsWith('UPDATE publish_log')).length, 1);
  });

  test('selected text rejects stale or widened selection without update', async () => {
    const fx = fixture(row());
    const result = await fx.store.refineDraft(
      17, 'account-a', 2, 'selected_text',
      { start: 2, end: 9, text: '另一段文字' },
      { content: '开头替换结尾' }, 'refinement:job-1',
    );
    assert.deepEqual(result, { ok: false, reason: 'invalid_selection' });
    assert.equal(fx.calls.some((call) => call.sql.trimStart().startsWith('UPDATE publish_log')), false);
  });

  test('selected image only permits one exact slot replacement', async () => {
    const ok = fixture(row());
    const result = await ok.store.refineDraft(
      17, 'account-a', 2, 'selected_image', { imageUrl: 'b' }, { images: ['a', 'new-b'] }, 'refinement:job-2',
    );
    assert.equal(result.ok, true);

    const widened = fixture(row());
    assert.deepEqual(
      await widened.store.refineDraft(
        17, 'account-a', 2, 'selected_image', { imageUrl: 'b' }, { images: ['new-a', 'new-b'] }, 'refinement:job-2',
      ),
      { ok: false, reason: 'invalid_selection' },
    );
  });

  test('all-images and whole reject incomplete generated sets and preserve original', async () => {
    for (const scope of ['images', 'whole'] as const) {
      const fx = fixture(row());
      const patch = scope === 'images'
        ? { images: ['only-one'] }
        : { title: '新标题', content: '新正文', topics: ['新话题'], images: ['only-one'] };
      const result = await fx.store.refineDraft(17, 'account-a', 2, scope, null, patch, 'refinement:job-3');
      assert.deepEqual(result, { ok: false, reason: 'invalid_field' });
      assert.equal(fx.calls.some((call) => call.sql.trimStart().startsWith('UPDATE publish_log')), false);
    }
  });

  test('whole writes text, topics, and complete images atomically with account/version predicate', async () => {
    const fx = fixture(row());
    const result = await fx.store.refineDraft(
      17, 'account-a', 2, 'whole', null,
      { title: '新标题', content: '新正文', topics: ['新话题'], images: ['new-a', 'new-b'] },
      'refinement:job-4',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.contentVersion, 3);
    assert.deepEqual(result.images, ['new-a', 'new-b']);
    const update = fx.calls.find((call) => call.sql.trimStart().startsWith('UPDATE publish_log'))!;
    assert.match(update.sql, /account_id=\$2[\s\S]*content_version=\$10/);
    assert.deepEqual(update.params[5], ['new-a', 'new-b']);
    const merged = JSON.parse(update.params[4] as string);
    assert.deepEqual(merged.topics, ['新话题']);
    assert.deepEqual(merged.compliance, metadata.compliance);
  });

  test('missing, non-pending, and version conflict fail closed', async () => {
    assert.deepEqual(
      await fixture(null).store.refineDraft(17, 'account-a', 2, 'body', null, { content: 'x' }, 'worker'),
      { ok: false, reason: 'not_found' },
    );
    assert.deepEqual(
      await fixture(row({ status: 'published' })).store.refineDraft(17, 'account-a', 2, 'body', null, { content: 'x' }, 'worker'),
      { ok: false, reason: 'not_pending' },
    );
    assert.deepEqual(
      await fixture(row({ content_version: 3 })).store.refineDraft(17, 'account-a', 2, 'body', null, { content: 'x' }, 'worker'),
      { ok: false, reason: 'version_conflict' },
    );
  });
});
