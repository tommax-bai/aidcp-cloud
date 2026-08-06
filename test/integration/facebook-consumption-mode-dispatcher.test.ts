import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '@automation/orchestrator/role-dispatcher.js';
import type {
  FacebookConsumptionActionReceiptInput,
  FacebookConsumptionActionView,
} from '@automation/orchestrator/facebook-consumption-mode-types.js';
import type { Soul } from '@kernel/kernel/soul-types.js';
import { InteractionGuard } from '@automation/risk/interaction-guard.js';

const soul: Soul = {
  identity: { name: 'Consumption Account', role: 'operator', background: 'test', tone: 'neutral' },
  interests: { primary: [], secondary: [], seed_keywords: [] },
};

const waitForAsyncChain = () => new Promise((resolve) => setTimeout(resolve, 35));
const targetUrl = 'https://www.facebook.com/posts/post-5';

function likeAction(overrides: Partial<FacebookConsumptionActionView> = {}): FacebookConsumptionActionView {
  return {
    actionId: '00000000-0000-4000-8000-000000000101',
    accountId: 'fb-consumption-1',
    executionTarget: 'dev',
    policyRevision: 9,
    policySnapshot: {
      viewsPerLike: 5,
      confirmedLikesPerJoin: 2,
      confirmedJoinsPerComment: 2,
    },
    sequence: 1,
    actionType: 'like',
    idempotencyKey: 'consume-like-1',
    triggerSourceDedupeKey: 'view-5',
    state: 'ready',
    dispatchPhase: 'not_started',
    outcome: null,
    blocker: null,
    downstreamEnabled: true,
    target: {
      groupKey: null,
      groupUrl: null,
      contentKey: 'post-5',
      contentUrl: targetUrl,
      selection: null,
      evidence: null,
    },
    ownerId: null,
    ownerExpiresAt: null,
    version: 1,
    dispatchedAt: null,
    settledAt: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

function joinAction(): FacebookConsumptionActionView {
  return likeAction({
    actionId: '00000000-0000-4000-8000-000000000102',
    actionType: 'join',
    sequence: 2,
    state: 'waiting_target',
    target: {
      groupKey: null,
      groupUrl: null,
      contentKey: null,
      contentUrl: null,
      selection: null,
      evidence: null,
    },
    blocker: 'waiting_join_target',
  });
}

function makeDispatcher(input: {
  receipts: FacebookConsumptionActionReceiptInput[];
  commands: EdgeCommand[];
  triggerCalls: FacebookConsumptionActionView[];
  supersedeCalls?: Array<{ accountId: string; policyRevision: number; mode: string }>;
  interactionGuard?: InteractionGuard;
  settle?: (
    receipt: FacebookConsumptionActionReceiptInput,
  ) => Promise<
    | { kind: 'pending'; action: FacebookConsumptionActionView }
    | { kind: 'settled'; action: FacebookConsumptionActionView; nextAction: FacebookConsumptionActionView | null }
  >;
}): RoleDispatcher {
  const created = likeAction();
  return new RoleDispatcher({
    soul,
    llm: { complete: async () => '{"verdict":"skip"}' },
    sendCommand: (command) => { input.commands.push(command); },
    accountPlatform: 'facebook',
    facebookRuleModeDecision: () => ({
      mode: 'consumption',
      blocker: null,
      policyRevision: 9,
      consumptionPolicy: created.policySnapshot,
    }),
    applyFacebookConsumptionView: async () => ({ kind: 'action_created', action: created }),
    claimFacebookConsumptionAction: async () => ({
      kind: 'claimed',
      action: likeAction({
        ownerId: 'role-owner',
        ownerExpiresAt: '2026-07-30T00:01:00.000Z',
        version: 2,
      }),
    }),
    markFacebookConsumptionActionDispatched: async () => ({
      kind: 'updated',
      action: likeAction({
        state: 'dispatched',
        dispatchPhase: 'dispatched',
        ownerId: 'role-owner',
        ownerExpiresAt: '2026-07-30T00:01:00.000Z',
        version: 3,
        dispatchedAt: '2026-07-30T00:00:01.000Z',
      }),
    }),
    settleFacebookConsumptionAction: async (receipt) => {
      input.receipts.push(receipt);
      if (input.settle) return input.settle(receipt);
      return {
        kind: 'settled',
        action: likeAction({
          state: 'terminal',
          dispatchPhase: 'settled',
          outcome: receipt.outcome,
        }),
        nextAction: null,
      };
    },
    triggerFacebookConsumptionAction: async (action) => {
      input.triggerCalls.push(action);
    },
    supersedeFacebookOperationRuntime: async (call) => {
      input.supersedeCalls?.push(call);
    },
    explainInteract: () => ({ allowed: true }),
    interactionGuard: input.interactionGuard,
  });
}

function emitConfirmedView(dispatcher: RoleDispatcher): void {
  dispatcher.bus.emit('facebook.rule.view.confirmed', {
    accountId: 'fb-consumption-1',
    noteId: targetUrl,
    sourceDedupeKey: 'view-5',
    source: 'detail',
    occurredAt: Date.now(),
  });
}

describe('RoleDispatcher facebook consumption mode', () => {
  it('dispatches the exact trigger target and does not count already_liked as a new like', async () => {
    const commands: EdgeCommand[] = [];
    const receipts: FacebookConsumptionActionReceiptInput[] = [];
    const triggerCalls: FacebookConsumptionActionView[] = [];
    const supersedeCalls: Array<{ accountId: string; policyRevision: number; mode: string }> = [];
    const dispatcher = makeDispatcher({ commands, receipts, triggerCalls, supersedeCalls });
    dispatcher.setCurrentAccountId('fb-consumption-1');
    dispatcher.setup();
    dispatcher.startSession();

    emitConfirmedView(dispatcher);
    await waitForAsyncChain();
    const like = commands.find((command) => command.action === 'like');
    assert.equal(like?.params?.noteId, targetUrl);
    assert.equal(like?.reason, 'facebook_consumption_like');

    dispatcher.bus.emit('action.completed', {
      action: 'like',
      ok: true,
      reason: 'already_liked',
      noteId: targetUrl,
      ts: Date.now(),
    });
    await waitForAsyncChain();

    assert.equal(receipts.at(-1)?.outcome, 'already_liked');
    assert.equal(triggerCalls.length, 0, 'already_liked must not create the join obligation');
    assert.deepEqual(supersedeCalls, [{
      accountId: 'fb-consumption-1',
      policyRevision: 9,
      mode: 'consumption',
    }]);
    dispatcher.endSession();
  });

  it('keeps pending in-flight and upgrades the same receipt key on a confirmed terminal result', async () => {
    const commands: EdgeCommand[] = [];
    const receipts: FacebookConsumptionActionReceiptInput[] = [];
    const triggerCalls: FacebookConsumptionActionView[] = [];
    const downstream = joinAction();
    const interactionGuard = new InteractionGuard();
    let settles = 0;
    const dispatcher = makeDispatcher({
      commands,
      receipts,
      triggerCalls,
      interactionGuard,
      settle: async (receipt) => {
        settles += 1;
        if (receipt.outcome === 'pending') {
          return {
            kind: 'pending',
            action: likeAction({
              state: 'dispatched',
              dispatchPhase: 'dispatched',
              outcome: 'pending',
            }),
          };
        }
        return {
          kind: 'settled',
          action: likeAction({
            state: 'terminal',
            dispatchPhase: 'settled',
            outcome: receipt.outcome,
          }),
          nextAction: downstream,
        };
      },
    });
    dispatcher.setCurrentAccountId('fb-consumption-1');
    dispatcher.setup();
    dispatcher.startSession();
    emitConfirmedView(dispatcher);
    await waitForAsyncChain();

    dispatcher.bus.emit('action.completed', {
      action: 'like',
      ok: false,
      reason: 'pending',
      noteId: targetUrl,
      ts: Date.now(),
    });
    await waitForAsyncChain();
    assert.equal(triggerCalls.length, 0);
    assert.deepEqual(
      interactionGuard.stats(),
      { inFlight: 1, completed: 0 },
      'pending keeps the duplicate-prevention claim in flight',
    );

    dispatcher.bus.emit('action.completed', {
      action: 'like',
      ok: true,
      noteId: targetUrl,
      ts: Date.now(),
    });
    await waitForAsyncChain();

    assert.equal(settles, 2);
    assert.deepEqual(receipts.map((receipt) => receipt.outcome), ['pending', 'confirmed_new_like']);
    assert.equal(receipts[0]?.sourceDedupeKey, receipts[1]?.sourceDedupeKey);
    assert.deepEqual(triggerCalls.map((action) => action.actionType), ['join']);
    assert.deepEqual(interactionGuard.stats(), { inFlight: 0, completed: 1 });
    dispatcher.endSession();
  });

  it('settles an ok receipt without same-target proof as ambiguous and does not advance', async () => {
    const commands: EdgeCommand[] = [];
    const receipts: FacebookConsumptionActionReceiptInput[] = [];
    const triggerCalls: FacebookConsumptionActionView[] = [];
    const dispatcher = makeDispatcher({ commands, receipts, triggerCalls });
    dispatcher.setCurrentAccountId('fb-consumption-1');
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.bus.emit('note.detail.arrived', {
      detail: {
        noteId: targetUrl,
        title: 'target',
        content: 'safe body',
        likeCount: 0,
        collectCount: 0,
      },
      accountId: 'fb-consumption-1',
      ts: Date.now(),
    });
    emitConfirmedView(dispatcher);
    await waitForAsyncChain();

    // A fresh Edge echo has priority over matching current-detail fallback.
    dispatcher.bus.emit('action.completed', {
      action: 'like',
      ok: true,
      noteId: 'https://www.facebook.com/posts/different-post',
      ts: Date.now(),
    });
    await waitForAsyncChain();

    assert.equal(receipts.at(-1)?.outcome, 'ambiguous');
    assert.equal(triggerCalls.length, 0);
    dispatcher.endSession();
  });

  it('uses the existing current-detail correlation when a real detail like receipt omits noteId', async () => {
    const commands: EdgeCommand[] = [];
    const receipts: FacebookConsumptionActionReceiptInput[] = [];
    const triggerCalls: FacebookConsumptionActionView[] = [];
    const downstream = joinAction();
    const dispatcher = makeDispatcher({
      commands,
      receipts,
      triggerCalls,
      settle: async (receipt) => ({
        kind: 'settled',
        action: likeAction({
          state: 'terminal',
          dispatchPhase: 'settled',
          outcome: receipt.outcome,
        }),
        nextAction: receipt.outcome === 'confirmed_new_like' ? downstream : null,
      }),
    });
    dispatcher.setCurrentAccountId('fb-consumption-1');
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.bus.emit('note.detail.arrived', {
      detail: {
        noteId: targetUrl,
        title: 'target',
        content: 'safe body',
        likeCount: 0,
        collectCount: 0,
      },
      accountId: 'fb-consumption-1',
      ts: Date.now(),
    });
    emitConfirmedView(dispatcher);
    await waitForAsyncChain();

    // Current Facebook detail-surface Edge receipts intentionally omit noteId.
    dispatcher.bus.emit('action.completed', {
      action: 'like',
      ok: true,
      ts: Date.now(),
    });
    await waitForAsyncChain();

    assert.equal(receipts.at(-1)?.outcome, 'confirmed_new_like');
    assert.equal(
      (receipts.at(-1)?.evidence as { targetWitness?: string } | undefined)?.targetWitness,
      'current_detail',
    );
    assert.deepEqual(triggerCalls.map((action) => action.actionType), ['join']);
    dispatcher.endSession();
  });

  it('does not reuse detail state as target proof for an inline receipt without a witness', async () => {
    const commands: EdgeCommand[] = [];
    const receipts: FacebookConsumptionActionReceiptInput[] = [];
    const triggerCalls: FacebookConsumptionActionView[] = [];
    const dispatcher = makeDispatcher({ commands, receipts, triggerCalls });
    dispatcher.setCurrentAccountId('fb-consumption-1');
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-consumption-1',
      noteId: targetUrl,
      sourceDedupeKey: 'reel-view-5',
      source: 'reels',
      occurredAt: Date.now(),
    });
    await waitForAsyncChain();

    dispatcher.bus.emit('action.completed', {
      action: 'like',
      ok: true,
      ts: Date.now(),
    });
    await waitForAsyncChain();

    assert.equal(receipts.at(-1)?.outcome, 'ambiguous');
    assert.equal(triggerCalls.length, 0);
    dispatcher.endSession();
  });

  for (const { reason, expectedOutcome } of [
    { reason: 'verify_indeterminate', expectedOutcome: 'ambiguous' },
    { reason: 'state_unchanged', expectedOutcome: 'ambiguous' },
    { reason: 'submitted_unconfirmed', expectedOutcome: 'submitted_unknown' },
  ] as const) {
    it(`${reason} is non-counting unknown and completes the guard to prevent a blind retry`, async () => {
      const commands: EdgeCommand[] = [];
      const receipts: FacebookConsumptionActionReceiptInput[] = [];
      const triggerCalls: FacebookConsumptionActionView[] = [];
      const interactionGuard = new InteractionGuard();
      const dispatcher = makeDispatcher({
        commands,
        receipts,
        triggerCalls,
        interactionGuard,
      });
      dispatcher.setCurrentAccountId('fb-consumption-1');
      dispatcher.setup();
      dispatcher.startSession();
      emitConfirmedView(dispatcher);
      await waitForAsyncChain();

      dispatcher.bus.emit('action.completed', {
        action: 'like',
        ok: false,
        reason,
        noteId: targetUrl,
        ts: Date.now(),
      });
      await waitForAsyncChain();

      assert.equal(receipts.at(-1)?.outcome, expectedOutcome);
      assert.equal(triggerCalls.length, 0, 'unknown does not advance the confirmed-like counter');
      assert.deepEqual(interactionGuard.stats(), { inFlight: 0, completed: 1 });
      assert.equal(
        interactionGuard.tryClaim(`like::${targetUrl}`),
        false,
        'the same target remains guarded after an unknown platform write',
      );

      emitConfirmedView(dispatcher);
      await waitForAsyncChain();
      assert.equal(
        commands.filter((command) => command.action === 'like').length,
        1,
        'a repeated durable intent cannot blindly click the same target again',
      );
      dispatcher.endSession();
    });
  }

  it('a known failed like releases the guard and remains retryable', async () => {
    const commands: EdgeCommand[] = [];
    const receipts: FacebookConsumptionActionReceiptInput[] = [];
    const triggerCalls: FacebookConsumptionActionView[] = [];
    const interactionGuard = new InteractionGuard();
    const dispatcher = makeDispatcher({
      commands,
      receipts,
      triggerCalls,
      interactionGuard,
    });
    dispatcher.setCurrentAccountId('fb-consumption-1');
    dispatcher.setup();
    dispatcher.startSession();
    emitConfirmedView(dispatcher);
    await waitForAsyncChain();

    dispatcher.bus.emit('action.completed', {
      action: 'like',
      ok: false,
      reason: 'no_button',
      noteId: targetUrl,
      ts: Date.now(),
    });
    await waitForAsyncChain();

    assert.equal(receipts.at(-1)?.outcome, 'structural');
    assert.deepEqual(interactionGuard.stats(), { inFlight: 0, completed: 0 });
    emitConfirmedView(dispatcher);
    await waitForAsyncChain();
    assert.equal(
      commands.filter((command) => command.action === 'like').length,
      2,
      'known failure releases the target for a later attempt',
    );
    dispatcher.bus.emit('action.completed', {
      action: 'like',
      ok: false,
      reason: 'no_button',
      noteId: targetUrl,
      ts: Date.now(),
    });
    await waitForAsyncChain();
    dispatcher.endSession();
  });
});
