import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { CommentReviewer } from '../../src/agents/comment-reviewer.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { NoteData } from '../../src/agents/content-curator-role.js';
import type { Soul } from '../../src/soul/types.js';
import type { ReadingScrollCommentsPayload, ReadingDonePayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
};

const note: NoteData = { noteId: 'note_1', title: 't', content: '正文', likeCount: 100, collectCount: 10 };
const getNote = (_id: string): NoteData | null => note;

function mkRole(bus: EventBus, complete: () => Promise<string>): CommentReviewer {
  const role = new CommentReviewer({
    eventBus: bus,
    soul: mockSoul,
    llm: { complete },
    sessionContext: new SessionContext(),
    getNoteData: getNote,
  });
  role.subscribe();
  return role;
}

describe('CommentReviewer（评论判定）', () => {
  it('构造函数：无 LLM 抛错', () => {
    assert.throws(
      () => new CommentReviewer({ eventBus: new EventBus(), soul: mockSoul, sessionContext: new SessionContext(), getNoteData: getNote }),
      /需要 LlmClient/,
    );
  });

  it('LLM=read → emit reading.scroll_comments；回执到达 → emit reading.done', async () => {
    const bus = new EventBus();
    mkRole(bus, async () => '{"action":"read","reason":"互动高"}');

    let intent = null as ReadingScrollCommentsPayload | null;
    let done = null as ReadingDonePayload | null;
    let doneCount = 0;
    bus.on('reading.scroll_comments', (p) => { intent = p; });
    bus.on('reading.done', (p) => { done = p; doneCount++; });

    bus.emit('reading.images_done', { noteId: 'note_1', sourcePageType: 'feed', imagesBrowsed: 2, ts: Date.now() });
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(intent, '应 emit reading.scroll_comments');
    assert.ok(intent!.count >= 3, '应带动态滚动次数');
    assert.equal(doneCount, 0, '回执前不应 emit reading.done');

    bus.emit('action.completed', { action: 'scroll_comments', ok: true, ts: Date.now() });
    assert.ok(done, '回执后应 emit reading.done');
    assert.equal(done!.noteId, 'note_1');
    assert.equal(done!.imagesBrowsed, 2, 'imagesBrowsed 应从 reading.images_done 透传');
    assert.equal(done!.commentsRead, 1);
  });

  it('LLM=skip → 直接 emit reading.done，不发 scroll_comments', async () => {
    const bus = new EventBus();
    mkRole(bus, async () => '{"action":"skip","reason":"无关"}');

    let intentCount = 0;
    let done = null as ReadingDonePayload | null;
    bus.on('reading.scroll_comments', () => { intentCount++; });
    bus.on('reading.done', (p) => { done = p; });

    bus.emit('reading.images_done', { noteId: 'note_1', sourcePageType: 'search', imagesBrowsed: 0, ts: Date.now() });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(intentCount, 0);
    assert.ok(done, '应直接 emit reading.done');
    assert.equal(done!.sourcePageType, 'search');
    assert.equal(done!.commentsRead, 0);
  });

  it('LLM 失败 → 不看评论，仍 emit reading.done（不阻塞互动）', async () => {
    const bus = new EventBus();
    mkRole(bus, async () => { throw new Error('llm down'); });

    let done = null as ReadingDonePayload | null;
    bus.on('reading.done', (p) => { done = p; });

    bus.emit('reading.images_done', { noteId: 'note_1', sourcePageType: 'feed', imagesBrowsed: 1, ts: Date.now() });
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(done, 'LLM 失败也应推进');
    assert.equal(done!.commentsRead, 0);
  });
});
