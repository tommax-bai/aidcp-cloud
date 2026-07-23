import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { BackToFeed } from '../../src/agents/back-to-feed.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/kernel/soul-types.js';
import type { FeedEnteredPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
};

describe('BackToFeed', () => {
  it('收到 quality.reject → emit feed.entered with sourcePageType', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    ctx.setCurrentNoteId('note_1');
    const role = new BackToFeed({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as FeedEnteredPayload | null;
    bus.on('feed.entered', (p) => { captured = p; });

    bus.emit('quality.reject', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      reason: '质量太差',
      ts: Date.now(),
    });

    assert.ok(captured, 'should emit feed.entered');
    assert.equal(captured!.pageType, 'feed');
    assert.equal(captured!.trigger, 'back_to_feed');
    assert.equal(ctx.currentNoteId, null, 'should clear currentNoteId');
  });

  it('收到 interaction.skipped → emit feed.entered', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    ctx.setCurrentNoteId('note_2');
    const role = new BackToFeed({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as FeedEnteredPayload | null;
    bus.on('feed.entered', (p) => { captured = p; });

    bus.emit('interaction.skipped', {
      noteId: 'note_2',
      sourcePageType: 'search',
      reason: '不值得互动',
      ts: Date.now(),
    });

    assert.ok(captured);
    assert.equal(captured!.pageType, 'search');
    assert.equal(captured!.trigger, 'back_to_feed');
    assert.equal(ctx.currentNoteId, null);
  });

  it('收到 profile.skipped → emit feed.entered', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    ctx.setCurrentNoteId('note_3');
    const role = new BackToFeed({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as FeedEnteredPayload | null;
    bus.on('feed.entered', (p) => { captured = p; });

    bus.emit('profile.skipped', {
      noteId: 'note_3',
      sourcePageType: 'feed',
      reason: '不感兴趣',
      ts: Date.now(),
    });

    assert.ok(captured);
    assert.equal(captured!.pageType, 'feed');
    assert.equal(ctx.currentNoteId, null);
  });

  it('收到 profile.exit(关注被拦) → emit feed.entered 并清理 currentNoteId', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    ctx.setCurrentNoteId('note_4');
    const role = new BackToFeed({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as FeedEnteredPayload | null;
    bus.on('feed.entered', (p) => { captured = p; });

    // 关注被风控拦截分支：仍须返回（治「卡死在作者主页」）。
    bus.emit('profile.exit', { sourcePageType: 'feed', reason: 'follow_blocked', ts: Date.now() });

    assert.ok(captured, 'profile.exit 应触发返回');
    assert.equal(captured!.pageType, 'feed');
    assert.equal(captured!.trigger, 'back_to_feed');
    assert.equal(ctx.currentNoteId, null, '应清理 currentNoteId');
  });

  it('收到 profile.exit → 每次各返回一次，来源页透传（不关注/已关注分支同样返回）', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new BackToFeed({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let count = 0;
    let last = null as FeedEnteredPayload | null;
    bus.on('feed.entered', (p) => { count++; last = p; });

    bus.emit('profile.exit', { sourcePageType: 'search', reason: 'not_followed', ts: Date.now() });
    bus.emit('profile.exit', { sourcePageType: 'search', reason: 'followed', ts: Date.now() });

    assert.equal(count, 2, '每个 profile.exit 各触发恰好一次返回');
    assert.equal(last!.pageType, 'search', '来源页透传');
  });

  it('回归：不再因 profile.done 直接返回（返回触发器唯一，避免双触发）', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new BackToFeed({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as FeedEnteredPayload | null;
    bus.on('feed.entered', (p) => { captured = p; });

    // 返回现由 RoleDispatcher 经 profile.exit 单一触发；BackToFeed 不再自行消费 profile.done。
    bus.emit('profile.done', { authorId: 'a', sourcePageType: 'feed', followed: false, ts: Date.now() });
    bus.emit('profile.done', { authorId: 'a', sourcePageType: 'feed', followed: true, ts: Date.now() });
    assert.equal(captured, null, 'BackToFeed 不应再直接消费 profile.done');
  });

  it('回归：不再因 action.completed{follow} 返回（返回与关注回执解耦）', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new BackToFeed({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as FeedEnteredPayload | null;
    bus.on('feed.entered', (p) => { captured = p; });

    bus.emit('action.completed', { action: 'follow', ok: true, ts: Date.now() });
    bus.emit('action.completed', { action: 'like', ok: true, ts: Date.now() });
    assert.equal(captured, null, '动作回执不再触发返回（含 follow）');
  });

  it('sourcePageType 正确传递：feed 来源返回 feed', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new BackToFeed({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as FeedEnteredPayload | null;
    bus.on('feed.entered', (p) => { captured = p; });

    bus.emit('quality.reject', {
      noteId: 'note_x',
      sourcePageType: 'feed',
      reason: '低质',
      ts: Date.now(),
    });

    assert.equal(captured!.pageType, 'feed');
  });

  it('sourcePageType 正确传递：search 来源返回 search', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new BackToFeed({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as FeedEnteredPayload | null;
    bus.on('feed.entered', (p) => { captured = p; });

    bus.emit('quality.reject', {
      noteId: 'note_y',
      sourcePageType: 'search',
      reason: '低质',
      ts: Date.now(),
    });

    assert.equal(captured!.pageType, 'search');
  });

  it('unsubscribe 后不再响应事件', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new BackToFeed({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();
    role.unsubscribe();

    let captured = null as FeedEnteredPayload | null;
    bus.on('feed.entered', (p) => { captured = p; });

    bus.emit('quality.reject', {
      noteId: 'note_z',
      sourcePageType: 'feed',
      reason: '低质',
      ts: Date.now(),
    });

    assert.equal(captured, null, 'should not emit after unsubscribe');
  });
});
