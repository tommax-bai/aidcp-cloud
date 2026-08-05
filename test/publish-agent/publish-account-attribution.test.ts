/**
 * 发布链显式归账（change parallel-rewrite-drafts / spec publish-account-attribution）。
 * 红线：每次模型调用从当轮黑板显式带 accountId；并发生成各轮各归各账（同一角色单例服务多 context 不串账）；
 * 覆盖非角色调用点 PostProcessor.rewrite（唯一不经 roleLlm 包装的发布链模型调用）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ContentCreatorRole } from '../../src/publish-agent/roles/content-creator.js';
import { ContentCleanerRole } from '../../src/publish-agent/roles/content-cleaner.js';
import { PostProcessor } from '../../src/publish-agent/post-processor.js';
import { BANNED_PHRASES } from '../../src/publish-agent/prompts.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, TriggerInput, ScoutDecision } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeTriggerInput(accountId: string): TriggerInput {
  return {
    metrics: { hoursSinceLastPublish: 30, newConceptCount: 3, likedSinceLastPublish: 20 },
    generateInput: {
      concepts: [{ keyword: 'RAG 重排' }],
      likedContents: [],
      soul: {
        identity: { name: '小林', role: 'AI研发', background: '3年', tone: '理性' },
        interests: { primary: ['LLM'], secondary: [], seed_keywords: ['RAG'] },
        engagement_rules: { like: [], skip: [], comment_trigger: [] },
        browse_patterns: {
          mode: 'state_machine',
          states: { browse: { action: 'x', transitions: [] } },
          session: { max_duration_min: 10, max_likes: 8, max_searches: 3, cooldown_between_actions_sec: [3, 8] },
        },
      },
      recentPosts: [],
    },
    recentPublished: [],
    accountId,
  };
}

const scout: ScoutDecision = {
  shouldPublish: true,
  publishDirection: 'RAG 检索优化',
  keyPoints: ['向量切块'],
  confidence: 0.8,
  reason: '素材充足',
  scoutedAt: 1700000000000,
};

describe('publish explicit account attribution (AC)', () => {
  test('并发两轮（同一角色单例、两账号）→ 每次 LLM 调用各带各的 accountId，不串账', async () => {
    const seen: Array<string | undefined> = [];
    const fakeLlm = {
      chat: async (_m: unknown, opts?: { accountId?: string }) => {
        seen.push(opts?.accountId);
        return JSON.stringify({ title: 't', content: 'c', tags: [], tone: 'casual', style: {} });
      },
      complete: async () => '',
    };
    const role = new ContentCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });

    const ctxA = new PipelineContext<PipelineFields>();
    const ctxB = new PipelineContext<PipelineFields>();
    ctxA.write('trigger', makeTriggerInput('acct-A'));
    ctxB.write('trigger', makeTriggerInput('acct-B'));
    role.register(ctxA);
    role.register(ctxB);
    // 并发激活两轮（同一 tick 写入两个 context 的 scoutDecision）。
    ctxA.write('scoutDecision', scout);
    ctxB.write('scoutDecision', scout);
    await new Promise((r) => setTimeout(r, 50));

    // 正文长度确定性闸（change fb-publish-fill-deadline 5.3b）会对离谱长度带纠正说明重写一次，
    // 而本 mock 的正文只有 1 个字 ⇒ 每轮不止一次调用。本用例的红线是「**每次**模型调用都带当轮账号」，
    // 所以断言要把重写那一次也覆盖进去，而不是把调用数掰回 1（那等于让红线绕开新增的调用点）。
    assert.ok(seen.length >= 2, '两轮至少各一次调用');
    assert.equal(seen.filter((id) => id === undefined).length, 0, '绝无 default / 缺账号的调用');
    assert.deepEqual([...new Set(seen)].sort(), ['acct-A', 'acct-B'], '只出现这两个账号，绝无串账');
    assert.equal(
      seen.filter((id) => id === 'acct-A').length,
      seen.filter((id) => id === 'acct-B').length,
      '两轮调用次数对称——不对称说明某一轮的调用被记到了另一轮账上',
    );
  });

  test('PostProcessor.rewrite 显式收到当轮账号（非角色调用点覆盖）', async () => {
    let rewriteAccount: string | undefined;
    const pp = new PostProcessor({
      rewriteThreshold: 1,
      rewrite: async (content, _flagged, accountId) => {
        rewriteAccount = accountId;
        return content.replaceAll(BANNED_PHRASES[0], '');
      },
    });
    await pp.process(`开头${BANNED_PHRASES[0]}结尾`, 1, 'acct-X');
    assert.equal(rewriteAccount, 'acct-X', '重写调用带当轮账号记账');
  });

  test('ContentCleanerRole 把黑板账号穿给 postProcessor.process', async () => {
    let seenAccount: string | undefined;
    const role = new ContentCleanerRole({
      postProcessor: {
        process: async (content, _ex, accountId) => {
          seenAccount = accountId;
          return { content, aiScore: 0, rewritten: false, flaggedPhrases: [] };
        },
      },
      clock,
      logger: silentLogger,
    });
    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', makeTriggerInput('acct-C'));
    role.register(ctx);
    ctx.write('createdContent', { title: 't', content: 'c', tags: [], tone: 'casual', style: {}, createdAt: clock() });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(seenAccount, 'acct-C');
  });
});
