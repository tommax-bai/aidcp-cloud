import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import {
  FaithfulDraftWriterRole,
  FaithfulRewritePlannerRole,
  FidelityAuditorRole,
  ReferenceAnalyzerRole,
} from '../../src/publish-agent/roles/index.js';
import { ContentCreatorRole } from '../../src/publish-agent/roles/content-creator.js';
import type { PipelineFields, ScoutDecision, TriggerInput } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeTrigger(): TriggerInput {
  return {
    metrics: { hoursSinceLastPublish: 8, newConceptCount: 0, likedSinceLastPublish: 0 },
    generateInput: {
      concepts: [],
      likedContents: [],
      referenceNote: {
        sourceId: 'lmcache-1',
        title: 'LMCache 突破一万 star',
        body: 'LMCache 从实验室项目走向开源项目，先通过 vLLM patch 接入，后来改成 connector API，并在 agentic workload 增长后升级到多进程架构。',
        topics: ['LMCache', 'KV Cache'],
        author: 'committers',
      },
      soul: {
        identity: { name: '小林', role: 'AI 工程师', background: '做推理服务', tone: '直接' },
        interests: { primary: ['LLM'], secondary: ['推理优化'], seed_keywords: ['KV cache'] },
      },
      recentPosts: [],
    },
    recentPublished: [],
    forced: true,
    accountId: 'acc-ref',
  };
}

function registerFaithfulRoles(ctx: PipelineContext<PipelineFields>, responses: string[]) {
  const calls: string[] = [];
  const fakeLlm = {
    chat: async (messages: Array<{ content: string }>) => {
      calls.push(messages[0]?.content ?? '');
      const next = responses.shift();
      if (!next) throw new Error('unexpected llm call');
      return next;
    },
    complete: async () => '',
  };
  const common = { llmClient: fakeLlm as any, clock, logger: silentLogger };
  new ReferenceAnalyzerRole(common).register(ctx);
  new FaithfulRewritePlannerRole(common).register(ctx);
  new FaithfulDraftWriterRole(common).register(ctx);
  new FidelityAuditorRole(common).register(ctx);
  return calls;
}

describe('faithful reference rewrite roles', () => {
  test('参照稿路径：四段链路通过审核后才写入 createdContent', async () => {
    const ctx = new PipelineContext<PipelineFields>();
    const calls = registerFaithfulRoles(ctx, [
      JSON.stringify({
        title: 'LMCache 突破一万 star',
        thesis: '方向判断和工程落地促成开源认可',
        structure: ['起源', '接入演进', '架构升级'],
        keyFacts: ['vLLM patch', 'connector API', '多进程架构'],
        keyClaims: ['长期工程投入很关键'],
        entities: ['LMCache', 'vLLM'],
        timeline: ['2024 年 7 月', '2025 年 Q2-Q3'],
        mustPreserve: ['connector API 替代 patch', '多进程架构升级'],
        forbiddenAdditions: ['个人实测延迟下降数据'],
        perspective: '项目成员复盘',
      }),
      JSON.stringify({
        titleDirection: '保留 star 与工程演进',
        paragraphs: [{ source: '接入演进', rewriteGoal: '换表达保留事实', mustKeep: ['connector API 替代 patch'] }],
        styleNotes: ['口语化'],
        forbiddenAdditions: ['个人实测延迟下降数据'],
      }),
      JSON.stringify({
        title: 'LMCache 万星背后',
        content: 'LMCache 这次破万星，真正值得看的是它一路从实验室方案走到工程化接入。早期靠 vLLM patch，后来换成 connector API，再到多进程架构，核心都是围绕 KV cache 怎么被更稳定地复用。',
        tone: 'casual',
        style: { rewriteMode: 'faithful' },
      }),
      JSON.stringify({
        pass: true,
        score: 0.91,
        reason: '覆盖关键事实，未新增实测数据',
        issues: [],
        unsupportedClaims: [],
        missingKeyPoints: [],
      }),
    ]);

    ctx.write('trigger', makeTrigger());
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(calls.length, 4);
    assert.equal(ctx.get('pipelineAbort'), undefined);
    assert.equal(ctx.get('fidelityAuditReport')?.pass, true);
    const created = ctx.get('createdContent');
    assert.ok(created);
    assert.equal(created.title, 'LMCache 万星背后');
    assert.match(created.content, /connector API/);
    assert.deepEqual(created.tags, []);
    assert.equal(created.style.rewriteMode, 'faithful');
  });

  test('忠实度审核不通过：写 pipelineAbort，不产 createdContent', async () => {
    const ctx = new PipelineContext<PipelineFields>();
    registerFaithfulRoles(ctx, [
      JSON.stringify({
        title: 'T',
        thesis: 't',
        structure: [],
        keyFacts: ['事实'],
        keyClaims: [],
        entities: [],
        timeline: [],
        mustPreserve: ['事实'],
        forbiddenAdditions: ['个人实测延迟下降数据'],
        perspective: '项目成员复盘',
      }),
      JSON.stringify({ titleDirection: 'x', paragraphs: [], styleNotes: [], forbiddenAdditions: [] }),
      JSON.stringify({ title: 'T', content: '我测了下延迟直接降了58%。', tone: 'casual', style: {} }),
      JSON.stringify({
        pass: false,
        score: 0.42,
        reason: '新增原稿没有的亲历实测数据',
        issues: ['新增数据'],
        unsupportedClaims: ['我测了下延迟直接降了58%'],
        missingKeyPoints: [],
      }),
    ]);

    ctx.write('trigger', makeTrigger());
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(ctx.get('createdContent'), undefined);
    assert.equal(ctx.get('fidelityAuditReport')?.pass, false);
    assert.match(ctx.get('pipelineAbort')?.reason ?? '', /Faithful rewrite audit failed/);
    assert.match(ctx.get('pipelineAbort')?.reason ?? '', /延迟直接降了58/);
  });

  test('有 referenceNote 时 ContentCreator 即使收到 scoutDecision 也不调用 LLM', async () => {
    const scout: ScoutDecision = { shouldPublish: true, publishDirection: 'x', keyPoints: [], confidence: 1, reason: 'x', scoutedAt: 1 };
    let calls = 0;
    const fakeLlm = {
      chat: async () => {
        calls += 1;
        return JSON.stringify({ title: 'x', content: 'x', tone: 'casual', style: {} });
      },
      complete: async () => '',
    };
    const ctx = new PipelineContext<PipelineFields>();
    new ContentCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger }).register(ctx);
    ctx.write('trigger', makeTrigger());
    ctx.write('scoutDecision', scout);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(calls, 0);
    assert.equal(ctx.get('createdContent'), undefined);
  });
});
