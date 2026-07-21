import type { ClientUserStore } from '../client-auth/client-user-store.js';
import type {
  AdsPowerAdminApi,
  AdsPowerFailureReason,
} from './admin-api.js';

export type DirectEnvironmentDeletionFailureReason =
  | 'not_found'
  | 'already_deleted'
  | 'adspower_key_missing'
  | 'deletion_in_progress'
  | AdsPowerFailureReason
  | 'adspower_delete_failed'
  | 'persistence_failed';

export interface DirectEnvironmentDeletionView {
  requestId: string;
  version: number;
  envKey: string;
  platform: string | null;
  targetUserId: string | null;
  state: 'deleting' | 'delete_failed' | 'deleted';
  resultKind: 'deleted' | 'already_missing' | null;
  idempotent: boolean;
}

export type DirectEnvironmentDeletionResult =
  | { ok: true; deletion: DirectEnvironmentDeletionView }
  | { ok: false; reason: DirectEnvironmentDeletionFailureReason; deletion?: DirectEnvironmentDeletionView };

export interface EnvironmentDeletionServiceOptions {
  store: Pick<ClientUserStore, 'beginDirectEnvironmentDeletion' | 'finishDirectEnvironmentDeletion'>;
  adsPower: Pick<AdsPowerAdminApi, 'deleteProfile' | 'profileExists'>;
  getApiKey: () => Promise<string | null>;
}

function failedView(
  begin: Extract<Awaited<ReturnType<ClientUserStore['beginDirectEnvironmentDeletion']>>, { ok: true }>,
): DirectEnvironmentDeletionView {
  return {
    requestId: begin.requestId,
    version: begin.version,
    envKey: begin.envKey,
    platform: begin.platform,
    targetUserId: begin.targetUserId,
    state: 'delete_failed',
    resultKind: null,
    idempotent: begin.idempotent,
  };
}

export class EnvironmentDeletionService {
  private readonly store: EnvironmentDeletionServiceOptions['store'];
  private readonly adsPower: EnvironmentDeletionServiceOptions['adsPower'];
  private readonly getApiKey: EnvironmentDeletionServiceOptions['getApiKey'];

  constructor(options: EnvironmentDeletionServiceOptions) {
    this.store = options.store;
    this.adsPower = options.adsPower;
    this.getApiKey = options.getApiKey;
  }

  async delete(envKey: string, requestedBy: string, idempotencyKey: string): Promise<DirectEnvironmentDeletionResult> {
    const apiKey = (await this.getApiKey().catch(() => null))?.trim() || null;
    if (!apiKey) return { ok: false, reason: 'adspower_key_missing' };

    const begin = await this.store.beginDirectEnvironmentDeletion(envKey, requestedBy, idempotencyKey);
    if (!begin.ok) return { ok: false, reason: begin.reason };
    if (begin.action === 'complete') {
      return {
        ok: true,
        deletion: {
          requestId: begin.requestId,
          version: begin.version,
          envKey: begin.envKey,
          platform: begin.platform,
          targetUserId: begin.targetUserId,
          state: 'deleted',
          resultKind: null,
          idempotent: true,
        },
      };
    }
    if (begin.action === 'in_progress') {
      return {
        ok: false,
        reason: 'deletion_in_progress',
        deletion: {
          requestId: begin.requestId,
          version: begin.version,
          envKey: begin.envKey,
          platform: begin.platform,
          targetUserId: begin.targetUserId,
          state: 'deleting',
          resultKind: null,
          idempotent: true,
        },
      };
    }

    const deleted = await this.adsPower.deleteProfile(begin.envKey, apiKey);
    let resultKind: 'deleted' | 'already_missing' | null = deleted.ok ? 'deleted' : null;
    if (!deleted.ok) {
      const existence = await this.adsPower.profileExists(begin.envKey, apiKey);
      if (existence.ok && !existence.exists) resultKind = 'already_missing';
    }

    if (resultKind) {
      let finished;
      try {
        finished = await this.store.finishDirectEnvironmentDeletion(begin.requestId, begin.version, {
          status: 'succeeded',
          resultKind,
        });
      } catch {
        return { ok: false, reason: 'persistence_failed' };
      }
      if (!finished.ok || finished.state !== 'deleted') return { ok: false, reason: 'persistence_failed' };
      return {
        ok: true,
        deletion: {
          requestId: begin.requestId,
          version: begin.version,
          envKey: begin.envKey,
          platform: begin.platform,
          targetUserId: begin.targetUserId,
          state: 'deleted',
          resultKind,
          idempotent: begin.idempotent || finished.idempotent,
        },
      };
    }

    const failureReason = deleted.ok ? 'adspower_delete_failed' : deleted.reason;
    try {
      const finished = await this.store.finishDirectEnvironmentDeletion(begin.requestId, begin.version, {
        status: 'failed',
        error: deleted.ok ? 'adspower_delete_failed' : deleted.detail,
      });
      if (!finished.ok || finished.state !== 'delete_failed') {
        return { ok: false, reason: 'persistence_failed' };
      }
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
    return { ok: false, reason: failureReason, deletion: failedView(begin) };
  }
}
