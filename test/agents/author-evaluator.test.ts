import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { AuthorEvaluator } from '../../src/agents/author-evaluator.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { NoteData } from '../../src/agents/content-curator-role.js';
import type { Soul } from '../../src/soul/types.js';
import type { ProfileWorthVisitingPayload, ProfileSkippedPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程'], seed_keywords: ['GPT'] },
};

const sampleNote: NoteData = {
  noteId: 'note_1',
  title: 'LLM微调实战指南',
  content: '详细的微调步骤和代码示例...',
  author: 'tech_guru',
  likeCount: 200,
  collectCount: 80,
};

describe('AuthorEvaluator', () => {
  it('构造函数：无 LLM 抛错', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    assert.throws(
      () => new AuthorEvaluator({
        eventBus: bus,
        soul: mockSoul,
        sessionContext: ctx,
        getNoteData: () => null,
      }),
      /需要 LlmClient/,
    );
  });

  it('LLM 返回 visit → emit profile.worth_visiting', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"verdict":"visit","reason":"作者专业度高","confidence":0.85}',
    };
    const role = new AuthorEvaluator({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
    });
    role.subscribe();

    let captured = null as ProfileWorthVisitingPayload | null;
    bus.on('profile.worth_visiting', (p) => { captured = p; });

    bus.emit('comment.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      actions: ['like'],
      ok: true,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured, 'should emit profile.worth_visiting');
    assert.equal(captured!.noteId, 'note_1');
    assert.equal(captured!.authorId, 'tech_guru');
    assert.equal(captured!.sourcePageType, 'feed');
    assert.equal(captured!.reason, '作者专业度高');

    role.unsubscribe();
  });

  it('LLM 返回 skip → emit profile.skipped', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"verdict":"skip","reason":"内容太普通"}',
    };
    const role = new AuthorEvaluator({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
    });
    role.subscribe();

    let captured = null as ProfileSkippedPayload | null;
    bus.on('profile.skipped', (p) => { captured = p; });

    bus.emit('comment.done', {
      noteId: 'note_1',
      sourcePageType: 'search',
      actions: ['like'],
      ok: true,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured, 'should emit profile.skipped');
    assert.equal(captured!.noteId, 'note_1');
    assert.equal(captured!.sourcePageType, 'search');
    assert.equal(captured!.reason, '内容太普通');

    role.unsubscribe();
  });

  it('collect 场景：prompt 中包含收藏偏向信息', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    let capturedPrompt = '';
    const llm = {
      complete: async (prompt: string) => {
        capturedPrompt = prompt;
        return '{"verdict":"visit","reason":"收藏内容作者值得关注","confidence":0.9}';
      },
    };
    const role = new AuthorEvaluator({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
    });
    role.subscribe();

    let captured = null as ProfileWorthVisitingPayload | null;
    bus.on('profile.worth_visiting', (p) => { captured = p; });

    bus.emit('comment.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      actions: ['like', 'collect'],
      ok: true,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured, 'should emit profile.worth_visiting for collect');
    assert.ok(capturedPrompt.includes('收藏'), 'prompt should mention collect implication');

    role.unsubscribe();
  });

  it('笔记数据不可用 → emit profile.skipped (note_data_unavailable)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = { complete: async () => '{}' };
    const role = new AuthorEvaluator({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => null,
    });
    role.subscribe();

    let captured = null as ProfileSkippedPayload | null;
    bus.on('profile.skipped', (p) => { captured = p; });

    bus.emit('comment.done', {
      noteId: 'note_x',
      sourcePageType: 'feed',
      actions: ['like'],
      ok: true,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.equal(captured!.reason, 'note_data_unavailable');

    role.unsubscribe();
  });

  it('作者未知 → emit profile.skipped (author_unknown)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = { complete: async () => '{}' };
    const noteNoAuthor: NoteData = { ...sampleNote, author: undefined };
    const role = new AuthorEvaluator({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => noteNoAuthor,
    });
    role.subscribe();

    let captured = null as ProfileSkippedPayload | null;
    bus.on('profile.skipped', (p) => { captured = p; });

    bus.emit('comment.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      actions: ['like'],
      ok: true,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured);
    assert.equal(captured!.reason, 'author_unknown');

    role.unsubscribe();
  });

  it('authorFollowed=true → 提前 skip(already_followed)，不调 LLM、不产 worth_visiting', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    let llmCalled = false;
    const llm = { complete: async () => { llmCalled = true; return '{"verdict":"visit","reason":"x","confidence":0.9}'; } };
    const followedNote: NoteData = { ...sampleNote, authorFollowed: true };
    const role = new AuthorEvaluator({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => followedNote,
    });
    role.subscribe();

    let skipped = null as ProfileSkippedPayload | null;
    let worthEmitted = false;
    bus.on('profile.skipped', (p) => { skipped = p; });
    bus.on('profile.worth_visiting', () => { worthEmitted = true; });

    bus.emit('comment.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      actions: ['like'],
      ok: true,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(skipped, 'should emit profile.skipped');
    assert.equal(skipped!.reason, 'already_followed');
    assert.equal(skipped!.noteId, 'note_1');
    assert.equal(worthEmitted, false, 'must not emit profile.worth_visiting');
    assert.equal(llmCalled, false, 'must not call LLM when already followed');

    role.unsubscribe();
  });

  it('authorFollowed=false → 照常走 LLM 评估（不短路）', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    let llmCalled = false;
    const llm = { complete: async () => { llmCalled = true; return '{"verdict":"visit","reason":"好博主","confidence":0.9}'; } };
    const notFollowed: NoteData = { ...sampleNote, authorFollowed: false };
    const role = new AuthorEvaluator({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => notFollowed,
    });
    role.subscribe();

    let worth = null as ProfileWorthVisitingPayload | null;
    bus.on('profile.worth_visiting', (p) => { worth = p; });

    bus.emit('comment.done', { noteId: 'note_1', sourcePageType: 'feed', actions: ['like'], ok: true, ts: Date.now() });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(llmCalled, true, 'should call LLM when not followed');
    assert.ok(worth, 'should evaluate normally');

    role.unsubscribe();
  });

  it('LLM 抛错 → emit profile.skipped (llm_error)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = { complete: async () => { throw new Error('timeout'); } };
    const role = new AuthorEvaluator({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
    });
    role.subscribe();

    let captured = null as ProfileSkippedPayload | null;
    bus.on('profile.skipped', (p) => { captured = p; });

    bus.emit('comment.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      actions: ['like'],
      ok: true,
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
      complete: async () => '{"verdict":"visit","reason":"好博主","confidence":0.8}',
    };
    const role = new AuthorEvaluator({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
    });
    role.subscribe();

    let captured = null as ProfileWorthVisitingPayload | null;
    bus.on('profile.worth_visiting', (p) => { captured = p; });

    bus.emit('comment.done', {
      noteId: 'note_1',
      sourcePageType: 'search',
      actions: ['collect'],
      ok: true,
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
      complete: async () => '{"verdict":"visit","reason":"test","confidence":0.8}',
    };
    const role = new AuthorEvaluator({
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getNoteData: () => sampleNote,
    });
    role.subscribe();
    role.unsubscribe();

    let worthEmitted = false;
    let skippedEmitted = false;
    bus.on('profile.worth_visiting', () => { worthEmitted = true; });
    bus.on('profile.skipped', () => { skippedEmitted = true; });

    bus.emit('comment.done', {
      noteId: 'note_1',
      sourcePageType: 'feed',
      actions: ['like'],
      ok: true,
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(worthEmitted, false);
    assert.equal(skippedEmitted, false);
  });
});
