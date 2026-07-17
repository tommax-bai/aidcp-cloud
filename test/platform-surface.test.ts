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

/** 六键形状（无 join_group）：本 change 之前的载荷形状，用于证明既有行为逐位不变。 */
const SIX_KEY_CAPS: UiDailyUsageCounts = { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 };

/**
 * 七键形状 = 今天 pickDailyUsageCounts 的**真实出参**（它把全部键无条件物化）。
 * 投影拿到的永远是这个形状，所以 join_group 的相关断言必须压在它上面——压在六键形状上等于没测。
 */
const SEVEN_KEY_COUNTS: UiDailyUsageCounts = { ...SIX_KEY_CAPS, join_group: 3 };

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

test('usage metrics: fb 恰好少 collect(noteActions) 与 follow(capabilities)，其余逐位不变', () => {
  const out = omitUnsupportedUsageMetrics('facebook', SIX_KEY_CAPS);
  assert.deepEqual(out, { view: 150, like: 50, comment: 8, publish: 1 });
  // 两张矩阵都查到了：只查 noteActions 会漏掉 follow（它声明在 capabilities）。
  assert.ok(!('collect' in out), 'collect 必须缺席（no_collect_concept）');
  assert.ok(!('follow' in out), 'follow 必须缺席（no_follow_actuator）');
  // 入参不被就地改写（纯函数）。
  assert.deepEqual(SIX_KEY_CAPS, { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 });
});

test('usage metrics: 小红书逐位不变（回归判据，不是善意期待）', () => {
  assert.deepEqual(omitUnsupportedUsageMetrics('xiaohongshu', SIX_KEY_CAPS), SIX_KEY_CAPS);
});

test('usage metrics: fb 拿到 join_group（显式 supported:true 才发）', () => {
  const out = omitUnsupportedUsageMetrics('facebook', SEVEN_KEY_COUNTS);
  assert.deepEqual(out, { view: 150, like: 50, comment: 8, publish: 1, join_group: 3 });
});

test('usage metrics: 小红书 MUST NOT 拿到 join_group（no_group_concept），其余六键逐位不变', () => {
  const out = omitUnsupportedUsageMetrics('xiaohongshu', SEVEN_KEY_COUNTS);
  assert.ok(!('join_group' in out), '小红书没有群 ⇒ 加群键必须缺席');
  assert.deepEqual(out, SIX_KEY_CAPS, '六键逐位不变');
});

test('usage metrics: 视频号只剩 publish（其余动作全声明 interaction_inbox_only）', () => {
  assert.deepEqual(omitUnsupportedUsageMetrics('wechat_channels', SEVEN_KEY_COUNTS), { publish: 1 });
});

test('usage metrics fail-safe: 平台未知 / 缺失 / 查表抛异常 ⇒ **保持现状**（既有键一个不摘、join_group 一个不加）', () => {
  // 现状 = 本规则之前客户端有的那六格。**不是**「原样返回入参」——入参含 join_group（pick 无条件物化），
  // 原样透传会把加群格泄给一个我们根本不知道是什么平台的账号。用一个新谎去治一个旧谎。
  for (const unknown of [undefined, null, '', 'tiktok'] as const) {
    const out = omitUnsupportedUsageMetrics(unknown, SEVEN_KEY_COUNTS);
    assert.deepEqual(out, SIX_KEY_CAPS, `platform=${String(unknown)}：六键照发`);
    assert.ok(!('join_group' in out), `platform=${String(unknown)}：绝不因「没查到」而凭空长出加群格`);
  }
});

test('usage metrics: join_group 的读法不是 fail-open-to-supported（这是最容易改错的一处）', () => {
  // isOrchestrationCapabilitySupported('tiktok', 'group_join') 会 fail-open 返回 true——
  // 若投影复用了它，未知平台就会拿到加群格。这条断言就是钉死「绝不能复用它」。
  assert.equal(isOrchestrationCapabilitySupported('tiktok', 'group_join'), true, '前提：那条 helper 确实 fail-open 到 true');
  assert.ok(
    !('join_group' in omitUnsupportedUsageMetrics('tiktok', SEVEN_KEY_COUNTS)),
    '投影必须用「显式 supported===true」的读法，不得复用上面那条 helper',
  );
});

test('usage metrics: publish 两张矩阵都没有声明 ⇒ 永不摘（缺声明 ≠ 不支持）', () => {
  // FB 结构上会发帖，但 registry 刻意不为 publish 立编排词（接线在 FacebookPublishExecutor 专属路径）。
  assert.equal(omitUnsupportedUsageMetrics('facebook', { publish: 1 }).publish, 1);
});

test('usage metrics: session 窗口的四键子集同规则（本轮计划也是客户端指标面）', () => {
  // pickSessionUsageCounts 只产 like/collect/comment/follow（无 view/publish），默认预算 collects:5 / follows:3。
  const sessionCaps: UiDailyUsageCounts = { like: 10, collect: 5, comment: 2, follow: 3 };
  assert.deepEqual(omitUnsupportedUsageMetrics('facebook', sessionCaps), { like: 10, comment: 2 });
  assert.deepEqual(omitUnsupportedUsageMetrics('xiaohongshu', sessionCaps), sessionCaps);
});

test('usage metrics: 入参缺席的键不会被凭空物化（绝不把「没有」变成 0）', () => {
  // 0 是个真数字、必须原样保留；undefined 是「没有」、必须保持缺席。
  assert.deepEqual(omitUnsupportedUsageMetrics('xiaohongshu', { like: 0 }), { like: 0 });
  assert.deepEqual(omitUnsupportedUsageMetrics('facebook', {}), {});
  // 计数 0 与「没有这个指标」是两件事：FB 真发了 0 次加群申请 ⇒ 必须照显 0，不得当作缺席摘掉。
  assert.deepEqual(omitUnsupportedUsageMetrics('facebook', { join_group: 0 }), { join_group: 0 });
});

test('capability + pacing resolvers (with fail-open)', () => {
  assert.equal(isOrchestrationCapabilitySupported('facebook', 'feed_refresh'), true);
  assert.equal(isOrchestrationCapabilitySupported('facebook', 'browse'), true);
  assert.equal(isOrchestrationCapabilitySupported('xiaohongshu', 'browse'), true);
  assert.equal(isOrchestrationCapabilitySupported('tiktok', 'browse'), true); // fail-open
  assert.equal(platformFeedScrollFloorMs('facebook'), 7000);
  assert.equal(platformFeedScrollFloorMs('xiaohongshu'), undefined);
  assert.equal(platformFeedScrollFloorMs('tiktok'), undefined); // fail-open
});
