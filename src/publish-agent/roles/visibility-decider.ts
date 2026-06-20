import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, VisibilityDecision } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';

/**
 * VisibilityDecider — 可见范围决策（A 阶段3 元数据角色，纯规则、确定性、不调 LLM）。
 *
 * 人设为「公开技术分享」：刻意决定 visibility='public'，reason 写明这是刻意决策、非静默缺省。
 * 红线：public 必须是 execute 的刻意产出；getDefaultOutput 才是保守 self_only
 *       （绝不把 public 当隐式缺省；降级时宁可只对自己可见，也不擅自公开）。
 * execute 纯规则、确定性、不抛异常，必写键（防 waitAll 死锁）。
 */
export class VisibilityDeciderRole extends BasePublishRole<CreatedContent, VisibilityDecision> {
  readonly config: RoleConfig = {
    name: 'VisibilityDecider',
    watchKeys: ['createdContent'],
    timeoutMs: 5000,
    fallback: 'default',
  };
  protected readonly outputKey = 'visibilityDecision' as const;

  protected extractInput(snapshot: Partial<PipelineFields>): CreatedContent {
    return snapshot.createdContent!;
  }

  protected async execute(
    _input: CreatedContent,
    _context: PipelineContext<PipelineFields>
  ): Promise<VisibilityDecision> {
    // 人设定位为公开技术分享：刻意（非静默缺省）决定公开可见。
    return {
      visibility: 'public',
      reason: '人设为公开技术分享，刻意决定公开可见（deliberate decision, not a silent default）',
      decidedAt: this.clock(),
    };
  }

  /** 降级保守默认：self_only（绝不隐式 public）。 */
  protected override getDefaultOutput(): VisibilityDecision {
    return {
      visibility: 'self_only',
      reason: '降级保守默认：仅自己可见（fallback, never implicitly public）',
      decidedAt: this.clock(),
    };
  }
}
