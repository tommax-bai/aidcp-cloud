import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { ContentCuratorRole } from '../../src/agents/content-curator-role.js';
import type { NoteData } from '../../src/agents/content-curator-role.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/soul/types.js';
import type { QualityPassPayload, QualityRejectPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程', '技术'], seed_keywords: ['GPT'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
};

const sampleNote: NoteData = {
  noteId: 'note_1',
  title: 'LLM微调实战指南',
  content: '详细的微调步骤和代码示例...',
  author: '技术猫',
  likeCount: 200,
  collectCount: 80,
};

describe('ContentCuratorRole', () => {
  it('构造函数：无 LLM 抛错', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    assert.throws(
      () => new ContentCuratorRole({
        eventBus: bus,
        soul: mockSoul,
        sessionContext: ctx,
      }),
      /需要 LlmClient/,
    );
  });

  it('LLM 返回 pass → emit quality.pass', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    ctx.setSourcePageType('feed');
    const llm = {
      complete: async () => '{"action":"pass","reason":"内容有具体细节和代码","confidence":0.85}',
    };
    const role = new ContentCuratorRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
    });
    role.subscribe();

    let captured = null as QualityPassPayload | null;
    bus.on('quality.pass', (p) => { captured = p; });

    bus.emit('note.detail.arrived', { detail: sampleNote, ts: Date.now() });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured, 'should emit quality.pass');
    assert.equal(captured!.noteId, 'note_1');
    assert.equal(captured!.sourcePageType, 'feed');
    assert.equal(captured!.reason, '内容有具体细节和代码');

    role.unsubscribe();
  });

  it('LLM 返回 close_note → emit quality.reject', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    ctx.setSourcePageType('search');
    const llm = {
      complete: async () => '{"action":"close_note","reason":"标题党内容空洞","confidence":0.9}',
    };
    const role = new ContentCuratorRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
    });
    role.subscribe();

    let captured = null as QualityRejectPayload | null;
    bus.on('quality.reject', (p) => { captured = p; });

    bus.emit('note.detail.arrived', { detail: sampleNote, ts: Date.now() });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured, 'should emit quality.reject');
    assert.equal(captured!.noteId, 'note_1');
    assert.equal(captured!.sourcePageType, 'search');
    assert.equal(captured!.reason, '标题党内容空洞');

    role.unsubscribe();
  });

  it('LLM 抛错 → emit quality.reject (llm_error)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    ctx.setSourcePageType('feed');
    const llm = { complete: async () => { throw new Error('timeout'); } };
    const role = new ContentCuratorRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
    });
    role.subscribe();

    let captured = null as QualityRejectPayload | null;
    bus.on('quality.reject', (p) => { captured = p; });

    bus.emit('note.detail.arrived', { detail: sampleNote, ts: Date.now() });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured, 'should emit quality.reject');
    assert.equal(captured!.reason, 'llm_error');

    role.unsubscribe();
  });

  it('LLM 返回非法 JSON → emit quality.reject (parse_failed)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    ctx.setSourcePageType('feed');
    const llm = { complete: async () => '这不是JSON' };
    const role = new ContentCuratorRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
    });
    role.subscribe();

    let captured = null as QualityRejectPayload | null;
    bus.on('quality.reject', (p) => { captured = p; });

    bus.emit('note.detail.arrived', { detail: sampleNote, ts: Date.now() });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured, 'should emit quality.reject');
    assert.equal(captured!.reason, 'parse_failed');

    role.unsubscribe();
  });

  it('sourcePageType 从 sessionContext 正确读取', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    ctx.setSourcePageType('search');
    const llm = {
      complete: async () => '{"action":"pass","reason":"好内容","confidence":0.8}',
    };
    const role = new ContentCuratorRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
    });
    role.subscribe();

    let captured = null as QualityPassPayload | null;
    bus.on('quality.pass', (p) => { captured = p; });

    bus.emit('note.detail.arrived', { detail: sampleNote, ts: Date.now() });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.equal(captured!.sourcePageType, 'search');

    role.unsubscribe();
  });

  it('unsubscribe 后不再响应事件', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    ctx.setSourcePageType('feed');
    const llm = {
      complete: async () => '{"action":"pass","reason":"test","confidence":0.8}',
    };
    const role = new ContentCuratorRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
    });
    role.subscribe();
    role.unsubscribe();

    let passEmitted = false;
    let rejectEmitted = false;
    bus.on('quality.pass', () => { passEmitted = true; });
    bus.on('quality.reject', () => { rejectEmitted = true; });

    bus.emit('note.detail.arrived', { detail: sampleNote, ts: Date.now() });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(passEmitted, false);
    assert.equal(rejectEmitted, false);
  });
});
