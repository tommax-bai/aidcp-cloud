import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { WriteNoteOpportunity } from '../../src/agents/write-note-opportunity.js';
import type { NoteData } from '../../src/agents/content-curator-role.js';
import type { Soul } from '../../src/soul/types.js';

const soul: Soul = {
  identity: { name: 'TestBot', role: '生活方式博主', background: '长期写居家和效率笔记', tone: '自然克制' },
  interests: { primary: ['家居', '收纳'], secondary: ['效率'], seed_keywords: ['小户型'] },
  behavior_guidelines: {
    style: '写得像真实使用后的经验总结',
    privacy: '不暴露隐私',
    collection_principle: '可复用才收藏',
    like_principle: '有共鸣才点赞',
  },
};

const note: NoteData = {
  noteId: 'note-1',
  title: '小户型玄关收纳复盘',
  content: '这篇笔记详细拆解了玄关动线、鞋柜分区、临时置物区和踩坑经验，适合延展成自己的收纳方法论。',
  author: '博主甲',
  likeCount: 300,
  collectCount: 180,
};

const wait = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('WriteNoteOpportunity', () => {
  it('LLM 高置信 write → 触发现有发布链路参照创作', async () => {
    const bus = new EventBus();
    const prompts: Array<{ prompt: string; role?: string }> = [];
    const triggers: unknown[] = [];
    const role = new WriteNoteOpportunity({
      eventBus: bus,
      soul,
      llm: {
        complete: async (prompt, opts) => {
          prompts.push({ prompt, role: opts?.role });
          return '{"action":"write","reason":"能延展成自己的收纳框架","confidence":0.88}';
        },
      },
      getNoteData: () => note,
      getAccountId: () => 'acc-1',
      triggerWriteNote: async (accountId, referenceNote) => {
        triggers.push({ accountId, referenceNote });
        return { triggered: true, reason: 'read_reference', status: 'pending_approval' };
      },
    });
    role.subscribe();

    bus.emit('feed.entered', { pageType: 'feed', trigger: 'session_start', ts: Date.now() });
    bus.emit('reading.done', {
      noteId: 'note-1',
      sourcePageType: 'feed',
      imagesBrowsed: 2,
      commentsRead: 0,
      keyPoints: [],
      readDurationMs: 1200,
      ts: Date.now(),
    });
    await wait();

    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].role, 'browse:write_note_opportunity');
    assert.equal(triggers.length, 1);
    assert.deepEqual(triggers[0], {
      accountId: 'acc-1',
      referenceNote: {
        sourceId: 'note-1',
        title: '小户型玄关收纳复盘',
        body: note.content,
        topics: ['小户', '户型', '型玄', '玄关', '关收', '收纳', '纳复', '复盘'],
        author: '博主甲',
      },
    });

    role.unsubscribe();
  });

  it('发布链路忙时直接跳过，不打 LLM', async () => {
    const bus = new EventBus();
    let llmCalls = 0;
    let triggerCalls = 0;
    const role = new WriteNoteOpportunity({
      eventBus: bus,
      soul,
      llm: {
        complete: async () => {
          llmCalls += 1;
          return '{"action":"write","reason":"可写","confidence":0.9}';
        },
      },
      getNoteData: () => note,
      getAccountId: () => 'acc-1',
      isWriteNoteBusy: () => true,
      triggerWriteNote: async () => {
        triggerCalls += 1;
        return { triggered: true };
      },
    });
    role.subscribe();

    bus.emit('reading.done', {
      noteId: 'note-1',
      sourcePageType: 'feed',
      imagesBrowsed: 0,
      commentsRead: 0,
      keyPoints: [],
      readDurationMs: 1000,
      ts: Date.now(),
    });
    await wait();

    assert.equal(llmCalls, 0);
    assert.equal(triggerCalls, 0);
    role.unsubscribe();
  });

  it('默认单场最多触发一次', async () => {
    const bus = new EventBus();
    let triggerCalls = 0;
    const notes = new Map<string, NoteData>([
      ['note-1', note],
      ['note-2', { ...note, noteId: 'note-2', title: '厨房抽屉分区经验' }],
    ]);
    const role = new WriteNoteOpportunity({
      eventBus: bus,
      soul,
      llm: { complete: async () => '{"action":"write","reason":"可延展","confidence":0.9}' },
      getNoteData: (id) => notes.get(id) ?? null,
      getAccountId: () => 'acc-1',
      triggerWriteNote: async () => {
        triggerCalls += 1;
        return { triggered: true, reason: 'read_reference', status: 'pending_approval' };
      },
    });
    role.subscribe();

    bus.emit('feed.entered', { pageType: 'feed', trigger: 'session_start', ts: Date.now() });
    for (const noteId of ['note-1', 'note-2']) {
      bus.emit('reading.done', {
        noteId,
        sourcePageType: 'feed',
        imagesBrowsed: 1,
        commentsRead: 0,
        keyPoints: [],
        readDurationMs: 1000,
        ts: Date.now(),
      });
      await wait();
    }

    assert.equal(triggerCalls, 1);
    role.unsubscribe();
  });
});
