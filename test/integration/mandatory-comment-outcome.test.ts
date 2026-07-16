import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoleDispatcher,
  type EdgeCommand,
  type MandatoryCommentOutcomeNoticeInput,
  type ViewQuotaDecision,
} from '../../src/orchestrator/role-dispatcher.js';
import type { CommentDonePayload, MandatoryInteractionContext } from '../../src/event-bus/types.js';
import type { Soul } from '../../src/soul/types.js';

const soul: Soul = {
  identity: { name: 'Tianxing Bai', role: 'người tìm việc', background: 'Tìm việc tại Việt Nam', tone: 'thân thiện' },
  interests: { primary: ['tuyển dụng'], secondary: [], seed_keywords: ['cần tuyển'] },
};
const mandatoryInteraction: MandatoryInteractionContext = {
  ruleId: 'vietnam-recruitment',
  actions: ['like', 'comment'],
  commentApproval: 'auto_approve',
};

function makeDispatcher(options: {
  risk?: ViewQuotaDecision;
  timeoutMs?: number;
  accountPlatform?: 'facebook' | 'xiaohongshu';
  hasInlineTargeting?: boolean;
} = {}) {
  const commands: EdgeCommand[] = [];
  const outcomes: MandatoryCommentOutcomeNoticeInput[] = [];
  const dispatcher = new RoleDispatcher({
    soul,
    llm: { complete: async () => '{"verdict":"skip","reason":"unused"}' },
    sendCommand: (command) => { commands.push(command); },
    canInteract: () => true,
    explainInteract: () => options.risk ?? { allowed: true },
    notifyMandatoryCommentOutcome: (input) => { outcomes.push(input); },
    mandatoryCommentOutcomeTimeoutMs: options.timeoutMs ?? 5_000,
    ...(options.accountPlatform ? { accountPlatform: options.accountPlatform } : {}),
    ...(options.hasInlineTargeting === undefined ? {} : { hasInlineTargeting: () => options.hasInlineTargeting! }),
  });
  dispatcher.setCurrentAccountId('acc-fb');
  dispatcher.setup();
  dispatcher.startSession();
  return { dispatcher, commands, outcomes };
}

function approve(dispatcher: RoleDispatcher, requestId = 'comment-note-1-123'): void {
  dispatcher.bus.emit('comment.approved', {
    noteId: 'note-1',
    sourcePageType: 'feed',
    actions: ['like'],
    text: 'Cho mình hỏi còn tuyển không ạ?',
    mandatoryInteraction,
    approvalTrace: {
      requestId,
      accountId: 'acc-fb',
      accountName: 'Tianxing Bai',
      title: 'Tuyển dụng tại Hà Nam',
      authorName: 'Việc Làm Hà Nam',
    },
    ts: Date.now(),
  });
}

describe('mandatory auto_approve comment terminal outcomes', () => {
  it('边缘 ok:true 才发 confirmed，且同 requestId 最多一张终态卡', () => {
    const { dispatcher, commands, outcomes } = makeDispatcher();
    approve(dispatcher);
    assert.equal(commands.filter((c) => c.action === 'comment').length, 1);
    dispatcher.bus.emit('action.completed', { action: 'comment', ok: true, ts: Date.now() });
    dispatcher.bus.emit('action.completed', { action: 'comment', ok: true, ts: Date.now() });
    assert.deepEqual(outcomes.map((o) => o.outcome), ['confirmed']);
    assert.equal(outcomes[0]?.requestId, 'comment-note-1-123');
    dispatcher.endSession('test');
  });

  it('群管理员审批态为 pending，不染绿 comment.done', () => {
    const { dispatcher, outcomes } = makeDispatcher();
    const done: CommentDonePayload[] = [];
    dispatcher.bus.on('comment.done', (payload) => { done.push(payload); });
    approve(dispatcher);
    dispatcher.bus.emit('action.completed', {
      action: 'comment',
      ok: true,
      reason: 'pending_group_approval',
      ts: Date.now(),
    });
    assert.deepEqual(outcomes.map((o) => o.outcome), ['pending']);
    assert.equal(done[0]?.ok, false);
    assert.equal(done[0]?.reason, 'pending_group_approval');
    dispatcher.endSession('test');
  });

  it('预授权后最终风控拒绝 → 不下发评论并回 failed 的精确原因', () => {
    const { dispatcher, commands, outcomes } = makeDispatcher({ risk: { allowed: false, reason: 'quota:minute' } });
    approve(dispatcher);
    assert.equal(commands.some((c) => c.action === 'comment'), false);
    assert.deepEqual(outcomes.map((o) => [o.outcome, o.reason]), [['failed', 'risk:quota:minute']]);
    dispatcher.endSession('test');
  });

  it('迁移落地失败 → fail-closed，评论不下发并回 failed', () => {
    const { dispatcher, commands, outcomes } = makeDispatcher({ accountPlatform: 'facebook', hasInlineTargeting: true });
    approve(dispatcher);
    assert.equal(commands.filter((c) => c.action === 'open_note').length, 1);
    assert.equal(commands.some((c) => c.action === 'comment'), false);
    dispatcher.bus.emit('action.completed', {
      action: 'open_note',
      ok: false,
      reason: 'nav_failed',
      ts: Date.now(),
    });
    assert.deepEqual(outcomes.map((o) => [o.outcome, o.reason]), [['failed', 'nav_failed']]);
    assert.equal(commands.some((c) => c.action === 'comment'), false);
    dispatcher.endSession('test');
  });

  it('断连/会话结束时待回执评论回 unknown，不冒充失败或成功', () => {
    const { dispatcher, outcomes } = makeDispatcher();
    approve(dispatcher);
    dispatcher.endSession('disconnect');
    assert.deepEqual(outcomes.map((o) => [o.outcome, o.reason]), [['unknown', 'session_ended:disconnect']]);
  });

  it('平台回执超过有界等待时间 → unknown + comment.done(receipt_timeout)', async () => {
    const { dispatcher, outcomes } = makeDispatcher({ timeoutMs: 5 });
    const done: CommentDonePayload[] = [];
    dispatcher.bus.on('comment.done', (payload) => { done.push(payload); });
    approve(dispatcher);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(outcomes.map((o) => [o.outcome, o.reason]), [['unknown', 'receipt_timeout']]);
    assert.equal(done[0]?.ok, false);
    assert.equal(done[0]?.reason, 'receipt_timeout');
    dispatcher.endSession('test');
  });
});
