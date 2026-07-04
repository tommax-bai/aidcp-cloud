import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '../../src/orchestrator/role-dispatcher.js';
import type { EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/soul/types.js';

const soul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程'], seed_keywords: ['GPT'] },
};

function withTimeout<T>(p: Promise<T>, label: string, ms = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${label}`)), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

describe('RoleDispatcher read-to-write note lane', () => {
  it('reading.done 上写笔记旁路可触发，同时不阻塞互动 skip 后返回 feed', async () => {
    const commands: EdgeCommand[] = [];
    const responses = [
      '{"action":"pass","reason":"互动克制","confidence":0.5}',
      '{"action":"write","reason":"能延展成独立选题","confidence":0.9}',
    ];
    const llm = {
      complete: async () => {
        const next = responses.shift();
        if (!next) throw new Error('unexpected llm call');
        return next;
      },
    };
    const note = {
      noteId: 'note_0',
      title: 'LLM产品复盘',
      content: '详细拆解一个LLM产品的定位、交互、留存与复盘方法。',
      author: '产品猫',
      likeCount: 200,
      collectCount: 80,
    };
    let triggered: { accountId: string; sourceId: string } | null = null;
    let resolveTriggered!: () => void;
    const triggeredPromise = new Promise<void>((resolve) => {
      resolveTriggered = resolve;
    });
    let resolveReturned!: () => void;
    const returnedPromise = new Promise<void>((resolve) => {
      resolveReturned = resolve;
    });

    const dispatcher = new RoleDispatcher({
      soul,
      llm,
      sendCommand: (cmd) => commands.push(cmd),
      isWriteNoteBusy: () => false,
      triggerWriteNote: async (accountId, referenceNote) => {
        triggered = { accountId, sourceId: referenceNote.sourceId };
        resolveTriggered();
        return { triggered: true, reason: 'read_reference', status: 'pending_approval' };
      },
    });
    dispatcher.setCurrentAccountId('acc-1');
    dispatcher.setup();
    dispatcher.updateNoteData(note);
    dispatcher.startSession();
    dispatcher.bus.on('feed.entered', (payload) => {
      if (payload.trigger === 'back_to_feed') resolveReturned();
    });

    dispatcher.bus.emit('reading.done', {
      noteId: note.noteId,
      sourcePageType: 'feed',
      imagesBrowsed: 0,
      commentsRead: 0,
      keyPoints: [],
      readDurationMs: 1000,
      ts: Date.now(),
    });

    await Promise.all([
      withTimeout(triggeredPromise, 'write note trigger'),
      withTimeout(returnedPromise, 'back_to_feed event'),
    ]);

    assert.deepEqual(triggered, { accountId: 'acc-1', sourceId: 'note_0' });
    assert.ok(!commands.some((c) => c.action === 'like' || c.action === 'collect'), '写作旁路不应消费互动指令');

    dispatcher.endSession();
  });
});
