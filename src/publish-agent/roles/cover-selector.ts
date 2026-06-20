import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, ImageDirective, CoverSelection } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';

/**
 * CoverSelector — 封面选择（A 阶段2 新增）。
 * 单图直选；无图（imageDirective.imageUrl===null）→ 诚实回 {imageUrl:null, hasCover:false}，
 * 绝不选占位图 / 谎报 hasCover（spec 红线）。多图选择逻辑留接口。
 */
export class CoverSelectorRole extends BasePublishRole<ImageDirective, CoverSelection> {
  readonly config: RoleConfig = {
    name: 'CoverSelector',
    watchKeys: ['imageDirective'],
    timeoutMs: 5000,
    fallback: 'default',
  };
  protected readonly outputKey = 'coverSelection' as const;

  protected extractInput(snapshot: Partial<PipelineFields>): ImageDirective {
    return snapshot.imageDirective!;
  }

  protected async execute(input: ImageDirective, _context: PipelineContext<PipelineFields>): Promise<CoverSelection> {
    if (input.imageUrl) {
      return { imageUrl: input.imageUrl, hasCover: true, selectedAt: this.clock() };
    }
    // 无图：诚实回报，不伪造封面。
    return { imageUrl: null, hasCover: false, selectedAt: this.clock() };
  }

  protected override getDefaultOutput(): CoverSelection {
    return { imageUrl: null, hasCover: false, selectedAt: this.clock() };
  }
}
