import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { InteractionAppraiserRole } from '../../src/agents/interaction-appraiser-role.js';
import type { NoteData } from '../../src/agents/content-curator-role.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/soul/types.js';
import type { InteractionCompletedPayload, InteractionSkippedPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程'], seed_keywords: ['GPT'] },
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

const defaultBudget = () => ({ likes: 5, collects: 3 });

describe('InteractionAppraiserRole', () => {
  it('构造函数：无 LLM 抛错', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    assert.throws(
      () => new InteractionAppraiserRole({
        eventBus: bus,
        soul: mockSoul,
        sessionContext: ctx,
        getNoteData: () => null,
        getRemainingBudget: defaultBudget,
      }),
      /需要 LlmClient/,
    );
  });

  it('LLM 返回 like → emit interaction.completed with actions=["like"]', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"action":"like","reason":"有启发","confidence":0.8}',
    };
    const role = new InteractionAppraiserRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
      getRemainingBudget: defaultBudget,
    });
    role.subscribe();

    let captured = null as InteractionCompletedPayload | null;
    bus.on('interaction.completed', (p) => { captured = p; });

    bus.emit('reading.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      imagesBrowsed: 3,
      commentsRead: 5,
      keyPoints: [],
      readDurationMs: 1000,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured, 'should emit interaction.completed');
    assert.equal(captured!.noteId, 'note_1');
    assert.equal(captured!.sourcePageType, 'feed');
    assert.deepEqual(captured!.actions, ['like']);

    role.unsubscribe();
  });

  it('LLM 返回 collect（like 配额充足）→ 收藏即点赞 actions=["like","collect"]', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"action":"collect","reason":"有实操步骤","confidence":0.9}',
    };
    const role = new InteractionAppraiserRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
      getRemainingBudget: defaultBudget,
    });
    role.subscribe();

    let captured = null as InteractionCompletedPayload | null;
    bus.on('interaction.completed', (p) => { captured = p; });

    bus.emit('reading.done', {
      noteId: 'note_1',
      sourcePageType: 'search',
      imagesBrowsed: 2,
      commentsRead: 3,
      keyPoints: [],
      readDurationMs: 800,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.deepEqual(captured!.actions, ['like', 'collect']);
    assert.equal(captured!.sourcePageType, 'search');

    role.unsubscribe();
  });

  it('LLM 返回 collect（like 配额=0）→ 仅 collect，不绕过配额', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"action":"collect","reason":"硬核可复用","confidence":0.9}',
    };
    const role = new InteractionAppraiserRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
      getRemainingBudget: () => ({ likes: 0, collects: 3 }),
    });
    role.subscribe();

    let captured = null as InteractionCompletedPayload | null;
    bus.on('interaction.completed', (p) => { captured = p; });

    bus.emit('reading.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      imagesBrowsed: 2,
      commentsRead: 3,
      keyPoints: [],
      readDurationMs: 800,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.deepEqual(captured!.actions, ['collect']);

    role.unsubscribe();
  });

  it('LLM 返回 collect（collect 配额=0、like 配额充足）→ 仅 like', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"action":"collect","reason":"有用但藏额已满","confidence":0.9}',
    };
    const role = new InteractionAppraiserRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
      getRemainingBudget: () => ({ likes: 5, collects: 0 }),
    });
    role.subscribe();

    let captured = null as InteractionCompletedPayload | null;
    bus.on('interaction.completed', (p) => { captured = p; });

    bus.emit('reading.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      imagesBrowsed: 2,
      commentsRead: 3,
      keyPoints: [],
      readDurationMs: 800,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.deepEqual(captured!.actions, ['like']);

    role.unsubscribe();
  });

  it('prompt 把 like 框定为低门槛常见、collect 为稀有选择性', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    let capturedPrompt = '';
    const llm = {
      complete: async (p: string) => {
        capturedPrompt = p;
        return '{"action":"pass","reason":"n/a","confidence":0.5}';
      },
    };
    const role = new InteractionAppraiserRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
      getRemainingBudget: defaultBudget,
    });
    role.subscribe();

    bus.emit('reading.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      imagesBrowsed: 1,
      commentsRead: 1,
      keyPoints: [],
      readDurationMs: 300,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.match(capturedPrompt, /点赞是高频轻互动/);
    assert.match(capturedPrompt, /多数值得互动的笔记都该至少点赞/);
    assert.match(capturedPrompt, /稀有、谨慎/);

    role.unsubscribe();
  });

  it('LLM 返回 both → emit interaction.completed with actions=["like","collect"]', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"action":"both","reason":"非常优质","confidence":0.95}',
    };
    const role = new InteractionAppraiserRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
      getRemainingBudget: defaultBudget,
    });
    role.subscribe();

    let captured = null as InteractionCompletedPayload | null;
    bus.on('interaction.completed', (p) => { captured = p; });

    bus.emit('reading.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      imagesBrowsed: 5,
      commentsRead: 10,
      keyPoints: [],
      readDurationMs: 2000,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.deepEqual(captured!.actions, ['like', 'collect']);

    role.unsubscribe();
  });

  it('LLM 返回 pass → emit interaction.skipped', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"action":"pass","reason":"不够格","confidence":0.5}',
    };
    const role = new InteractionAppraiserRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
      getRemainingBudget: defaultBudget,
    });
    role.subscribe();

    let captured = null as InteractionSkippedPayload | null;
    bus.on('interaction.skipped', (p) => { captured = p; });

    bus.emit('reading.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      imagesBrowsed: 1,
      commentsRead: 2,
      keyPoints: [],
      readDurationMs: 500,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured, 'should emit interaction.skipped');
    assert.equal(captured!.noteId, 'note_1');
    assert.equal(captured!.reason, '不够格');

    role.unsubscribe();
  });

  it('无预算 → emit interaction.skipped (no_budget)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = { complete: async () => '{}' };
    const role = new InteractionAppraiserRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
      getRemainingBudget: () => ({ likes: 0, collects: 0 }),
    });
    role.subscribe();

    let captured = null as InteractionSkippedPayload | null;
    bus.on('interaction.skipped', (p) => { captured = p; });

    bus.emit('reading.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      imagesBrowsed: 0,
      commentsRead: 0,
      keyPoints: [],
      readDurationMs: 100,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.equal(captured!.reason, 'no_budget');

    role.unsubscribe();
  });

  it('笔记数据不可用 → emit interaction.skipped (note_data_unavailable)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = { complete: async () => '{}' };
    const role = new InteractionAppraiserRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => null,
      getRemainingBudget: defaultBudget,
    });
    role.subscribe();

    let captured = null as InteractionSkippedPayload | null;
    bus.on('interaction.skipped', (p) => { captured = p; });

    bus.emit('reading.done', {
      noteId: 'note_x',
      sourcePageType: 'search',
      imagesBrowsed: 0,
      commentsRead: 0,
      keyPoints: [],
      readDurationMs: 50,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.equal(captured!.reason, 'note_data_unavailable');

    role.unsubscribe();
  });

  it('LLM 抛错 → emit interaction.skipped (llm_error)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = { complete: async () => { throw new Error('timeout'); } };
    const role = new InteractionAppraiserRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
      getRemainingBudget: defaultBudget,
    });
    role.subscribe();

    let captured = null as InteractionSkippedPayload | null;
    bus.on('interaction.skipped', (p) => { captured = p; });

    bus.emit('reading.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      imagesBrowsed: 0,
      commentsRead: 0,
      keyPoints: [],
      readDurationMs: 100,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.equal(captured!.reason, 'llm_error');

    role.unsubscribe();
  });

  it('sourcePageType 透传正确', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"action":"like","reason":"好内容","confidence":0.8}',
    };
    const role = new InteractionAppraiserRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
      getRemainingBudget: defaultBudget,
    });
    role.subscribe();

    let captured = null as InteractionCompletedPayload | null;
    bus.on('interaction.completed', (p) => { captured = p; });

    bus.emit('reading.done', {
      noteId: 'note_1',
      sourcePageType: 'search',
      imagesBrowsed: 2,
      commentsRead: 4,
      keyPoints: [],
      readDurationMs: 600,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.equal(captured!.sourcePageType, 'search');

    role.unsubscribe();
  });

  it('unsubscribe 后不再响应事件', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"action":"like","reason":"test","confidence":0.8}',
    };
    const role = new InteractionAppraiserRole({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
      getRemainingBudget: defaultBudget,
    });
    role.subscribe();
    role.unsubscribe();

    let completedEmitted = false;
    let skippedEmitted = false;
    bus.on('interaction.completed', () => { completedEmitted = true; });
    bus.on('interaction.skipped', () => { skippedEmitted = true; });

    bus.emit('reading.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      imagesBrowsed: 0,
      commentsRead: 0,
      keyPoints: [],
      readDurationMs: 100,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(completedEmitted, false);
    assert.equal(skippedEmitted, false);
  });
});
