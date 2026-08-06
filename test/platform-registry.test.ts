import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_REGISTRY,
  XHS_COMMENT_PROFILE,
  FB_COMMENT_PROFILE,
  SCHEDULED_AUTOMATION_CATALOG_READER,
  commentProfileForPlatform,
  defaultCommentSearchLabel,
  normalizePlatformId,
  normalizePlatformForCatalog,
  availableScheduledAutomationActionsForPlatform,
  SCHEDULED_AUTOMATION_ACTIONS,
  scheduledAutomationDeclarationsForPlatform,
  identityCaptureStrategyForPlatform,
} from '@automation/platform/index.js';
import {
  NEW_ACCOUNT_AUTOMATION_SEED_ACTOR,
  newAccountAutomationDefaultsFor,
} from '@kernel/kernel/scheduled-automation-catalog.js';
import type { NoteScopedAction, PlatformRegistryEntry } from '@automation/platform/index.js';

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

test('platform registry: identity capture strategy is exhaustive and platform-specific', () => {
  assert.deepEqual(identityCaptureStrategyForPlatform('xiaohongshu'), {
    supported: true,
    command: 'identity.read_self_profile',
    restore: 'feed',
    capability: 'identity_read_self_profile_v1',
  });
  assert.deepEqual(identityCaptureStrategyForPlatform('facebook'), {
    supported: true,
    command: 'identity.read_current',
    restore: 'none',
    capability: 'identity_read_current_v1',
  });
  assert.deepEqual(identityCaptureStrategyForPlatform('wechat_channels'), {
    supported: false,
    reason: 'interaction_auth_identity_only',
  });
});

test('platform registry: scheduled automation fully covers every platform and action', () => {
  for (const entry of Object.values(PLATFORM_REGISTRY)) {
    for (const action of SCHEDULED_AUTOMATION_ACTIONS) {
      const support = entry.scheduledAutomation[action];
      assert.ok(support, `${entry.platform} 缺 scheduledAutomation.${action}`);
      if (support.supported) {
        if (action === 'join_group') {
          assert.deepEqual(support.allowedModes, [], `${entry.platform}.${action} 是纯开关动作，不伪造审批 mode`);
        } else {
          assert.ok(support.allowedModes.length > 0, `${entry.platform}.${action} 支持却无 mode`);
        }
        assert.ok(support.maxDailyCap > 0, `${entry.platform}.${action} 支持却无正上限`);
      } else {
        assert.ok(support.reason.length > 0, `${entry.platform}.${action} 不支持却无 reason`);
      }
    }
  }
});

test('platform registry: catalog projection is ordered, honest, and detached from registry arrays', () => {
  assert.deepEqual(availableScheduledAutomationActionsForPlatform('fb'), [
    { action: 'post', allowedModes: ['review'], maxDailyCap: 50 },
    { action: 'comment', allowedModes: ['review', 'auto_approve'], maxDailyCap: 50 },
    // 联系评论保持 10、加群抬到 50（change raise-facebook-group-join-cap-ceiling）。
    // 两者刻意不同值：这一行同时守住「加群已抬」与「联系评论没被顺带抬」。
    { action: 'contact_comment', allowedModes: ['review', 'auto_approve'], maxDailyCap: 10 },
    { action: 'join_group', allowedModes: [], maxDailyCap: 50 },
  ]);
  assert.deepEqual(availableScheduledAutomationActionsForPlatform('wechat_channels'), []);
  assert.deepEqual(availableScheduledAutomationActionsForPlatform('future-platform'), []);

  const projected = availableScheduledAutomationActionsForPlatform('xiaohongshu');
  projected[0]?.allowedModes.splice(0);
  assert.deepEqual(PLATFORM_REGISTRY.xiaohongshu.scheduledAutomation.post, {
    supported: true,
    allowedModes: ['review', 'auto_approve'],
    maxDailyCap: 50,
  });
});

test('platform registry: exported scheduled catalog is recursively immutable at runtime', () => {
  const catalog = PLATFORM_REGISTRY.xiaohongshu.scheduledAutomation;
  const post = catalog.post;
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(post), true);
  assert.equal(post.supported && Object.isFrozen(post.allowedModes), true);
  assert.throws(() => {
    (catalog as Record<string, unknown>).post = { supported: false, reason: 'mutated' };
  }, TypeError);
  assert.throws(() => {
    if (post.supported) (post.allowedModes as string[]).splice(0);
  }, TypeError);
  assert.deepEqual(availableScheduledAutomationActionsForPlatform('xiaohongshu')[0], {
    action: 'post',
    allowedModes: ['review', 'auto_approve'],
    maxDailyCap: 50,
  });
});

test('platform registry: named catalog functions are the single reader implementation', () => {
  assert.equal(
    SCHEDULED_AUTOMATION_CATALOG_READER.normalizeForCatalog,
    normalizePlatformForCatalog,
  );
  assert.equal(
    SCHEDULED_AUTOMATION_CATALOG_READER.availableActions,
    availableScheduledAutomationActionsForPlatform,
  );
  assert.equal(
    SCHEDULED_AUTOMATION_CATALOG_READER.declarationsFor,
    scheduledAutomationDeclarationsForPlatform,
  );
  assert.equal(normalizePlatformForCatalog(' FB '), 'facebook');
  assert.equal(normalizePlatformForCatalog(' future-platform '), 'future-platform');
  assert.equal(
    scheduledAutomationDeclarationsForPlatform('fb')?.join_group.supported,
    true,
  );
  const declarations = scheduledAutomationDeclarationsForPlatform('xiaohongshu');
  assert.ok(declarations?.post.supported);
  (declarations.post.allowedModes as string[]).splice(0);
  assert.deepEqual(availableScheduledAutomationActionsForPlatform('xiaohongshu')[0], {
    action: 'post',
    allowedModes: ['review', 'auto_approve'],
    maxDailyCap: 50,
  });
});

// ── change seed-facebook-automation-defaults-on-registration：新账号种入默认值 ──

test('新账号种入默认值: Facebook 取值逐字符合用户拍板值，含联系评论', () => {
  const fb = newAccountAutomationDefaultsFor('facebook');
  assert.notEqual(fb, null);
  assert.deepEqual(fb!.schedule, {
    autoEnabled: true,
    postMode: 'review',
    postDailyCap: 5,
    // 评论免审（用户 2026-07-29 定）。这条断言同时守住「发帖仍必须是需人审」——
    // 两个模式刻意不同值，一起改成免审会在下面那条用例当场红。
    commentMode: 'auto_approve',
    commentDailyCap: 20,
    // 联系评论（change seed-facebook-contact-comment-default）。
    //
    // 上一个 change 这里原本断言「联系评论 MUST NOT 出现」，那是一条**有前置条件的守卫**：
    // 带「先加群再评论」标记的复合动作只挂在联系评论上，种它等于让新账号具备
    // 「加入新群后同一轮立即在该群评论」这一会招致平台警告的形态。
    //
    // 该前置已由 decouple-scheduled-contact-comment-from-group-join 解除（排期路径不再带那个标记，
    // 改走账本选群、受预热与冷却约束），故守卫在此**连同理由一起反向改写**，而不是默默删掉。
    // 若那个标记被加回排期路径，这两项 MUST 同时撤回。
    contactCommentMode: 'auto_approve',
    contactCommentDailyCap: 5,
  });
  assert.deepEqual(fb!.joinGroup, { enabled: true, dailyCap: 20 });
});

test('新账号种入默认值: 联系评论不得越过其自身硬上限（刻意与发帖/评论的 50 分开）', () => {
  const fb = newAccountAutomationDefaultsFor('facebook')!;
  const declared = availableScheduledAutomationActionsForPlatform('facebook');
  const contactCap = declared.find((d) => d.action === 'contact_comment')?.maxDailyCap ?? -1;
  assert.equal(contactCap, 10, '联系评论硬上限刻意是 10，不随发帖/评论的 50 走');
  assert.ok(fb.schedule.contactCommentDailyCap <= contactCap);
  // 并非要求它一定小于硬上限，但当前取 5 是刻意留出余量（与普通评论争抢同一评论配额）。
  assert.ok(fb.schedule.contactCommentDailyCap < contactCap);
});

test('新账号种入默认值: 别名归一后仍命中 Facebook', () => {
  assert.notEqual(newAccountAutomationDefaultsFor('fb'), null);
});

test('新账号种入默认值: 其余平台一律不种（无条目 = 不种）', () => {
  for (const p of ['xiaohongshu', 'wechat_channels', 'future-platform', null, undefined, '']) {
    assert.equal(newAccountAutomationDefaultsFor(p), null, `${String(p)} MUST NOT 被种入`);
  }
});

test('新账号种入默认值: 取值不得越过各自动作的硬上限', () => {
  const fb = newAccountAutomationDefaultsFor('facebook')!;
  const declared = availableScheduledAutomationActionsForPlatform('facebook');
  const capOf = (action: string) => declared.find((d) => d.action === action)?.maxDailyCap ?? -1;
  assert.ok(fb.schedule.postDailyCap <= capOf('post'));
  assert.ok(fb.schedule.commentDailyCap <= capOf('comment'));
  assert.ok(fb.joinGroup.dailyCap <= capOf('join_group'));
});

test('新账号种入默认值: 发帖必须需人审、评论必须免审，且各自都在平台允许的模式集合内', () => {
  const fb = newAccountAutomationDefaultsFor('facebook')!;
  const declared = availableScheduledAutomationActionsForPlatform('facebook');
  const modesOf = (action: string) => declared.find((d) => d.action === action)?.allowedModes ?? [];
  // 发帖：平台只允许需人审，种入值别无选择。
  assert.deepEqual(modesOf('post'), ['review']);
  assert.equal(fb.schedule.postMode, 'review');
  // 评论：平台允许免审，种入值取免审（用户 2026-07-29 定）。
  assert.ok(modesOf('comment').includes('auto_approve'));
  assert.equal(fb.schedule.commentMode, 'auto_approve');
  // 两者刻意不同值：这一行专挡「把两个模式一起改掉」的误编辑。
  assert.notEqual(fb.schedule.postMode, fb.schedule.commentMode);
});

test('种入署名可辨识，便于区分系统种入与运营手工写入', () => {
  assert.match(NEW_ACCOUNT_AUTOMATION_SEED_ACTOR, /^system:/);
});
