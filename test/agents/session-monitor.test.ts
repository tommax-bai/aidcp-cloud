import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionMonitor } from '../../src/agents/session-monitor.js';
import type { BlackboardState } from '../../src/blackboard/types.js';
import type { Soul } from '../../src/soul/types.js';

const mockSoul = {
  identity: { name: 'test', role: 'test', background: '', tone: '' },
  interests: { primary: [], secondary: [], seed_keywords: [] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
} as Soul;

function makeBoard(overrides: Partial<BlackboardState> = {}): BlackboardState {
  return {
    currentNote: null,
    pageType: 'note',
    sessionStats: { startedAt: 0, durationMs: 0, views: 10, likes: 0, collects: 0, searches: 0, follows: 0 },
    riskStatus: { status: 'normal', quotaLevel: 'normal', remainingActionsToday: { like: 8, collect: 5, search: 3 }, viewOnly: false },
    loginState: 'logged_in',
    conceptPool: { known: [], candidates: [], source: new Map() },
    availableActions: ['browse_next', 'like', 'collect'],
    decisions: new Map(),
    finalCommand: null,
    ...overrides,
  };
}

describe('SessionMonitor', () => {
  const agent = new SessionMonitor({ soul: mockSoul });

  it('shouldActivate 总是返回 true', () => {
    const board = makeBoard();
    assert.equal(agent.shouldActivate(board), true);
  });

  it('超时 → veto + end_session', async () => {
    const board = makeBoard({
      sessionStats: { startedAt: 0, durationMs: 600_001, views: 10, likes: 0, collects: 0, searches: 0, follows: 0 },
    });
    const decision = await agent.decide(board);
    assert.equal(decision.action, 'end_session');
    assert.equal(decision.veto, true);
  });

  it('配额耗尽（like/collect/search 全 0）→ veto + end_session', async () => {
    const board = makeBoard({
      riskStatus: {
        status: 'normal',
        quotaLevel: 'normal',
        remainingActionsToday: { like: 0, collect: 0, search: 0 },
        viewOnly: false,
      },
    });
    const decision = await agent.decide(board);
    assert.equal(decision.action, 'end_session');
    assert.equal(decision.veto, true);
  });

  it('冷启动（views < 5）→ gate blocks interaction_appraiser', async () => {
    const board = makeBoard({
      sessionStats: { startedAt: 0, durationMs: 5000, views: 3, likes: 0, collects: 0, searches: 0, follows: 0 },
    });
    const decision = await agent.decide(board);
    assert.equal(decision.action, 'pass');
    assert.deepEqual(decision.gate, { blocks: ['interaction_appraiser'] });
  });

  it('正常情况 → pass', async () => {
    const board = makeBoard();
    const decision = await agent.decide(board);
    assert.equal(decision.action, 'pass');
    assert.equal(decision.veto, undefined);
    assert.equal(decision.gate, undefined);
  });
});
