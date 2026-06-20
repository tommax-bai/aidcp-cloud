import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, AssembledContent, ComplianceDecision, Compliance } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';

/**
 * AI 味强制阈值（2026 合规硬规）：aiScore 超过此值即强制 AI 声明。
 * 不可被外部覆盖（硬编码模块常量）。
 */
export const AI_FLAVOR_THRESHOLD = 0.6;

/**
 * 命中即强制 AI 声明的关键词（不可被外部覆盖）。
 * 涵盖「AI 生成 / AIGC / 人工智能生成 / AI 合成 / AI 绘」等显式声明。
 */
export const AI_KEYWORD_PATTERN = /AI\s*生成|AIGC|人工智能生成|AI\s*合成|AI\s*绘/;

/**
 * ComplianceDecider — 合规决策（A 阶段3，2026 合规红线核心）。
 * 纯规则、确定性、不调 LLM、不抛异常。
 *
 * 硬规：当 assembledContent.aiScore > AI_FLAVOR_THRESHOLD（0.6）
 *   **或** finalContent 命中 AI 关键词 → 强制 compliance.ai=true 且 aiEnforced=true（审计 warn）。
 * 否则 ai 不强制（不设/false）、aiEnforced 缺省。
 * 优先级 ai > ad > origin（本阶段 ad/origin 暂不主动置，留字段）。
 * 红线：不伪造 ai=false 抹除真实风险；无法判定时回 compliance:{}（不乱置 true，也不假阴）。
 */
export class ComplianceDeciderRole extends BasePublishRole<AssembledContent, ComplianceDecision> {
  readonly config: RoleConfig = {
    name: 'ComplianceDecider',
    watchKeys: ['assembledContent'],
    timeoutMs: 5000,
    fallback: 'default',
  };
  protected readonly outputKey = 'complianceDecision' as const;

  protected extractInput(snapshot: Partial<PipelineFields>): AssembledContent {
    return snapshot.assembledContent!;
  }

  protected async execute(
    input: AssembledContent,
    _context: PipelineContext<PipelineFields>
  ): Promise<ComplianceDecision> {
    const compliance: Compliance = {};

    const aiScore = typeof input?.aiScore === 'number' ? input.aiScore : 0;
    const finalContent = typeof input?.finalContent === 'string' ? input.finalContent : '';

    const scoreExceeded = aiScore > AI_FLAVOR_THRESHOLD;
    const keywordHit = AI_KEYWORD_PATTERN.test(finalContent);

    if (scoreExceeded || keywordHit) {
      // 红线强制：含 AI 生成则强制声明，aiEnforced 置位后不可降。
      compliance.ai = true;
      compliance.aiEnforced = true;
      this.logger.warn(
        `[ComplianceDecider] AI declaration enforced (aiScore=${aiScore}, scoreExceeded=${scoreExceeded}, keywordHit=${keywordHit})`
      );
    }
    // 否则 ai 不强制（留缺省）；ad/origin 本阶段不主动置，留字段。

    return { compliance, decidedAt: this.clock() };
  }

  protected override getDefaultOutput(): ComplianceDecision {
    // 保守：无法判定时回空 compliance（不伪造 ai=false 抹除真实风险，也不乱置 true）。
    return { compliance: {}, decidedAt: this.clock() };
  }
}
