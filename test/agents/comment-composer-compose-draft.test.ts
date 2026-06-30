/**
 * CommentComposer.composeDraft 单测（change comment-search-command，task 7）。
 * 覆盖：现场评论进 prompt、空/超长/LLM 失败诚实返回 null、不读评论区时行为不变。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommentComposer } from '../../src/agents/comment-composer.js';
import type { NoteData } from '../../src/agents/content-curator-role.js';
import type { Soul } from '../../src/soul/types.js';
import { EventBus } from '../../src/event-bus/index.js';

const soul: Soul = {
  identity: { name: 'TestBot', role: 'AI研发工程师', background: 'x', tone: '理性' },
  interests: { primary: ['LLM'], secondary: ['RAG'], seed_keywords: ['vLLM'] },
};

const note: NoteData = { noteId: 'n1', title: 'RAG 工程实战', content: '正文内容', likeCount: 10, collectCount: 5 };

function makeComposer(complete: (p: string) => string | Promise<string>) {
  let lastPrompt = '';
  const composer = new CommentComposer({
    eventBus: new EventBus(),
    soul,
    getNoteData: () => note,
    llm: {
      complete: async (p) => {
        lastPrompt = p;
        return complete(p);
      },
    },
  });
  return { composer, getPrompt: () => lastPrompt };
}

describe('CommentComposer.composeDraft', () => {
  it('现场评论进 prompt，正常返回草稿', async () => {
    const { composer, getPrompt } = makeComposer(() => '{"text":"这套检索链路很实在"}');
    const draft = await composer.composeDraft(note, { onPageComments: ['这个分块策略学到了', '召回怎么调'] });
    assert.equal(draft, '这套检索链路很实在');
    assert.match(getPrompt(), /这条笔记现有的评论/);
    assert.match(getPrompt(), /这个分块策略学到了/);
  });

  it('不传现场评论 → prompt 无现场评论块（行为同旧）', async () => {
    const { composer, getPrompt } = makeComposer(() => '{"text":"不错"}');
    await composer.composeDraft(note, {});
    assert.doesNotMatch(getPrompt(), /这条笔记现有的评论/);
  });

  it('LLM 失败 → 诚实返回 null', async () => {
    const { composer } = makeComposer(() => {
      throw new Error('llm down');
    });
    const draft = await composer.composeDraft(note, { onPageComments: ['x'] });
    assert.equal(draft, null);
  });

  it('空文本 → null', async () => {
    const { composer } = makeComposer(() => '{"text":""}');
    assert.equal(await composer.composeDraft(note), null);
  });

  it('超长（>50字）→ null', async () => {
    const long = '很'.repeat(60);
    const { composer } = makeComposer(() => `{"text":"${long}"}`);
    assert.equal(await composer.composeDraft(note), null);
  });

  it('裸 @ 被剥离', async () => {
    const { composer } = makeComposer(() => '{"text":"@某人 说得对"}');
    const draft = await composer.composeDraft(note);
    assert.ok(draft && !draft.includes('@'));
  });
});
