/**
 * CommentTargetPicker 单测（change comment-search-command，新角色②）。
 * 覆盖：无候选→null、强相关里取最多收藏、LLM pickIndex 非强相关时云端兜底取最高收藏、
 * 无强相关→null（换词）、LLM 降级/解析失败→null（不默认挑）、弱相关不入选。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommentTargetPicker } from '../../src/agents/comment-target-picker.js';
import type { CommentCandidateCard } from '../../src/agents/comment-target-picker.js';
import type { Soul } from '../../src/kernel/soul-types.js';

const soul: Soul = {
  identity: { name: 'TestBot', role: 'AI研发工程师', background: '技术博主', tone: '理性' },
  interests: { primary: ['LLM Agent'], secondary: ['RAG'], seed_keywords: ['vLLM'] },
};

const cards: CommentCandidateCard[] = [
  { index: 0, noteId: 'a', title: 'Agent 框架横评', collectCount: 800 },
  { index: 1, noteId: 'b', title: 'RAG 工程实战', collectCount: 1200 },
  { index: 2, noteId: 'c', title: '今日穿搭分享', collectCount: 5000 },
];

async function pick(llmRaw: string | (() => never), candidates = cards) {
  const role = new CommentTargetPicker({
    soul,
    llm: {
      complete: async () => {
        if (typeof llmRaw === 'function') return llmRaw();
        return llmRaw;
      },
    },
  });
  return role.pick(candidates);
}

describe('CommentTargetPicker 强相关甄选', () => {
  it('无候选 → pickIndex=null', async () => {
    const r = await pick('{}', []);
    assert.equal(r.pickIndex, null);
    assert.equal(r.reason, 'no_candidates');
  });

  it('强相关里取最多收藏（强相关=[0,1]，收藏 800 vs 1200 → 选 1）', async () => {
    const r = await pick('{"pickIndex":1,"stronglyRelevantIndexes":[0,1],"reason":"都在领域内"}');
    assert.deepEqual(r.stronglyRelevantIndexes, [0, 1]);
    assert.equal(r.pickIndex, 1);
  });

  it('云端兜底：LLM pickIndex 给了非最多收藏的强相关项 → 仍取强相关里收藏最高的', async () => {
    const r = await pick('{"pickIndex":0,"stronglyRelevantIndexes":[0,1],"reason":"x"}');
    assert.equal(r.pickIndex, 1, '强相关 [0,1] 里收藏最高是 index 1');
  });

  it('弱相关（穿搭）即使收藏最高也不入选——不在 stronglyRelevantIndexes 内', async () => {
    const r = await pick('{"pickIndex":1,"stronglyRelevantIndexes":[0,1],"reason":"穿搭跨界排除"}');
    assert.ok(!r.stronglyRelevantIndexes.includes(2));
    assert.notEqual(r.pickIndex, 2);
  });

  it('无强相关 → pickIndex=null（换词）', async () => {
    const r = await pick('{"pickIndex":null,"stronglyRelevantIndexes":[],"reason":"全不强相关"}');
    assert.equal(r.pickIndex, null);
  });

  it('LLM 返回的越界 index 被过滤', async () => {
    const r = await pick('{"pickIndex":9,"stronglyRelevantIndexes":[1,9],"reason":"x"}');
    assert.deepEqual(r.stronglyRelevantIndexes, [1]);
    assert.equal(r.pickIndex, 1);
  });

  it('LLM 降级（抛错）→ null（不默认挑）', async () => {
    const r = await pick(() => {
      throw new Error('llm down');
    });
    assert.equal(r.pickIndex, null);
    assert.equal(r.reason, 'llm_error');
  });

  it('解析失败（坏输出）→ null（不默认挑）', async () => {
    const r = await pick('这不是JSON');
    assert.equal(r.pickIndex, null);
    assert.equal(r.reason, 'parse_error');
  });

  it('pickIndex 给了不在强相关集里的项 → 仍按强相关集兜底', async () => {
    // pickIndex=2 不在 stronglyRelevantIndexes=[0] 里 → 忽略 pickIndex，取强相关里最高(仅 0)
    const r = await pick('{"pickIndex":2,"stronglyRelevantIndexes":[0],"reason":"x"}');
    assert.equal(r.pickIndex, 0);
  });
});
