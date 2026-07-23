import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGatekeeperRole } from '../../src/publish-agent/roles/approval-gatekeeper.js';
import {
  QualityScorerRole,
  ImageSetPlannerRole,
  ImagePromptComposerRole,
  ContentScoutRole,
  ContentCreatorRole,
  ReferenceAnalyzerRole,
  FaithfulRewritePlannerRole,
  FaithfulDraftWriterRole,
  FidelityAuditorRole,
  TitleCreatorRole,
  TopicGeneratorRole,
  TopicEvaluatorRole,
  CLEAN_TIMEOUT_MS,
} from '../../src/publish-agent/roles/index.js';
import { PublishOrchestrator } from '../../src/publish-agent/index.js';

/**
 * change raise-model-call-timeouts-for-thinking-models — 守护 publish-pipeline spec 的新不变量：
 * ① 任何调用模型的发布角色，其执行超时（角色闸）MUST ≥ 单次模型调用天花板；
 * ② 发布流水线总闸 MUST ≥ 每个模型角色闸（容器不得小于其内容物）。
 * 这直接拦住我们本次修复的那类退化（如某角色闸 15/20/30s 短于模型峰值 → 每次合法慢调用误触降级）。
 */

// 单次模型调用天花板（qwen.ts 构造默认 / server.ts AIDCP_LLM_TIMEOUT_MS）。
const LLM_CEILING_MS = 180_000;

const stubLlm = { chat: async () => '{}', complete: async () => '' } as any;
const logger = { log() {}, warn() {}, error() {} };

// 所有「调用模型」的发布角色（决策/投影类纯逻辑角色不调模型、不在此列）。
const llmRoles = [
  new ApprovalGatekeeperRole({ llmClient: stubLlm, logger }),
  new QualityScorerRole({ llmClient: stubLlm, logger }),
  new ImageSetPlannerRole({ llmClient: stubLlm, logger }),
  new ImagePromptComposerRole({ llmClient: stubLlm, logger }),
  new ContentScoutRole({ llmClient: stubLlm, logger }),
  new ContentCreatorRole({ llmClient: stubLlm, logger }),
  new ReferenceAnalyzerRole({ llmClient: stubLlm, logger }),
  new FaithfulRewritePlannerRole({ llmClient: stubLlm, logger }),
  new FaithfulDraftWriterRole({ llmClient: stubLlm, logger }),
  new FidelityAuditorRole({ llmClient: stubLlm, logger }),
  new TitleCreatorRole({ llmClient: stubLlm, logger }),
  // change split-topic-roles：话题生成/评判两 LLM 角色，同受 ≥180s 超时下限约束。
  new TopicGeneratorRole({ llmClient: stubLlm, logger }),
  new TopicEvaluatorRole({ llmClient: stubLlm, logger }),
] as any[];

test('调用模型的发布角色：角色闸 ≥ 单次模型调用天花板（不短于所包裹的模型预算）', () => {
  for (const r of llmRoles) {
    const { name, timeoutMs } = r.config;
    assert.ok(
      timeoutMs >= LLM_CEILING_MS,
      `${name} 角色闸 ${timeoutMs}ms 短于单次模型天花板 ${LLM_CEILING_MS}ms → 合法慢调用会被角色秒表提前掐断走降级`,
    );
  }
  // ContentCleaner 的模型调用在 server 注入的 postProcessor.rewrite 里，超时收在 CLEAN_TIMEOUT_MS（角色闸与该调用共读）。
  assert.ok(CLEAN_TIMEOUT_MS >= LLM_CEILING_MS, `CLEAN_TIMEOUT_MS ${CLEAN_TIMEOUT_MS}ms 短于单次模型天花板`);
});

test('发布流水线总闸（默认）≥ 每个模型角色闸（容器不得小于其内容物）', () => {
  const orch = new PublishOrchestrator({ logger }) as any;
  const pipelineMs = orch.pipelineTimeoutMs;
  for (const r of llmRoles) {
    assert.ok(
      pipelineMs >= r.config.timeoutMs,
      `总闸 ${pipelineMs}ms < 角色闸 ${r.config.name} ${r.config.timeoutMs}ms → 该角色的诚实降级永不可达`,
    );
  }
  assert.ok(pipelineMs >= CLEAN_TIMEOUT_MS, `总闸 ${pipelineMs}ms < CLEAN_TIMEOUT_MS ${CLEAN_TIMEOUT_MS}ms`);
});
