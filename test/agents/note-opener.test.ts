import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { NoteOpener } from '../../src/agents/note-opener.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/soul/types.js';
import type { NoteEnteredPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
};

describe('NoteOpener', () => {
  it('收到 content.valuable → emit note.entered', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new NoteOpener({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as NoteEnteredPayload | null;
    bus.on('note.entered', (p) => { captured = p; });

    bus.emit('content.valuable', {
      index: 2,
      title: 'LLM最新进展',
      reason: '相关性高',
      confidence: 0.9,
      sourcePageType: 'feed',
      ts: Date.now(),
    });

    assert.ok(captured, 'should emit note.entered');
    assert.equal(captured!.noteId, 'note_2');
    assert.equal(captured!.sourcePageType, 'feed');
  });

  it('更新 SessionContext：setCurrentNoteId、markVisited、setSourcePageType、resetScrolls', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    // 先增加一些 scrolls
    ctx.incrementScrolls();
    ctx.incrementScrolls();

    const role = new NoteOpener({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    bus.emit('content.valuable', {
      index: 3,
      title: '技术前沿',
      reason: 'AI相关',
      confidence: 0.85,
      sourcePageType: 'search',
      ts: Date.now(),
    });

    assert.equal(ctx.currentNoteId, 'note_3');
    assert.equal(ctx.sourcePageType, 'search');
    assert.equal(ctx.consecutiveScrolls, 0, 'scrolls should be reset');
    assert.ok(ctx.isVisited('note_3'), 'note should be marked visited');
  });

  it('sourcePageType=search → note.entered.sourcePageType=search', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new NoteOpener({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as NoteEnteredPayload | null;
    bus.on('note.entered', (p) => { captured = p; });

    bus.emit('content.valuable', {
      index: 0,
      title: '搜索结果',
      reason: '与搜索词匹配',
      confidence: 0.7,
      sourcePageType: 'search',
      ts: Date.now(),
    });

    assert.ok(captured);
    assert.equal(captured!.sourcePageType, 'search');
  });

  it('unsubscribe 后不再响应事件', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new NoteOpener({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();
    role.unsubscribe();

    let captured = null as NoteEnteredPayload | null;
    bus.on('note.entered', (p) => { captured = p; });

    bus.emit('content.valuable', {
      index: 1,
      title: 'test',
      reason: 'test',
      confidence: 0.8,
      sourcePageType: 'feed',
      ts: Date.now(),
    });

    assert.equal(captured, null, 'should not emit after unsubscribe');
  });
});
