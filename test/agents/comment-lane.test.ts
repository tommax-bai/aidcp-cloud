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
import {
  DEFAULT_COMMENT_LLM_TIMEOUT_MS,
  DEFAULT_COMMENT_SUBLINE_TIMEOUT_MS,
  RoleDispatcher,
} from '../../src/orchestrator/role-dispatcher.js';
import type { NoteData } from '../../src/agents/content-curator-role.js';
import type { LlmCallOpts } from '../../src/llm/qwen.js';
import type { Soul } from '../../src/soul/types.js';

const soul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程'], seed_keywords: ['GPT'] },
};
// likeCount > 1000 且 collectCount > 300：过 engagement-restraint 的评论硬数值门槛，使本组测试仍走 LLM 判定路径。
const note: NoteData = { noteId: 'n1', title: '高热度精品', content: '真有干货', author: 'guru', likeCount: 1200, collectCount: 400 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const trigger = { noteId: 'n1', sourcePageType: 'feed' as const, actions: ['like'] as ('like' | 'collect')[], ts: 0 };
const mandatoryInteraction = {
  ruleId: 'vietnam-recruitment',
  actions: ['like', 'comment'] as ('like' | 'comment')[],
  commentGuidance: 'Bình luận bằng tiếng Việt và hỏi về lương.',
  commentApproval: 'auto_approve' as const,
};

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

  it('mandatory 风控预检拒绝 → 不调 LLM、不进入撰写，微任务后诚实 skip', async () => {
    const bus = new EventBus();
    let llmCalled = false;
    const role = new CommentAppraiser({
      eventBus: bus,
      soul,
      llm: { complete: async () => { llmCalled = true; return '{"comment":true}'; } },
      getNoteData: () => note,
      getRemainingComments: () => 0,
      getMandatoryRiskDecision: () => ({ allowed: false, reason: 'quota:minute', retryAfterMs: 20_000 }),
    });
    role.subscribe();
    let appraised: any = null;
    const skipped: any[] = [];
    bus.on('comment.appraised', (p) => { appraised = p; });
    bus.on('comment.skipped', (p) => { skipped.push(p); });
    bus.emit('interaction.completed', { ...trigger, mandatoryInteraction, ts: Date.now() });
    assert.equal(skipped.length, 0, 'skip 应排到微任务，给同级 mandatory like 留出先下发顺序');
    await Promise.resolve();
    assert.equal(skipped[0]?.reason, 'risk_preflight:quota:minute');
    assert.equal(appraised, null);
    assert.equal(llmCalled, false);
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

  it('可选语料查询永不 settle → 到短超时后按空参考继续撰写', async () => {
    const bus = new EventBus();
    let llmCalled = false;
    const role = new CommentComposer({
      eventBus: bus,
      soul,
      llm: { complete: async () => {
        llmCalled = true;
        return '{"text":"这个方法我也想试试"}';
      } },
      getNoteData: () => note,
      getCorpusReferences: async () => new Promise<never>(() => {}),
      corpusLookupTimeoutMs: 5,
    });
    role.subscribe();
    let composed: any = null;
    bus.on('comment.composed', (p) => { composed = p; });
    bus.emit('comment.appraised', { ...trigger, ts: Date.now() });
    await sleep(30);
    assert.equal(llmCalled, true, '语料查询只是增强项，超时后仍应调用撰写模型');
    assert.equal(composed?.draft, '这个方法我也想试试');
    assert.equal(composed?.references, undefined, '超时按空参考继续，不伪造引用');
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

  it('mandatory 首次弃权 → 按规则指引补写一次并透传上下文', async () => {
    const bus = new EventBus();
    const prompts: string[] = [];
    const role = new CommentComposer({
      eventBus: bus,
      soul,
      llm: { complete: async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1 ? '{"decline":"nothing_genuine"}' : '{"text":"Cho mình hỏi ca làm và mức lương thế nào ạ?"}';
      } },
      getNoteData: () => note,
    });
    role.subscribe();
    let composed: any = null;
    bus.on('comment.composed', (p) => { composed = p; });
    bus.emit('comment.appraised', { ...trigger, mandatoryInteraction, ts: Date.now() });
    await sleep(40);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /Bình luận bằng tiếng Việt/);
    assert.match(prompts[1], /唯一一次补写/);
    assert.equal(composed?.mandatoryInteraction?.ruleId, 'vietnam-recruitment');
    assert.match(composed?.draft ?? '', /ca làm/);
  });

  it('mandatory 两次都弃权 → 诚实 skip，不造模板', async () => {
    const bus = new EventBus();
    let calls = 0;
    const role = new CommentComposer({
      eventBus: bus,
      soul,
      llm: { complete: async () => { calls++; return '{"decline":"nothing_genuine"}'; } },
      getNoteData: () => note,
    });
    role.subscribe();
    let skipped: any = null;
    bus.on('comment.skipped', (p) => { skipped = p; });
    bus.emit('comment.appraised', { ...trigger, mandatoryInteraction, ts: Date.now() });
    await sleep(40);
    assert.equal(calls, 2);
    assert.equal(skipped?.reason, 'nothing_genuine');
    assert.equal(skipped?.mandatoryInteraction?.ruleId, 'vietnam-recruitment');
  });

  it('mandatory 撰写遇 transport/deadline 失败 → 不自动重试同一模型调用', async () => {
    const bus = new EventBus();
    let calls = 0;
    const role = new CommentComposer({
      eventBus: bus,
      soul,
      llm: { complete: async () => { calls++; throw new Error('LLM timeout'); } },
      getNoteData: () => note,
    });
    role.subscribe();
    let skipped: any = null;
    bus.on('comment.skipped', (p) => { skipped = p; });
    bus.emit('comment.appraised', { ...trigger, mandatoryInteraction, ts: Date.now() });
    await sleep(30);
    assert.equal(calls, 1, 'transport/deadline 失败不得走内容补写重试');
    assert.equal(skipped?.reason, 'llm_error');
  });
});

describe('评论角色独立 LLM deadline', () => {
  it('生产默认：单次模型 30s、整条评论支线 5min', () => {
    assert.equal(DEFAULT_COMMENT_LLM_TIMEOUT_MS, 30_000);
    assert.equal(DEFAULT_COMMENT_SUBLINE_TIMEOUT_MS, 5 * 60_000);
  });

  it('RoleDispatcher 只给 appraiser/composer/de-ai 三个评论模型调用注入同一短 deadline', async () => {
    const calls: Array<{ role?: string; timeoutMs?: number }> = [];
    const llm = {
      complete: async (_prompt: string, opts?: LlmCallOpts): Promise<string> => {
        calls.push({ role: opts?.role, timeoutMs: opts?.timeoutMs });
        if (opts?.role === 'browse:comment_appraiser') return '{"comment":true,"reason":"值得说"}';
        if (opts?.role === 'browse:comment_composer') return '{"text":"感谢分享"}';
        if (opts?.role === 'browse:comment_de_ai_flavor') return '这个角度挺有意思';
        return '{}';
      },
    };
    const dispatcher = new RoleDispatcher({
      soul,
      llm,
      commentLlmTimeoutMs: 37,
      sendCommand: () => {},
    });
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.updateNoteData(note);
    dispatcher.bus.emit('interaction.completed', { ...trigger, ts: Date.now() });
    await sleep(60);

    for (const role of ['browse:comment_appraiser', 'browse:comment_composer', 'browse:comment_de_ai_flavor']) {
      const call = calls.find((item) => item.role === role);
      assert.ok(call, `${role} 应实际调用模型`);
      assert.equal(call.timeoutMs, 37, `${role} 应使用评论专用 per-call deadline`);
    }
    for (const call of calls.filter((item) => !item.role?.startsWith('browse:comment_'))) {
      assert.equal(call.timeoutMs, undefined, `${call.role} 不应继承评论专用 deadline`);
    }
    dispatcher.endSession();
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

  it('授权通过 → comment.approved（携文本）+ 审批卡携账号、笔记标题与用户昵称（供人识别）', async () => {
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
      getNoteAuthor: (id) => (id === 'n1' ? note.author ?? null : null),
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
    assert.equal(card.authorName, note.author, '用户昵称应由 getNoteAuthor 解析后透传给审批卡');
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

  it('mandatory auto_approve → 先通知成功再 approved，不调用逐条审批', async () => {
    const bus = new EventBus();
    let notice: any = null;
    let reviewCalled = false;
    const role = new CommentApprovalGate({
      eventBus: bus,
      soul,
      approval: { request: async () => { reviewCalled = true; }, isApproved: async () => false },
      autoApproveNotify: async (input) => { notice = input; },
      getAccountId: () => 'acc-fb',
      getAccountName: () => 'Tianxing Bai',
      getNoteTitle: () => note.title,
      now: () => 123,
    });
    role.subscribe();
    let approved: any = null;
    bus.on('comment.approved', (p) => { approved = p; });
    bus.emit('comment.cleared', { ...trigger, text: 'Cho mình hỏi còn tuyển không ạ?', mandatoryInteraction, ts: Date.now() });
    await sleep(30);
    assert.equal(reviewCalled, false);
    assert.equal(notice?.text, 'Cho mình hỏi còn tuyển không ạ?');
    assert.equal(notice?.accountName, 'Tianxing Bai');
    assert.equal(approved?.mandatoryInteraction?.ruleId, 'vietnam-recruitment');
    assert.equal(approved?.approvalTrace?.requestId, notice?.requestId);
    assert.equal(approved?.approvalTrace?.accountId, 'acc-fb');
    assert.equal(approved?.approvalTrace?.accountName, 'Tianxing Bai');
    assert.equal(approved?.approvalTrace?.title, note.title);
  });

  it('mandatory auto_approve 通知失败 → fail-closed，不 approved', async () => {
    const bus = new EventBus();
    const role = new CommentApprovalGate({
      eventBus: bus,
      soul,
      autoApproveNotify: async () => { throw new Error('chat unavailable'); },
    });
    role.subscribe();
    let skipped: any = null;
    let approved = false;
    bus.on('comment.skipped', (p) => { skipped = p; });
    bus.on('comment.approved', () => { approved = true; });
    bus.emit('comment.cleared', { ...trigger, text: 'Còn tuyển không ạ?', mandatoryInteraction, ts: Date.now() });
    await sleep(30);
    assert.equal(skipped?.reason, 'auto_approve_notice_failed');
    assert.equal(approved, false);
  });

  it('账号 auto_approve_all 覆盖普通浏览评论：通知后授权，不调用按钮审批', async () => {
    const bus = new EventBus();
    let notice: any = null;
    let reviewCalled = false;
    const role = new CommentApprovalGate({
      eventBus: bus,
      soul,
      approval: { request: async () => { reviewCalled = true; }, isApproved: async () => false },
      resolveApprovalMode: async (_accountId, sourceMode) => {
        assert.equal(sourceMode, 'review');
        return 'auto_approve';
      },
      autoApproveNotify: async (input) => { notice = input; },
      getAccountId: () => 'acc-global',
      now: () => 456,
    });
    role.subscribe();
    let approved: any = null;
    bus.on('comment.approved', (payload) => { approved = payload; });
    bus.emit('comment.cleared', { ...trigger, text: '普通评论终稿', ts: Date.now() });
    await sleep(30);
    assert.equal(reviewCalled, false);
    assert.equal(notice?.approvalSource, 'account_global');
    assert.equal(approved?.text, '普通评论终稿');
    assert.equal(approved?.approvalTrace?.accountId, 'acc-global');
  });

  it('账号策略解析异常回落来源 review，不扩大权限', async () => {
    const bus = new EventBus();
    let reviewCalled = false;
    const role = new CommentApprovalGate({
      eventBus: bus,
      soul,
      approval: { request: async () => { reviewCalled = true; }, isApproved: async () => true, pollMs: 1 },
      resolveApprovalMode: async () => { throw new Error('pg down'); },
      getAccountId: () => 'acc-safe',
      now: () => 10,
      sleep: async () => {},
    });
    role.subscribe();
    let approved = false;
    bus.on('comment.approved', () => { approved = true; });
    bus.emit('comment.cleared', { ...trigger, text: '仍需审批', ts: Date.now() });
    await sleep(30);
    assert.equal(reviewCalled, true);
    assert.equal(approved, true);
  });
});
