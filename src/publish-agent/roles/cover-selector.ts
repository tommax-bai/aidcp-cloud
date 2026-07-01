import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, ImageDirective, CoverSelection } from '../types.js';

/**
 * CoverSelector — 封面选择（change publish-multi-image：单图直选 → 透传图集，封面恒取首张）。
 * 读 imageDirective.imageUrls：透传全集、封面 = imageUrls[0]（成功序列首张 = 钩子图）。
 * 无图（空数组）→ 诚实回 {imageUrls:[], hasCover:false}，绝不选占位图 / 谎报 hasCover（红线）。
 * 本期不引入封面索引、不做封面美学选择（YAGNI，留待边缘设封面校准那期）。
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

  protected async execute(input: ImageDirective): Promise<CoverSelection> {
    const imageUrls = input.imageUrls ?? [];
    return { imageUrls, hasCover: imageUrls.length > 0, selectedAt: this.clock() };
  }

  protected override getDefaultOutput(): CoverSelection {
    return { imageUrls: [], hasCover: false, selectedAt: this.clock() };
  }
}
