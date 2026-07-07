import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_REGISTRY,
  XHS_COMMENT_PROFILE,
  FB_COMMENT_PROFILE,
  commentProfileForPlatform,
  defaultCommentSearchLabel,
  normalizePlatformId,
} from '../src/platform/index.js';

test('platform registry: xhs entry carries current comment defaults', () => {
  const xhs = PLATFORM_REGISTRY.xiaohongshu;
  assert.equal(xhs.app, 'xhs');
  assert.ok(xhs.capabilities.includes('comment'));
  assert.equal(xhs.scheduler.comment.defaultSort, 'most_collected');
  assert.equal(xhs.scheduler.comment.defaultTimeWindow, 'one_day');
  assert.equal(xhs.comment.maxCommentLength, 50);
  assert.equal(defaultCommentSearchLabel(xhs.comment), '最近一天·最多收藏');
});

test('commentProfileForPlatform: aliases resolve to xhs profile', () => {
  assert.equal(normalizePlatformId('xhs'), 'xiaohongshu');
  assert.equal(commentProfileForPlatform('xhs'), XHS_COMMENT_PROFILE);
  assert.equal(commentProfileForPlatform(undefined), XHS_COMMENT_PROFILE);
});

test('platform registry: facebook is registered as a comment-only platform (facebook-scheduled-comment)', () => {
  assert.equal(normalizePlatformId('facebook'), 'facebook');
  assert.equal(normalizePlatformId('fb'), 'facebook');
  // facebook now resolves to its own comment profile (no longer throws).
  assert.equal(commentProfileForPlatform('facebook'), FB_COMMENT_PROFILE);
  assert.equal(FB_COMMENT_PROFILE.siteName, 'Facebook');
  const fb = PLATFORM_REGISTRY.facebook;
  assert.ok(fb, 'facebook registry entry exists');
  // v1 declares 'comment' only and MUST NOT declare 'browse' (else the edge assembly gate
  // would attach the xhs browse session, and the cloud session-start platform gate relies on this).
  assert.ok(fb!.capabilities.includes('comment'));
  assert.ok(!fb!.capabilities.includes('browse'), 'facebook v1 must not declare browse capability');
  assert.equal(fb!.scheduler.comment.enabled, true);
});
