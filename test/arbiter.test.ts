import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Arbiter } from '../src/blackboard/arbiter.js';
import type { BlackboardState } from '../src/blackboard/types.js';
import type { AgentRole, AgentDecision } from '../src/event-bus/types.js';

function makeBoard(decisions: [AgentRole, Partial<AgentDecision>][]): BlackboardState {
  const board: BlackboardState = {
    currentNote: null,
    pageType: 'note',
    sessionStats: { startedAt: 0, durationMs: 0, views: 0, likes: 0, collects: 0, searches: 0, follows: 0 },
    riskStatus: { status: 'normal', quotaLevel: 'normal', remainingActionsToday: {}, viewOnly: false },
    loginState: 'logged_in',
    conceptPool: { known: [], candidates: [], source: new Map() },
    availableActions: ['browse_next', 'scroll', 'like', 'collect', 'close_note', 'end_session'],
    decisions: new Map(),
    finalCommand: null,
  };
  for (const [role, partial] of decisions) {
    board.decisions.set(role, {
      agent: role,
      action: partial.action ?? 'pass',
      reason: partial.reason ?? 'test',
      confidence: partial.confidence ?? 0.5,
      veto: partial.veto,
      gate: partial.gate,
      params: partial.params,
      ts: Date.now(),
    });
  }
  return board;
}

describe('Arbiter', () => {
  const arbiter = new Arbiter();

  it('veto 场景：SessionMonitor veto=true, action=end_session → 最终命令为 end_session', () => {
    const board = makeBoard([
      ['session_monitor', { action: 'end_session', veto: true, confidence: 1, reason: '超时' }],
      ['feed_scanner', { action: 'open_note', confidence: 0.9 }],
    ]);
    const result = arbiter.arbitrate(board);
    assert.equal(result.action, 'end_session');
    assert.match(result.reason, /session_monitor/);
  });

  it('gate 场景：ContentCurator close_note + gate blocks interaction_appraiser → 忽略 InteractionAppraiser', () => {
    const board = makeBoard([
      ['content_curator', { action: 'close_note', confidence: 0.8, gate: { blocks: ['interaction_appraiser'] } }],
      ['interaction_appraiser', { action: 'like', confidence: 0.9 }],
    ]);
    const result = arbiter.arbitrate(board);
    assert.equal(result.action, 'close_note');
    // close_note 是 terminal action，不附加互动
    assert.equal(result.interaction, undefined);
  });

  it('正常合并：FeedScanner open_note + InteractionAppraiser pass → 输出 open_note', () => {
    const board = makeBoard([
      ['feed_scanner', { action: 'open_note', confidence: 0.9, params: { index: 2 } }],
      ['interaction_appraiser', { action: 'pass', confidence: 0 }],
    ]);
    const result = arbiter.arbitrate(board);
    assert.equal(result.action, 'open_note');
    assert.deepEqual(result.params, { index: 2 });
  });

  it('互动附加：InteractionAppraiser action=like → 输出 browse_next + interaction=like', () => {
    const board = makeBoard([
      ['interaction_appraiser', { action: 'like', confidence: 0.8, reason: '干货' }],
    ]);
    const result = arbiter.arbitrate(board);
    // 只有互动没有导航 → 主命令为 browse_next
    assert.equal(result.action, 'browse_next');
    assert.equal(result.interaction, 'like');
  });

  it('全 pass：所有 Agent 都 pass → fallback browse_next', () => {
    const board = makeBoard([
      ['feed_scanner', { action: 'pass', confidence: 0 }],
      ['content_curator', { action: 'pass', confidence: 0 }],
      ['interaction_appraiser', { action: 'pass', confidence: 0 }],
    ]);
    const result = arbiter.arbitrate(board);
    assert.equal(result.action, 'browse_next');
    assert.equal(result.reason, 'all_agents_pass');
  });

  it('导航优先级：多个导航动作取 confidence 最高的', () => {
    const board = makeBoard([
      ['feed_scanner', { action: 'scroll', confidence: 0.6 }],
      ['content_curator', { action: 'close_note', confidence: 0.9 }],
    ]);
    const result = arbiter.arbitrate(board);
    assert.equal(result.action, 'close_note');
    assert.match(result.reason, /content_curator/);
  });

  it('close_note 忽略互动：导航为 close_note 时不附加 like', () => {
    const board = makeBoard([
      ['content_curator', { action: 'pass', confidence: 0 }],
      ['interaction_appraiser', { action: 'like', confidence: 0.7 }],
      ['feed_scanner', { action: 'close_note', confidence: 0.9 }],
    ]);
    const result = arbiter.arbitrate(board);
    assert.equal(result.action, 'close_note');
    assert.equal(result.interaction, undefined);
  });
});
