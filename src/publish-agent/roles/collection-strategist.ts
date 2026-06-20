import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, CollectionSelection } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';

/**
 * CollectionStrategist — 合集决策（A 阶段3 元数据角色，纯规则、确定性、不调 LLM）。
 * 本阶段无合集源（无可选合集列表 / 平台合集 API 未接线）→ 恒回 null，绝不编造凑数（spec 红线）。
 * 规则式 execute 永不抛、必写键（fallback:'default' 不兜底，防 waitAll 死锁）。
 */
export class CollectionStrategistRole extends BasePublishRole<CreatedContent, CollectionSelection> {
  readonly config: RoleConfig = {
    name: 'CollectionStrategist',
    watchKeys: ['createdContent'],
    timeoutMs: 5000,
    fallback: 'default',
  };
  protected readonly outputKey = 'collectionSelection' as const;

  protected extractInput(snapshot: Partial<PipelineFields>): CreatedContent {
    return snapshot.createdContent!;
  }

  protected async execute(
    _input: CreatedContent,
    _context: PipelineContext<PipelineFields>
  ): Promise<CollectionSelection> {
    // 本阶段无合集源：不编造，诚实回 null。将来接入平台合集列表后按内容主题匹配。
    return { selectedCollection: null, selectedAt: this.clock() };
  }

  protected override getDefaultOutput(): CollectionSelection {
    return { selectedCollection: null, selectedAt: this.clock() };
  }
}
