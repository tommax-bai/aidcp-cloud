import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { DeepReader } from '../../src/agents/deep-reader.js';
import type { Soul } from '../../src/soul/types.js';
import type { ReadingDonePayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
};

describe('DeepReader', () => {
  it('收到 quality.pass → emit reading.done', async () => {
    const bus = new EventBus();
    const role = new DeepReader({ eventBus: bus, soul: mockSoul });
    role.subscribe();

    let captured = null as ReadingDonePayload | null;
    bus.on('reading.done', (p) => { captured = p; });

    bus.emit('quality.pass', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      reason: '内容质量高',
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured, 'should emit reading.done');
    assert.equal(captured!.noteId, 'note_1');
    assert.equal(captured!.sourcePageType, 'feed');
    assert.equal(captured!.imagesBrowsed, 0);
    assert.equal(captured!.commentsRead, 0);
    assert.deepEqual(captured!.keyPoints, []);
    assert.ok(captured!.readDurationMs >= 0);
    assert.ok(captured!.ts > 0);

    role.unsubscribe();
  });

  it('sourcePageType=search 透传', async () => {
    const bus = new EventBus();
    const role = new DeepReader({ eventBus: bus, soul: mockSoul });
    role.subscribe();

    let captured = null as ReadingDonePayload | null;
    bus.on('reading.done', (p) => { captured = p; });

    bus.emit('quality.pass', {
      noteId: 'note_2',
      sourcePageType: 'search',
      reason: '质量好',
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.equal(captured!.sourcePageType, 'search');
    assert.equal(captured!.noteId, 'note_2');

    role.unsubscribe();
  });

  it('unsubscribe 后不再响应事件', async () => {
    const bus = new EventBus();
    const role = new DeepReader({ eventBus: bus, soul: mockSoul });
    role.subscribe();
    role.unsubscribe();

    let captured = null as ReadingDonePayload | null;
    bus.on('reading.done', (p) => { captured = p; });

    bus.emit('quality.pass', {
      noteId: 'note_3',
      sourcePageType: 'feed',
      reason: '质量好',
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(captured, null, 'should not emit after unsubscribe');
  });
});
