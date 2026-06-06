import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FeedScanner } from '../../src/agents/feed-scanner.js';
import type { BlackboardState } from '../../src/blackboard/types.js';
import type { LlmClient } from '../../src/llm/index.js';
import type { Soul } from '../../src/soul/types.js';

const mockSoul = {
  identity: { name: 'test', role: 'test', background: '', tone: '' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
} as Soul;

function makeBoard(pageType: 'feed' | 'note' | 'search' = 'feed'): BlackboardState {
  return {
    currentNote: null,
    pageType,
    sessionStats: { startedAt: 0, durationMs: 0, views: 5, likes: 0, collects: 0, searches: 0, follows: 0 },
    riskStatus: { status: 'normal', quotaLevel: 'normal', remainingActionsToday: { like: 8 }, viewOnly: false },
    loginState: 'logged_in',
    conceptPool: { known: ['AI', 'LLM'], candidates: [], source: new Map() },
    availableActions: ['browse_next', 'open_note', 'scroll'],
    decisions: new Map(),
    finalCommand: null,
  };
}

describe('FeedScanner', () => {
  it('shouldActivate：pageType=feed → true', () => {
    const llm: LlmClient = { complete: async () => '' };
    const agent = new FeedScanner({ soul: mockSoul, llm });
    assert.equal(agent.shouldActivate(makeBoard('feed')), true);
  });

  it('shouldActivate：pageType=note → false', () => {
    const llm: LlmClient = { complete: async () => '' };
    const agent = new FeedScanner({ soul: mockSoul, llm });
    assert.equal(agent.shouldActivate(makeBoard('note')), false);
  });

  it('decide：LLM 返回有效 JSON → 正确解析', async () => {
    const mockLlm: LlmClient = {
      complete: async () => '{"action":"open_note","params":{"index":2},"reason":"与AI相关","confidence":0.9}',
    };
    const agent = new FeedScanner({ soul: mockSoul, llm: mockLlm });
    const decision = await agent.decide(makeBoard());
    assert.equal(decision.action, 'open_note');
    assert.deepEqual(decision.params, { index: 2 });
    assert.equal(decision.reason, '与AI相关');
    assert.equal(decision.confidence, 0.9);
  });

  it('decide：LLM 返回垃圾 → pass', async () => {
    const mockLlm: LlmClient = {
      complete: async () => '这是一段无意义的文本，不是JSON',
    };
    const agent = new FeedScanner({ soul: mockSoul, llm: mockLlm });
    const decision = await agent.decide(makeBoard());
    assert.equal(decision.action, 'pass');
  });

  it('decide：LLM 抛错 → pass', async () => {
    const mockLlm: LlmClient = {
      complete: async () => { throw new Error('网络超时'); },
    };
    const agent = new FeedScanner({ soul: mockSoul, llm: mockLlm });
    const decision = await agent.decide(makeBoard());
    assert.equal(decision.action, 'pass');
    assert.equal(decision.reason, 'llm_error');
  });
});
