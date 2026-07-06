import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_REGISTRY,
  XHS_COMMENT_PROFILE,
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

test('platform registry: recognized but unimplemented facebook fails honestly', () => {
  assert.equal(normalizePlatformId('facebook'), 'facebook');
  assert.throws(() => commentProfileForPlatform('facebook'), /no cloud registry entry/);
});
