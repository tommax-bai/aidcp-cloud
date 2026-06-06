import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InteractionAppraiser } from '../../src/agents/interaction-appraiser.js';
import type { BlackboardState } from '../../src/blackboard/types.js';
import type { LlmClient } from '../../src/llm/index.js';
import type { Soul } from '../../src/soul/types.js';

const mockSoul = {
  identity: { name: 'test', role: 'test', background: '技术从业者', tone: '理性' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
  behavior_guidelines: { style: '', privacy: '', collection_principle: '可复用知识', like_principle: '有启发' },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
} as Soul;

function makeBoard(availableActions: string[] = ['browse_next', 'like', 'collect', 'close_note']): BlackboardState {
  return {
    currentNote: { noteId: 'n1', title: '深度学习实战', summary: '详细教程', likeCount: 200, collectCount: 80 },
    pageType: 'note',
    sessionStats: { startedAt: 0, durationMs: 0, views: 10, likes: 2, collects: 1, searches: 0, follows: 0 },
    riskStatus: { status: 'normal', quotaLevel: 'normal', remainingActionsToday: { like: 5, collect: 3 }, viewOnly: false },
    loginState: 'logged_in',
    conceptPool: { known: [], candidates: [], source: new Map() },
    availableActions: availableActions as BlackboardState['availableActions'],
    decisions: new Map(),
    finalCommand: null,
  };
}

describe('InteractionAppraiser', () => {
  it('shouldActivate：pageType=note + currentNote + availableActions 含 like/collect → true', () => {
    const llm: LlmClient = { complete: async () => '' };
    const agent = new InteractionAppraiser({ soul: mockSoul, llm });
    assert.equal(agent.shouldActivate(makeBoard(['browse_next', 'like', 'collect'])), true);
  });

  it('shouldActivate：availableActions 不含 like/collect → true（shouldActivate 只看 pageType+note）', () => {
    const llm: LlmClient = { complete: async () => '' };
    const agent = new InteractionAppraiser({ soul: mockSoul, llm });
    // shouldActivate 只检查 pageType=note && currentNote !== null
    // 但 decide 里会提前 pass
    assert.equal(agent.shouldActivate(makeBoard(['browse_next', 'close_note'])), true);
  });

  it('decide：availableActions 不含 like/collect → 直接 pass 不调 LLM', async () => {
    let llmCalled = false;
    const mockLlm: LlmClient = {
      complete: async () => { llmCalled = true; return '{"action":"like"}'; },
    };
    const agent = new InteractionAppraiser({ soul: mockSoul, llm: mockLlm });
    const board = makeBoard(['browse_next', 'close_note']);
    const decision = await agent.decide(board);
    assert.equal(decision.action, 'pass');
    assert.equal(llmCalled, false);
  });

  it('decide：LLM 返回 like → like 决策', async () => {
    const mockLlm: LlmClient = {
      complete: async () => '{"action":"like","reason":"有启发性","confidence":0.8}',
    };
    const agent = new InteractionAppraiser({ soul: mockSoul, llm: mockLlm });
    const decision = await agent.decide(makeBoard());
    assert.equal(decision.action, 'like');
    assert.equal(decision.reason, '有启发性');
    assert.equal(decision.confidence, 0.8);
  });

  it('decide：LLM 返回 collect → collect 决策', async () => {
    const mockLlm: LlmClient = {
      complete: async () => '{"action":"collect","reason":"可复用知识","confidence":0.9}',
    };
    const agent = new InteractionAppraiser({ soul: mockSoul, llm: mockLlm });
    const decision = await agent.decide(makeBoard());
    assert.equal(decision.action, 'collect');
    assert.equal(decision.reason, '可复用知识');
  });

  it('decide：解析失败 → pass', async () => {
    const mockLlm: LlmClient = {
      complete: async () => '不是有效的JSON响应',
    };
    const agent = new InteractionAppraiser({ soul: mockSoul, llm: mockLlm });
    const decision = await agent.decide(makeBoard());
    assert.equal(decision.action, 'pass');
  });
});
