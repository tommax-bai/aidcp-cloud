import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { BackToFeed } from '../../src/agents/back-to-feed.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/soul/types.js';
import type { FeedEnteredPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
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

  it('收到 profile.done → emit feed.entered', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    ctx.setCurrentNoteId('note_4');
    const role = new BackToFeed({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as FeedEnteredPayload | null;
    bus.on('feed.entered', (p) => { captured = p; });

    bus.emit('profile.done', {
      authorId: 'author_1',
      sourcePageType: 'search',
      followed: true,
      ts: Date.now(),
    });

    assert.ok(captured);
    assert.equal(captured!.pageType, 'search');
    assert.equal(captured!.trigger, 'back_to_feed');
    assert.equal(ctx.currentNoteId, null);
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
