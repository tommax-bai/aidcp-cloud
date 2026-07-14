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
} from '../src/platform/index.js';

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

test('capability + pacing resolvers (with fail-open)', () => {
  assert.equal(isOrchestrationCapabilitySupported('facebook', 'feed_refresh'), true);
  assert.equal(isOrchestrationCapabilitySupported('facebook', 'browse'), true);
  assert.equal(isOrchestrationCapabilitySupported('xiaohongshu', 'browse'), true);
  assert.equal(isOrchestrationCapabilitySupported('tiktok', 'browse'), true); // fail-open
  assert.equal(platformFeedScrollFloorMs('facebook'), 7000);
  assert.equal(platformFeedScrollFloorMs('xiaohongshu'), undefined);
  assert.equal(platformFeedScrollFloorMs('tiktok'), undefined); // fail-open
});
