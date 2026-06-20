import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, LocationSelection } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';

/**
 * LocationStrategist — 地点决策（A 阶段3 元数据，纯 cloud、规则式确定性、不调 LLM）。
 * 本阶段无地点源（无 GPS / 无平台 POI 候选 / 无用户指定）→ 恒回 null。
 * 红线：不编造、不凑数；无数据则诚实回 null，绝不伪造一个地点。
 * fallback:'default' + getDefaultOutput 保证必写键（防 waitAll 死锁）；execute 纯规则、不抛。
 */
export class LocationStrategistRole extends BasePublishRole<CreatedContent, LocationSelection> {
  readonly config: RoleConfig = {
    name: 'LocationStrategist',
    watchKeys: ['createdContent'],
    timeoutMs: 5000,
    fallback: 'default',
  };
  protected readonly outputKey = 'locationSelection' as const;

  protected extractInput(snapshot: Partial<PipelineFields>): CreatedContent {
    return snapshot.createdContent!;
  }

  protected async execute(
    _input: CreatedContent,
    _context: PipelineContext<PipelineFields>,
  ): Promise<LocationSelection> {
    // 本阶段无地点源 → 诚实回 null（不编造）。
    return { selectedLocation: null, selectedAt: this.clock() };
  }

  protected override getDefaultOutput(): LocationSelection {
    return { selectedLocation: null, selectedAt: this.clock() };
  }
}
