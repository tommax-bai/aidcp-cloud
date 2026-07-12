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

test('platform registry: facebook declares browse/interact/comment/join/publish', () => {
  assert.equal(normalizePlatformId('facebook'), 'facebook');
  assert.equal(normalizePlatformId('fb'), 'facebook');
  // facebook now resolves to its own comment profile (no longer throws).
  assert.equal(commentProfileForPlatform('facebook'), FB_COMMENT_PROFILE);
  assert.equal(FB_COMMENT_PROFILE.siteName, 'Facebook');
  const fb = PLATFORM_REGISTRY.facebook;
  assert.ok(fb, 'facebook registry entry exists');
  // change facebook-browse-and-like-loop：'browse'/'interact' 已声明——edge 侧 FacebookBrowseSession 原子同落，
  // 装配闸解析到 FB 浏览会话（非 xhs），session-start 平台闸靠 includes('browse') 放行 FB。
  assert.ok(fb!.capabilities.includes('comment'));
  assert.ok(fb!.capabilities.includes('browse'), 'facebook now declares browse (co-landed with FacebookBrowseSession)');
  assert.ok(fb!.capabilities.includes('interact'));
  assert.ok(fb!.capabilities.includes('publish'), 'facebook publish co-landed with edge FacebookPublishExecutor');
  // 与 edge Facebook driver 的编排能力子集 {browse, comment, publish, interact, join} 逐字对齐。
  assert.deepEqual([...fb!.capabilities], ['browse', 'comment', 'publish', 'interact', 'join']);
  assert.equal(fb!.scheduler.comment.enabled, true);
});
