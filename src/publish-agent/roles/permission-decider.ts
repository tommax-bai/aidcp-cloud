import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, PermissionDecision } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';

/**
 * PermissionDecider — 评论/保存权限决策（A 阶段3 元数据角色，纯规则、确定性、不调 LLM）。
 *
 * 人设为公开技术分享、鼓励互动：刻意（非静默缺省）放开评论与保存。
 *   comment='allow'、save='allow'。
 * 红线：allow 必须是 execute 的刻意产出；getDefaultOutput 才是保守默认
 *       （comment='disable'、save='disable'——降级时宁可全关，也不擅自放开）。
 * execute 纯规则、确定性、不抛异常，必写键（防 waitAll 死锁）。
 */
export class PermissionDeciderRole extends BasePublishRole<CreatedContent, PermissionDecision> {
  readonly config: RoleConfig = {
    name: 'PermissionDecider',
    watchKeys: ['createdContent'],
    timeoutMs: 5000,
    fallback: 'default',
  };
  protected readonly outputKey = 'permissionDecision' as const;

  protected extractInput(snapshot: Partial<PipelineFields>): CreatedContent {
    return snapshot.createdContent!;
  }

  protected async execute(
    _input: CreatedContent,
    _context: PipelineContext<PipelineFields>
  ): Promise<PermissionDecision> {
    // 人设鼓励互动：刻意（非静默缺省）放开评论与保存。
    return {
      comment: 'allow',
      save: 'allow',
      decidedAt: this.clock(),
    };
  }

  /** 降级保守默认：评论/保存全关（绝不隐式放开）。 */
  protected override getDefaultOutput(): PermissionDecision {
    return {
      comment: 'disable',
      save: 'disable',
      decidedAt: this.clock(),
    };
  }
}
