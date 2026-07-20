import type { ReplyConfigScopeStore } from './reply-config-scope-store.js';
import type {
  EffectiveReplyConfig,
  ReplyConfigSnapshot,
} from './types.js';

export interface ReplyConfigReader {
  getPublished?(accountId: string): Promise<ReplyConfigSnapshot | null>;
  getSnapshotForJob?(
    accountId: string,
    scopeId: string | null | undefined,
    version: number,
  ): Promise<ReplyConfigSnapshot | null>;
  getSnapshot?(accountId: string, selector: 'draft' | 'published' | number): Promise<ReplyConfigSnapshot | null>;
}

export async function readPublishedConfig(reader: ReplyConfigReader, accountId: string): Promise<ReplyConfigSnapshot | null> {
  if (reader.getPublished) return reader.getPublished(accountId);
  return reader.getSnapshot?.(accountId, 'published') ?? null;
}

export async function readJobConfig(
  reader: ReplyConfigReader,
  accountId: string,
  scopeId: string | null | undefined,
  version: number,
): Promise<ReplyConfigSnapshot | null> {
  if (reader.getSnapshotForJob) return reader.getSnapshotForJob(accountId, scopeId, version);
  return scopeId ? null : reader.getSnapshot?.(accountId, version) ?? null;
}

export class ReplyConfigResolver {
  readonly mode = 'scoped' as const;

  constructor(private readonly scopes: ReplyConfigScopeStore) {}

  private async scoped(accountId: string): Promise<EffectiveReplyConfig> {
    const source = await this.scopes.sourceForAccount(accountId);
    if (!source) {
      return {
        accountId, mode: this.mode, status: 'missing', reason: 'account_not_found',
        source: { type: 'default', groupLabel: null }, head: null, snapshot: null,
      };
    }
    const head = await this.scopes.getScopeBySource(source);
    if (!head) {
      return {
        accountId, mode: this.mode, status: 'missing',
        reason: source.type === 'group' ? 'group_config_missing' : 'default_config_missing',
        source, head: null, snapshot: null,
      };
    }
    if (head.publishedVersion === null) {
      return {
        accountId, mode: this.mode, status: head.draftVersion === null ? 'missing' : 'draft_only',
        reason: source.type === 'group' ? 'group_config_missing' : 'default_config_missing',
        source, head, snapshot: null,
      };
    }
    const snapshot = await this.scopes.getSnapshot(head.scopeId, head.publishedVersion, accountId);
    return {
      accountId, mode: this.mode, status: snapshot ? 'published' : 'unknown',
      reason: snapshot ? null : source.type === 'group' ? 'group_config_missing' : 'default_config_missing',
      source, head, snapshot,
    };
  }

  async resolve(accountId: string): Promise<EffectiveReplyConfig> {
    return this.scoped(accountId);
  }

  async getPublished(accountId: string): Promise<ReplyConfigSnapshot | null> {
    return (await this.resolve(accountId)).snapshot;
  }

  async getSnapshotForJob(accountId: string, scopeId: string | null | undefined, version: number): Promise<ReplyConfigSnapshot | null> {
    return scopeId
      ? this.scopes.getSnapshot(scopeId, version, accountId)
      : null;
  }

  async close(): Promise<void> {}
}
