/**
 * 发评论支线单测：CommentAppraiser → CommentComposer → CommentDeAiFlavor → CommentApprovalGate。
 * 每角色脱 LLM / 脱风控可单测；重点守红线：审批未接线 → 绝不裸发（comment.skipped:approval_unwired）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { CommentAppraiser } from '../../src/agents/comment-appraiser.js';
import { CommentComposer } from '../../src/agents/comment-composer.js';
import { CommentDeAiFlavor } from '../../src/agents/comment-de-ai-flavor.js';
import { CommentApprovalGate, type CommentApprovalPort } from '../../src/agents/comment-approval-gate.js';
import type { NoteData } from '../../src/agents/content-curator-role.js';
import type { Soul } from '../../src/soul/types.js';

const soul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程'], seed_keywords: ['GPT'] },
};
// likeCount > 1000 且 collectCount > 300：过 engagement-restraint 的评论硬数值门槛，使本组测试仍走 LLM 判定路径。
const note: NoteData = { noteId: 'n1', title: '高热度精品', content: '真有干货', author: 'guru', likeCount: 1200, collectCount: 400 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const trigger = { noteId: 'n1', sourcePageType: 'feed' as const, actions: ['like'] as ('like' | 'collect')[], ts: 0 };

describe('CommentAppraiser', () => {
  it('comment:true → comment.appraised（带 actions）', async () => {
    const bus = new EventBus();
    const role = new CommentAppraiser({ eventBus: bus, soul, llm: { complete: async () => '{"comment":true,"reason":"精品"}' }, getNoteData: () => note, getRemainingComments: () => 2 });
    role.subscribe();
    let appraised: any = null;
    bus.on('comment.appraised', (p) => { appraised = p; });
    bus.emit('interaction.completed', { ...trigger, ts: Date.now() });
    await sleep(30);
    assert.ok(appraised);
    assert.deepEqual(appraised.actions, ['like']);
  });

  it('comment:false → comment.skipped', async () => {
    const bus = new EventBus();
    const role = new CommentAppraiser({ eventBus: bus, soul, llm: { complete: async () => '{"comment":false,"reason":"无可说"}' }, getNoteData: () => note, getRemainingComments: () => 2 });
    role.subscribe();
    let skipped: any = null;
    bus.on('comment.skipped', (p) => { skipped = p; });
    bus.emit('interaction.completed', { ...trigger, ts: Date.now() });
    await sleep(30);
    assert.ok(skipped);
  });

  it('会话预算耗尽 → comment.skipped(no_comment_budget)，不调 LLM', async () => {
    const bus = new EventBus();
    let llmCalled = false;
    const role = new CommentAppraiser({ eventBus: bus, soul, llm: { complete: async () => { llmCalled = true; return '{}'; } }, getNoteData: () => note, getRemainingComments: () => 0 });
    role.subscribe();
    let skipped: any = null;
    bus.on('comment.skipped', (p) => { skipped = p; });
    bus.emit('interaction.completed', { ...trigger, ts: Date.now() });
    await sleep(30);
    assert.equal(skipped?.reason, 'no_comment_budget');
    assert.equal(llmCalled, false);
  });

  it('每日上限耗尽 → comment.skipped(daily_cap_reached)', async () => {
    const bus = new EventBus();
    const role = new CommentAppraiser({ eventBus: bus, soul, llm: { complete: async () => '{"comment":true}' }, getNoteData: () => note, getRemainingComments: () => 2, getDailyRemaining: () => 0 });
    role.subscribe();
    let skipped: any = null;
    bus.on('comment.skipped', (p) => { skipped = p; });
    bus.emit('interaction.completed', { ...trigger, ts: Date.now() });
    await sleep(30);
    assert.equal(skipped?.reason, 'daily_cap_reached');
  });
});

describe('CommentComposer', () => {
  it('产出文本 → comment.composed', async () => {
    const bus = new EventBus();
    const role = new CommentComposer({ eventBus: bus, soul, llm: { complete: async () => '{"text":"学到了，感谢分享"}' }, getNoteData: () => note });
    role.subscribe();
    let composed: any = null;
    bus.on('comment.composed', (p) => { composed = p; });
    bus.emit('comment.appraised', { ...trigger, ts: Date.now() });
    await sleep(30);
    assert.equal(composed?.draft, '学到了，感谢分享');
  });

  it('裸 @ 被剥除', async () => {
    const bus = new EventBus();
    const role = new CommentComposer({ eventBus: bus, soul, llm: { complete: async () => '{"text":"@某人 学到了"}' }, getNoteData: () => note });
    role.subscribe();
    let composed: any = null;
    bus.on('comment.composed', (p) => { composed = p; });
    bus.emit('comment.appraised', { ...trigger, ts: Date.now() });
    await sleep(30);
    assert.ok(composed && !composed.draft.includes('@'));
  });

  it('空文本 → comment.skipped(compose_empty)', async () => {
    const bus = new EventBus();
    const role = new CommentComposer({ eventBus: bus, soul, llm: { complete: async () => '{"text":""}' }, getNoteData: () => note });
    role.subscribe();
    let skipped: any = null;
    bus.on('comment.skipped', (p) => { skipped = p; });
    bus.emit('comment.appraised', { ...trigger, ts: Date.now() });
    await sleep(30);
    assert.equal(skipped?.reason, 'compose_empty');
  });
});

describe('CommentDeAiFlavor（脱 LLM 也可跑）', () => {
  it('透传 → comment.cleared', async () => {
    const bus = new EventBus();
    const role = new CommentDeAiFlavor({ eventBus: bus, soul });
    role.subscribe();
    let cleared: any = null;
    bus.on('comment.cleared', (p) => { cleared = p; });
    bus.emit('comment.composed', { ...trigger, draft: '学到了', ts: Date.now() });
    await sleep(30);
    assert.equal(cleared?.text, '学到了');
  });
});

describe('CommentApprovalGate', () => {
  it('红线：审批未接线 → comment.skipped(approval_unwired)，绝不裸发', async () => {
    const bus = new EventBus();
    const role = new CommentApprovalGate({ eventBus: bus, soul });
    role.subscribe();
    let skipped: any = null;
    let approved = false;
    bus.on('comment.skipped', (p) => { skipped = p; });
    bus.on('comment.approved', () => { approved = true; });
    bus.emit('comment.cleared', { ...trigger, text: '学到了', ts: Date.now() });
    await sleep(30);
    assert.equal(skipped?.reason, 'approval_unwired');
    assert.equal(approved, false);
  });

  it('授权通过 → comment.approved（携文本）+ 审批卡携账号与笔记标题（供人识别）', async () => {
    const bus = new EventBus();
    let card: any = null;
    const approval: CommentApprovalPort = { request: async (i) => { card = i; }, isApproved: async () => true, timeoutMs: 1000, pollMs: 1 };
    let t = 0;
    const role = new CommentApprovalGate({
      eventBus: bus,
      soul,
      approval,
      getAccountId: () => 'acc-01',
      getAccountName: () => 'Tmax',
      getNoteTitle: (id) => (id === 'n1' ? note.title : null),
      now: () => t++,
      sleep: async () => {},
    });
    role.subscribe();
    let out: any = null;
    bus.on('comment.approved', (p) => { out = p; });
    bus.emit('comment.cleared', { ...trigger, text: '学到了', ts: Date.now() });
    await sleep(30);
    assert.equal(out?.text, '学到了');
    assert.ok(card && card.text === '学到了' && String(card.requestId).startsWith('comment-'));
    assert.equal(card.title, note.title, '标题应由 getNoteTitle 解析后透传给审批卡');
    assert.equal(card.accountId, 'acc-01');
    assert.equal(card.accountName, 'Tmax');
  });

  it('超时 → comment.skipped(approval_timeout)，不发', async () => {
    const bus = new EventBus();
    const approval: CommentApprovalPort = { request: async () => {}, isApproved: async () => false, timeoutMs: 0, pollMs: 1 };
    let t = 0;
    const role = new CommentApprovalGate({ eventBus: bus, soul, approval, now: () => t++, sleep: async () => {} });
    role.subscribe();
    let skipped: any = null;
    let approved = false;
    bus.on('comment.skipped', (p) => { skipped = p; });
    bus.on('comment.approved', () => { approved = true; });
    bus.emit('comment.cleared', { ...trigger, text: '学到了', ts: Date.now() });
    await sleep(30);
    assert.equal(skipped?.reason, 'approval_timeout');
    assert.equal(approved, false);
  });
});
