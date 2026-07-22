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
import type { NoteScopedAction, PlatformRegistryEntry } from '../src/platform/index.js';

const NOTE_SCOPED_ACTIONS: NoteScopedAction[] = [
  'read_content',
  'like',
  'collect',
  'comment',
  'comment_like',
  'browse_images',
  'scroll_comments',
];

test('platform registry: xhs entry carries current comment defaults', () => {
  const xhs = PLATFORM_REGISTRY.xiaohongshu;
  assert.equal(xhs.app, 'xhs');
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

test('platform registry: facebook resolves to its own comment profile', () => {
  assert.equal(normalizePlatformId('facebook'), 'facebook');
  assert.equal(normalizePlatformId('fb'), 'facebook');
  // facebook now resolves to its own comment profile (no longer throws).
  assert.equal(commentProfileForPlatform('facebook'), FB_COMMENT_PROFILE);
  assert.equal(FB_COMMENT_PROFILE.siteName, 'Facebook');
  assert.ok(PLATFORM_REGISTRY.facebook, 'facebook registry entry exists');
  assert.equal(PLATFORM_REGISTRY.facebook!.scheduler.comment.enabled, true);
});

// change platform-registry-shape：能力/surface 表全覆盖断言（typecheck 已逼每格声明，运行时再守 reason 非空与形状）。
test('platform registry: noteActions fully cover every action with non-empty reasons when unsupported', () => {
  const entries: PlatformRegistryEntry[] = [
    PLATFORM_REGISTRY.xiaohongshu,
    PLATFORM_REGISTRY.facebook!,
    PLATFORM_REGISTRY.wechat_channels!,
  ];
  for (const entry of entries) {
    for (const action of NOTE_SCOPED_ACTIONS) {
      const support = entry.noteActions[action];
      assert.ok(support, `${entry.platform} 缺 noteActions.${action} 声明`);
      if (!support.supported) {
        assert.ok(support.reason.length > 0, `${entry.platform}.${action} 不支持却无 reason`);
      }
    }
    // surface 只对 read/like/comment 三个动作声明。
    assert.ok(entry.noteSurfaces.read_content);
    assert.ok(entry.noteSurfaces.like);
    assert.ok(entry.noteSurfaces.comment);
  }
});

test('platform registry: browse capability is a Record and xhs browse stays supported (startup gate)', () => {
  assert.equal(PLATFORM_REGISTRY.xiaohongshu.capabilities.browse.supported, true);
  assert.equal(PLATFORM_REGISTRY.facebook!.capabilities.browse.supported, true);
  // change facebook-feed-inline-browse「开关打开」：FB read/like 翻到 feed（就地读/赞），comment 仍 detail；
  // XHS 全 detail 不变。FB collect 仍显式不支持 + reason。
  assert.equal(PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content, 'feed');
  assert.equal(PLATFORM_REGISTRY.facebook!.noteSurfaces.comment, 'detail');
  assert.equal(PLATFORM_REGISTRY.xiaohongshu.noteSurfaces.read_content, 'detail');
  const fbCollect = PLATFORM_REGISTRY.facebook!.noteActions.collect;
  assert.equal(fbCollect.supported, false);
  assert.equal(PLATFORM_REGISTRY.facebook!.capabilities.follow.supported, false, '普通主页关注保持关闭');
  assert.equal(PLATFORM_REGISTRY.facebook!.capabilities.profile_visit.supported, false, '不借 Reel 能力绕开主页访问边界');
  assert.equal(PLATFORM_REGISTRY.facebook!.capabilities.reel_follow.supported, true, 'Reel 卡内关注单独声明');
  assert.equal(PLATFORM_REGISTRY.xiaohongshu.capabilities.follow.supported, true);
  assert.equal(PLATFORM_REGISTRY.xiaohongshu.capabilities.reel_follow.supported, false);
});

test('platform registry: delegated actions declare XHS stable and Facebook beta/unsupported boundaries', () => {
  assert.equal(PLATFORM_REGISTRY.xiaohongshu.delegatedActions.publish_from_inspiration.level, 'supported');
  assert.equal(PLATFORM_REGISTRY.facebook!.delegatedActions.publish_post.level, 'beta');
  const inspiration = PLATFORM_REGISTRY.facebook!.delegatedActions.publish_from_inspiration;
  assert.equal(inspiration.level, 'unsupported');
  assert.ok('reason' in inspiration && inspiration.reason.length > 0);
  const curated = PLATFORM_REGISTRY.facebook!.delegatedActions.comment_curated;
  assert.equal(curated.level, 'unsupported');
});

test('platform registry: Video Channels is inbox-only and exposes no proactive delegated action', () => {
  const channels = PLATFORM_REGISTRY.wechat_channels!;
  assert.equal(channels.scheduler.comment.enabled, false);
  assert.equal(channels.noteActions.comment.supported, false);
  for (const support of Object.values(channels.delegatedActions)) {
    assert.equal(support.level, 'unsupported');
    assert.equal('reason' in support && support.reason, 'interaction_inbox_only');
  }
});
