/**
 * return-to-feed-on-follow-block — 关注被风控拦截后仍须返回信息流（不卡死在作者主页）。
 *
 * 验证 RoleDispatcher（内部已装配 BackToFeed）在「主页关注评估完成」单一时序点的收敛行为：
 *  - 关注被风控拦截：不发 follow，但仍下发返回（back）——治本机监测 2026-06-24 复现的卡死。
 *  - 关注放行：follow 命令在 back 之前下发（同一时序点顺序 emit + 边缘 FIFO 保证关注先点、再返回）。
 *  - 决定不关注：仍下发返回。
 *  - 每个 profile.done 收敛到恰好一次返回（不重复、不零返回）。
 * 直接经 EventBus 注入 profile.done，观测 sendCommand 序列。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '../../src/orchestrator/role-dispatcher.js';
import type { EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import { EventBus } from '../../src/event-bus/index.js';
import type { Soul } from '../../src/soul/types.js';

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: ['x'], seed_keywords: ['k'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
};
const mockLlm = { complete: async () => 'pass' };

function setup(canInteract: (a: 'like' | 'collect' | 'follow' | 'comment' | 'comment_like') => boolean) {
  const commands: EdgeCommand[] = [];
  const bus = new EventBus();
  const d = new RoleDispatcher({
    soul: mockSoul,
    llm: mockLlm,
    eventBus: bus,
    canInteract,
    sendCommand: (c) => commands.push(c),
    clock: () => 0,
  });
  d.setup();
  return { bus, commands };
}

const actionsOf = (commands: EdgeCommand[]) => commands.map((c) => c.action);

describe('return-to-feed-on-follow-block', () => {
  it('关注被风控拦截 → 不发 follow，但仍下发返回(back)（不卡死主页）', () => {
    const { bus, commands } = setup((a) => a !== 'follow'); // 仅拦 follow

    bus.emit('profile.done', { authorId: 'a1', sourcePageType: 'feed', followed: true, ts: 0 });

    const acts = actionsOf(commands);
    assert.ok(!acts.includes('follow'), 'follow 应被风控拦截、不下发');
    assert.ok(acts.includes('back'), '关注被拦时仍须下发返回，MUST NOT 卡在作者主页');
  });

  it('关注放行 → follow 在 back 之前下发（同一时序点顺序 + FIFO 保证关注先点）', () => {
    const { bus, commands } = setup(() => true);

    bus.emit('profile.done', { authorId: 'a1', sourcePageType: 'feed', followed: true, ts: 0 });

    const acts = actionsOf(commands);
    const iFollow = acts.indexOf('follow');
    const iBack = acts.indexOf('back');
    assert.ok(iFollow >= 0, 'follow 应下发');
    assert.ok(iBack >= 0, 'back 应下发');
    assert.ok(iFollow < iBack, 'follow MUST 在 back 之前下发（否则返回抢在关注前、关注落空）');
  });

  it('决定不关注 → 仍下发返回(back)，不发 follow', () => {
    const { bus, commands } = setup(() => true);

    bus.emit('profile.done', { authorId: 'a1', sourcePageType: 'feed', followed: false, ts: 0 });

    const acts = actionsOf(commands);
    assert.ok(!acts.includes('follow'), '不关注不应下发 follow');
    assert.ok(acts.includes('back'), '不关注仍须返回信息流');
  });

  it('返回收敛唯一：每个 profile.done 恰好一次 back', () => {
    const { bus, commands } = setup(() => true);

    bus.emit('profile.done', { authorId: 'a1', sourcePageType: 'feed', followed: true, ts: 0 });

    const backs = actionsOf(commands).filter((a) => a === 'back');
    assert.equal(backs.length, 1, '应恰好一次返回（不重复、不零返回）');
  });

  it('来源页透传：search 来源关注被拦 → 返回带 targetPage=search', () => {
    const { bus, commands } = setup((a) => a !== 'follow');

    bus.emit('profile.done', { authorId: 'a1', sourcePageType: 'search', followed: true, ts: 0 });

    const back = commands.find((c) => c.action === 'back');
    assert.ok(back, 'back 应下发');
    assert.equal((back!.params as { targetPage?: string } | undefined)?.targetPage, 'search', '搜索来源返回搜索结果');
  });
});
