/**
 * Bridges a real curated source admission into the existing reference rewrite
 * pipeline for the account's lifetime first-post onboarding.
 */

import type { CuratedSourceAdmission } from '../cache/curated-content-store.js';
import type { BeginRewriteResult, ReferenceNote } from '../kernel/publish-generation-types.js';

/**
 * 首作引导的**认领三方法**窄端口（change cloud-coupling-phase4-runtime-ports）。
 * 实现在 api 的 FirstPostOnboardingStore；本文件（content）只按端口引，不再 import 那个实现。
 * 端口刻意零 pg 泄漏：没有 Pool、没有 SchemaEnsurer、没有 DDL 常量。
 */
export interface FirstPostOnboardingClaimPort {
  claim(accountId: string, sourceId: string): Promise<boolean>;
  release(accountId: string, sourceId: string, reason: string): Promise<boolean>;
  complete(accountId: string, sourceId: string): Promise<boolean>;
}

export interface FirstPostOnboardingCoordinatorDeps {
  store: FirstPostOnboardingClaimPort;
  countPendingForAccount: (accountId: string) => Promise<number>;
  beginRewrite: (
    accountId: string,
    referenceNote: ReferenceNote,
    opts: { dbPendingCount: number },
  ) => BeginRewriteResult;
  onStateChanged?: (accountId: string) => void | Promise<void>;
  logger?: Pick<Console, 'log' | 'warn'>;
}

const PRODUCED_ARTIFACT_STATES = new Set(['pending_approval', 'draft', 'published']);

export class FirstPostOnboardingCoordinator {
  private readonly logger: Pick<Console, 'log' | 'warn'>;

  constructor(private readonly deps: FirstPostOnboardingCoordinatorDeps) {
    this.logger = deps.logger ?? console;
  }

  private notifyStateChanged(accountId: string): void {
    if (!this.deps.onStateChanged) return;
    try {
      void Promise.resolve(this.deps.onStateChanged(accountId)).catch((err) => {
        this.logger.warn(`[first-post] state projection failed account=${accountId}: ${(err as Error).message}`);
      });
    } catch (err) {
      this.logger.warn(`[first-post] state projection failed account=${accountId}: ${(err as Error).message}`);
    }
  }

  async onSourceAdmitted(source: CuratedSourceAdmission): Promise<void> {
    const { accountId, sourceId } = source;
    let claimed = false;
    try {
      claimed = await this.deps.store.claim(accountId, sourceId);
    } catch (err) {
      this.logger.warn(`[first-post] claim failed account=${accountId} source=${sourceId}: ${(err as Error).message}`);
      return;
    }
    if (!claimed) return;
    this.notifyStateChanged(accountId);

    const release = async (reason: string): Promise<void> => {
      try {
        await this.deps.store.release(accountId, sourceId, reason);
        this.notifyStateChanged(accountId);
      } catch (err) {
        this.logger.warn(`[first-post] release failed account=${accountId} source=${sourceId}: ${(err as Error).message}`);
      }
    };

    let begin: BeginRewriteResult;
    try {
      const dbPendingCount = await this.deps.countPendingForAccount(accountId);
      const referenceNote: ReferenceNote = {
        sourceId,
        title: source.title ?? '',
        body: source.body,
        topics: source.topics,
        accountId,
        capturedAt: Date.now(),
        ...(source.author ? { author: source.author } : {}),
        ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
        ...(source.referenceImages.length > 0 ? { images: source.referenceImages } : {}),
        ...(source.textCardTranscription ? { textCardTranscription: source.textCardTranscription } : {}),
      };
      begin = this.deps.beginRewrite(accountId, referenceNote, { dbPendingCount });
    } catch (err) {
      await release(`trigger_error:${(err as Error).message}`);
      return;
    }

    if (!begin.started) {
      await release(`claim_rejected:${begin.reason}`);
      return;
    }

    try {
      const outcome = await begin.outcome;
      if (outcome.result === 'triggered' && PRODUCED_ARTIFACT_STATES.has(outcome.status)) {
        await this.deps.store.complete(accountId, sourceId);
        this.notifyStateChanged(accountId);
        this.logger.log(`[first-post] first draft produced account=${accountId} source=${sourceId} status=${outcome.status}`);
        return;
      }
      const detail = outcome.result === 'triggered'
        ? `${outcome.status}:${outcome.failureReason ?? 'no_artifact'}`
        : `${outcome.result}:${outcome.reason}`;
      await release(detail);
    } catch (err) {
      await release(`outcome_error:${(err as Error).message}`);
    }
  }
}
