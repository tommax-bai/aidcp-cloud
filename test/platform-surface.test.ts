import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveReadSurface,
  resolveCommentSurface,
  loopClosure,
  isNoteActionSupported,
  noteActionRefusalReason,
  isOrchestrationCapabilitySupported,
  platformFeedScrollFloorMs,
  omitUnsupportedUsageMetrics,
} from '../src/platform/index.js';
import type { UiDailyUsageCounts } from '../src/comm/protocol.js';

/** 六键形状（无 search/join_group）：两项新增指标之前的载荷形状，用于证明旧端逐位兼容。 */
const SIX_KEY_CAPS: UiDailyUsageCounts = { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 };

/**
 * 八键形状 = 今天 pickDailyUsageCounts 的**真实出参**（它把全部键无条件物化）。
 * 投影拿到的永远是这个形状，所以 search/join_group 的相关断言必须压在它上面。
 */
const EIGHT_KEY_COUNTS: UiDailyUsageCounts = { view: 150, search: 2, like: 50, collect: 25, comment: 8, follow: 15, publish: 1, join_group: 3 };

test('surface resolvers: xhs read/comment on detail; fb read=feed (就地读已开) / comment=detail', () => {
  assert.equal(resolveReadSurface('xiaohongshu'), 'detail');
  // change facebook-feed-inline-browse「开关打开」：FB registry read_content 翻到 feed（就地读）。注意这是
  // **registry 声明值**；实际是否对某连接生效还要过版本偏斜闸（边缘声明 inline_targeting，见 dispatcher effectiveReadSurface）。
  assert.equal(resolveReadSurface('facebook'), 'feed');
  assert.equal(resolveCommentSurface('xiaohongshu'), 'detail');
  assert.equal(resolveCommentSurface('facebook'), 'detail', '评论仍必进详情页（P5）⇒ 与 read=feed 不等 ⇒ 触发迁移');
});

test('surface resolvers fail open to detail on unknown/undefined platform', () => {
  assert.equal(resolveReadSurface('tiktok'), 'detail');
  assert.equal(resolveReadSurface(undefined), 'detail');
  assert.equal(resolveCommentSurface('bogus'), 'detail');
});

test('loopClosure pure decision: detail⇒back, feed⇒scroll, migrated⇒back', () => {
  assert.equal(loopClosure('detail', false), 'back');
  assert.equal(loopClosure('feed', false), 'scroll');
  assert.equal(loopClosure('feed', true), 'back');
  assert.equal(loopClosure('detail', true), 'back');
});

test('note action support: fb collect/deep-read unsupported with reasons, xhs all supported', () => {
  assert.equal(isNoteActionSupported('facebook', 'like'), true);
  assert.equal(isNoteActionSupported('facebook', 'comment'), true);
  assert.equal(isNoteActionSupported('facebook', 'collect'), false);
  assert.equal(noteActionRefusalReason('facebook', 'collect'), 'no_collect_concept');
  assert.equal(isNoteActionSupported('facebook', 'browse_images'), false);
  assert.equal(isNoteActionSupported('facebook', 'scroll_comments'), false);
  assert.equal(isNoteActionSupported('facebook', 'comment_like'), false);
  assert.equal(isNoteActionSupported('xiaohongshu', 'collect'), true);
  assert.equal(noteActionRefusalReason('xiaohongshu', 'collect'), null);
});

test('note action support fails open to true on unknown platform', () => {
  assert.equal(isNoteActionSupported('tiktok', 'collect'), true);
  assert.equal(noteActionRefusalReason('tiktok', 'collect'), null);
});

test('usage metrics: fb 少 collect，但 Reel 关注执行器使 follow 如实保留', () => {
  const out = omitUnsupportedUsageMetrics('facebook', SIX_KEY_CAPS);
  assert.deepEqual(out, { view: 150, like: 50, comment: 8, follow: 15, publish: 1 });
  assert.ok(!('collect' in out), 'collect 必须缺席（no_collect_concept）');
  assert.equal(out.follow, 15, '普通主页关注仍关闭，但 Reel 关注真实烧同一 follow 配额');
  // 入参不被就地改写（纯函数）。
  assert.deepEqual(SIX_KEY_CAPS, { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 });
});

test('usage metrics: 小红书逐位不变（回归判据，不是善意期待）', () => {
  assert.deepEqual(omitUnsupportedUsageMetrics('xiaohongshu', SIX_KEY_CAPS), SIX_KEY_CAPS);
});

test('usage metrics: fb 拿到 join_group（显式 supported:true 才发）', () => {
  const out = omitUnsupportedUsageMetrics('facebook', EIGHT_KEY_COUNTS);
  assert.deepEqual(out, { view: 150, search: 2, like: 50, comment: 8, follow: 15, publish: 1, join_group: 3 });
});

test('usage metrics: 小红书拿到 search，但 MUST NOT 拿到 join_group（no_group_concept）', () => {
  const out = omitUnsupportedUsageMetrics('xiaohongshu', EIGHT_KEY_COUNTS);
  assert.ok(!('join_group' in out), '小红书没有群 ⇒ 加群键必须缺席');
  assert.deepEqual(out, { view: 150, search: 2, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 });
});

test('usage metrics: 视频号只剩 publish（其余动作全声明 interaction_inbox_only）', () => {
  assert.deepEqual(omitUnsupportedUsageMetrics('wechat_channels', EIGHT_KEY_COUNTS), { publish: 1 });
});

test('usage metrics fail-safe: 平台未知 / 缺失 / 查表抛异常 ⇒ 既有六键照发，search/join_group 均不猜', () => {
  // 现状 = 本规则之前客户端有的六格。**不是**「原样返回入参」——入参含两个 absent 新键，
  // 原样透传会把搜索/加群泄给一个我们根本不知道是什么平台的账号。
  for (const unknown of [undefined, null, '', 'tiktok'] as const) {
    const out = omitUnsupportedUsageMetrics(unknown, EIGHT_KEY_COUNTS);
    assert.deepEqual(out, SIX_KEY_CAPS, `platform=${String(unknown)}：六键照发`);
    assert.ok(!('search' in out), `platform=${String(unknown)}：绝不猜测搜索能力`);
    assert.ok(!('join_group' in out), `platform=${String(unknown)}：绝不因「没查到」而凭空长出加群格`);
  }
});

test('usage metrics: join_group 的读法不是 fail-open-to-supported（这是最容易改错的一处）', () => {
  // isOrchestrationCapabilitySupported('tiktok', 'group_join') 会 fail-open 返回 true——
  // 若投影复用了它，未知平台就会拿到加群格。这条断言就是钉死「绝不能复用它」。
  assert.equal(isOrchestrationCapabilitySupported('tiktok', 'group_join'), true, '前提：那条 helper 确实 fail-open 到 true');
  assert.ok(
    !('join_group' in omitUnsupportedUsageMetrics('tiktok', EIGHT_KEY_COUNTS)),
    '投影必须用「显式 supported===true」的读法，不得复用上面那条 helper',
  );
});

test('usage metrics: publish 两张矩阵都没有声明 ⇒ 永不摘（缺声明 ≠ 不支持）', () => {
  // FB 结构上会发帖，但 registry 刻意不为 publish 立编排词（接线在 FacebookPublishExecutor 专属路径）。
  assert.equal(omitUnsupportedUsageMetrics('facebook', { publish: 1 }).publish, 1);
});

test('usage metrics: session 窗口包含 search 子集并按平台塑形（本轮计划也是客户端指标面）', () => {
  const sessionCaps: UiDailyUsageCounts = { search: 3, like: 10, collect: 5, comment: 2, follow: 3 };
  assert.deepEqual(omitUnsupportedUsageMetrics('facebook', sessionCaps), { search: 3, like: 10, comment: 2, follow: 3 });
  assert.deepEqual(omitUnsupportedUsageMetrics('xiaohongshu', sessionCaps), sessionCaps);
  assert.deepEqual(omitUnsupportedUsageMetrics('wechat_channels', sessionCaps), {});
});

test('usage metrics: 入参缺席的键不会被凭空物化（绝不把「没有」变成 0）', () => {
  // 0 是个真数字、必须原样保留；undefined 是「没有」、必须保持缺席。
  assert.deepEqual(omitUnsupportedUsageMetrics('xiaohongshu', { like: 0 }), { like: 0 });
  assert.deepEqual(omitUnsupportedUsageMetrics('facebook', {}), {});
  assert.deepEqual(omitUnsupportedUsageMetrics('facebook', { search: 0 }), { search: 0 });
  assert.deepEqual(omitUnsupportedUsageMetrics('xiaohongshu', { search: 0 }), { search: 0 });
  assert.deepEqual(omitUnsupportedUsageMetrics('wechat_channels', { search: 0 }), {});
  // 计数 0 与「没有这个指标」是两件事：FB 真发了 0 次加群申请 ⇒ 必须照显 0，不得当作缺席摘掉。
  assert.deepEqual(omitUnsupportedUsageMetrics('facebook', { join_group: 0 }), { join_group: 0 });
});

test('capability + pacing resolvers (with fail-open)', () => {
  assert.equal(isOrchestrationCapabilitySupported('facebook', 'feed_refresh'), true);
  assert.equal(isOrchestrationCapabilitySupported('facebook', 'browse'), true);
  assert.equal(isOrchestrationCapabilitySupported('facebook', 'follow'), false, '普通主页关注能力仍不开放');
  assert.equal(isOrchestrationCapabilitySupported('facebook', 'reel_follow'), true, '仅 Reel 面具备关注执行器');
  assert.equal(isOrchestrationCapabilitySupported('facebook', 'search'), true, '客户端搜索指标有显式平台声明');
  assert.equal(isOrchestrationCapabilitySupported('xiaohongshu', 'search'), true);
  assert.equal(isOrchestrationCapabilitySupported('wechat_channels', 'search'), false);
  assert.equal(isOrchestrationCapabilitySupported('xiaohongshu', 'browse'), true);
  assert.equal(isOrchestrationCapabilitySupported('tiktok', 'browse'), true); // fail-open
  assert.equal(platformFeedScrollFloorMs('facebook'), 7000);
  assert.equal(platformFeedScrollFloorMs('xiaohongshu'), undefined);
  assert.equal(platformFeedScrollFloorMs('tiktok'), undefined); // fail-open
});
