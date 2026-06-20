import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, ScoutDecision, ContentType } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';

/**
 * ContentTypeSelector — 内容类型决策（A 阶段2 新增）。
 * 现恒图文（kind 联合预留 video/text）；实体化为真实角色，不在别处硬编码"一律图文"绕过（spec 红线）。
 * 守卫：仅 shouldPublish=true 才产出（与 ContentCreator 一致），shouldPublish=false 时不写键、由 Scout 短路。
 */
export class ContentTypeSelectorRole extends BasePublishRole<ScoutDecision, ContentType> {
  readonly config: RoleConfig = {
    name: 'ContentTypeSelector',
    watchKeys: ['scoutDecision'],
    timeoutMs: 5000,
    fallback: 'default',
  };
  protected readonly outputKey = 'contentType' as const;

  protected override shouldActivate(snapshot: Partial<PipelineFields>): boolean {
    return snapshot.scoutDecision?.shouldPublish === true;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): ScoutDecision {
    return snapshot.scoutDecision!;
  }

  protected async execute(_input: ScoutDecision, _context: PipelineContext<PipelineFields>): Promise<ContentType> {
    // 现阶段恒图文；将来按 ScoutDecision/平台能力决定 video/text。
    return { kind: 'image_text', selectedAt: this.clock() };
  }

  protected override getDefaultOutput(): ContentType {
    return { kind: 'image_text', selectedAt: this.clock() };
  }
}
