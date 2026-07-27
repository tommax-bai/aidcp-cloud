import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/kernel/soul-types.js';
import type { FacebookRuleActionState } from '../../src/kernel/facebook-rule-mode-types.js';

const soul: Soul = {
  identity: { name: 'Rule Account', role: 'operator', background: 'test', tone: 'neutral' },
  interests: { primary: ['persona-only-topic'], secondary: [], seed_keywords: [] },
};

const batch = {
  batchId: '00000000-0000-4000-8000-000000000001',
  sequence: 1,
  triggerContentKey: 'post-10',
  likeState: 'pending' as FacebookRuleActionState,
  joinState: 'pending' as FacebookRuleActionState,
  commentState: 'pending' as FacebookRuleActionState,
  terminal: false,
  blocker: null,
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
};

const waitForAsyncChain = () => new Promise((resolve) => setTimeout(resolve, 35));

describe('RoleDispatcher facebook rule mode', () => {
  it('selects by feed order without persona LLM evaluation and binds the like to the tenth content', async () => {
    const commands: EdgeCommand[] = [];
    const patches: Array<Record<string, unknown>> = [];
    const joinCalls: Array<{ accountId: string; batchId: string }> = [];
    let llmCalls = 0;
    const dispatcher = new RoleDispatcher({
      soul,
      llm: {
        complete: async () => {
          llmCalls += 1;
          return '{"verdict":"skip","reason":"persona mismatch"}';
        },
      },
      sendCommand: (command) => { commands.push(command); },
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => ({ mode: 'facebook_rule', blocker: null }),
      applyFacebookRuleView: async () => ({ kind: 'batch_created', batch }),
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
      explainInteract: () => ({ allowed: true }),
      explainRuleJoin: () => ({ allowed: true }),
      triggerFacebookRuleJoinContact: async (accountId, batchId) => {
        joinCalls.push({ accountId, batchId });
        return {
          started: true,
          onTerminal: Promise.resolve({
            joinState: 'confirmed',
            commentState: 'confirmed',
          }),
        };
      },
    });
    dispatcher.setCurrentAccountId('fb-1');
    dispatcher.setup();
    dispatcher.startSession();

    dispatcher.bus.emit('page.cards.arrived', {
      cards: [
        { index: 2, noteId: 'https://www.facebook.com/posts/post-2', title: 'second', likeCount: 0, collectCount: 0 },
        { index: 1, noteId: 'https://www.facebook.com/posts/post-10', title: 'first', likeCount: 0, collectCount: 0 },
      ],
      listKind: 'feed',
      ts: Date.now(),
    });
    await waitForAsyncChain();
    const open = commands.find((command) => command.action === 'open_note');
    assert.equal(open?.params?.noteId, 'https://www.facebook.com/posts/post-10');
    assert.equal(llmCalls, 0, '规则选卡不得调用 Persona/Soul LLM');

    dispatcher.bus.emit('note.detail.arrived', {
      detail: {
        noteId: 'https://www.facebook.com/posts/post-10',
        title: 'first',
        content: 'safe body',
        likeCount: 0,
        collectCount: 0,
      },
      accountId: 'fb-1',
      ts: Date.now(),
    });
    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-1',
      noteId: 'https://www.facebook.com/posts/post-10',
      sourceDedupeKey: 'receipt-10',
      source: 'detail',
      occurredAt: Date.now(),
    });
    await waitForAsyncChain();

    const like = commands.find((command) => command.action === 'like');
    assert.equal(like?.params?.noteId, 'https://www.facebook.com/posts/post-10');
    assert.equal(like?.reason, 'facebook_rule_batch_like');
    assert.equal(joinCalls.length, 0, '点赞未终态前不得启动加群联系');

    dispatcher.bus.emit('action.completed', { action: 'like', ok: true, ts: Date.now() });
    await waitForAsyncChain();

    assert.deepEqual(joinCalls, [{ accountId: 'fb-1', batchId: batch.batchId }]);
    assert.ok(patches.some((patch) => patch.likeState === 'confirmed'));
    assert.ok(patches.some((patch) =>
      patch.joinState === 'confirmed'
      && patch.commentState === 'confirmed'
      && patch.terminal === true,
    ));
    assert.equal(llmCalls, 0);
    dispatcher.endSession();
  });

  it('lets slow start take over before dispatch and terminalizes undispatched actions', async () => {
    const commands: EdgeCommand[] = [];
    const patches: Array<Record<string, unknown>> = [];
    let mode: 'facebook_rule' | 'slow_start' = 'facebook_rule';
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: (command) => { commands.push(command); },
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => mode === 'facebook_rule'
        ? { mode: 'facebook_rule', blocker: null }
        : { mode: 'slow_start', blocker: 'slow_start_active' },
      applyFacebookRuleView: async () => {
        mode = 'slow_start';
        return { kind: 'batch_created', batch };
      },
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
    });
    dispatcher.setCurrentAccountId('fb-1');
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-1',
      noteId: 'https://www.facebook.com/posts/post-10',
      sourceDedupeKey: 'receipt-10',
      source: 'detail',
      occurredAt: Date.now(),
    });
    await waitForAsyncChain();

    assert.equal(commands.some((command) => command.action === 'like'), false);
    assert.ok(patches.some((patch) =>
      patch.likeState === 'not_started'
      && patch.joinState === 'not_started'
      && patch.commentState === 'not_started'
      && patch.terminal === true
      && patch.blocker === 'slow_start_active',
    ));
    dispatcher.endSession();
  });

  it('records risk-suppressed like without debt and still independently attempts join-contact once', async () => {
    const commands: EdgeCommand[] = [];
    const patches: Array<Record<string, unknown>> = [];
    let joinCalls = 0;
    let likeAllowed = false;
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: (command) => { commands.push(command); },
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => ({ mode: 'facebook_rule', blocker: null }),
      applyFacebookRuleView: async () => ({ kind: 'batch_created', batch }),
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
      explainInteract: () => likeAllowed
        ? { allowed: true }
        : { allowed: false, reason: 'daily_like_quota' },
      explainRuleJoin: () => ({ allowed: true }),
      triggerFacebookRuleJoinContact: async () => {
        joinCalls += 1;
        return {
          started: true,
          onTerminal: Promise.resolve({
            joinState: 'already_satisfied',
            commentState: 'submitted_unknown',
            blocker: 'verification_ambiguous',
          }),
        };
      },
    });
    dispatcher.setCurrentAccountId('fb-1');
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-1',
      noteId: 'https://www.facebook.com/posts/post-10',
      sourceDedupeKey: 'receipt-10',
      source: 'detail',
      occurredAt: Date.now(),
    });
    await waitForAsyncChain();

    assert.equal(commands.some((command) => command.action === 'like'), false);
    assert.equal(joinCalls, 1);
    assert.ok(patches.some((patch) =>
      patch.likeState === 'risk_suppressed' && patch.blocker === 'daily_like_quota',
    ));
    assert.ok(patches.some((patch) =>
      patch.joinState === 'already_satisfied'
      && patch.commentState === 'submitted_unknown'
      && patch.terminal === true,
    ));

    likeAllowed = true;
    await waitForAsyncChain();
    assert.equal(commands.some((command) => command.action === 'like'), false, '额度恢复不得补发历史点赞');
    assert.equal(joinCalls, 1, '终态批次不得重放历史加群联系');
    dispatcher.endSession();
  });

  it('persists already-liked, submitted-unknown, and structural no-target receipts distinctly', async () => {
    const cases: Array<{ reason: string; expected: FacebookRuleActionState }> = [
      { reason: 'already_liked', expected: 'already_satisfied' },
      { reason: 'verification_ambiguous', expected: 'submitted_unknown' },
      { reason: 'no_target', expected: 'structural_skip' },
    ];
    for (const [index, testCase] of cases.entries()) {
      const commands: EdgeCommand[] = [];
      const patches: Array<Record<string, unknown>> = [];
      const dispatcher = new RoleDispatcher({
        soul,
        llm: { complete: async () => '{"verdict":"skip"}' },
        sendCommand: (command) => { commands.push(command); },
        accountPlatform: 'facebook',
        facebookRuleModeDecision: () => ({ mode: 'facebook_rule', blocker: null }),
        applyFacebookRuleView: async () => ({
          kind: 'batch_created',
          batch: { ...batch, batchId: `00000000-0000-4000-8000-00000000001${index}` },
        }),
        updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
        explainInteract: () => ({ allowed: true }),
        explainRuleJoin: () => ({ allowed: false, reason: 'join_test_stop' }),
      });
      dispatcher.setCurrentAccountId('fb-1');
      dispatcher.setup();
      dispatcher.startSession();
      dispatcher.bus.emit('facebook.rule.view.confirmed', {
        accountId: 'fb-1',
        noteId: `https://www.facebook.com/posts/post-${index}`,
        sourceDedupeKey: `receipt-${index}`,
        source: 'detail',
        occurredAt: Date.now(),
      });
      await waitForAsyncChain();
      assert.equal(commands.some((command) => command.action === 'like'), true);
      dispatcher.bus.emit('action.completed', {
        action: 'like',
        ok: false,
        reason: testCase.reason,
        ts: Date.now(),
      });
      await waitForAsyncChain();
      assert.ok(
        patches.some((patch) => patch.likeState === testCase.expected),
        `${testCase.reason} should persist ${testCase.expected}`,
      );
      dispatcher.endSession();
    }
  });

  it('reconciles an in-flight like as ambiguous at a session/reconnect boundary without replay', async () => {
    const commands: EdgeCommand[] = [];
    const patches: Array<Record<string, unknown>> = [];
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: (command) => { commands.push(command); },
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => ({ mode: 'facebook_rule', blocker: null }),
      applyFacebookRuleView: async () => ({ kind: 'batch_created', batch }),
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
      explainInteract: () => ({ allowed: true }),
    });
    dispatcher.setCurrentAccountId('fb-1');
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-1',
      noteId: 'https://www.facebook.com/posts/post-10',
      sourceDedupeKey: 'receipt-10',
      source: 'detail',
      occurredAt: Date.now(),
    });
    await waitForAsyncChain();
    assert.equal(commands.some((command) => command.action === 'like'), true);

    dispatcher.endSession('edge_disconnected');
    await waitForAsyncChain();
    assert.ok(patches.some((patch) =>
      patch.likeState === 'ambiguous'
      && patch.joinState === 'not_started'
      && patch.commentState === 'not_started'
      && patch.terminal === true
      && patch.blocker === 'session_ended:edge_disconnected',
    ));

    dispatcher.bus.emit('action.completed', { action: 'like', ok: true, ts: Date.now() });
    await waitForAsyncChain();
    assert.equal(
      patches.filter((patch) => patch.likeState === 'confirmed').length,
      0,
      'session boundary released the in-memory intent; late receipt must not replay or overwrite ambiguity',
    );
  });
});
