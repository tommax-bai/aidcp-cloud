import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, PublishModeDecision } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { XHS_SCHEDULE_MAX_AHEAD_MS, XHS_SCHEDULE_MIN_AHEAD_MS } from '../../kernel/schedule-policy.js';

/**
 * 校验定时发布时间：必须「未来至少 1h 且 ≤14 天」，否则返回 null（不接受非法定时）。
 * 纯函数，确定性，供将来 scheduled 模式接线复用；本阶段默认 immediate 不调用。
 * @param publishTime 期望的发布时间戳（毫秒）；null/非有限值即无效。
 * @param now 当前时间戳（毫秒）。
 * @returns 合法则返回 publishTime；否则返回 null。
 */
export function clampScheduledTime(publishTime: number | null, now: number): number | null {
  if (publishTime === null || !Number.isFinite(publishTime)) return null;
  if (publishTime - now < XHS_SCHEDULE_MIN_AHEAD_MS) return null;
  if (publishTime - now > XHS_SCHEDULE_MAX_AHEAD_MS) return null;
  return publishTime;
}

/**
 * PublishModeDecider — 发布方式决策（A 阶段3 元数据，纯规则、确定性、不调 LLM）。
 * 规则：本阶段默认 mode='immediate'、publishTime=null（不定时）。
 * 定时（scheduled）的「未来 1 小时至 14 天」校验由纯函数 clampScheduledTime 实现，供审批编辑与下发共用。
 * 红线：不编造时间——非定时一律 publishTime=null。
 * 降级（getDefaultOutput）：保守取 'draft'（不自动发出去），publishTime=null。
 */
export class PublishModeDeciderRole extends BasePublishRole<CreatedContent, PublishModeDecision> {
  readonly config: RoleConfig = {
    name: 'PublishModeDecider',
    watchKeys: ['createdContent'],
    timeoutMs: 5000,
    fallback: 'default',
  };
  protected readonly outputKey = 'publishModeDecision' as const;

  protected extractInput(snapshot: Partial<PipelineFields>): CreatedContent {
    return snapshot.createdContent!;
  }

  protected async execute(
    _input: CreatedContent,
    _context: PipelineContext<PipelineFields>
  ): Promise<PublishModeDecision> {
    // 本阶段默认立即发布、不定时。将来如支持 scheduled，用 clampScheduledTime 校验 publishTime。
    return { mode: 'immediate', publishTime: null, decidedAt: this.clock() };
  }

  protected override getDefaultOutput(): PublishModeDecision {
    // 保守降级：草稿（不自动发布），不定时。
    return { mode: 'draft', publishTime: null, decidedAt: this.clock() };
  }
}
