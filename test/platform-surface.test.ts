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

test('surface resolvers: xhs + fb read/comment both on detail at stage 0', () => {
  assert.equal(resolveReadSurface('xiaohongshu'), 'detail');
  assert.equal(resolveReadSurface('facebook'), 'detail');
  assert.equal(resolveCommentSurface('xiaohongshu'), 'detail');
  assert.equal(resolveCommentSurface('facebook'), 'detail');
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
