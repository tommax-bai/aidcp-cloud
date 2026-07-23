/**
 * PublishLogStore.editDraft（change edit-note-draft-before-publish）—— 待审草稿就地编辑单写。
 * 红线：仅 pending_approval 可编、乐观 CAS 版本必须匹配、clampTitle 收口、可见范围枚举校验、
 * 元数据深合并保 compliance 字节、content_version+1、诚实非乐观（可区分拒因）。
 * 用脚本化假 pool（不依赖真实 PG）验证校验分支与事务 CAS 逻辑。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PublishLogStore } from '../../src/publish-agent/publish-log-store.js';

const META = {
  topics: ['旧话题'], mentions: ['@某人'], location: '上海', collection: '合集A',
  visibility: 'self_only', permissions: { comment: 'allow', save: 'allow' },
  mode: 'immediate', publishTime: null, compliance: { ai: true, aiEnforced: true }, metadataScore: 0.8, decidedAt: 0,
};

/** 脚本化假 client：按 SQL 关键字回应；记录 UPDATE 参数。 */
function fakeClient(row: Record<string, unknown> | null, opts: { updateRowCount?: number } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let updateParams: unknown[] | undefined;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.trim().split('\n')[0], params });
      if (sql.includes('FOR UPDATE')) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      if (sql.startsWith('UPDATE')) {
        updateParams = params;
        const rc = opts.updateRowCount ?? 1;
        // 回读真态：模拟 RETURNING（版本 = nextVersion=params[4]，title/content/meta 取本次写入值）。
        // 回读真态：模拟 RETURNING（images/image_url 取本次写入的 params[7]/[8]，见 editDraft UPDATE 参数序）。
        return {
          rowCount: rc,
          rows: rc > 0 ? [{ content_version: params?.[4], title: params?.[1], content: params?.[2], publish_metadata: params?.[3], images: params?.[7], image_url: params?.[8] }] : [],
        };
      }
      return { rows: [], rowCount: 0 }; // BEGIN/COMMIT/ROLLBACK
    },
    release: () => {},
  };
  return { client, calls, get updateParams() { return updateParams; } };
}

function storeWith(fc: ReturnType<typeof fakeClient>, now?: number) {
  // 只需 connect()；构造器接受注入 pool。
  const pool = { connect: async () => fc.client } as any;
  return new PublishLogStore({ pool, ...(now === undefined ? {} : { clock: () => now }) });
}

describe('PublishLogStore.editDraft', () => {
  test('校验分支在事务前诚实拒（不碰 DB）：空标题→invalid_title、非法可见范围→invalid_field、坏 topics→invalid_field、清空可见范围→missing_visibility', async () => {
    // pool.connect 抛错——若校验未在事务前拦住则会命中它。
    const store = new PublishLogStore({ pool: { connect: async () => { throw new Error('should not connect'); } } as any });
    assert.deepEqual(await store.editDraft(1, 0, { title: '   ' }, 'op'), { ok: false, reason: 'invalid_title' });
    assert.deepEqual(await store.editDraft(1, 0, { visibility: 'nope' }, 'op'), { ok: false, reason: 'invalid_field' });
    assert.deepEqual(await store.editDraft(1, 0, { visibility: '' }, 'op'), { ok: false, reason: 'missing_visibility' });
    assert.deepEqual(await store.editDraft(1, 0, { topics: [1 as any] }, 'op'), { ok: false, reason: 'invalid_field' });
    assert.deepEqual(await store.editDraft(1, 0, { content: '  ' }, 'op'), { ok: false, reason: 'invalid_field' });
  });

  test('不存在→not_found；非待审→not_pending；版本不符→version_conflict', async () => {
    assert.deepEqual(await storeWith(fakeClient(null)).editDraft(9, 0, { content: 'x' }, 'op'), { ok: false, reason: 'not_found' });
    assert.deepEqual(
      await storeWith(fakeClient({ status: 'published', content_version: 0, title: 't', content: 'c', publish_metadata: META })).editDraft(9, 0, { content: 'x' }, 'op'),
      { ok: false, reason: 'not_pending' },
    );
    assert.deepEqual(
      await storeWith(fakeClient({ status: 'pending_approval', content_version: 2, title: 't', content: 'c', publish_metadata: META })).editDraft(9, 0, { content: 'x' }, 'op'),
      { ok: false, reason: 'version_conflict' },
    );
  });

  test('成功：content_version+1、深合并只动 visibility/topics 保 compliance 字节、clampTitle 收口、回读真态', async () => {
    const fc = fakeClient({ status: 'pending_approval', content_version: 1, title: '旧标题', content: '旧正文', publish_metadata: META });
    const store = storeWith(fc);
    const longTitle = '这是一个非常非常非常非常长的标题绝对超过十八个字素上限';
    const res = await store.editDraft(9, 1, { title: longTitle, visibility: 'public', topics: ['新话题'] }, 'alice');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.contentVersion, 2, 'content_version 自增 1');
    // UPDATE 参数：[recordId, title, content, metadataJson, nextVersion, editor, expectedVersion]
    const p = fc.updateParams!;
    assert.equal(p[5], 'alice', 'edited_by = JWT 主体');
    assert.equal(p[6], 1, 'CAS WHERE content_version = expectedVersion');
    // 标题被 clampTitle 收口 ≤18 字素
    const { graphemeCount } = await import('../../src/kernel/title-clamp.js');
    assert.ok(graphemeCount(p[1] as string) <= 18, '标题收口 ≤18 字素');
    // 深合并：visibility/topics 改，compliance/mentions/location 逐字保留
    const merged = JSON.parse(p[3] as string);
    assert.equal(merged.visibility, 'public');
    assert.deepEqual(merged.topics, ['新话题']);
    assert.deepEqual(merged.compliance, { ai: true, aiEnforced: true }, 'compliance 字节保留、不重算棘轮');
    assert.deepEqual(merged.mentions, ['@某人'], 'mentions 逐字保留');
    assert.equal(merged.location, '上海', 'location 逐字保留');
  });

  test('元数据为 null 又要改可见范围 → invalid_field（守硬必选可见范围致命闸）', async () => {
    const fc = fakeClient({ status: 'pending_approval', content_version: 0, title: 't', content: 'c', publish_metadata: null });
    assert.deepEqual(await storeWith(fc).editDraft(9, 0, { visibility: 'public' }, 'op'), { ok: false, reason: 'invalid_field' });
  });

  test('定时编辑经同一 CAS 落库：仅 XHS、1 小时至 14 天，且切回立即发布会清空时间', async () => {
    const now = 1_800_000_000_000;
    const publishTime = now + 2 * 60 * 60 * 1000;
    const scheduled = fakeClient({
      status: 'pending_approval', content_version: 0, title: 't', content: 'c', publish_metadata: META,
      platform: 'xiaohongshu', image_url: null, images: [],
    });
    const result = await storeWith(scheduled, now).editDraft(
      9,
      0,
      { publishMode: 'scheduled', publishTime },
      'operator',
    );
    assert.equal(result.ok, true);
    const scheduledMeta = JSON.parse(scheduled.updateParams?.[3] as string);
    assert.equal(scheduledMeta.mode, 'scheduled');
    assert.equal(scheduledMeta.publishTime, publishTime);

    const immediate = fakeClient({
      status: 'pending_approval', content_version: 1, title: 't', content: 'c',
      publish_metadata: { ...META, mode: 'scheduled', publishTime },
      platform: 'xiaohongshu', image_url: null, images: [],
    });
    const immediateResult = await storeWith(immediate, now).editDraft(9, 1, { publishMode: 'immediate' }, 'operator');
    assert.equal(immediateResult.ok, true);
    const immediateMeta = JSON.parse(immediate.updateParams?.[3] as string);
    assert.equal(immediateMeta.mode, 'immediate');
    assert.equal(immediateMeta.publishTime, null);
  });

  test('定时编辑越界或非 XHS 均 fail closed，不写 UPDATE', async () => {
    const now = 1_800_000_000_000;
    for (const row of [
      { platform: 'xiaohongshu', publishTime: now + 60 * 60 * 1000 - 1 },
      { platform: 'xiaohongshu', publishTime: now + 14 * 24 * 60 * 60 * 1000 + 1 },
      { platform: 'facebook', publishTime: now + 2 * 60 * 60 * 1000 },
    ]) {
      const fc = fakeClient({
        status: 'pending_approval', content_version: 0, title: 't', content: 'c', publish_metadata: META,
        platform: row.platform, image_url: null, images: [],
      });
      const result = await storeWith(fc, now).editDraft(9, 0, {
        publishMode: 'scheduled',
        publishTime: row.publishTime,
      }, 'operator');
      assert.deepEqual(result, { ok: false, reason: 'invalid_field' });
      assert.equal(fc.updateParams, undefined);
    }
  });
});

describe('PublishLogStore.editDraft — 配图删除（pending-draft-image-delete）', () => {
  // 待审行工厂：默认 image_url = images[0]，可覆盖。
  const PENDING = (images: string[], image_url: string | null = images[0] ?? null) => ({
    status: 'pending_approval', content_version: 1, title: 't', content: 'c', publish_metadata: META, image_url, images,
  });

  test('删一张：落库为保序子序列、cover 重算为首项、content_version+1、回读真态 images', async () => {
    const fc = fakeClient(PENDING(['a', 'b', 'c']));
    const res = await storeWith(fc).editDraft(9, 1, { images: ['a', 'c'] }, 'alice');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const p = fc.updateParams!; // [id,title,content,meta,nextVer,editor,expVer,images,cover]
    assert.deepEqual(p[7], ['a', 'c'], 'images = 当前集合的保序子序列');
    assert.equal(p[8], 'a', 'cover = 保留列表首项');
    assert.equal(res.contentVersion, 2, 'content_version 自增（作废旧飞书卡）');
    assert.deepEqual(res.images, ['a', 'c'], '回读真态带回删后 images');
  });

  test('防注入：提交含非当前成员 URL → invalid_field，绝不落库（无 UPDATE）并回滚', async () => {
    const fc = fakeClient(PENDING(['a', 'b']));
    const res = await storeWith(fc).editDraft(9, 1, { images: ['a', 'https://evil/x.png'] }, 'op');
    assert.deepEqual(res, { ok: false, reason: 'invalid_field' });
    assert.equal(fc.updateParams, undefined, '注入被拦：没有发生 UPDATE');
    assert.ok(fc.calls.some((c) => c.sql.startsWith('ROLLBACK')), '事务已回滚');
  });

  test('删空 = 纯文字帖：images=[]、cover=null 合法落库', async () => {
    const fc = fakeClient(PENDING(['a', 'b']));
    const res = await storeWith(fc).editDraft(9, 1, { images: [] }, 'op');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const p = fc.updateParams!;
    assert.deepEqual(p[7], [], '配图清空');
    assert.equal(p[8], null, 'cover = null');
    assert.deepEqual(res.images, []);
  });

  test('坏类型 images（非数组 / 含非 string）→ invalid_field，事务前拒、不碰 DB', async () => {
    const store = new PublishLogStore({ pool: { connect: async () => { throw new Error('should not connect'); } } as any });
    assert.deepEqual(await store.editDraft(1, 0, { images: 'a' as any }, 'op'), { ok: false, reason: 'invalid_field' });
    assert.deepEqual(await store.editDraft(1, 0, { images: [1 as any] }, 'op'), { ok: false, reason: 'invalid_field' });
  });

  test('非待审记录删配图 → not_pending', async () => {
    const fc = fakeClient({ status: 'published', content_version: 1, title: 't', content: 'c', publish_metadata: META, image_url: 'a', images: ['a', 'b'] });
    assert.deepEqual(await storeWith(fc).editDraft(9, 1, { images: ['a'] }, 'op'), { ok: false, reason: 'not_pending' });
  });

  test('版本不符删配图 → version_conflict（无丢更新）', async () => {
    const fc = fakeClient(PENDING(['a', 'b'])); // 活版本 1
    assert.deepEqual(await storeWith(fc).editDraft(9, 0, { images: ['a'] }, 'op'), { ok: false, reason: 'version_conflict' });
  });

  test('未带 images 补丁：逐字保留原 images / image_url（零回归）', async () => {
    const fc = fakeClient(PENDING(['a', 'b'], 'a'));
    const res = await storeWith(fc).editDraft(9, 1, { content: '新正文' }, 'op');
    assert.equal(res.ok, true);
    const p = fc.updateParams!;
    assert.deepEqual(p[7], ['a', 'b'], '未删图时 images 逐字保留');
    assert.equal(p[8], 'a', '未删图时 image_url 逐字保留');
  });
});
