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
  omitUnsupportedUsageCaps,
} from '../src/platform/index.js';
import type { UiDailyUsageCounts } from '../src/comm/protocol.js';

/** 一份真实形状的六键上限（= pickDailyUsageCounts 的出参形状，normal 档量级）。 */
const SIX_KEY_CAPS: UiDailyUsageCounts = { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 };

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

test('usage caps: fb 恰好少 collect(noteActions) 与 follow(capabilities)，其余逐位不变', () => {
  const out = omitUnsupportedUsageCaps('facebook', SIX_KEY_CAPS);
  assert.deepEqual(out, { view: 150, like: 50, comment: 8, publish: 1 });
  // 两张矩阵都查到了：只查 noteActions 会漏掉 follow（它声明在 capabilities）。
  assert.ok(!('collect' in out), 'collect 上限必须缺席（no_collect_concept）');
  assert.ok(!('follow' in out), 'follow 上限必须缺席（no_follow_actuator）');
  // 入参不被就地改写（纯函数）。
  assert.deepEqual(SIX_KEY_CAPS, { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 });
});

test('usage caps: 小红书逐位不变（回归判据，不是善意期待）', () => {
  assert.deepEqual(omitUnsupportedUsageCaps('xiaohongshu', SIX_KEY_CAPS), SIX_KEY_CAPS);
});

test('usage caps fail-open: 平台未知 / 缺失 / 查表抛异常 ⇒ 原样返回，绝不因「没查到」摘上限', () => {
  assert.deepEqual(omitUnsupportedUsageCaps(undefined, SIX_KEY_CAPS), SIX_KEY_CAPS, '镜像缺键=未知');
  assert.deepEqual(omitUnsupportedUsageCaps(null, SIX_KEY_CAPS), SIX_KEY_CAPS);
  assert.deepEqual(omitUnsupportedUsageCaps('', SIX_KEY_CAPS), SIX_KEY_CAPS);
  // normalizePlatformId 对未知串抛 ⇒ 函数内部自兜、照发全部上限（fail-open 由函数自证）。
  assert.deepEqual(omitUnsupportedUsageCaps('tiktok', SIX_KEY_CAPS), SIX_KEY_CAPS);
});

test('usage caps: publish 两张矩阵都没有声明 ⇒ 永不摘（缺声明 ≠ 不支持）', () => {
  // FB 结构上会发帖，但 registry 刻意不为 publish 立编排词（接线在 FacebookPublishExecutor 专属路径）。
  assert.equal(omitUnsupportedUsageCaps('facebook', { publish: 1 }).publish, 1);
});

test('usage caps: session 窗口的四键子集同规则（本轮计划也是客户端上限面）', () => {
  // pickSessionUsageCounts 只产 like/collect/comment/follow（无 view/publish），默认预算 collects:5 / follows:3。
  const sessionCaps: UiDailyUsageCounts = { like: 10, collect: 5, comment: 2, follow: 3 };
  assert.deepEqual(omitUnsupportedUsageCaps('facebook', sessionCaps), { like: 10, comment: 2 });
  assert.deepEqual(omitUnsupportedUsageCaps('xiaohongshu', sessionCaps), sessionCaps);
});

test('usage caps: 入参缺席的键不会被凭空物化（绝不把「没上限」变成 0）', () => {
  // 0 是个真上限、必须原样保留；undefined 是「没有上限」、必须保持缺席。
  assert.deepEqual(omitUnsupportedUsageCaps('xiaohongshu', { like: 0 }), { like: 0 });
  assert.deepEqual(omitUnsupportedUsageCaps('facebook', {}), {});
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
