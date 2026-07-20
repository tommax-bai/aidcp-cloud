import { createHash } from 'node:crypto';
import pg from 'pg';
import { resolveEnvPgConfig } from '../cache/pg-config.js';
import type { ReplyConfigStore } from './reply-config-store.js';
import type { ReplyConfigScopeStore } from './reply-config-scope-store.js';
import type {
  EffectiveReplyConfig,
  ReplyConfigResolutionMode,
  ReplyConfigSnapshot,
  ReplyConfigSource,
} from './types.js';

const { Pool } = pg;

export function parseReplyConfigResolutionMode(raw: string | undefined): ReplyConfigResolutionMode {
  return raw === 'shadow' || raw === 'scoped' ? raw : 'legacy';
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function replyConfigFingerprint(snapshot: ReplyConfigSnapshot | null): string | null {
  if (!snapshot) return null;
  const safe = {
    policy: snapshot.policy,
    templates: [...snapshot.templates].sort((left, right) => left.templateId.localeCompare(right.templateId))
      .map(({ updatedAt: _updatedAt, updatedBy: _updatedBy, templateVersion: _templateVersion, ...template }) => template),
    rules: [...snapshot.rules].sort((left, right) => left.ruleId.localeCompare(right.ruleId))
      .map(({ updatedAt: _updatedAt, updatedBy: _updatedBy, ...rule }) => rule),
    profiles: [...snapshot.profiles].sort((left, right) => left.channel.localeCompare(right.channel)),
  };
  return createHash('sha256').update(JSON.stringify(canonical(safe))).digest('hex');
}

export interface ReplyConfigInventoryItem {
  source: ReplyConfigSource;
  accounts: Array<{ accountId: string; legacyVersion: number | null; fingerprint: string | null }>;
  conflict: boolean;
}

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
  private readonly pool: pg.Pool;

  constructor(
    private readonly legacy: ReplyConfigStore,
    private readonly scopes: ReplyConfigScopeStore,
    readonly mode: ReplyConfigResolutionMode,
    options: {
      pool?: pg.Pool;
      onShadowObservation?: (value: {
        accountId: string;
        source: ReplyConfigSource;
        legacyVersion: number | null;
        scopedVersion: number | null;
        sameFingerprint: boolean;
      }) => void;
    } = {},
  ) {
    this.pool = options.pool ?? new Pool(resolveEnvPgConfig());
    this.onShadowObservation = options.onShadowObservation ?? ((value) => {
      console.info('[wechat-reply-config-shadow]', JSON.stringify(value));
    });
  }

  private readonly onShadowObservation: (value: {
    accountId: string;
    source: ReplyConfigSource;
    legacyVersion: number | null;
    scopedVersion: number | null;
    sameFingerprint: boolean;
  }) => void;

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
    const scoped = await this.scoped(accountId);
    if (this.mode === 'scoped') return scoped;
    const legacySnapshot = await this.legacy.getSnapshot(accountId, 'published');
    const legacyHead = await this.legacy.getHead(accountId);
    if (this.mode === 'shadow') {
      this.onShadowObservation({
        accountId,
        source: scoped.source,
        legacyVersion: legacySnapshot?.configVersion ?? null,
        scopedVersion: scoped.snapshot?.configVersion ?? null,
        sameFingerprint: replyConfigFingerprint(legacySnapshot) === replyConfigFingerprint(scoped.snapshot),
      });
    }
    return {
      accountId,
      mode: this.mode,
      status: legacySnapshot ? 'published' : legacyHead?.draftVersion !== null && legacyHead?.draftVersion !== undefined
        ? 'draft_only' : 'missing',
      reason: legacySnapshot ? null : scoped.reason,
      source: scoped.source,
      head: scoped.head,
      snapshot: legacySnapshot,
    };
  }

  async getPublished(accountId: string): Promise<ReplyConfigSnapshot | null> {
    return (await this.resolve(accountId)).snapshot;
  }

  async getSnapshotForJob(accountId: string, scopeId: string | null | undefined, version: number): Promise<ReplyConfigSnapshot | null> {
    return scopeId
      ? this.scopes.getSnapshot(scopeId, version, accountId)
      : this.legacy.getSnapshot(accountId, version);
  }

  async inventory(): Promise<ReplyConfigInventoryItem[]> {
    const { rows } = await this.pool.query<{ account_id: string; group_label: string | null }>(
      `SELECT account_id,group_label FROM accounts WHERE platform='wechat_channels' ORDER BY group_label NULLS FIRST,account_id`,
    );
    const grouped = new Map<string, ReplyConfigInventoryItem>();
    for (const row of rows) {
      const source: ReplyConfigSource = row.group_label === null
        ? { type: 'default', groupLabel: null }
        : { type: 'group', groupLabel: row.group_label };
      const key = source.type === 'default' ? 'default' : `group:${source.groupLabel}`;
      const snapshot = await this.legacy.getSnapshot(row.account_id, 'published');
      const item = grouped.get(key) ?? { source, accounts: [], conflict: false };
      item.accounts.push({
        accountId: row.account_id,
        legacyVersion: snapshot?.configVersion ?? null,
        fingerprint: replyConfigFingerprint(snapshot),
      });
      grouped.set(key, item);
    }
    for (const item of grouped.values()) {
      item.conflict = new Set(item.accounts.map((account) => account.fingerprint).filter(Boolean)).size > 1;
    }
    return [...grouped.values()];
  }

  async close(): Promise<void> { await this.pool.end(); }
}
