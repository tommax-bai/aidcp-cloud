import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '@automation/orchestrator/role-dispatcher.js';
import type { Soul } from '@kernel/kernel/soul-types.js';
import {
  facebookRuleRoundIncludesJoin,
  type FacebookRuleActionState,
  type FacebookRuleModeBatchView,
} from '@kernel/kernel/facebook-rule-mode-types.js';

const soul: Soul = {
  identity: { name: 'Rule Account', role: 'operator', background: 'test', tone: 'neutral' },
  interests: { primary: ['persona-only-topic'], secondary: [], seed_keywords: [] },
};

/**
 * 两级节奏：轮次序号决定本轮是否含加群联系评论。序号 1 = 只点赞，序号 2 = 点赞 + 加群联系评论。
 * includesJoin 一律由 sequence 派生，测试里不手写，避免 fixture 与真实判据漂移。
 */
function makeBatch(overrides: Partial<FacebookRuleModeBatchView> & { sequence: number }): FacebookRuleModeBatchView {
  return {
    batchId: '00000000-0000-4000-8000-000000000001',
    policyRevision: 7,
    policySnapshot: { viewsPerLike: 5, joinEveryNRounds: 2 },
    triggerContentKey: 'post-5',
    likeState: 'pending' as FacebookRuleActionState,
    joinState: 'pending' as FacebookRuleActionState,
    commentState: 'pending' as FacebookRuleActionState,
    terminal: false,
    blocker: null,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
    includesJoin: facebookRuleRoundIncludesJoin(overrides.sequence),
  };
}

/** 含加群的那一轮（周期第 2 位）。 */
const joinRound = makeBatch({ sequence: 2 });
/** 只点赞的那一轮（周期第 1 位）。 */
const likeOnlyRound = makeBatch({ sequence: 1 });
const RULE_DECISION = {
  mode: 'facebook_rule',
  blocker: null,
  policyRevision: 7,
  rulePolicy: { viewsPerLike: 5, joinEveryNRounds: 2 },
  consumptionPolicy: {
    viewsPerLike: 5,
    confirmedLikesPerJoin: 2,
    confirmedJoinsPerComment: 2,
  },
} as const;

const waitForAsyncChain = () => new Promise((resolve) => setTimeout(resolve, 35));

describe('RoleDispatcher facebook rule mode', () => {
  it('derives the join tier from the round sequence, not from confirmed likes', () => {
    assert.equal(facebookRuleRoundIncludesJoin(1), false);
    assert.equal(facebookRuleRoundIncludesJoin(2), true);
    assert.equal(facebookRuleRoundIncludesJoin(3), false);
    assert.equal(facebookRuleRoundIncludesJoin(4), true);
    assert.equal(joinRound.includesJoin, true);
    assert.equal(likeOnlyRound.includesJoin, false);
  });

  it('selects by feed order without persona LLM evaluation and binds the like to the trigger content', async () => {
    const commands: EdgeCommand[] = [];
    const patches: Array<Record<string, unknown>> = [];
    const joinCalls: Array<{ accountId: string; batchId: string }> = [];
    let appliedPolicy: unknown;
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
      facebookRuleModeDecision: () => RULE_DECISION,
      applyFacebookRuleView: async (input) => {
        appliedPolicy = input.policy;
        return { kind: 'batch_created', batch: joinRound };
      },
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
      explainInteract: () => ({ allowed: true }),
      explainRuleJoin: () => ({ allowed: true }),
      facebookRuleCommentBodyScheme: () => 'template',
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
    assert.deepEqual(appliedPolicy, {
      policyRevision: 7,
      snapshot: { viewsPerLike: 5, joinEveryNRounds: 2 },
    });
    assert.equal(like?.reason, 'facebook_rule_batch_like');
    assert.equal(joinCalls.length, 0, '点赞未终态前不得启动加群联系');

    dispatcher.bus.emit('action.completed', { action: 'like', ok: true, ts: Date.now() });
    await waitForAsyncChain();

    assert.deepEqual(joinCalls, [{ accountId: 'fb-1', batchId: joinRound.batchId }]);
    assert.ok(patches.some((patch) => patch.likeState === 'confirmed'));
    assert.ok(patches.some((patch) =>
      patch.joinState === 'confirmed'
      && patch.commentState === 'confirmed'
      && patch.terminal === true,
    ));
    assert.equal(llmCalls, 0);
    dispatcher.endSession();
  });

  it('supersedes an undispatched batch when the rule revision changes before like dispatch', async () => {
    const commands: EdgeCommand[] = [];
    const patches: Array<Record<string, unknown>> = [];
    let policyRevision = 7;
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: (command) => { commands.push(command); },
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => ({
        ...RULE_DECISION,
        policyRevision,
      }),
      applyFacebookRuleView: async () => {
        policyRevision = 8;
        return { kind: 'batch_created', batch: joinRound };
      },
      updateFacebookRuleBatch: async (_batchId, patch) => {
        patches.push(patch);
      },
      explainInteract: () => ({ allowed: true }),
      explainRuleJoin: () => ({ allowed: true }),
    });
    dispatcher.setCurrentAccountId('fb-1');
    dispatcher.setup();
    dispatcher.startSession();

    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-1',
      noteId: 'https://www.facebook.com/posts/post-revision-before-like',
      sourceDedupeKey: 'receipt-revision-before-like',
      source: 'detail',
      occurredAt: Date.now(),
    });
    await waitForAsyncChain();

    assert.equal(commands.some((command) => command.action === 'like'), false);
    assert.deepEqual(patches.at(-1), {
      likeState: 'policy_superseded',
      joinState: 'policy_superseded',
      commentState: 'policy_superseded',
      terminal: true,
      blocker: 'policy_superseded',
    });
    dispatcher.endSession();
  });

  it('keeps a dispatched like receipt truthful but supersedes join and comment after a rule revision change', async () => {
    const commands: EdgeCommand[] = [];
    const patches: Array<Record<string, unknown>> = [];
    let policyRevision = 7;
    let joinCalls = 0;
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: (command) => { commands.push(command); },
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => ({
        ...RULE_DECISION,
        policyRevision,
      }),
      applyFacebookRuleView: async () => ({
        kind: 'batch_created',
        batch: joinRound,
      }),
      updateFacebookRuleBatch: async (_batchId, patch) => {
        patches.push(patch);
      },
      explainInteract: () => ({ allowed: true }),
      explainRuleJoin: () => ({ allowed: true }),
      facebookRuleCommentBodyScheme: () => 'template',
      triggerFacebookRuleJoinContact: async () => {
        joinCalls += 1;
        return {
          started: true,
          onTerminal: Promise.resolve({
            joinState: 'confirmed' as const,
            commentState: 'confirmed' as const,
          }),
        };
      },
    });
    dispatcher.setCurrentAccountId('fb-1');
    dispatcher.setup();
    dispatcher.startSession();

    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-1',
      noteId: 'https://www.facebook.com/posts/post-revision-before-join',
      sourceDedupeKey: 'receipt-revision-before-join',
      source: 'detail',
      occurredAt: Date.now(),
    });
    await waitForAsyncChain();
    assert.equal(commands.some((command) => command.action === 'like'), true);

    policyRevision = 8;
    dispatcher.bus.emit('action.completed', {
      action: 'like',
      ok: true,
      ts: Date.now(),
    });
    await waitForAsyncChain();

    assert.equal(joinCalls, 0);
    assert.ok(patches.some((patch) => patch.likeState === 'confirmed'));
    assert.deepEqual(patches.at(-1), {
      joinState: 'policy_superseded',
      commentState: 'policy_superseded',
      terminal: true,
      blocker: 'policy_superseded',
    });
    dispatcher.endSession();
  });

  it('rechecks the rule revision immediately before the join-contact write', async () => {
    const commands: EdgeCommand[] = [];
    const patches: Array<Record<string, unknown>> = [];
    let policyRevision = 7;
    let joinCalls = 0;
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: (command) => { commands.push(command); },
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => ({
        ...RULE_DECISION,
        policyRevision,
      }),
      applyFacebookRuleView: async () => ({
        kind: 'batch_created',
        batch: joinRound,
      }),
      updateFacebookRuleBatch: async (_batchId, patch) => {
        patches.push(patch);
        if (patch.joinState === 'dispatched') policyRevision = 8;
      },
      explainInteract: () => ({ allowed: true }),
      explainRuleJoin: () => ({ allowed: true }),
      facebookRuleCommentBodyScheme: () => 'template',
      triggerFacebookRuleJoinContact: async () => {
        joinCalls += 1;
        return {
          started: true,
          onTerminal: Promise.resolve({
            joinState: 'confirmed' as const,
            commentState: 'confirmed' as const,
          }),
        };
      },
    });
    dispatcher.setCurrentAccountId('fb-1');
    dispatcher.setup();
    dispatcher.startSession();

    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-1',
      noteId: 'https://www.facebook.com/posts/post-revision-at-join',
      sourceDedupeKey: 'receipt-revision-at-join',
      source: 'detail',
      occurredAt: Date.now(),
    });
    await waitForAsyncChain();
    assert.equal(commands.some((command) => command.action === 'like'), true);

    dispatcher.bus.emit('action.completed', {
      action: 'like',
      ok: true,
      ts: Date.now(),
    });
    await waitForAsyncChain();

    assert.equal(joinCalls, 0);
    assert.deepEqual(patches.at(-1), {
      joinState: 'policy_superseded',
      commentState: 'policy_superseded',
      terminal: true,
      blocker: 'policy_superseded',
    });
    dispatcher.endSession();
  });

  it('runs a like-only round without join-contact and still terminalizes it', async () => {
    const commands: EdgeCommand[] = [];
    const patches: Array<Record<string, unknown>> = [];
    let joinCalls = 0;
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: (command) => { commands.push(command); },
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => RULE_DECISION,
      applyFacebookRuleView: async () => ({ kind: 'batch_created', batch: likeOnlyRound }),
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
      explainInteract: () => ({ allowed: true }),
      explainRuleJoin: () => ({ allowed: true }),
      triggerFacebookRuleJoinContact: async () => {
        joinCalls += 1;
        return { started: true, onTerminal: Promise.resolve({ joinState: 'confirmed' as const, commentState: 'confirmed' as const }) };
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
    assert.equal(commands.some((command) => command.action === 'like'), true, '只点赞的轮次照样点赞');

    dispatcher.bus.emit('action.completed', { action: 'like', ok: true, ts: Date.now() });
    await waitForAsyncChain();

    assert.equal(joinCalls, 0, '周期第 1 位的轮次 MUST NOT 触发加群联系');
    const terminal = patches.find((patch) => patch.terminal === true);
    assert.ok(terminal, '只点赞的轮次 MUST 终结——不终结即单飞锁永不释放、后续浏览全部被丢弃');
    assert.equal(terminal?.joinState, 'not_scheduled');
    assert.equal(terminal?.commentState, 'not_scheduled');
    assert.equal(
      Object.prototype.hasOwnProperty.call(terminal!, 'blocker'),
      false,
      '本轮不加群 MUST NOT 写 blocker——该列三阶段共用、后写覆盖先写',
    );
    dispatcher.endSession();
  });

  it('keeps the like blocker readable after a like-only round terminalizes', async () => {
    const patches: Array<Record<string, unknown>> = [];
    let joinCalls = 0;
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: () => {},
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => RULE_DECISION,
      applyFacebookRuleView: async () => ({ kind: 'batch_created', batch: likeOnlyRound }),
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
      explainInteract: () => ({ allowed: false, reason: 'daily_like_quota' }),
      explainRuleJoin: () => ({ allowed: true }),
      triggerFacebookRuleJoinContact: async () => {
        joinCalls += 1;
        return { started: false, reason: 'unexpected' };
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

    assert.equal(joinCalls, 0);
    assert.ok(patches.some((patch) =>
      patch.likeState === 'risk_suppressed' && patch.blocker === 'daily_like_quota',
    ));
    const terminal = patches.find((patch) => patch.terminal === true);
    assert.ok(terminal);
    assert.equal(
      Object.prototype.hasOwnProperty.call(terminal!, 'blocker'),
      false,
      '终结不得覆盖点赞阶段的抑制原因',
    );
    dispatcher.endSession();
  });

  it('does not deadlock browsing across consecutive like-only rounds', async () => {
    const patches: Array<Record<string, unknown>> = [];
    let sequence = 0;
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: () => {},
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => RULE_DECISION,
      // 每次确认浏览都产生一个新的「只点赞」轮次（序号 1/3/5…），模拟连续的周期第 1 位。
      applyFacebookRuleView: async () => {
        sequence += 2;
        return {
          kind: 'batch_created',
          batch: makeBatch({
            sequence: sequence - 1,
            batchId: `00000000-0000-4000-8000-00000000000${sequence}`,
          }),
        };
      },
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
      explainInteract: () => ({ allowed: false, reason: 'daily_like_quota' }),
      explainRuleJoin: () => ({ allowed: true }),
    });
    dispatcher.setCurrentAccountId('fb-1');
    dispatcher.setup();
    dispatcher.startSession();

    for (const index of [1, 2, 3]) {
      dispatcher.bus.emit('facebook.rule.view.confirmed', {
        accountId: 'fb-1',
        noteId: `https://www.facebook.com/posts/post-${index}`,
        sourceDedupeKey: `receipt-${index}`,
        source: 'detail',
        occurredAt: Date.now(),
      });
      await waitForAsyncChain();
    }

    const terminals = patches.filter((patch) => patch.terminal === true);
    assert.equal(terminals.length, 3, '每个只点赞的轮次都必须自己走到终态');
    assert.ok(terminals.every((patch) =>
      patch.joinState === 'not_scheduled' && patch.commentState === 'not_scheduled',
    ));
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
        ? RULE_DECISION
        : { mode: 'slow_start', blocker: 'slow_start_active' },
      applyFacebookRuleView: async () => {
        mode = 'slow_start';
        return { kind: 'batch_created', batch: joinRound };
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
      patch.likeState === 'policy_superseded'
      && patch.joinState === 'policy_superseded'
      && patch.commentState === 'policy_superseded'
      && patch.terminal === true
      && patch.blocker === 'policy_superseded',
    ));
    dispatcher.endSession();
  });

  it('records risk-suppressed like without debt and still independently attempts join-contact once on a join round', async () => {
    const commands: EdgeCommand[] = [];
    const patches: Array<Record<string, unknown>> = [];
    let joinCalls = 0;
    let likeAllowed = false;
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: (command) => { commands.push(command); },
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => RULE_DECISION,
      applyFacebookRuleView: async () => ({ kind: 'batch_created', batch: joinRound }),
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
      explainInteract: (action) => action === 'like' && !likeAllowed
        ? { allowed: false, reason: 'daily_like_quota' }
        : { allowed: true },
      explainRuleJoin: () => ({ allowed: true }),
      facebookRuleCommentBodyScheme: () => 'template',
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
    assert.equal(
      joinCalls,
      1,
      '点赞被抑制 MUST NOT 连带取消加群：二级节奏按轮次序号推进，不按成功点赞数',
    );
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

  it('preflights the RiskController comment quota before joining a group', async () => {
    const patches: Array<Record<string, unknown>> = [];
    let joinCalls = 0;
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: () => {},
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => RULE_DECISION,
      applyFacebookRuleView: async () => ({ kind: 'batch_created', batch: joinRound }),
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
      explainInteract: (action) => action === 'comment'
        ? { allowed: false, reason: 'quota:day' }
        : { allowed: false, reason: 'daily_like_quota' },
      explainRuleJoin: () => ({ allowed: true }),
      facebookRuleCommentBodyScheme: () => 'template',
      triggerFacebookRuleJoinContact: async () => {
        joinCalls += 1;
        return {
          started: true,
          onTerminal: Promise.resolve({
            joinState: 'confirmed' as const,
            commentState: 'confirmed' as const,
          }),
        };
      },
    });
    dispatcher.setCurrentAccountId('fb-1');
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-1',
      noteId: 'https://www.facebook.com/posts/quota-blocked',
      sourceDedupeKey: 'receipt-quota-blocked',
      source: 'detail',
      occurredAt: Date.now(),
    });
    await waitForAsyncChain();

    assert.equal(joinCalls, 0, '评论日配额已满时不得先执行不可逆的加群动作');
    assert.ok(patches.some((patch) =>
      patch.joinState === 'not_started'
      && patch.commentState === 'risk_suppressed'
      && patch.blocker === 'quota:day'
      && patch.terminal === true,
    ));
    dispatcher.endSession();
  });

  it('preflights the active-session comment budget before joining a group', async () => {
    const patches: Array<Record<string, unknown>> = [];
    let joinCalls = 0;
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: () => {},
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => RULE_DECISION,
      applyFacebookRuleView: async () => ({ kind: 'batch_created', batch: joinRound }),
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
      explainInteract: (action) => action === 'like'
        ? { allowed: false, reason: 'daily_like_quota' }
        : { allowed: true },
      explainRuleJoin: () => ({ allowed: true }),
      facebookRuleCommentBodyScheme: () => 'template',
      sessionLimitProvider: {
        sessionDurationMs: () => 10 * 60_000,
        sessionBudget: () => ({
          likes: 10,
          collects: 5,
          follows: 3,
          searches: 5,
          comments: 0,
          comment_likes: 3,
          join_groups: 1,
        }),
        collectSaveLikeRatio: () => 1 / 3,
        followFansRatio: () => 1 / 8,
        weekActiveMask: () => null,
      },
      triggerFacebookRuleJoinContact: async () => {
        joinCalls += 1;
        return {
          started: true,
          onTerminal: Promise.resolve({
            joinState: 'confirmed' as const,
            commentState: 'confirmed' as const,
          }),
        };
      },
    });
    dispatcher.setCurrentAccountId('fb-1');
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-1',
      noteId: 'https://www.facebook.com/posts/session-blocked',
      sourceDedupeKey: 'receipt-session-blocked',
      source: 'detail',
      occurredAt: Date.now(),
    });
    await waitForAsyncChain();

    assert.equal(joinCalls, 0, '本场评论预算耗尽时不得先执行不可逆的加群动作');
    assert.ok(patches.some((patch) =>
      patch.joinState === 'not_started'
      && patch.commentState === 'risk_suppressed'
      && patch.blocker === 'comment_session_budget'
      && patch.terminal === true,
    ));
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
        facebookRuleModeDecision: () => RULE_DECISION,
        applyFacebookRuleView: async () => ({
          kind: 'batch_created',
          batch: makeBatch({ sequence: 2, batchId: `00000000-0000-4000-8000-00000000001${index}` }),
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

  // ── change facebook-rule-mode-without-persona ────────────────────────────────────────────
  it('runs the whole rule batch for an account with no persona at all (never resolves one)', async () => {
    const commands: EdgeCommand[] = [];
    const patches: Array<Record<string, unknown>> = [];
    const joinCalls: string[] = [];
    let soulReads = 0;
    const dispatcher = new RoleDispatcher({
      // 未绑人设账号：解析器诚实抛「无人设」。规则模式这条路一次都不该读它。
      getSoul: () => { soulReads += 1; throw new Error('no_persona'); },
      llm: { complete: async () => { throw new Error('rule mode must not call the persona LLM'); } },
      sendCommand: (command) => { commands.push(command); },
      accountPlatform: 'facebook',
      personaBinding: () => 'unbound',
      facebookRuleModeDecision: () => RULE_DECISION,
      applyFacebookRuleView: async () => ({ kind: 'batch_created', batch: joinRound }),
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
      explainInteract: () => ({ allowed: true }),
      explainRuleJoin: () => ({ allowed: true }),
      facebookRuleCommentBodyScheme: () => 'template',
      triggerFacebookRuleJoinContact: async (accountId) => {
        joinCalls.push(accountId);
        return {
          started: true,
          onTerminal: Promise.resolve({
            joinState: 'confirmed' as FacebookRuleActionState,
            commentState: 'confirmed' as FacebookRuleActionState,
          }),
        };
      },
    });
    dispatcher.setCurrentAccountId('fb-no-persona');
    dispatcher.setup();
    // 未绑人设 + 规则模式启用 → 启动闸豁免，会话正常起。
    dispatcher.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'fb-no-persona', ts: 1 });
    assert.equal(dispatcher.active, true, '未绑人设 + 规则模式启用 → 会话正常启动');

    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-no-persona',
      noteId: 'https://www.facebook.com/posts/post-10',
      sourceDedupeKey: 'receipt-10',
      source: 'detail',
      occurredAt: Date.now(),
    });
    await waitForAsyncChain();
    assert.equal(commands.some((command) => command.action === 'like'), true, '固定点赞意图照常下发');
    dispatcher.bus.emit('action.completed', { action: 'like', ok: true, ts: Date.now() });
    await waitForAsyncChain();

    assert.deepEqual(joinCalls, ['fb-no-persona']);
    assert.ok(patches.some((patch) =>
      patch.joinState === 'confirmed' && patch.commentState === 'confirmed' && patch.terminal === true,
    ));
    assert.equal(soulReads, 0, '规则模式全程不读人设，也不回落任何替代人设');
    dispatcher.endSession();
  });

  // 正文方案闸只挂在**真正会走到评论的那一轮**（周期第 2 位）上，所以以下几例一律用 joinRound。
  it('makes the comment leg unexecutable for an explicit generated body scheme and keeps the like outcome', async () => {
    const patches: Array<Record<string, unknown>> = [];
    let joinCalls = 0;
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: () => {},
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => RULE_DECISION,
      applyFacebookRuleView: async () => ({ kind: 'batch_created', batch: joinRound }),
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
      explainInteract: () => ({ allowed: true }),
      explainRuleJoin: () => ({ allowed: true }),
      facebookRuleCommentBodyScheme: () => 'generated',
      triggerFacebookRuleJoinContact: async () => {
        joinCalls += 1;
        return { started: true, onTerminal: Promise.resolve({ joinState: 'confirmed' as FacebookRuleActionState, commentState: 'confirmed' as FacebookRuleActionState }) };
      },
    });
    dispatcher.setCurrentAccountId('fb-generated');
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-generated',
      noteId: 'https://www.facebook.com/posts/post-10',
      sourceDedupeKey: 'receipt-10',
      source: 'detail',
      occurredAt: Date.now(),
    });
    await waitForAsyncChain();
    dispatcher.bus.emit('action.completed', { action: 'like', ok: true, ts: Date.now() });
    await waitForAsyncChain();

    assert.equal(joinCalls, 0, '显式生成方案 → 绝不调用加群联系评论编排（也就绝不调用生成器）');
    assert.ok(
      patches.some((patch) => patch.likeState === 'confirmed'),
      '点赞结果原样保留（批次如实呈现为部分完成）',
    );
    assert.ok(
      patches.some((patch) =>
        patch.joinState === 'not_started'
        && patch.commentState === 'rejected'
        && patch.terminal === true
        && patch.blocker === 'comment_body_scheme_generated',
      ),
      '评论段以稳定具名原因收敛为不可执行',
    );
    dispatcher.endSession();
  });

  it('fails closed with its own named reason when the body scheme cannot be resolved', async () => {
    for (const [scheme, expectedBlocker] of [
      [undefined, 'comment_body_scheme_unavailable'],
      ['unavailable' as const, 'comment_body_scheme_unavailable'],
    ] as const) {
      const patches: Array<Record<string, unknown>> = [];
      let joinCalls = 0;
      const dispatcher = new RoleDispatcher({
        soul,
        llm: { complete: async () => '{"verdict":"skip"}' },
        sendCommand: () => {},
        accountPlatform: 'facebook',
        facebookRuleModeDecision: () => RULE_DECISION,
        applyFacebookRuleView: async () => ({ kind: 'batch_created', batch: joinRound }),
        updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
        explainInteract: () => ({ allowed: true }),
        explainRuleJoin: () => ({ allowed: true }),
        ...(scheme ? { facebookRuleCommentBodyScheme: () => scheme } : {}),
        triggerFacebookRuleJoinContact: async () => {
          joinCalls += 1;
          return { started: true, onTerminal: Promise.resolve({ joinState: 'confirmed' as FacebookRuleActionState, commentState: 'confirmed' as FacebookRuleActionState }) };
        },
      });
      dispatcher.setCurrentAccountId('fb-unknown-scheme');
      dispatcher.setup();
      dispatcher.startSession();
      dispatcher.bus.emit('facebook.rule.view.confirmed', {
        accountId: 'fb-unknown-scheme',
        noteId: 'https://www.facebook.com/posts/post-10',
        sourceDedupeKey: 'receipt-10',
        source: 'detail',
        occurredAt: Date.now(),
      });
      await waitForAsyncChain();
      dispatcher.bus.emit('action.completed', { action: 'like', ok: true, ts: Date.now() });
      await waitForAsyncChain();

      assert.equal(joinCalls, 0, '方案不可解析 → 不执行评论段，也绝不以模板顶替');
      assert.ok(patches.some((patch) =>
        patch.commentState === 'rejected' && patch.terminal === true && patch.blocker === expectedBlocker,
      ));
      dispatcher.endSession();
    }
  });

  it('never consults the body scheme on a like-only round and keeps its not_scheduled terminal', async () => {
    const patches: Array<Record<string, unknown>> = [];
    let schemeReads = 0;
    let joinCalls = 0;
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: () => {},
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => RULE_DECISION,
      applyFacebookRuleView: async () => ({ kind: 'batch_created', batch: likeOnlyRound }),
      updateFacebookRuleBatch: async (_batchId, patch) => { patches.push(patch); },
      explainInteract: () => ({ allowed: true }),
      explainRuleJoin: () => ({ allowed: true }),
      // 显式生成方案，但本轮按节奏根本没有评论段：闸不得在这里判、更不得把节奏收尾改写成正文方案原因。
      facebookRuleCommentBodyScheme: () => { schemeReads += 1; return 'generated'; },
      triggerFacebookRuleJoinContact: async () => {
        joinCalls += 1;
        return { started: true, onTerminal: Promise.resolve({ joinState: 'confirmed' as FacebookRuleActionState, commentState: 'confirmed' as FacebookRuleActionState }) };
      },
    });
    dispatcher.setCurrentAccountId('fb-like-only');
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-like-only',
      noteId: 'https://www.facebook.com/posts/post-10',
      sourceDedupeKey: 'receipt-10',
      source: 'detail',
      occurredAt: Date.now(),
    });
    await waitForAsyncChain();
    dispatcher.bus.emit('action.completed', { action: 'like', ok: true, ts: Date.now() });
    await waitForAsyncChain();

    assert.equal(schemeReads, 0, '只点赞的轮次不进评论段 → 正文方案一次都不该被读');
    assert.equal(joinCalls, 0);
    assert.ok(
      patches.some((patch) =>
        patch.joinState === 'not_scheduled'
        && patch.commentState === 'not_scheduled'
        && patch.terminal === true,
      ),
      '按节奏正常收尾，仍是 not_scheduled，而不是正文方案不可执行',
    );
    assert.equal(
      patches.some((patch) => typeof patch.blocker === 'string' && patch.blocker.startsWith('comment_body_scheme')),
      false,
      '绝不把「本轮按节奏不做评论」误报成「正文方案不可执行」',
    );
    dispatcher.endSession();
  });

  it('reconciles an in-flight like as ambiguous at a session/reconnect boundary without replay', async () => {
    const commands: EdgeCommand[] = [];
    const patches: Array<Record<string, unknown>> = [];
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: (command) => { commands.push(command); },
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => RULE_DECISION,
      applyFacebookRuleView: async () => ({ kind: 'batch_created', batch: joinRound }),
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

  it('reconciles a like-only round at a session boundary too', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const dispatcher = new RoleDispatcher({
      soul,
      llm: { complete: async () => '{"verdict":"skip"}' },
      sendCommand: () => {},
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => RULE_DECISION,
      applyFacebookRuleView: async () => ({ kind: 'batch_created', batch: likeOnlyRound }),
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

    dispatcher.endSession('edge_disconnected');
    await waitForAsyncChain();
    assert.ok(
      patches.some((patch) => patch.terminal === true && patch.likeState === 'ambiguous'),
      '会话边界对账对只点赞的轮次同样生效（点赞已下发、回执未到）',
    );
  });
});
