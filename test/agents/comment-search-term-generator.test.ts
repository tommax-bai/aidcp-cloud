/**
 * CommentSearchTermGenerator 单测（change comment-search-command，新角色①）。
 * 覆盖：精选样本出词、解析空/LLM 降级退回种子词、种子也空诚实返回空、有序去重 + 上限、source 标注。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommentSearchTermGenerator } from '../../src/agents/comment-search-term-generator.js';
import type { CuratedSampleForTerms } from '../../src/agents/comment-search-term-generator.js';
import type { Soul } from '../../src/kernel/soul-types.js';

const soul: Soul = {
  identity: { name: 'TestBot', role: 'AI研发工程师', background: '技术博主', tone: '理性' },
  interests: { primary: ['LLM Agent', 'RAG'], secondary: ['推理优化'], seed_keywords: ['vLLM 部署', 'Prompt 技巧'] },
};

interface RunOpts {
  llmRaw?: string;
  llmThrows?: boolean;
  maxTerms?: number;
  samples?: CuratedSampleForTerms[];
  soulOverride?: Soul;
}

async function run(opts: RunOpts = {}) {
  let prompt = '';
  const role = new CommentSearchTermGenerator({
    soul: opts.soulOverride ?? soul,
    maxTerms: opts.maxTerms,
    llm: {
      complete: async (p) => {
        prompt = p;
        if (opts.llmThrows) throw new Error('llm down');
        return opts.llmRaw ?? '{"terms":["RAG 实战","Agent 框架","向量检索"],"source":"curated"}';
      },
    },
  });
  const result = await role.generate(opts.samples ?? []);
  return { result, prompt };
}

describe('CommentSearchTermGenerator 搜索词生成', () => {
  it('有精选样本 + 正常 LLM → 返回解析词、source=mixed（有精选且有种子词）', async () => {
    const { result } = await run({ samples: [{ title: 'Claude Code 实战' }, { title: 'RAG 工程化' }] });
    assert.deepEqual(result.terms, ['RAG 实战', 'Agent 框架', '向量检索']);
    assert.equal(result.source, 'mixed');
  });

  it('无精选样本 → prompt 提示无样本，source=persona', async () => {
    const { result, prompt } = await run({ samples: [] });
    assert.equal(result.source, 'persona');
    assert.match(prompt, /暂无精选样本/);
  });

  it('解析空（坏输出）→ 退回人设种子词、source=persona', async () => {
    const { result } = await run({ llmRaw: '这不是JSON', samples: [{ title: '某标题' }] });
    assert.deepEqual(result.terms, ['vLLM 部署', 'Prompt 技巧']);
    assert.equal(result.source, 'persona');
  });

  it('LLM 降级（抛错）→ 退回种子词、不抛', async () => {
    const { result } = await run({ llmThrows: true });
    assert.deepEqual(result.terms, ['vLLM 部署', 'Prompt 技巧']);
    assert.equal(result.source, 'persona');
  });

  it('解析失败且种子词也空 → 诚实返回空集（不编造）', async () => {
    const emptySeedSoul: Soul = { ...soul, interests: { primary: ['X'], secondary: [], seed_keywords: [] } };
    const { result } = await run({ llmThrows: true, soulOverride: emptySeedSoul });
    assert.deepEqual(result.terms, []);
  });

  it('有序去重 + 上限 maxTerms', async () => {
    const { result } = await run({
      maxTerms: 2,
      llmRaw: '{"terms":["A","A","B","C"],"source":"curated"}',
      samples: [{ title: 't' }],
    });
    assert.deepEqual(result.terms, ['A', 'B']);
  });

  it('非字符串数组的 terms → 视为空 → 退回种子词', async () => {
    const { result } = await run({ llmRaw: '{"terms":"不是数组","source":"x"}' });
    assert.deepEqual(result.terms, ['vLLM 部署', 'Prompt 技巧']);
  });
});
