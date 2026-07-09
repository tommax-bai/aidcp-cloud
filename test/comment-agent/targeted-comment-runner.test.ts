/**
 * runTargetedCommentTask 单测（change curated-note-actions：定向评论控制流）。
 * 覆盖：首搜命中即走到底、二搜用放宽词、有界用尽 note_not_found、非目标卡绝不评、
 * 详情 noteId 不一致不评（read_failed）、撰写空/发布失败诚实失败、记账只在发布成功后。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTargetedCommentTask } from '../../src/comment-agent/comment-task-runner.js';
import type { NoteForComment, TargetedCommentSteps } from '../../src/comment-agent/comment-task-runner.js';
import type { CommentCandidateCard } from '../../src/agents/comment-target-picker.js';

const silent = { log: () => {}, warn: () => {} };

const card = (index: number, noteId: string): CommentCandidateCard => ({
  index,
  noteId,
  title: `标题${index}`,
  collectCount: 100,
});

interface StubConfig {
  /** 每次搜索返回的候选（按调用次序；不够则复用最后一组）。 */
  harvests: CommentCandidateCard[][];
  /** readNote 返回的详情 noteId（缺省=卡片 noteId）；null=读失败。 */
  detailNoteId?: string | null;
  composeText?: string | null;
  contactInfo?: string | null;
  postOk?: boolean;
}

function makeSteps(cfg: StubConfig) {
  const calls = { searchTerms: [] as string[], read: 0, readCurrent: 0, compose: 0, post: [] as string[], record: [] as string[] };
  let i = 0;
  const steps: TargetedCommentSteps = {
    searchAndHarvest: async (term) => {
      calls.searchTerms.push(term);
      const h = cfg.harvests[Math.min(i, cfg.harvests.length - 1)];
      i++;
      return h;
    },
    readNote: async (c) => {
      calls.read++;
      if (cfg.detailNoteId === null) return null;
      return {
        note: { noteId: cfg.detailNoteId ?? c.noteId!, title: c.title ?? '', content: '正文' },
        comments: [],
      };
    },
    readCurrentNote: async (note) => {
      calls.readCurrent++;
      if (cfg.detailNoteId === null) return null;
      return {
        note: { ...note, noteId: cfg.detailNoteId ?? note.noteId },
        comments: [{ text: '当前评论' }],
      };
    },
    composeAndApprove: async () => {
      calls.compose++;
      if (cfg.composeText === null) return null;
      return { text: cfg.composeText ?? '真诚评论', contactInfo: cfg.contactInfo ?? null };
    },
    post: async (noteId) => {
      calls.post.push(noteId);
      return cfg.postOk ?? true;
    },
    recordCommented: async (noteId) => {
      calls.record.push(noteId);
    },
  };
  return { steps, calls };
}

const currentNote = (noteId = 'target-1'): NoteForComment => ({
  noteId,
  title: '当前笔记标题',
  content: '当前正文',
  likeCount: 3000,
  collectCount: 500,
});

test('首搜命中目标 noteId → 读/撰写/发布/记账走到底，outcome=commented', async () => {
  const { steps, calls } = makeSteps({ harvests: [[card(0, 'other'), card(1, 'target-1')]] });
  const r = await runTargetedCommentTask(
    steps,
    { noteId: 'target-1', searchTerm: '全标题搜索词', fallbackTerm: '放宽词' },
    { logger: silent },
  );
  assert.equal(r.outcome, 'commented');
  assert.equal(r.searchAttempts, 1);
  assert.deepEqual(calls.searchTerms, ['全标题搜索词']);
  assert.deepEqual(calls.post, ['target-1']); // 评的是目标，不是同页其它卡
  assert.deepEqual(calls.record, ['target-1']); // 记账在发布成功后
});

test('首搜未中、二搜用放宽词命中 → commented，searchAttempts=2', async () => {
  const { steps, calls } = makeSteps({ harvests: [[card(0, 'other')], [card(0, 'target-1')]] });
  const r = await runTargetedCommentTask(
    steps,
    { noteId: 'target-1', searchTerm: '全标题', fallbackTerm: '放宽' },
    { logger: silent },
  );
  assert.equal(r.outcome, 'commented');
  assert.equal(r.searchAttempts, 2);
  assert.deepEqual(calls.searchTerms, ['全标题', '放宽']); // 第二次换放宽词
});

test('两次搜索均无目标 → note_not_found，绝不读/评任何「相似」卡片', async () => {
  const { steps, calls } = makeSteps({ harvests: [[card(0, 'a'), card(1, 'b')]] });
  const r = await runTargetedCommentTask(steps, { noteId: 'target-1', searchTerm: 't' }, { logger: silent });
  assert.equal(r.outcome, 'note_not_found');
  assert.equal(r.searchAttempts, 2); // 有界默认 2 次
  assert.equal(calls.read, 0);
  assert.equal(calls.compose, 0);
  assert.deepEqual(calls.post, []);
  assert.deepEqual(calls.record, []);
});

test('当前笔记上下文存在 → 跳过标题搜索，直接采当前评论并发布', async () => {
  const { steps, calls } = makeSteps({ harvests: [[card(0, 'other')]] });
  const r = await runTargetedCommentTask(
    steps,
    { noteId: 'target-1', title: '目标标题', currentNote: currentNote(), searchTerm: '不应搜索', fallbackTerm: '也不应搜索' },
    { logger: silent },
  );
  assert.equal(r.outcome, 'commented');
  assert.equal(r.searchAttempts, 0);
  assert.deepEqual(calls.searchTerms, []);
  assert.equal(calls.read, 0);
  assert.equal(calls.readCurrent, 1);
  assert.deepEqual(calls.post, ['target-1']);
  assert.deepEqual(calls.record, ['target-1']);
});

test('当前笔记上下文 noteId 错配 → read_failed，绝不退回标题搜索', async () => {
  const { steps, calls } = makeSteps({ harvests: [[card(0, 'target-1')]] });
  const r = await runTargetedCommentTask(
    steps,
    { noteId: 'target-1', title: '目标标题', currentNote: currentNote('other-note'), searchTerm: '不应搜索' },
    { logger: silent },
  );
  assert.equal(r.outcome, 'read_failed');
  assert.equal(r.searchAttempts, 0);
  assert.match(r.reason ?? '', /current_detail_mismatch/);
  assert.deepEqual(calls.searchTerms, []);
  assert.equal(calls.read, 0);
  assert.equal(calls.readCurrent, 0);
  assert.deepEqual(calls.post, []);
});

test('fallbackTerm 缺省 → 第二次沿用原搜索词重发', async () => {
  const { steps, calls } = makeSteps({ harvests: [[]] });
  await runTargetedCommentTask(steps, { noteId: 'n', searchTerm: '同词' }, { logger: silent });
  assert.deepEqual(calls.searchTerms, ['同词', '同词']);
});

test('命中后开笔记失败 → read_failed（诚实失败，不重搜不换目标）', async () => {
  const { steps, calls } = makeSteps({ harvests: [[card(0, 'target-1')]], detailNoteId: null });
  const r = await runTargetedCommentTask(steps, { noteId: 'target-1', searchTerm: 't' }, { logger: silent });
  assert.equal(r.outcome, 'read_failed');
  assert.equal(calls.compose, 0);
  assert.deepEqual(calls.record, []);
});

test('详情上报 noteId 与目标不一致 → read_failed，绝不评错帖', async () => {
  const { steps, calls } = makeSteps({ harvests: [[card(0, 'target-1')]], detailNoteId: 'someone-else' });
  const r = await runTargetedCommentTask(steps, { noteId: 'target-1', searchTerm: 't' }, { logger: silent });
  assert.equal(r.outcome, 'read_failed');
  assert.match(r.reason ?? '', /detail_note_mismatch/);
  assert.equal(calls.compose, 0);
  assert.deepEqual(calls.post, []);
});

test('撰写为空/未授权 → compose_skipped，不发布', async () => {
  const { steps, calls } = makeSteps({ harvests: [[card(0, 'target-1')]], composeText: null });
  const r = await runTargetedCommentTask(steps, { noteId: 'target-1', searchTerm: 't' }, { logger: silent });
  assert.equal(r.outcome, 'compose_skipped');
  assert.deepEqual(calls.post, []);
});

test('发布未真成功 → post_failed，不记账', async () => {
  const { steps, calls } = makeSteps({ harvests: [[card(0, 'target-1')]], postOk: false });
  const r = await runTargetedCommentTask(steps, { noteId: 'target-1', searchTerm: 't' }, { logger: silent });
  assert.equal(r.outcome, 'post_failed');
  assert.deepEqual(calls.record, []); // 记账只挂真实回执
});

test('带联系方式：合并终稿含联系方式（text\\n联系方式），post 收到正文与联系方式分离', async () => {
  const { steps, calls } = makeSteps({ harvests: [[card(0, 'target-1')]], composeText: '正文', contactInfo: 'CODE123' });
  const r = await runTargetedCommentTask(steps, { noteId: 'target-1', searchTerm: 't' }, { logger: silent });
  assert.equal(r.outcome, 'commented');
  assert.equal(r.text, '正文\nCODE123');
  assert.deepEqual(calls.post, ['target-1']);
});
