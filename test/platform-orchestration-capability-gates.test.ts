/**
 * change platform-orchestration-capability-gates（C4）——按平台能力闸决定角色注册。
 *
 * - patrol && notification 不支持 ⇒ 12 通知巡视角色整套不注册（FB 无通知面）。
 * - profile_visit 不支持 ⇒ ProfileOpener 不注册（AuthorEvaluator 已抑制 worth_visiting ⇒ 本就不触发）。
 * - AuthorEvaluator / ProfileBrowser / FollowAgent **恒注册**（评论→返回 feed 的桥 / 本人昵称采集 / 返回信号，须常在）。
 * - fail-open：无平台 / 查表失败 ⇒ 全注册（=今天，绝不静默砍小红书巡视）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '@automation/orchestrator/role-dispatcher.js';
import type { EdgeCommand } from '@automation/orchestrator/role-dispatcher.js';
import type { PlatformId } from '@automation/platform/index.js';
import { EventBus } from '@automation/event-bus/index.js';
import type { Soul } from '@kernel/kernel/soul-types.js';

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: ['x'], seed_keywords: ['k'] },
};
const mockLlm = { complete: async () => 'skip' };

// 12 通知巡视角色的 roleName（检测→准入→暂停→开首页→分诊→按类浏览→分类→去重→发飞书→返回→恢复）。
const PATROL_ROLE_NAMES = [
  'notification_gatekeeper',
  'browse_suspender',
  'notification_home_opener',
  'notification_triage',
  'notification_comment_browser',
  'notification_like_browser',
  'notification_follow_browser',
  'notification_classifier',
  'notification_deduper',
  'notification_notifier',
  'notification_return_home',
  'excursion_resumer',
];

function registeredRoleNames(accountPlatform?: PlatformId): string[] {
  const commands: EdgeCommand[] = [];
  const d = new RoleDispatcher({
    soul: mockSoul,
    llm: mockLlm,
    eventBus: new EventBus(),
    canInteract: () => true,
    ...(accountPlatform ? { accountPlatform } : {}),
    sendCommand: (c) => commands.push(c),
    clock: () => 0,
  });
  d.setup();
  return d.getRoles().map((r) => r.roleName as string);
}

describe('C4 平台能力闸 → 角色注册', () => {
  it('小红书（四词全支持）：12 巡视角色 + ProfileOpener + ProfileBrowser + AuthorEvaluator + FollowAgent 全注册', () => {
    const names = registeredRoleNames('xiaohongshu');
    for (const rn of PATROL_ROLE_NAMES) {
      assert.ok(names.includes(rn), `小红书应注册巡视角色 ${rn}`);
    }
    assert.ok(names.includes('profile_opener'), '小红书注册 ProfileOpener');
    assert.ok(names.includes('profile_browser'), '小红书注册 ProfileBrowser');
    assert.ok(names.includes('author_evaluator'), '小红书注册 AuthorEvaluator');
    assert.ok(names.includes('follow_agent'), '小红书注册 FollowAgent');
  });

  it('Facebook（四词全不支持）：12 巡视角色 + ProfileOpener 不注册；ProfileBrowser/AuthorEvaluator/FollowAgent 仍注册', () => {
    const names = registeredRoleNames('facebook');
    for (const rn of PATROL_ROLE_NAMES) {
      assert.ok(!names.includes(rn), `FB 不应注册巡视角色 ${rn}（无通知面）`);
    }
    assert.ok(!names.includes('profile_opener'), 'FB 不注册 ProfileOpener（不访主页）');
    // 恒注册（结构原因，非能力）：
    assert.ok(names.includes('profile_browser'), 'FB 仍注册 ProfileBrowser（本人昵称采集经其 onDetailArrived）');
    assert.ok(names.includes('author_evaluator'), 'FB 仍注册 AuthorEvaluator（评论→返回 feed 的桥）');
    assert.ok(names.includes('follow_agent'), 'FB 仍注册 FollowAgent（返回链信号；canFollow 抑制关注动作）');
    // 浏览闭环核心角色不受影响：
    assert.ok(names.includes('content_evaluator'), 'FB 浏览闭环核心角色照常注册');
  });

  it('fail-open：无平台（accountPlatform 未设）⇒ 全注册（=今天，绝不静默砍）', () => {
    const names = registeredRoleNames(undefined);
    for (const rn of PATROL_ROLE_NAMES) {
      assert.ok(names.includes(rn), `无平台应 fail-open 注册巡视角色 ${rn}`);
    }
    assert.ok(names.includes('profile_opener'), '无平台 fail-open 注册 ProfileOpener');
    assert.ok(names.includes('follow_agent'), '无平台 fail-open 注册 FollowAgent');
  });

  it('12 巡视角色是原子整套：FB 一个都不注册（不半开半关）', () => {
    const names = registeredRoleNames('facebook');
    const present = PATROL_ROLE_NAMES.filter((rn) => names.includes(rn));
    assert.equal(present.length, 0, `FB 巡视角色应 0 注册，实到 ${present.length}：${present.join(',')}`);
  });
});
