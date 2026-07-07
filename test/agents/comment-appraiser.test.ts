/**
 * CommentAppraiser 评论硬数值阈值 + 评论冷却早判单测（change engagement-restraint）。
 * 阈值（change humanize-interaction-prompts 起默认地板 300/100）：点赞 > 300 且（收藏 > 100 或 点赞 > 10000，严格大于）才达门槛。
 * 冷却：未到点在评估阶段即跳过、不调 LLM。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { CommentAppraiser } from '../../src/agents/comment-appraiser.js';
import type { NoteData } from '../../src/agents/content-curator-role.js';
import type { Soul } from '../../src/soul/types.js';

const soul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程'], seed_keywords: ['GPT'] },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const trigger = { noteId: 'n1', sourcePageType: 'feed' as const, actions: ['like'] as ('like' | 'collect')[], ts: 0 };
const mkNote = (likeCount: number, collectCount: number): NoteData => ({ noteId: 'n1', title: 't', content: 'c', author: 'a', likeCount, collectCount });

/** 跑一次评估，返回 {appraised, skipped, llmCalled}。 */
async function run(note: NoteData, opts: { cooldownOk?: boolean } = {}) {
  const bus = new EventBus();
  let llmCalled = false;
  const role = new CommentAppraiser({
    eventBus: bus,
    soul,
    llm: { complete: async () => { llmCalled = true; return '{"comment":true,"reason":"精品"}'; } },
    getNoteData: () => note,
    getRemainingComments: () => 2,
    ...(opts.cooldownOk === undefined ? {} : { getCommentCooldownOk: () => opts.cooldownOk! }),
  });
  role.subscribe();
  let appraised: any = null;
  let skipped: any = null;
  bus.on('comment.appraised', (p) => { appraised = p; });
  bus.on('comment.skipped', (p) => { skipped = p; });
  bus.emit('interaction.completed', { ...trigger, ts: Date.now() });
  await sleep(30);
  return { appraised, skipped, llmCalled };
}

describe('CommentAppraiser 硬数值阈值（>300 赞 且 (>100 藏 或 >10000 赞)，严格大于）', () => {
  it('301/101 达标 → 进入 LLM 判定 → comment.appraised', async () => {
    const r = await run(mkNote(301, 101));
    assert.ok(r.appraised, '应达标并被 LLM 判为要评');
    assert.equal(r.skipped, null);
    assert.equal(r.llmCalled, true);
  });

  it('中腰部高收藏（500/150，旧 1000 门槛下会被排除）→ 达标进入 LLM', async () => {
    const r = await run(mkNote(500, 150));
    assert.ok(r.appraised, '新默认地板应纳入中腰部高收藏内容');
    assert.equal(r.llmCalled, true);
  });

  it('300/101 边界（赞恰好等于 300）→ below_comment_threshold，不调 LLM', async () => {
    const r = await run(mkNote(300, 101));
    assert.equal(r.skipped?.reason, 'below_comment_threshold');
    assert.equal(r.appraised, null);
    assert.equal(r.llmCalled, false);
  });

  it('301/100 边界（收藏恰好等于 100）→ below_comment_threshold', async () => {
    const r = await run(mkNote(301, 100));
    assert.equal(r.skipped?.reason, 'below_comment_threshold');
    assert.equal(r.llmCalled, false);
  });

  it('300/100 双边界 → below_comment_threshold', async () => {
    const r = await run(mkNote(300, 100));
    assert.equal(r.skipped?.reason, 'below_comment_threshold');
  });

  it('高赞但低收藏（5000/50）→ below_comment_threshold（未过超高热豁免、收藏不足）', async () => {
    const r = await run(mkNote(5000, 50));
    assert.equal(r.skipped?.reason, 'below_comment_threshold');
  });

  it('超高热爆帖豁免收藏（10001/50）→ 达标进入 LLM', async () => {
    const r = await run(mkNote(10001, 50));
    assert.ok(r.appraised, '赞 > 10000 应豁免收藏绝对值');
    assert.equal(r.llmCalled, true);
  });
});

describe('CommentAppraiser 评论冷却早判', () => {
  it('冷却未到点 → comment.skipped(cooldown)，在调 LLM 与取阈值之前即跳过', async () => {
    const r = await run(mkNote(5000, 1000), { cooldownOk: false });
    assert.equal(r.skipped?.reason, 'cooldown');
    assert.equal(r.appraised, null);
    assert.equal(r.llmCalled, false);
  });

  it('冷却已过 + 达数值阈值 → 正常进入 LLM 判定', async () => {
    const r = await run(mkNote(5000, 1000), { cooldownOk: true });
    assert.ok(r.appraised);
    assert.equal(r.llmCalled, true);
  });
});
