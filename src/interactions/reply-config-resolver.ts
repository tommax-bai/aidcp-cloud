import type { ReplyConfigScopeStore } from './reply-config-scope-store.js';
import type {
  EffectiveReplyConfig,
  ReplyConfigSnapshot,
} from '../kernel/interaction-types.js';

// 纯读取端口与两个无状态读取函数已析出到 kernel（change decouple-llm-lang-interaction-contracts）；
// 连库的 ReplyConfigResolver 类留在本文件。对既有从本文件取这三者的导入方保持等值再导出。
export { readJobConfig, readPublishedConfig, type ReplyConfigReader } from '../kernel/interaction-reply-contract.js';

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
