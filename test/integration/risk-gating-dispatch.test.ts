/**
 * RoleDispatcher 互动风控闸 — interaction-risk-gating 的可测场景。
 *
 * 验证：canInteract 拒绝时 like/collect/follow 不下发（诚实跳过、不假成功），
 * 而 scroll/back 等推进指令不受闸控（不死锁）；允许时正常下发。
 * 直接经 EventBus 注入 interaction.completed / profile.done / feed.scrolled，观测 sendCommand。
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
};
const mockLlm = { complete: async () => 'pass' };

function setup(
  canInteract: (a: 'like' | 'collect' | 'follow' | 'comment' | 'comment_like') => boolean,
  opts: { canView?: () => boolean } = {},
) {
  const commands: EdgeCommand[] = [];
  const bus = new EventBus();
  const d = new RoleDispatcher({
    soul: mockSoul,
    llm: mockLlm,
    eventBus: bus,
    canInteract,
    canView: opts.canView,
    sendCommand: (c) => commands.push(c),
    clock: () => 0,
  });
  d.setup();
  d.startSession(); // 反应链/指令翻译接线现随会话激活进行（不再在 setup 接线）
  return { bus, commands };
}

const actionsOf = (commands: EdgeCommand[]) => commands.map((c) => c.action);
const valuable = { index: 0, noteId: 'n1', title: 't', confidence: 0.9, sourcePageType: 'feed' as const, reason: 'test', ts: 0 };

describe('RoleDispatcher 互动风控闸', () => {
  it('canInteract=false：like/collect/follow 全部不下发，scroll 仍下发', () => {
    const { bus, commands } = setup(() => false);

    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like', 'collect'], ts: 0 });
    bus.emit('profile.done', { authorId: 'a1', sourcePageType: 'feed', followed: true, ts: 0 });
    bus.emit('feed.scrolled', { pageType: 'feed', scrollCount: 1, ts: 0 });

    assert.ok(!actionsOf(commands).includes('like'), 'like 应被风控拦截');
    assert.ok(!actionsOf(commands).includes('collect'), 'collect 应被风控拦截');
    assert.ok(!actionsOf(commands).includes('follow'), 'follow 应被风控拦截');
    assert.ok(actionsOf(commands).includes('scroll'), 'scroll 不受闸控，应正常下发（不死锁）');
  });

  it('canInteract=true：like/collect/follow 正常下发', () => {
    const { bus, commands } = setup(() => true);

    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like', 'collect'], ts: 0 });
    bus.emit('profile.done', { authorId: 'a1', sourcePageType: 'feed', followed: true, ts: 0 });

    assert.deepEqual(
      actionsOf(commands).filter((a) => a === 'like' || a === 'collect' || a === 'follow'),
      ['like', 'collect', 'follow'],
    );
  });

  it('选择性拦截：放行 like、拦 follow', () => {
    const { bus, commands } = setup((a) => a !== 'follow');

    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: 0 });
    bus.emit('profile.done', { authorId: 'a1', sourcePageType: 'feed', followed: true, ts: 0 });

    assert.ok(actionsOf(commands).includes('like'), 'like 应放行');
    assert.ok(!actionsOf(commands).includes('follow'), 'follow 应被拦');
  });

  it('canView=false：content.valuable 不下发 open_note，并结束会话', () => {
    const { bus, commands } = setup(() => true, { canView: () => false });

    bus.emit('content.valuable', valuable);

    assert.ok(!actionsOf(commands).includes('open_note'), 'view 配额拒绝时不得打开下一篇');
    assert.ok(actionsOf(commands).includes('session.end'), 'view 配额拒绝时应结束当前会话');
  });

  it('canView=true：content.valuable 正常下发 open_note', () => {
    const { bus, commands } = setup(() => true, { canView: () => true });

    bus.emit('content.valuable', valuable);

    assert.ok(actionsOf(commands).includes('open_note'), 'view 配额放行时应正常打开笔记');
  });

  it('edge.hello 启动入口受 canView 闸约束', () => {
    const commands: EdgeCommand[] = [];
    const bus = new EventBus();
    const d = new RoleDispatcher({
      soul: mockSoul,
      llm: mockLlm,
      eventBus: bus,
      canInteract: () => true,
      canView: () => false,
      sendCommand: (c) => commands.push(c),
      clock: () => 0,
    });
    d.setup();

    bus.emit('edge.hello', { edgeId: 'edge-1', accountId: 'acct-1', ts: 0 });
    bus.emit('content.valuable', valuable);

    assert.equal(d.active, false, 'view 配额拒绝时不应启动浏览会话');
    assert.equal(commands.length, 0, '会话未启动时不应响应 content.valuable 下发命令');
  });
});
