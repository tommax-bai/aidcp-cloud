/**
 * CommentComposer.composeDraft 单测（change comment-search-command，task 7）。
 * 覆盖：现场评论进 prompt、空/超长/LLM 失败诚实返回 null、不读评论区时行为不变。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommentComposer } from '@automation/agents/comment-composer.js';
import type { NoteData } from '@automation/agents/content-curator-role.js';
import type { Soul } from '@kernel/kernel/soul-types.js';
import { EventBus } from '@automation/event-bus/index.js';
import { FB_COMMENT_PROFILE, type CommentPlatformProfile } from '@automation/platform/registry.js';

const soul: Soul = {
  identity: { name: 'TestBot', role: 'AI研发工程师', background: 'x', tone: '理性' },
  interests: { primary: ['LLM'], secondary: ['RAG'], seed_keywords: ['vLLM'] },
};

const note: NoteData = { noteId: 'n1', title: 'RAG 工程实战', content: '正文内容', likeCount: 10, collectCount: 5 };

function makeComposer(
  complete: (p: string) => string | Promise<string>,
  platformProfile?: CommentPlatformProfile,
  soulOverride?: Soul,
) {
  let lastPrompt = '';
  const composer = new CommentComposer({
    eventBus: new EventBus(),
    soul: soulOverride ?? (platformProfile?.platform === 'facebook' ? { ...soul, writing_language: 'en' } : soul),
    getNoteData: () => note,
    ...(platformProfile ? { platformProfile } : {}),
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
    assert.match(getPrompt(), /最多 50 字/);
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

describe('CommentComposer 平台词汇与语言规则（change platform-vocabulary-and-thresholds 1.2/2.2）', () => {
  const fbNote: NoteData = { noteId: 'p1', title: '', content: '', likeCount: 300, collectCount: 0 };

  it('小红书 profile（缺省）：prompt 用「笔记」、无语言规则、上限 50 字（逐字节零回归）', async () => {
    const { composer, getPrompt } = makeComposer(() => '{"text":"学到了"}');
    await composer.composeDraft(note);
    const p = getPrompt();
    assert.match(p, /为下面这篇你认可的笔记写/);
    assert.match(p, /当前笔记：/);
    assert.match(p, /最多 50 字/);
    assert.doesNotMatch(p, /帖子/);
    assert.doesNotMatch(p, /当地语言/);
  });

  it('Facebook profile：prompt 用「帖子」、带账号发言语言规则、上限 500 字', async () => {
    const { composer, getPrompt } = makeComposer(() => '{"text":"nice one"}', FB_COMMENT_PROFILE);
    await composer.composeDraft({ ...fbNote, content: 'a real english post body' });
    const p = getPrompt();
    assert.match(p, /为下面这篇你认可的帖子写/);
    assert.match(p, /当前帖子：/);
    assert.match(p, /最多 500 字/);
    assert.match(p, /最终公开正文必须只使用英文自然表达/);
    assert.match(p, /不得先用其它语言成稿后再翻译/);
  });

  it('Facebook 空正文帖：诚实说明无文字正文 + 禁臆造画面，不渲染空标题行', async () => {
    const { composer, getPrompt } = makeComposer(() => '{"decline":"nothing_genuine"}', FB_COMMENT_PROFILE);
    await composer.composeDraft(fbNote, { onPageComments: ['great post', 'love this'] });
    const p = getPrompt();
    assert.match(p, /没有文字正文/);
    assert.match(p, /别臆造里面有什么/);
    assert.doesNotMatch(p, /标题：\n/); // 空标题不渲染成 "标题：" 空行
  });

  it('note.comments 自动进 prompt（FB 由 note.detail 带回，无需显式传 onPageComments）', async () => {
    const { composer, getPrompt } = makeComposer(() => '{"text":"agreed"}', FB_COMMENT_PROFILE);
    await composer.composeDraft({ ...fbNote, content: '', comments: ['this helped me', 'same here'] });
    const p = getPrompt();
    assert.match(p, /这条帖子现有的评论/);
    assert.match(p, /this helped me/);
  });

  it('显式 onPageComments 覆盖 note.comments（命令路径优先）', async () => {
    const { composer, getPrompt } = makeComposer(() => '{"text":"sounds good"}', FB_COMMENT_PROFILE);
    await composer.composeDraft(
      { ...fbNote, content: 'body', comments: ['from-note'] },
      { onPageComments: ['explicit-arg'] },
    );
    const p = getPrompt();
    assert.match(p, /explicit-arg/);
    assert.doesNotMatch(p, /from-note/);
  });

  it('Facebook 缺少账号发言语言时 fail closed，不调用模型', async () => {
    let calls = 0;
    const { composer } = makeComposer(() => { calls++; return '{"text":"nice post"}'; }, FB_COMMENT_PROFILE, soul);
    assert.equal(await composer.composeDraft({ ...fbNote, content: 'english body' }), null);
    assert.equal(calls, 0);
  });

  it('越南语账号遇到英文首稿会补写一次，只接受越南语终稿', async () => {
    let calls = 0;
    const vietnameseSoul: Soul = { ...soul, writing_language: 'vi' };
    const { composer, getPrompt } = makeComposer(
      () => ++calls === 1 ? '{"text":"nice post"}' : '{"text":"Cảm ơn bạn, bài viết rất hữu ích"}',
      FB_COMMENT_PROFILE,
      vietnameseSoul,
    );
    assert.equal(await composer.composeDraft({ ...fbNote, content: 'english body' }), 'Cảm ơn bạn, bài viết rất hữu ích');
    assert.equal(calls, 2);
    assert.match(getPrompt(), /上一次没有满足发言语言要求/);
  });

  it('中文 Facebook 账号直接接受自然中文评论', async () => {
    const chineseSoul: Soul = { ...soul, writing_language: 'zh-CN' };
    const { composer, getPrompt } = makeComposer(
      () => '{"text":"这个方法很实用，我也准备试试看"}',
      FB_COMMENT_PROFILE,
      chineseSoul,
    );
    assert.equal(await composer.composeDraft({ ...fbNote, content: 'English source context' }), '这个方法很实用，我也准备试试看');
    assert.match(getPrompt(), /只使用简体中文自然表达/);
  });
});
