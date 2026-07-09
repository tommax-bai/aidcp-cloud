/**
 * CommentTaskRunner 单测（change comment-search-command，task 3.2 核心控制流）。
 * 覆盖：无词诚实结束、首中即止、去重在择优前、换词重试、词用尽诚实结束、尝试上限 K、
 * 命中后读/撰写/发布失败=诚实失败（不偷换另一篇）、记账只在发布成功后。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCommentTask } from '../../src/comment-agent/comment-task-runner.js';
import type { CommentTaskSteps } from '../../src/comment-agent/comment-task-runner.js';
import type { CommentCandidateCard, PickResult } from '../../src/agents/comment-target-picker.js';

const silent = { log: () => {}, warn: () => {} };

const card = (index: number, noteId = `n${index}`, collectCount = 100): CommentCandidateCard => ({
  index,
  noteId,
  title: `标题${index}`,
  collectCount,
});

interface StubConfig {
  terms?: string[];
  // 每个搜索词返回的候选（按调用次序）
  harvests?: CommentCandidateCard[][];
  // filterUncommented：默认原样返回；可覆盖
  filter?: (cards: CommentCandidateCard[]) => CommentCandidateCard[];
  // 每次 pick 的结果（按调用次序）
  picks?: PickResult[];
  readNull?: boolean;
  composeText?: string | null;
  postOk?: boolean;
}

function makeSteps(cfg: StubConfig) {
  const calls = {
    generateTerms: 0,
    searchTerms: [] as string[],
    filter: 0,
    pick: 0,
    read: 0,
    compose: 0,
    post: 0,
    record: [] as string[],
  };
  let harvestI = 0;
  let pickI = 0;
  const steps: CommentTaskSteps = {
    generateTerms: async () => {
      calls.generateTerms++;
      return cfg.terms ?? ['t1', 't2', 't3'];
    },
    searchAndHarvest: async (term) => {
      calls.searchTerms.push(term);
      const h = cfg.harvests?.[harvestI] ?? [card(0)];
      harvestI++;
      return h;
    },
    filterUncommented: async (cards) => {
      calls.filter++;
      return cfg.filter ? cfg.filter(cards) : cards;
    },
    pick: async () => {
      calls.pick++;
      const p = cfg.picks?.[pickI] ?? { pickIndex: null, stronglyRelevantIndexes: [], reason: 'none' };
      pickI++;
      return p;
    },
    readNote: async (c) => {
      calls.read++;
      if (cfg.readNull) return null;
      return { note: { noteId: c.noteId!, title: c.title, content: '正文' }, comments: [{ text: '现场评论' }] };
    },
    composeAndApprove: async () => {
      calls.compose++;
      // change account-group-chat-injection：返回 {text, contactInfo} | null（null/'' 模拟跳过/未授权）。
      if (cfg.composeText === undefined) return { text: '一条评论', contactInfo: null };
      return cfg.composeText ? { text: cfg.composeText, contactInfo: null } : null;
    },
    post: async () => {
      calls.post++;
      return cfg.postOk ?? true;
    },
    recordCommented: async (noteId) => {
      calls.record.push(noteId);
    },
  };
  return { steps, calls };
}

describe('runCommentTask 有界换词重试', () => {
  it('无搜索词 → no_terms（诚实结束）', async () => {
    const { steps, calls } = makeSteps({ terms: [] });
    const r = await runCommentTask(steps, { logger: silent });
    assert.equal(r.outcome, 'no_terms');
    assert.equal(calls.pick, 0);
  });

  it('首个词强相关命中 → commented，且不再尝试余下词（首中即止）', async () => {
    const { steps, calls } = makeSteps({
      harvests: [[card(0), card(1)]],
      picks: [{ pickIndex: 0, stronglyRelevantIndexes: [0], reason: 'ok' }],
    });
    const r = await runCommentTask(steps, { logger: silent });
    assert.equal(r.outcome, 'commented');
    assert.equal(r.noteId, 'n0');
    assert.equal(r.termsTried, 1, '命中即止，只试 1 个词');
    assert.deepEqual(calls.searchTerms, ['t1']);
    assert.deepEqual(calls.record, ['n0'], '发布成功后记一笔');
  });

  it('去重在择优之前：当前词全被去重 → 不调 pick、换下一个词', async () => {
    const { steps, calls } = makeSteps({
      terms: ['t1', 't2'],
      harvests: [[card(0)], [card(1)]],
      filter: (cards) => (cards[0]?.index === 0 ? [] : cards), // t1 全去重，t2 保留
      picks: [{ pickIndex: 1, stronglyRelevantIndexes: [1], reason: 'ok' }],
    });
    const r = await runCommentTask(steps, { logger: silent });
    assert.equal(r.outcome, 'commented');
    assert.equal(r.termsTried, 2);
    assert.equal(calls.pick, 1, 't1 被全去重→未进 pick；只 t2 调一次 pick');
    assert.deepEqual(calls.searchTerms, ['t1', 't2']);
  });

  it('当前词无强相关 → 换下一个词', async () => {
    const { steps } = makeSteps({
      terms: ['t1', 't2'],
      harvests: [[card(0)], [card(1)]],
      picks: [
        { pickIndex: null, stronglyRelevantIndexes: [], reason: 'no_strong' },
        { pickIndex: 1, stronglyRelevantIndexes: [1], reason: 'ok' },
      ],
    });
    const r = await runCommentTask(steps, { logger: silent });
    assert.equal(r.outcome, 'commented');
    assert.equal(r.noteId, 'n1');
    assert.equal(r.termsTried, 2);
  });

  it('所有词试完仍无强相关 → no_strong_candidate（诚实结束）', async () => {
    const { steps, calls } = makeSteps({
      terms: ['t1', 't2', 't3'],
      picks: [
        { pickIndex: null, stronglyRelevantIndexes: [], reason: 'x' },
        { pickIndex: null, stronglyRelevantIndexes: [], reason: 'x' },
        { pickIndex: null, stronglyRelevantIndexes: [], reason: 'x' },
      ],
    });
    const r = await runCommentTask(steps, { logger: silent });
    assert.equal(r.outcome, 'no_strong_candidate');
    assert.equal(r.termsTried, 3);
    assert.equal(calls.post, 0);
    assert.deepEqual(calls.record, []);
  });

  it('尝试上限 K：maxTerms=2，5 个词都不命中 → 只试 2 个', async () => {
    const { steps, calls } = makeSteps({
      terms: ['t1', 't2', 't3', 't4', 't5'],
      picks: Array(5).fill({ pickIndex: null, stronglyRelevantIndexes: [], reason: 'x' }),
    });
    const r = await runCommentTask(steps, { maxTerms: 2, logger: silent });
    assert.equal(r.outcome, 'no_strong_candidate');
    assert.equal(r.termsTried, 2);
    assert.equal(calls.searchTerms.length, 2);
  });

  it('命中后开笔记失败 → read_failed（不偷换另一篇）', async () => {
    const { steps, calls } = makeSteps({
      picks: [{ pickIndex: 0, stronglyRelevantIndexes: [0], reason: 'ok' }],
      readNull: true,
    });
    const r = await runCommentTask(steps, { logger: silent });
    assert.equal(r.outcome, 'read_failed');
    assert.equal(r.termsTried, 1, '命中即止：不试余下词');
    assert.equal(calls.compose, 0);
    assert.deepEqual(calls.record, []);
  });

  it('命中后撰写为空/未授权 → compose_skipped（终态、不记账）', async () => {
    const { steps, calls } = makeSteps({
      picks: [{ pickIndex: 0, stronglyRelevantIndexes: [0], reason: 'ok' }],
      composeText: null,
    });
    const r = await runCommentTask(steps, { logger: silent });
    assert.equal(r.outcome, 'compose_skipped');
    assert.equal(calls.post, 0);
    assert.deepEqual(calls.record, []);
  });

  it('命中后发布未真成功 → post_failed（不记账）', async () => {
    const { steps, calls } = makeSteps({
      picks: [{ pickIndex: 0, stronglyRelevantIndexes: [0], reason: 'ok' }],
      postOk: false,
    });
    const r = await runCommentTask(steps, { logger: silent });
    assert.equal(r.outcome, 'post_failed');
    assert.deepEqual(calls.record, [], '未真发布不记账');
  });

  it('pickIndex 指向不存在的卡片 → 换词', async () => {
    const { steps } = makeSteps({
      terms: ['t1', 't2'],
      harvests: [[card(0)], [card(1)]],
      picks: [
        { pickIndex: 9, stronglyRelevantIndexes: [9], reason: 'bad' }, // 9 不在候选
        { pickIndex: 1, stronglyRelevantIndexes: [1], reason: 'ok' },
      ],
    });
    const r = await runCommentTask(steps, { logger: silent });
    assert.equal(r.outcome, 'commented');
    assert.equal(r.noteId, 'n1');
  });
});
