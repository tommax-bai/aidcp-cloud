import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, TriggerInput } from '../types.js';
import type { ReferenceVisualAnalysis } from '../visual-reference-types.js';
import { VISUAL_ANALYSIS_SCHEMA_VERSION } from '../visual-reference-types.js';
import type { VisualReferenceAnalyzer } from '../visual-reference-analyzer.js';

const VISUAL_ANALYZER_ROLE_TIMEOUT_MS = Number(process.env.AIDCP_REFERENCE_VISUAL_ROLE_TIMEOUT_MS ?? 300_000);

export class VisualReferenceAnalyzerRole extends BasePublishRole<TriggerInput, ReferenceVisualAnalysis> {
  readonly config: RoleConfig = {
    name: 'VisualReferenceAnalyzer',
    watchKeys: ['trigger'],
    timeoutMs: VISUAL_ANALYZER_ROLE_TIMEOUT_MS,
    fallback: 'default',
  };
  protected readonly outputKey = 'referenceVisualAnalysis' as const;

  constructor(
    private readonly analyzer: VisualReferenceAnalyzer,
    deps: { clock?: () => number; logger?: Pick<Console, 'log' | 'warn' | 'error'> } = {},
  ) {
    super(deps);
  }

  protected extractInput(snapshot: Partial<PipelineFields>): TriggerInput {
    return snapshot.trigger!;
  }

  protected async execute(input: TriggerInput): Promise<ReferenceVisualAnalysis> {
    const ref = input.generateInput.referenceNote;
    if (!ref?.images?.length) return this.none();
    return this.analyzer.analyze({
      curatedContentId: ref.curatedContentId ?? null,
      accountId: ref.accountId ?? input.accountId ?? 'default',
      sourceId: ref.sourceId,
      images: ref.images,
      cached: ref.visualAnalysis,
    });
  }

  protected override getDefaultOutput(): ReferenceVisualAnalysis {
    return this.none('analyzer role failed');
  }

  private none(error?: string): ReferenceVisualAnalysis {
    return {
      status: error ? 'unavailable' : 'none',
      schemaVersion: VISUAL_ANALYSIS_SCHEMA_VERSION,
      cacheKey: null,
      provider: null,
      model: null,
      analyzedAt: null,
      sourceCount: 0,
      ...(error ? { error } : {}),
    };
  }
}
