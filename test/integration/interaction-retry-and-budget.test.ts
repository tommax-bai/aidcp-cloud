/**
 * change fix-interaction-and-comment-capture：
 *  - like/collect 可重试失败（点了没生效 / 互动栏一时缺失）由云端原地有界重试一次，且不发兜底滚动（否则把详情页滚走）；
 *    不可重试失败（验证码 / 无按钮）诚实终止。
 *  - like/collect 会话预算改按 action.completed{ok:true} 扣（对齐 follow/comment），下发不乐观扣、失败不烧预算、重试成功只扣一次。
 * 经 EventBus 注入 interaction.completed（下发）+ action.completed（回执），观测 sendCommand 与内部预算。
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

function setup() {
  const commands: EdgeCommand[] = [];
  const bus = new EventBus();
  const d = new RoleDispatcher({
    soul: mockSoul,
    llm: mockLlm,
    eventBus: bus,
    canInteract: () => true,
    sendCommand: (c) => commands.push(c),
    clock: () => 0,
  });
  d.setup();
  d.startSession();
  return { d, bus, commands };
}

const actionsOf = (commands: EdgeCommand[]) => commands.map((c) => c.action);
const likeCount = (commands: EdgeCommand[]) => actionsOf(commands).filter((a) => a === 'like').length;
// 读内部会话预算（无公开访问器，白盒断言「预算不漂移」红线）。
const likeBudget = (d: RoleDispatcher): number => (d as unknown as { budget: { likes: number } }).budget.likes;

describe('like/collect 失败有界重试', () => {
  it('可重试失败(state_unchanged) → 原地重发一次，不发兜底滚动', () => {
    const { bus, commands } = setup();
    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: 0 });
    assert.equal(likeCount(commands), 1, '首发一次 like');
    bus.emit('action.completed', { action: 'like', ok: false, reason: 'state_unchanged', ts: 0 });
    assert.equal(likeCount(commands), 2, '可重试失败应重发一次 like');
    assert.ok(!actionsOf(commands).includes('scroll'), 'like 失败不应发兜底滚动（把详情页滚走）');
  });

  it('可重试失败(btn_no-bar) → 原地重发一次', () => {
    const { bus, commands } = setup();
    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['collect'], ts: 0 });
    const collectCount = () => actionsOf(commands).filter((a) => a === 'collect').length;
    assert.equal(collectCount(), 1);
    bus.emit('action.completed', { action: 'collect', ok: false, reason: 'btn_no-bar', ts: 0 });
    assert.equal(collectCount(), 2, '互动栏一时缺失应重发一次 collect');
    assert.ok(!actionsOf(commands).includes('scroll'), 'collect 失败不应发兜底滚动');
  });

  it('不可重试失败(blocked_by_captcha) → 不重发、不兜底滚动', () => {
    const { bus, commands } = setup();
    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: 0 });
    bus.emit('action.completed', { action: 'like', ok: false, reason: 'blocked_by_captcha', ts: 0 });
    assert.equal(likeCount(commands), 1, '验证码阻断不重试');
    assert.ok(!actionsOf(commands).includes('scroll'), '不发兜底滚动');
  });

  it('重试上限 1：连续两次可重试失败只重发一次', () => {
    const { bus, commands } = setup();
    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: 0 });
    bus.emit('action.completed', { action: 'like', ok: false, reason: 'state_unchanged', ts: 0 });
    bus.emit('action.completed', { action: 'like', ok: false, reason: 'state_unchanged', ts: 0 });
    assert.equal(likeCount(commands), 2, '首发 + 一次重发，第二次失败不再重发');
    assert.ok(!actionsOf(commands).includes('scroll'), '重试用尽也不发兜底滚动');
  });
});

describe('like/collect 预算按真成功回执扣', () => {
  it('下发不扣、ok:true 回执才扣一次', () => {
    const { d, bus } = setup();
    const before = likeBudget(d);
    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: 0 });
    assert.equal(likeBudget(d), before, '下发时不乐观扣预算');
    bus.emit('action.completed', { action: 'like', ok: true, ts: 0 });
    assert.equal(likeBudget(d), before - 1, '真成功回执扣一次');
  });

  it('下发后失败(ok:false)不扣预算', () => {
    const { d, bus } = setup();
    const before = likeBudget(d);
    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: 0 });
    bus.emit('action.completed', { action: 'like', ok: false, reason: 'no_like_btn', ts: 0 });
    assert.equal(likeBudget(d), before, '失败不烧预算');
  });

  it('重试成功只扣一次预算', () => {
    const { d, bus } = setup();
    const before = likeBudget(d);
    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: 0 });
    bus.emit('action.completed', { action: 'like', ok: false, reason: 'state_unchanged', ts: 0 }); // 触发重发，不扣
    bus.emit('action.completed', { action: 'like', ok: true, ts: 0 }); // 重发成功，扣一次
    assert.equal(likeBudget(d), before - 1, '重试成功只扣一次');
  });
});
