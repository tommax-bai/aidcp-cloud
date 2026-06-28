/**
 * CuratedCommentEvaluator 单测（change curated-admission-eval-roles，Phase 3）。
 * 覆盖：确认点赞恒过预筛 → 评估准入则 archiveComment；评估拒绝/降级/解析失败不落；账号取连接上下文；仅共鸣回退。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { CuratedCommentEvaluator } from '../../src/agents/curated-comment-evaluator.js';
import type { NoteData } from '../../src/agents/content-curator-role.js';
import type { Soul } from '../../src/soul/types.js';

const soul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程'], seed_keywords: ['GPT'] },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ArchiveCall {
  accountId: string;
  input: { sourceId: string; text: string; author?: string; topics: string[]; sourceNoteTitle?: string; reason?: string; likeCount?: number | null };
}

interface RunOpts {
  llmRaw?: string;
  llmThrows?: boolean;
  llmEvalEnabled?: boolean;
  accountId?: string;
  note?: NoteData | null;
}

const confirmed = (over: Partial<{ noteId: string; commentAnchorId: string; author?: string; text: string; reason: string; likeCount?: number }> = {}) => ({
  noteId: 'n1',
  commentAnchorId: 'c-1',
  author: '评论者',
  text: '这条评论角度很新，有信息量',
  reason: 'picked',
  likeCount: 12,
  ts: Date.now(),
  ...over,
});

async function run(payload: ReturnType<typeof confirmed>, opts: RunOpts = {}) {
  const bus = new EventBus();
  let llmCalled = false;
  const archives: ArchiveCall[] = [];
  const role = new CuratedCommentEvaluator({
    eventBus: bus,
    soul,
    llm: {
      complete: async () => {
        llmCalled = true;
        if (opts.llmThrows) throw new Error('llm down');
        return opts.llmRaw ?? '{"admit":true,"relevanceOk":true,"exemplarValueOk":true,"isSpamOrPromo":false,"reason":"有借鉴价值"}';
      },
    },
    curatedStore: { archiveComment: async (accountId, input) => { archives.push({ accountId, input }); } },
    getNoteData: () => (opts.note === undefined ? { noteId: 'n1', title: '来源笔记标题', content: 'c', likeCount: 0, collectCount: 0 } : opts.note),
    getAccountId: () => opts.accountId ?? 'acc-1',
    ...(opts.llmEvalEnabled === undefined ? {} : { llmEvalEnabled: opts.llmEvalEnabled }),
  });
  role.subscribe();
  bus.emit('comment_like.confirmed', payload);
  await sleep(30);
  return { llmCalled, archives };
}

describe('CuratedCommentEvaluator 评论准入', () => {
  it('确认点赞恒过预筛 + 评估准入 → archiveComment（带来源标题/赞数/账号）', async () => {
    const r = await run(confirmed());
    assert.equal(r.llmCalled, true);
    assert.equal(r.archives.length, 1);
    assert.equal(r.archives[0].accountId, 'acc-1');
    assert.equal(r.archives[0].input.sourceId, 'c-1');
    assert.equal(r.archives[0].input.sourceNoteTitle, '来源笔记标题');
    assert.equal(r.archives[0].input.likeCount, 12);
    assert.equal(r.archives[0].input.reason, 'llm_eval');
  });

  it('评估判水评/广告 → 不落', async () => {
    const r = await run(confirmed(), {
      llmRaw: '{"admit":false,"relevanceOk":true,"exemplarValueOk":false,"isSpamOrPromo":true,"reason":"水评"}',
    });
    assert.equal(r.llmCalled, true);
    assert.equal(r.archives.length, 0);
  });

  it('诚实红线：LLM 降级 → 不落、不抛', async () => {
    const r = await run(confirmed(), { llmThrows: true });
    assert.equal(r.archives.length, 0);
  });

  it('诚实红线：解析失败 → 不落', async () => {
    const r = await run(confirmed(), { llmRaw: '非JSON' });
    assert.equal(r.archives.length, 0);
  });

  it('开关关(llmEvalEnabled=false)：确认点赞 → 直接归档、不调 LLM', async () => {
    const r = await run(confirmed(), { llmEvalEnabled: false });
    assert.equal(r.llmCalled, false);
    assert.equal(r.archives.length, 1);
    assert.equal(r.archives[0].input.reason, 'picked'); // 回退时用原点赞原因
  });

  it('honest-fail：账号未绑定占位 → 不落、不调 LLM', async () => {
    const r = await run(confirmed(), { accountId: '__unbound__' });
    assert.equal(r.llmCalled, false);
    assert.equal(r.archives.length, 0);
  });

  it('来源笔记不可得 → 仍归档（sourceNoteTitle 诚实置空）', async () => {
    const r = await run(confirmed(), { note: null });
    assert.equal(r.archives.length, 1);
    assert.equal(r.archives[0].input.sourceNoteTitle, undefined);
  });
});
