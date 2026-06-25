import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { NoteOpener } from '../../src/agents/note-opener.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/soul/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
};

function detail(noteId: string) {
  return { noteId, title: 't', content: 'c', likeCount: 0, collectCount: 0 };
}

describe('NoteOpener', () => {
  it('content.valuable 只记录来源页类型，不标已访问（那是"决定要开"，不是"真打开"）', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new NoteOpener({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    bus.emit('content.valuable', {
      index: 2, noteId: 'n2', title: 'LLM最新进展', reason: '相关性高',
      confidence: 0.9, sourcePageType: 'search', ts: Date.now(),
    });

    assert.equal(ctx.sourcePageType, 'search', '应记录来源页类型');
    assert.equal(ctx.isVisited('n2'), false, '判定时不应标已访问');
  });

  it('note.detail.arrived 才标"已访问" + 重置连续空滑计数（用回传的真实 noteId）', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    ctx.incrementScrolls();
    ctx.incrementScrolls();

    const role = new NoteOpener({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    bus.emit('note.detail.arrived', { detail: detail('real-123'), ts: Date.now() });

    assert.ok(ctx.isVisited('real-123'), '真正打开后才标已访问');
    assert.equal(ctx.consecutiveScrolls, 0, '应重置连续空滑计数');
  });

  it('只判定、未真正打开（无 note.detail）→ 不标已访问，以后仍可重选', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new NoteOpener({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    bus.emit('content.valuable', {
      index: 0, noteId: 'n-gone', title: 't', reason: 'r',
      confidence: 0.8, sourcePageType: 'feed', ts: Date.now(),
    });

    assert.equal(ctx.isVisited('n-gone'), false, '没真正打开就不该标已访问');
  });

  it('unsubscribe 后不再响应事件', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new NoteOpener({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();
    role.unsubscribe();

    bus.emit('note.detail.arrived', { detail: detail('after-unsub'), ts: Date.now() });
    assert.equal(ctx.isVisited('after-unsub'), false, 'unsubscribe 后不应再标已访问');
  });
});
