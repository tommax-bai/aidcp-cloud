import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContentCurator } from '../../src/agents/content-curator.js';
import type { BlackboardState } from '../../src/blackboard/types.js';
import type { LlmClient } from '../../src/llm/index.js';
import type { Soul } from '../../src/soul/types.js';

const mockSoul = {
  identity: { name: 'test', role: 'test', background: '', tone: '' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
} as Soul;

function makeBoard(hasNote = true): BlackboardState {
  return {
    currentNote: hasNote ? { noteId: 'n1', title: '测试标题', summary: '测试内容', likeCount: 100, collectCount: 50 } : null,
    pageType: hasNote ? 'note' : 'feed',
    sessionStats: { startedAt: 0, durationMs: 0, views: 5, likes: 0, collects: 0, searches: 0, follows: 0 },
    riskStatus: { status: 'normal', quotaLevel: 'normal', remainingActionsToday: { like: 8 }, viewOnly: false },
    loginState: 'logged_in',
    conceptPool: { known: [], candidates: [], source: new Map() },
    availableActions: ['browse_next', 'close_note', 'like', 'collect'],
    decisions: new Map(),
    finalCommand: null,
  };
}

describe('ContentCurator', () => {
  it('shouldActivate：pageType=note + currentNote 不为 null → true', () => {
    const llm: LlmClient = { complete: async () => '' };
    const agent = new ContentCurator({ soul: mockSoul, llm });
    assert.equal(agent.shouldActivate(makeBoard(true)), true);
  });

  it('shouldActivate：pageType=feed 或 currentNote=null → false', () => {
    const llm: LlmClient = { complete: async () => '' };
    const agent = new ContentCurator({ soul: mockSoul, llm });
    assert.equal(agent.shouldActivate(makeBoard(false)), false);
  });

  it('decide：LLM 返回 close_note → gate blocks interaction_appraiser', async () => {
    const mockLlm: LlmClient = {
      complete: async () => '{"action":"close_note","reason":"内容空洞","confidence":0.8}',
    };
    const agent = new ContentCurator({ soul: mockSoul, llm: mockLlm });
    const decision = await agent.decide(makeBoard());
    assert.equal(decision.action, 'close_note');
    assert.equal(decision.reason, '内容空洞');
    assert.deepEqual(decision.gate, { blocks: ['interaction_appraiser'] });
  });

  it('decide：LLM 返回 pass → 正常 pass', async () => {
    const mockLlm: LlmClient = {
      complete: async () => '{"action":"pass","reason":"内容质量好","confidence":0.7}',
    };
    const agent = new ContentCurator({ soul: mockSoul, llm: mockLlm });
    const decision = await agent.decide(makeBoard());
    assert.equal(decision.action, 'pass');
    assert.equal(decision.reason, '内容质量好');
    assert.equal(decision.gate, undefined);
  });

  it('decide：解析失败 → pass', async () => {
    const mockLlm: LlmClient = {
      complete: async () => '无法解析的响应内容~~~',
    };
    const agent = new ContentCurator({ soul: mockSoul, llm: mockLlm });
    const decision = await agent.decide(makeBoard());
    assert.equal(decision.action, 'pass');
  });
});
