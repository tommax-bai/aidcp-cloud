import crypto from 'node:crypto';
import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { ImageDirective, PipelineFields, TriggerInput } from '../types.js';
import type { FacebookPublishMediaStore } from '../facebook-publish-media-store.js';

export interface FacebookMediaSelectorDeps {
  mediaStore: Pick<FacebookPublishMediaStore, 'reserveNext'>;
  clock?: () => number;
  idGen?: () => string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * Facebook publish MVP uses manually uploaded account media.
 * This role only activates for trigger.platform=facebook and writes imageDirective
 * directly from a reserved account media set. It never calls image models.
 */
export class FacebookMediaSelectorRole extends BasePublishRole<TriggerInput, ImageDirective> {
  readonly config: RoleConfig = {
    name: 'FacebookMediaSelector',
    watchKeys: ['trigger'],
    timeoutMs: 15_000,
    fallback: 'skip',
  };
  protected readonly outputKey = 'imageDirective' as const;
  private readonly mediaStore: Pick<FacebookPublishMediaStore, 'reserveNext'>;
  private readonly idGen: () => string;

  constructor(deps: FacebookMediaSelectorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.mediaStore = deps.mediaStore;
    this.idGen = deps.idGen ?? (() => crypto.randomBytes(8).toString('hex'));
  }

  protected override shouldActivate(snapshot: Partial<PipelineFields>): boolean {
    return snapshot.trigger?.platform === 'facebook';
  }

  protected extractInput(snapshot: Partial<PipelineFields>): TriggerInput {
    return snapshot.trigger!;
  }

  protected async execute(input: TriggerInput): Promise<ImageDirective> {
    const accountId = input.accountId ?? 'default';
    const reservationId = `fb-publish-${accountId}-${this.clock()}-${this.idGen()}`;
    const set = await this.mediaStore.reserveNext(accountId, reservationId);
    if (!set || set.images.length === 0) {
      this.logger.warn(`[FacebookMediaSelector] account=${accountId} no available media set`);
      return this.emptyDirective();
    }
    const imageUrls = set.images.map((img) => img.url).filter(Boolean);
    return {
      imagePrompt: null,
      imageUrls,
      imageUrl: imageUrls[0] ?? null,
      imageStyle: null,
      fallbackStrategy: 'skip',
      facebookMediaReservation: {
        setId: set.id,
        reservationId,
        imageIds: set.images.map((img) => img.id),
      },
      directedAt: this.clock(),
    };
  }

  protected override getDefaultOutput(): ImageDirective {
    return this.emptyDirective();
  }

  private emptyDirective(): ImageDirective {
    return {
      imagePrompt: null,
      imageUrls: [],
      imageUrl: null,
      imageStyle: null,
      fallbackStrategy: 'skip',
      directedAt: this.clock(),
    };
  }
}
