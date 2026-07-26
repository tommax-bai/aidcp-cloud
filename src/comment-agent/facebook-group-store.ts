import pg from 'pg';
import type { DeploymentTarget } from '../deployment-target.js';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { ensureCapabilitySchema } from '../schema/schema-capability.js';

const { Pool } = pg;

// 纯数据模型类型 + 哨兵错误已抬入 kernel（src/kernel/facebook-group-types.ts），供 api 侧面板 / 配置视图
// 跨边界共导；这里等值再导出，让既有 `from '../comment-agent/facebook-group-store'` 的类型 / 错误导入面
// （automation 内部消费方、scheduler 等）逐字不变。存储实现（pg 读写、DbRow 映射）留本文件。
import { FacebookGroupScopeError } from '../kernel/facebook-group-types.js';
import type {
  FacebookGroupJoinGating,
  FacebookGroupMembershipStatus,
  FacebookGroupTargetInput,
  FacebookGroupTargetRow,
  FacebookGroupTargetScopedRow,
  FacebookGroupTargetListRow,
  FacebookGroupTargetScopeWriteRow,
  ReplaceFacebookGroupTargetScopesResult,
  FacebookGroupTargetListOptions,
  FacebookGroupTargetListResult,
  FacebookGroupRegionFacet,
  FacebookGroupTargetFacets,
  FacebookGroupMembershipRow,
  FacebookGroupJoinAuditOutcome,
  FacebookGroupJoinRecentScheduledResult,
  FacebookGroupScopedTargetCount,
  FacebookGroupImportResult,
  FacebookGroupAccountProgress,
} from '../kernel/facebook-group-types.js';
export { FacebookGroupScopeError };
export type {
  FacebookGroupJoinGating,
  FacebookGroupMembershipStatus,
  FacebookGroupTargetInput,
  FacebookGroupTargetRow,
  FacebookGroupTargetScopedRow,
  FacebookGroupTargetListRow,
  FacebookGroupTargetScopeWriteRow,
  ReplaceFacebookGroupTargetScopesResult,
  FacebookGroupTargetListOptions,
  FacebookGroupTargetListResult,
  FacebookGroupRegionFacet,
  FacebookGroupTargetFacets,
  FacebookGroupMembershipRow,
  FacebookGroupJoinAuditOutcome,
  FacebookGroupJoinRecentScheduledResult,
  FacebookGroupScopedTargetCount,
  FacebookGroupImportResult,
  FacebookGroupAccountProgress,
};

export interface FacebookGroupStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  executionTarget?: DeploymentTarget;
  /**
   * 强制刷一次账号守卫投影（change automation-accounts-projection）。只在 `assertFacebookAccountGroupLabels`
   * 这一处「运营会被当场挡住」的写路径上用，用来把投影的常规滞后压到 0。
   * 不注入即退化为「按当前投影判定」——仍是 fail-closed，只是运营可能要等一个刷新周期。
   */
  refreshAccountProjection?: () => Promise<unknown>;
}

type FacebookGroupStoreQueryable = Pick<pg.Pool, 'query'>;

export interface FacebookGroupCoverageCandidateOptions {
  limit?: number;
  cooldownMs?: number;
  warmupMs?: number;
  /**
   * 放开时限兜底（change facebook-coverage-relax-and-keyword-space）：正常约束（预热/冷却）下无可评群时的降级选群。
   * 只保留 `status='joined'`，丢弃预热 / 冷却 / cooldown_until 三重时限闸，仍按「最久没评优先」排序取窗口——
   * 由飞书人审兜底把关（相应 pick 会在审核卡标注）。已降级为 left 的群 status≠joined 仍被排除，坏群不会被此路复活。
   */
  relaxed?: boolean;
}

export type FacebookGroupJoinTriggerSource = 'scheduled' | 'manual_pool' | 'manual_specific' | 'shadow';

export interface FacebookGroupJoinAuditRow {
  accountId: string;
  groupUrl?: string | null;
  outcome: FacebookGroupJoinAuditOutcome;
  phase?: 'pre_click' | 'post_click' | 'scheduler' | 'shadow';
  verdict?: string;
  reason?: string;
  shadow?: boolean;
  observation?: unknown;
  triggerSource?: FacebookGroupJoinTriggerSource;
}

interface TargetDbRow {
  group_url: string;
  group_name: string | null;
  region: string | null;
  park: string | null;
  direction: string | null;
  join_gating: FacebookGroupJoinGating;
  priority: number;
  enabled: boolean;
  import_batch: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TargetListDbRow extends TargetDbRow {
  account_group_labels: string[] | null;
  account_id: string | null;
  membership_status: FacebookGroupMembershipStatus | null;
  joined_at: Date | string | null;
  last_attempt_at: Date | string | null;
  last_reason: string | null;
  last_commented_at: Date | string | null;
  comments_total: number | string | null;
}

interface MembershipDbRow {
  account_id: string;
  group_url: string;
  status: FacebookGroupMembershipStatus;
  assigned_at: Date | string | null;
  joined_at: Date | string | null;
  last_attempt_at: Date | string | null;
  attempts: number | string;
  last_reason: string | null;
  last_commented_at: Date | string | null;
  cooldown_until: Date | string | null;
  comments_total: number | string;
  left_confirmations: number | string;
  updated_at: Date | string;
}

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  return new Date(v).toISOString();
}

function poolFrom(options: FacebookGroupStoreOptions): pg.Pool {
  return (
    options.pool ??
    new Pool({
      host: options.host ?? DEFAULT_PG_CONFIG.host,
      port: options.port ?? DEFAULT_PG_CONFIG.port,
      database: options.database ?? DEFAULT_PG_CONFIG.database,
      user: options.user ?? DEFAULT_PG_CONFIG.user,
      password: options.password ?? DEFAULT_PG_CONFIG.password,
    })
  );
}

function projectionExecutionTarget(
  configured: DeploymentTarget | undefined,
): DeploymentTarget | '__invalid__' {
  if (configured) return configured;
  const value = process.env.AIDCP_DEPLOY_ENV;
  return value === 'dev' || value === 'ol' ? value : '__invalid__';
}

export function canonicalFacebookGroupUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '').replace(/^mbasic\./, '');
  if (host !== 'facebook.com' && host !== 'fb.com') return null;
  const parts = parsed.pathname.split('/').map((p) => p.trim()).filter(Boolean);
  const groupIdx = parts.findIndex((p) => p.toLowerCase() === 'groups');
  if (groupIdx < 0 || !parts[groupIdx + 1]) return null;
  const slug = parts[groupIdx + 1];
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  return `https://www.facebook.com/groups/${slug}`;
}

function normalizeName(name: string | null | undefined): string | null {
  const v = typeof name === 'string' ? name.trim() : '';
  return v ? v.slice(0, 200) : null;
}

function normalizeMeta(value: string | null | undefined): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return v ? v.slice(0, 120) : null;
}

export function normalizeFacebookAccountGroupLabels(values: readonly string[]): string[] | null {
  const normalized = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64) return null;
    normalized.add(trimmed);
  }
  return [...normalized].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function toTargetRow(r: TargetDbRow): FacebookGroupTargetRow {
  return {
    groupUrl: r.group_url,
    groupName: r.group_name ?? null,
    region: r.region ?? null,
    park: r.park ?? null,
    direction: r.direction ?? null,
    joinGating: r.join_gating,
    priority: Number(r.priority),
    enabled: r.enabled,
    importBatch: r.import_batch ?? null,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

function toListRow(r: TargetListDbRow): FacebookGroupTargetListRow {
  return {
    ...toTargetRow(r),
    accountGroupLabels: r.account_group_labels ?? [],
    accountId: r.account_id ?? null,
    membershipStatus: r.membership_status ?? null,
    joinedAt: iso(r.joined_at),
    lastAttemptAt: iso(r.last_attempt_at),
    lastReason: r.last_reason ?? null,
    lastCommentedAt: iso(r.last_commented_at),
    commentsTotal: Number(r.comments_total ?? 0),
  };
}

function toMembershipRow(r: MembershipDbRow): FacebookGroupMembershipRow {
  return {
    accountId: r.account_id,
    groupUrl: r.group_url,
    status: r.status,
    assignedAt: iso(r.assigned_at),
    joinedAt: iso(r.joined_at),
    lastAttemptAt: iso(r.last_attempt_at),
    attempts: Number(r.attempts),
    lastReason: r.last_reason ?? null,
    lastCommentedAt: iso(r.last_commented_at),
    cooldownUntil: iso(r.cooldown_until),
    commentsTotal: Number(r.comments_total),
    leftConfirmations: Number(r.left_confirmations),
    updatedAt: iso(r.updated_at)!,
  };
}

export const FACEBOOK_GROUP_TARGET_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facebook_group_target (
  group_url    TEXT PRIMARY KEY,
  group_name   TEXT,
  region       TEXT,
  park         TEXT,
  direction    TEXT,
  join_gating  TEXT NOT NULL DEFAULT 'unknown'
               CHECK (join_gating IN ('unknown','instant','gated')),
  priority     INTEGER NOT NULL DEFAULT 0,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  import_batch TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS group_name TEXT;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS park TEXT;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS direction TEXT;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS join_gating TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS import_batch TEXT;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS scope_updated_at TIMESTAMPTZ;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS scope_updated_by TEXT;

CREATE TABLE IF NOT EXISTS facebook_group_target_scope (
  group_url           TEXT NOT NULL REFERENCES facebook_group_target(group_url) ON DELETE CASCADE,
  account_group_label TEXT NOT NULL CHECK (account_group_label = btrim(account_group_label)
                                           AND char_length(account_group_label) BETWEEN 1 AND 64),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT NOT NULL,
  PRIMARY KEY (group_url, account_group_label)
);
CREATE INDEX IF NOT EXISTS idx_fb_group_target_scope_label
  ON facebook_group_target_scope (account_group_label, group_url);

CREATE INDEX IF NOT EXISTS idx_fb_group_target_enabled_gating
  ON facebook_group_target (enabled, join_gating, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_fb_group_target_region_park
  ON facebook_group_target (region, park)
  WHERE region IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fb_group_target_direction
  ON facebook_group_target (direction)
  WHERE direction IS NOT NULL;
`;

export const FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facebook_group_membership (
  id                  BIGSERIAL PRIMARY KEY,
  -- 跨 owner 外键（引 accounts，另一服务所有）。additive 拆库前置：共库期保留此约束。
  -- 拆库后的替代已全部就位：本表全部账号守卫（claimNext / revalidateScopedAssignment /
  -- coverageCandidates）已改读本域的账号投影表，不再内联 accounts；投影缺行或陈旧一律判否。
  -- 降约束本身押到拆库那刻，语句已备在 scripts/db-split/0076_downgrade_cross_owner_account_fk.sql
  -- （facebook_group_membership_account_id_fkey 那一行），此处不删。
  account_id          TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  group_url           TEXT NOT NULL REFERENCES facebook_group_target(group_url) ON DELETE CASCADE,
  status              TEXT NOT NULL CHECK (status IN ('assigned','joining','joined','pending','gated','no_button','checkpoint','failed','left')),
  assigned_at         TIMESTAMPTZ,
  joined_at           TIMESTAMPTZ,
  last_attempt_at     TIMESTAMPTZ,
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_reason         TEXT,
  last_commented_at   TIMESTAMPTZ,
  cooldown_until      TIMESTAMPTZ,
  comments_total      INTEGER NOT NULL DEFAULT 0,
  left_confirmations  INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_url)
);

CREATE INDEX IF NOT EXISTS idx_fb_group_membership_account_status
  ON facebook_group_membership (account_id, status);
CREATE INDEX IF NOT EXISTS idx_fb_group_membership_status
  ON facebook_group_membership (status);
CREATE INDEX IF NOT EXISTS idx_fb_group_membership_coverage
  ON facebook_group_membership (account_id, status, last_commented_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_fb_group_membership_assigned_ttl
  ON facebook_group_membership (status, assigned_at);
`;

export const FACEBOOK_GROUP_JOIN_AUDIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facebook_group_join_audit (
  id          BIGSERIAL PRIMARY KEY,
  account_id  TEXT NOT NULL,
  group_url   TEXT,
  outcome     TEXT NOT NULL,
  phase       TEXT,
  verdict     TEXT,
  reason      TEXT,
  shadow      BOOLEAN NOT NULL DEFAULT false,
  observation JSONB,
  trigger_source TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE facebook_group_join_audit ADD COLUMN IF NOT EXISTS trigger_source TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facebook_group_join_audit_trigger_source_check') THEN
    ALTER TABLE facebook_group_join_audit
      ADD CONSTRAINT facebook_group_join_audit_trigger_source_check
      CHECK (trigger_source IS NULL OR trigger_source IN ('scheduled','manual_pool','manual_specific','shadow'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_fb_group_join_audit_account
  ON facebook_group_join_audit (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fb_group_join_audit_scheduled
  ON facebook_group_join_audit (account_id, created_at DESC)
  WHERE trigger_source = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_fb_group_join_audit_group
  ON facebook_group_join_audit (group_url, created_at DESC);
`;

export class FacebookGroupTargetStore {
  private readonly pool: pg.Pool;
  private readonly refreshAccountProjection?: () => Promise<unknown>;
  private readonly executionTarget: DeploymentTarget | '__invalid__';

  constructor(options: FacebookGroupStoreOptions = {}) {
    this.pool = poolFrom(options);
    this.refreshAccountProjection = options.refreshAccountProjection;
    this.executionTarget = projectionExecutionTarget(options.executionTarget);
  }

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await ensureCapabilitySchema(this.pool, {
      capability: 'facebook_group_target',
      sinceVersion: '0067_baseline_facebook_tables',
      ddl: [FACEBOOK_GROUP_TARGET_SCHEMA_SQL],
    });
  }

  async importTargets(
    inputs: FacebookGroupTargetInput[],
    importBatch: string | null = null,
    options: { accountGroupLabels?: string[]; updatedBy?: string } = {},
  ): Promise<FacebookGroupImportResult> {
    let invalid = 0;
    let duplicate = 0;
    let updated = 0;
    let imported = 0;
    const seen = new Set<string>();
    const normalizedInputs: Array<{ groupUrl: string; input: FacebookGroupTargetInput }> = [];
    for (const input of inputs) {
      const groupUrl = canonicalFacebookGroupUrl(input.url);
      if (!groupUrl) {
        invalid++;
        continue;
      }
      if (seen.has(groupUrl)) {
        duplicate++;
        continue;
      }
      seen.add(groupUrl);
      normalizedInputs.push({ groupUrl, input });
    }

    const requestedLabels = options.accountGroupLabels === undefined
      ? undefined
      : normalizeFacebookAccountGroupLabels(options.accountGroupLabels);
    if (requestedLabels === null) throw new FacebookGroupScopeError('invalid_account_group');
    const actor = options.updatedBy?.trim() || 'system';
    const client = requestedLabels === undefined ? null : await this.pool.connect();
    const queryable: FacebookGroupStoreQueryable = client ?? this.pool;
    const rows: FacebookGroupTargetRow[] = [];
    try {
      if (client && requestedLabels !== undefined) {
        await client.query('BEGIN');
        await this.assertFacebookAccountGroupLabels(client, requestedLabels);
      }
      for (const { groupUrl, input } of normalizedInputs) {
      const groupName = normalizeName(input.name);
      const region = normalizeMeta(input.region);
      const park = normalizeMeta(input.park);
      const direction = normalizeMeta(input.direction);
      const { rows: inserted } = await queryable.query<TargetDbRow>(
        `INSERT INTO facebook_group_target (group_url, group_name, region, park, direction, import_batch)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (group_url) DO NOTHING
         RETURNING group_url, group_name, region, park, direction, join_gating, priority, enabled, import_batch, created_at, updated_at`,
        [groupUrl, groupName, region, park, direction, importBatch],
      );
      if (inserted[0]) {
        imported++;
        rows.push(toTargetRow(inserted[0]));
        continue;
      }
      const { rows: changed } = await queryable.query<TargetDbRow>(
        `UPDATE facebook_group_target
         SET group_name = COALESCE($2, group_name),
             region = COALESCE($3, region),
             park = COALESCE($4, park),
             direction = COALESCE($5, direction),
             import_batch = COALESCE($6, import_batch),
             updated_at = now()
         WHERE group_url = $1
         RETURNING group_url, group_name, region, park, direction, join_gating, priority, enabled, import_batch, created_at, updated_at`,
        [groupUrl, groupName, region, park, direction, importBatch],
      );
      if (changed[0]) {
        updated++;
        rows.push(toTargetRow(changed[0]));
      } else {
        duplicate++;
      }
      }
      const groupUrls = rows.map((row) => row.groupUrl);
      if (requestedLabels !== undefined && groupUrls.length > 0) {
        await this.replaceScopesInTransaction(queryable, groupUrls, requestedLabels, actor);
      }
      const scopes = await this.readScopeLabels(queryable, groupUrls);
      if (client) await client.query('COMMIT');
      return {
        imported,
        updated,
        duplicate,
        invalid,
        rows: rows.map((row) => ({ ...row, accountGroupLabels: scopes.get(row.groupUrl) ?? [] })),
      };
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client?.release();
    }
  }

  private async readProjectedFacebookGroupLabels(
    queryable: FacebookGroupStoreQueryable,
    labels: string[],
  ): Promise<Set<string>> {
    // 守卫读改读本域投影（原为内联 accounts）。新鲜期谓词挂在同一条语句里：投影缺行 → 谓词自然判假；
    // 投影陈旧 / 从未刷过 → 新鲜期判假 → 整句返空 → 下面一律判否。两条路都落在拒绝一侧。
    const { rows } = await queryable.query<{ group_label: string }>(
      `SELECT DISTINCT p.group_label
       FROM automation_account_projection p
       WHERE lower(btrim(p.platform)) IN ('facebook','fb')
         AND p.group_label = ANY($1::text[])
         AND EXISTS (
           SELECT 1 FROM automation_sync_read_consumer_checkpoint apj_checkpoint
           WHERE apj_checkpoint.execution_target = $2
             AND apj_checkpoint.consumer = 'automation'
             AND apj_checkpoint.stream = 'automation_account_projection'
             AND apj_checkpoint.state = 'ready'
             AND apj_checkpoint.fresh_until_ms >
                 floor(extract(epoch FROM now()) * 1000)
         )`,
      [labels, this.executionTarget],
    );
    return new Set(rows.map((row) => row.group_label));
  }

  private async assertFacebookAccountGroupLabels(
    queryable: FacebookGroupStoreQueryable,
    labels: string[],
  ): Promise<void> {
    if (labels.length === 0) return;
    let actual = await this.readProjectedFacebookGroupLabels(queryable, labels);
    if (labels.some((label) => !actual.has(label)) && this.refreshAccountProjection) {
      // 未命中时**先强制刷一次投影再问一遍**。这是整批守卫里唯一一处运营会被当场挡住的写路径
      // （刚建号 / 刚改分组标签就来配 scope），投影的常规滞后会在这里变成一句莫名其妙的
      // 「分组不存在」。刷新失败或刷完仍未命中，照旧判否——refresh 只压缩窗口，MUST NOT 放行。
      await this.refreshAccountProjection().catch(() => undefined);
      actual = await this.readProjectedFacebookGroupLabels(queryable, labels);
    }
    if (labels.some((label) => !actual.has(label))) throw new FacebookGroupScopeError('invalid_account_group');
  }

  private async replaceScopesInTransaction(
    queryable: FacebookGroupStoreQueryable,
    groupUrls: string[],
    labels: string[],
    updatedBy: string,
  ): Promise<void> {
    await queryable.query(
      `DELETE FROM facebook_group_target_scope WHERE group_url = ANY($1::text[])`,
      [groupUrls],
    );
    if (labels.length > 0) {
      await queryable.query(
        `INSERT INTO facebook_group_target_scope (group_url, account_group_label, updated_at, updated_by)
         SELECT group_url, account_group_label, now(), $3
         FROM unnest($1::text[]) AS group_url
         CROSS JOIN unnest($2::text[]) AS account_group_label`,
        [groupUrls, labels, updatedBy],
      );
    }
    await queryable.query(
      `UPDATE facebook_group_target
       SET scope_updated_at = now(), scope_updated_by = $2
       WHERE group_url = ANY($1::text[])`,
      [groupUrls, updatedBy],
    );
  }

  private async readScopeLabels(
    queryable: FacebookGroupStoreQueryable,
    groupUrls: string[],
  ): Promise<Map<string, string[]>> {
    if (groupUrls.length === 0) return new Map();
    const { rows } = await queryable.query<{ group_url: string; account_group_labels: string[] | null }>(
      `SELECT t.group_url,
              COALESCE(array_agg(s.account_group_label ORDER BY s.account_group_label)
                FILTER (WHERE s.account_group_label IS NOT NULL), ARRAY[]::text[]) AS account_group_labels
       FROM facebook_group_target t
       LEFT JOIN facebook_group_target_scope s ON s.group_url = t.group_url
       WHERE t.group_url = ANY($1::text[])
       GROUP BY t.group_url`,
      [groupUrls],
    );
    return new Map(rows
      .filter((row) => typeof row.group_url === 'string')
      .map((row) => [row.group_url, row.account_group_labels ?? []]));
  }

  async replaceTargetScopes(
    groupUrlInputs: string[],
    accountGroupLabelInputs: string[],
    updatedBy: string,
  ): Promise<ReplaceFacebookGroupTargetScopesResult> {
    if (groupUrlInputs.length === 0) return { ok: false, reason: 'no_targets' };
    const canonicalGroupUrls = groupUrlInputs.map(canonicalFacebookGroupUrl);
    if (canonicalGroupUrls.some((url) => url === null)) return { ok: false, reason: 'invalid_target' };
    const groupUrls = [...new Set(canonicalGroupUrls as string[])];
    const labels = normalizeFacebookAccountGroupLabels(accountGroupLabelInputs);
    if (labels === null) return { ok: false, reason: 'invalid_account_group' };
    const actor = updatedBy.trim() || 'system';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertFacebookAccountGroupLabels(client, labels);
      const { rows: targets } = await client.query<{ group_url: string }>(
        `SELECT group_url FROM facebook_group_target WHERE group_url = ANY($1::text[]) FOR UPDATE`,
        [groupUrls],
      );
      if (targets.length !== groupUrls.length) throw new FacebookGroupScopeError('invalid_target');
      await this.replaceScopesInTransaction(client, groupUrls, labels, actor);
      const { rows } = await client.query<{
        group_url: string;
        account_group_labels: string[] | null;
        scope_updated_at: Date | string;
        scope_updated_by: string;
      }>(
        `SELECT t.group_url,
                COALESCE(array_agg(s.account_group_label ORDER BY s.account_group_label)
                  FILTER (WHERE s.account_group_label IS NOT NULL), ARRAY[]::text[]) AS account_group_labels,
                t.scope_updated_at, t.scope_updated_by
         FROM facebook_group_target t
         LEFT JOIN facebook_group_target_scope s ON s.group_url = t.group_url
         WHERE t.group_url = ANY($1::text[])
         GROUP BY t.group_url, t.scope_updated_at, t.scope_updated_by
         ORDER BY t.group_url`,
        [groupUrls],
      );
      await client.query('COMMIT');
      return {
        ok: true,
        items: rows.map((row) => ({
          groupUrl: row.group_url,
          accountGroupLabels: row.account_group_labels ?? [],
          updatedAt: iso(row.scope_updated_at)!,
          updatedBy: row.scope_updated_by,
        })),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof FacebookGroupScopeError) return { ok: false, reason: error.reason };
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 确保目标行存在以兜住成员表 FK（change facebook-comment-review-and-targeted-join，`/comment --join=<url>`）：
   * 新建行强制 `enabled=false`——nextJoinCandidate / claimNext 都要求 `enabled=true`，故这条**绝不**被自动加群扫到、
   * 不外泄成对其它账号开放的公共加群目标。已存在则**原样返回、绝不升降级**既有 target（可能是运营导入的启用共享目标）。
   * 非 Facebook 群 url → 返回 null。
   */
  async ensureTarget(urlInput: string): Promise<FacebookGroupTargetRow | null> {
    const groupUrl = canonicalFacebookGroupUrl(urlInput);
    if (!groupUrl) return null;
    const { rows: inserted } = await this.pool.query<TargetDbRow>(
      `INSERT INTO facebook_group_target (group_url, enabled)
       VALUES ($1, false)
       ON CONFLICT (group_url) DO NOTHING
       RETURNING group_url, group_name, region, park, direction, join_gating, priority, enabled, import_batch, created_at, updated_at`,
      [groupUrl],
    );
    if (inserted[0]) return toTargetRow(inserted[0]);
    const { rows: existing } = await this.pool.query<TargetDbRow>(
      `SELECT group_url, group_name, region, park, direction, join_gating, priority, enabled, import_batch, created_at, updated_at
       FROM facebook_group_target WHERE group_url = $1`,
      [groupUrl],
    );
    return existing[0] ? toTargetRow(existing[0]) : null;
  }

  async setEnabled(groupUrlInput: string, enabled: boolean): Promise<FacebookGroupTargetRow | null> {
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) return null;
    const { rows } = await this.pool.query<TargetDbRow>(
      `UPDATE facebook_group_target
       SET enabled = $2, updated_at = now()
       WHERE group_url = $1
       RETURNING group_url, group_name, region, park, direction, join_gating, priority, enabled, import_batch, created_at, updated_at`,
      [groupUrl, enabled],
    );
    return rows[0] ? toTargetRow(rows[0]) : null;
  }

  async markJoinGating(groupUrlInput: string, joinGating: FacebookGroupJoinGating): Promise<void> {
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) return;
    await this.pool.query(
      `UPDATE facebook_group_target
       SET join_gating = $2, updated_at = now()
       WHERE group_url = $1`,
      [groupUrl, joinGating],
    );
  }

  async listTargets(options: FacebookGroupTargetListOptions = {}): Promise<FacebookGroupTargetListResult> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
    const where: string[] = [];
    const values: unknown[] = [];
    if (typeof options.enabled === 'boolean') {
      values.push(options.enabled);
      where.push(`t.enabled = $${values.length}`);
    }
    if (options.status === 'unassigned') {
      where.push('m.group_url IS NULL');
    } else if (options.status) {
      values.push(options.status);
      where.push(`m.status = $${values.length}`);
    }
    const region = normalizeMeta(options.region);
    if (region) {
      values.push(region);
      where.push(`t.region = $${values.length}`);
    }
    const park = normalizeMeta(options.park);
    if (park) {
      values.push(park);
      where.push(`t.park = $${values.length}`);
    }
    const direction = normalizeMeta(options.direction);
    if (direction) {
      values.push(direction);
      where.push(`t.direction = $${values.length}`);
    }
    const accountGroupLabel = normalizeMeta(options.accountGroupLabel);
    if (accountGroupLabel) {
      values.push(accountGroupLabel.slice(0, 64));
      where.push(`EXISTS (
        SELECT 1 FROM facebook_group_target_scope sf
        WHERE sf.group_url = t.group_url AND sf.account_group_label = $${values.length}
      )`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM facebook_group_target t
       LEFT JOIN facebook_group_membership m ON m.group_url = t.group_url
       ${whereSql}`,
      values,
    );
    values.push(limit, offset);
    const { rows } = await this.pool.query<TargetListDbRow>(
      `SELECT t.group_url, t.group_name, t.region, t.park, t.direction, t.join_gating, t.priority, t.enabled, t.import_batch,
              t.created_at, t.updated_at,
              COALESCE((
                SELECT array_agg(s.account_group_label ORDER BY s.account_group_label)
                FROM facebook_group_target_scope s WHERE s.group_url = t.group_url
              ), ARRAY[]::text[]) AS account_group_labels,
              m.account_id, m.status AS membership_status, m.joined_at, m.last_attempt_at,
              m.last_reason, m.last_commented_at, m.comments_total
       FROM facebook_group_target t
       LEFT JOIN facebook_group_membership m ON m.group_url = t.group_url
       ${whereSql}
       ORDER BY t.enabled DESC, t.priority DESC, t.created_at DESC, t.group_url ASC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { items: rows.map(toListRow), total: Number(count.rows[0]?.total ?? 0) };
  }

  async listFacets(): Promise<FacebookGroupTargetFacets> {
    const [{ rows: regionRows }, { rows: directionRows }, { rows: accountGroupRows }, { rows: unscopedRows }] = await Promise.all([
      this.pool.query<{ region: string | null; park: string | null }>(
        `SELECT DISTINCT region, park
         FROM facebook_group_target
         WHERE region IS NOT NULL
         ORDER BY region ASC, park ASC NULLS LAST`,
      ),
      this.pool.query<{ direction: string | null }>(
        `SELECT DISTINCT direction
         FROM facebook_group_target
         WHERE direction IS NOT NULL
         ORDER BY direction ASC`,
      ),
      // 纯展示面（Console 的分组下拉），**不挂新鲜期谓词**：这里读到一个滞后 ≤ 一个刷新周期的
      // 标签清单不构成任何放行——运营真拿它去配 scope 时，写路径上的 assertFacebookAccountGroupLabels
      // 会再判一次（那一处才是守卫，且带新鲜期）。反过来，投影陈旧时把下拉清空只会让运营无从下手。
      this.pool.query<{ account_group_label: string }>(
        `SELECT DISTINCT group_label AS account_group_label
         FROM automation_account_projection
         WHERE lower(btrim(platform)) IN ('facebook','fb')
           AND group_label IS NOT NULL
           AND btrim(group_label) <> ''
         ORDER BY account_group_label ASC`,
      ),
      this.pool.query<{ total: string }>(
        `SELECT count(*)::text AS total
         FROM facebook_group_target t
         WHERE NOT EXISTS (
           SELECT 1 FROM facebook_group_target_scope s WHERE s.group_url = t.group_url
         )`,
      ),
    ]);
    const byRegion = new Map<string, Set<string>>();
    for (const row of regionRows) {
      const region = normalizeMeta(row.region);
      if (!region) continue;
      const parks = byRegion.get(region) ?? new Set<string>();
      const park = normalizeMeta(row.park);
      if (park) parks.add(park);
      byRegion.set(region, parks);
    }
    return {
      regions: [...byRegion.entries()].map(([region, parks]) => ({
        region,
        parks: [...parks].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
      })),
      directions: directionRows.map((row) => normalizeMeta(row.direction)).filter((v): v is string => !!v),
      accountGroupLabels: accountGroupRows.map((row) => row.account_group_label),
      unscopedTargetCount: Number(unscopedRows[0]?.total ?? '0'),
    };
  }

  /**
   * 纯展示面（Console 的加群自动化目录：这个账号的分组标签 + 名下可加群数）。与 listFacets 同理
   * **不挂新鲜期谓词**：它只喂一个数字给界面，不放行任何动作；真正下手的 claimNext 才是守卫。
   */
  async scopedTargetCountsForAccounts(
    accountIds: readonly string[],
  ): Promise<Map<string, FacebookGroupScopedTargetCount>> {
    const uniqueAccountIds = [...new Set(accountIds.filter((accountId) => accountId.trim() !== ''))];
    if (uniqueAccountIds.length === 0) return new Map();
    const { rows } = await this.pool.query<{ account_id: string; group_label: string | null; total: string }>(
      `SELECT a.account_id, a.group_label,
              count(t.group_url) FILTER (
                WHERE t.enabled = true AND t.join_gating IN ('unknown','instant')
                  AND NOT EXISTS (
                    SELECT 1 FROM facebook_group_membership m WHERE m.group_url = t.group_url
                  )
              )::text AS total
       FROM automation_account_projection a
       LEFT JOIN facebook_group_target_scope s ON s.account_group_label = a.group_label
       LEFT JOIN facebook_group_target t ON t.group_url = s.group_url
       WHERE a.account_id = ANY($1::text[]) AND lower(btrim(a.platform)) IN ('facebook','fb')
       GROUP BY a.account_id, a.group_label`,
      [uniqueAccountIds],
    );
    return new Map(rows.map((row) => [
      row.account_id,
      { accountGroupLabel: row.group_label ?? null, count: Number(row.total ?? '0') },
    ]));
  }

  async scopedTargetCountForAccount(accountId: string): Promise<FacebookGroupScopedTargetCount> {
    return (await this.scopedTargetCountsForAccounts([accountId])).get(accountId) ?? {
      accountGroupLabel: null,
      count: 0,
    };
  }

  /** 选群守卫：返回非 null 即意味着「可以对这个群下手」，故**挂新鲜期谓词**，陈旧时返 null。 */
  async nextJoinCandidate(accountId: string): Promise<FacebookGroupTargetRow | null> {
    const { rows } = await this.pool.query<TargetDbRow>(
      `SELECT t.group_url, t.group_name, t.region, t.park, t.direction, t.join_gating, t.priority, t.enabled, t.import_batch, t.created_at, t.updated_at
       FROM automation_account_projection a
       JOIN facebook_group_target_scope s ON s.account_group_label = a.group_label
       JOIN facebook_group_target t ON t.group_url = s.group_url
       WHERE a.account_id = $1
         AND EXISTS (
           SELECT 1 FROM automation_sync_read_consumer_checkpoint apj_checkpoint
           WHERE apj_checkpoint.execution_target = $2
             AND apj_checkpoint.consumer = 'automation'
             AND apj_checkpoint.stream = 'automation_account_projection'
             AND apj_checkpoint.state = 'ready'
             AND apj_checkpoint.fresh_until_ms >
                 floor(extract(epoch FROM now()) * 1000)
         )
         AND lower(btrim(a.platform)) IN ('facebook','fb')
         AND a.group_label IS NOT NULL AND btrim(a.group_label) <> ''
         AND t.enabled = true
         AND t.join_gating IN ('unknown','instant')
         AND NOT EXISTS (
           SELECT 1 FROM facebook_group_membership m WHERE m.group_url = t.group_url
         )
       ORDER BY t.priority DESC, t.created_at ASC, t.group_url ASC
       LIMIT 1`,
      [accountId, this.executionTarget],
    );
    return rows[0] ? toTargetRow(rows[0]) : null;
  }

  /**
   * 纯展示面（后台的逐账号加群进度）。同 listFacets **不挂新鲜期谓词**；注意这里的平台谓词是
   * `platform = 'facebook'` 精确等值（不是别处那句 `lower(btrim(...)) IN (...)`），投影存原样值
   * 才能让这句逐字照搬后仍然等价。
   */
  async accountProgress(): Promise<FacebookGroupAccountProgress[]> {
    const { rows } = await this.pool.query<{
      account_id: string;
      assigned: string;
      joining: string;
      joined: string;
      pending: string;
      gated: string;
      failed: string;
      last_joined_at: Date | string | null;
      last_commented_at: Date | string | null;
    }>(
      `SELECT a.account_id,
              count(*) FILTER (WHERE m.status = 'assigned')::text AS assigned,
              count(*) FILTER (WHERE m.status = 'joining')::text AS joining,
              count(*) FILTER (WHERE m.status = 'joined')::text AS joined,
              count(*) FILTER (WHERE m.status = 'pending')::text AS pending,
              count(*) FILTER (WHERE m.status = 'gated')::text AS gated,
              count(*) FILTER (WHERE m.status IN ('failed','checkpoint','no_button','left'))::text AS failed,
              max(m.joined_at) AS last_joined_at,
              max(m.last_commented_at) AS last_commented_at
       FROM automation_account_projection a
       LEFT JOIN facebook_group_membership m ON m.account_id = a.account_id
       WHERE a.platform = 'facebook'
       GROUP BY a.account_id
       ORDER BY a.account_id ASC`,
    );
    return rows.map((r) => ({
      accountId: r.account_id,
      assigned: Number(r.assigned),
      joining: Number(r.joining),
      joined: Number(r.joined),
      pending: Number(r.pending),
      gated: Number(r.gated),
      failed: Number(r.failed),
      lastJoinedAt: iso(r.last_joined_at),
      lastCommentedAt: iso(r.last_commented_at),
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class FacebookGroupMembershipStore {
  private readonly pool: pg.Pool;
  private readonly executionTarget: DeploymentTarget | '__invalid__';

  constructor(options: FacebookGroupStoreOptions = {}) {
    this.pool = poolFrom(options);
    this.executionTarget = projectionExecutionTarget(options.executionTarget);
  }

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await ensureCapabilitySchema(this.pool, {
      capability: 'facebook_group_membership',
      sinceVersion: '0067_baseline_facebook_tables',
      ddl: [FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL],
    });
  }

  async claimNext(accountId: string): Promise<FacebookGroupMembershipRow | null> {
    const { rows } = await this.pool.query<MembershipDbRow>(
      // 写路径守卫（认领一个群成员行）。原为内联 accounts，现读本域投影：整句仍是**一条语句**，
      // 候选选取与 INSERT 的原子性一字未变，且 `FOR UPDATE OF t` 锁的本来就只有 facebook_group_target
      // （automation 属主），从来没有跨属主行锁——去规范化之后更不可能有。
      `WITH candidate AS (
         SELECT t.group_url
         FROM automation_account_projection a
         JOIN facebook_group_target_scope s ON s.account_group_label = a.group_label
         JOIN facebook_group_target t ON t.group_url = s.group_url
         WHERE a.account_id = $1
           AND EXISTS (
             SELECT 1 FROM automation_sync_read_consumer_checkpoint apj_checkpoint
             WHERE apj_checkpoint.execution_target = $2
               AND apj_checkpoint.consumer = 'automation'
               AND apj_checkpoint.stream = 'automation_account_projection'
               AND apj_checkpoint.state = 'ready'
               AND apj_checkpoint.fresh_until_ms >
                   floor(extract(epoch FROM now()) * 1000)
           )
           AND lower(btrim(a.platform)) IN ('facebook','fb')
           AND a.group_label IS NOT NULL AND btrim(a.group_label) <> ''
           AND t.enabled = true
           AND t.join_gating IN ('unknown','instant')
           AND NOT EXISTS (
             SELECT 1 FROM facebook_group_membership m WHERE m.group_url = t.group_url
           )
           AND NOT EXISTS (
             SELECT 1 FROM facebook_group_membership mine
             WHERE mine.account_id = $1 AND mine.status IN ('assigned','joining')
           )
         ORDER BY t.priority DESC, t.created_at ASC, t.group_url ASC
         FOR UPDATE OF t SKIP LOCKED
         LIMIT 1
       )
       INSERT INTO facebook_group_membership (account_id, group_url, status, assigned_at, last_attempt_at, attempts)
       SELECT $1, candidate.group_url, 'assigned', now(), now(), 0
       FROM candidate
       ON CONFLICT (group_url) DO NOTHING
       RETURNING account_id, group_url, status, assigned_at, joined_at, last_attempt_at, attempts,
                 last_reason, last_commented_at, cooldown_until, comments_total, left_confirmations, updated_at`,
      [accountId, this.executionTarget],
    );
    return rows[0] ? toMembershipRow(rows[0]) : null;
  }

  /**
   * 当前投影是否仍在新鲜期内。投影与本 store 的表同库同池（去规范化的全部意义就在这里），
   * 所以这只是一次本地读。任何读失败（含表不存在）一律按「不新鲜」处理 —— fail-closed。
   */
  private async accountProjectionFresh(): Promise<boolean> {
    try {
      const { rows } = await this.pool.query<{ fresh: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM automation_sync_read_consumer_checkpoint apj_checkpoint
            WHERE apj_checkpoint.execution_target = $1
              AND apj_checkpoint.consumer = 'automation'
              AND apj_checkpoint.stream = 'automation_account_projection'
              AND apj_checkpoint.state = 'ready'
              AND apj_checkpoint.fresh_until_ms >
                  floor(extract(epoch FROM now()) * 1000)
         ) AS fresh`,
        [this.executionTarget],
      );
      return rows[0]?.fresh === true;
    } catch {
      return false;
    }
  }

  /**
   * 自动/裸池 assignment 在导航前重验账号当前分组与 scope。只删除 assigned/joining；任何终态事实原样保留。
   *
   * ⚠️ **这一处的极性是反的**，是整批守卫里唯一需要特殊处理的点：这里「账号查不到 / 分组对不上」
   * 意味着**删除**成员行。若照别处那样把新鲜期谓词直接挂进 SQL，投影陈旧时 NOT EXISTS 恒真 →
   * 反而会把一批合法的 assigned 行删掉；若把新鲜期挂在 DELETE 的正向条件上，陈旧时又变成一条也不删、
   * 落到下面的状态读上判 'eligible' —— 那是**放行**，正是红线禁止的方向。
   * 故这里改为**先问新鲜期**：不新鲜就既不删、也不放行，返回具名的 'projection_stale'。
   */
  async revalidateScopedAssignment(
    accountId: string,
    groupUrlInput: string,
  ): Promise<'eligible' | 'scope_mismatch' | 'terminal' | 'missing' | 'projection_stale'> {
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) return 'missing';
    if (!(await this.accountProjectionFresh())) return 'projection_stale';
    const removed = await this.pool.query(
      `DELETE FROM facebook_group_membership m
       WHERE m.account_id = $1 AND m.group_url = $2
         AND m.status IN ('assigned','joining')
         AND NOT EXISTS (
           SELECT 1
           FROM automation_account_projection a
           JOIN facebook_group_target_scope s
             ON s.group_url = m.group_url AND s.account_group_label = a.group_label
           WHERE a.account_id = m.account_id
             AND lower(btrim(a.platform)) IN ('facebook','fb')
             AND a.group_label IS NOT NULL AND btrim(a.group_label) <> ''
         )`,
      [accountId, groupUrl],
    );
    if ((removed.rowCount ?? 0) > 0) return 'scope_mismatch';
    const { rows } = await this.pool.query<{ status: FacebookGroupMembershipStatus }>(
      `SELECT status FROM facebook_group_membership WHERE account_id = $1 AND group_url = $2`,
      [accountId, groupUrl],
    );
    const status = rows[0]?.status;
    if (!status) return 'missing';
    return status === 'assigned' || status === 'joining' ? 'eligible' : 'terminal';
  }

  /**
   * 认领**指定 url** 的成员行（change facebook-comment-review-and-targeted-join，`/comment --join=<url>`）。
   * 因 `UNIQUE(group_url)`，一个群全局仅一行、只归一个账号：
   * - 无行 → INSERT 归本账号（`assigned`），返回 `{row, ownedByOther:false}`；
   * - 已存在且属**别的账号** → 返回 `{row, ownedByOther:true}`（诚实：不可双占，绝不冒充/抢改 account_id）；
   * - 已存在且属本账号且 `status='joined'` → 原样返回（快路，调用方跳过边端）；
   * - 已存在且属本账号但其它 status → 复位为 `assigned`（清 cooldown）供运营重试，返回刷新行。
   * 非 Facebook 群 url → 返回 null。调用方须先 `targets.ensureTarget(url)` 保 FK。
   */
  async claimSpecific(
    accountId: string,
    urlInput: string,
  ): Promise<{ row: FacebookGroupMembershipRow; ownedByOther: boolean } | null> {
    const groupUrl = canonicalFacebookGroupUrl(urlInput);
    if (!groupUrl) return null;
    const cols = `account_id, group_url, status, assigned_at, joined_at, last_attempt_at, attempts,
                  last_reason, last_commented_at, cooldown_until, comments_total, left_confirmations, updated_at`;
    const { rows: inserted } = await this.pool.query<MembershipDbRow>(
      `INSERT INTO facebook_group_membership (account_id, group_url, status, assigned_at, last_attempt_at, attempts)
       VALUES ($1, $2, 'assigned', now(), now(), 0)
       ON CONFLICT (group_url) DO NOTHING
       RETURNING ${cols}`,
      [accountId, groupUrl],
    );
    if (inserted[0]) return { row: toMembershipRow(inserted[0]), ownedByOther: false };
    const { rows: existing } = await this.pool.query<MembershipDbRow>(
      `SELECT ${cols} FROM facebook_group_membership WHERE group_url = $1`,
      [groupUrl],
    );
    const row = existing[0];
    if (!row) return null; // 竞态：刚被删 → 调用方按 invalid 诚实退
    if (row.account_id !== accountId) return { row: toMembershipRow(row), ownedByOther: true };
    if (row.status === 'joined') return { row: toMembershipRow(row), ownedByOther: false };
    const { rows: reset } = await this.pool.query<MembershipDbRow>(
      `UPDATE facebook_group_membership
       SET status = 'assigned', assigned_at = COALESCE(assigned_at, now()), cooldown_until = NULL,
           last_attempt_at = now(), updated_at = now()
       WHERE account_id = $1 AND group_url = $2
       RETURNING ${cols}`,
      [accountId, groupUrl],
    );
    return { row: toMembershipRow(reset[0] ?? row), ownedByOther: false };
  }

  async currentAssignment(accountId: string): Promise<FacebookGroupMembershipRow | null> {
    const { rows } = await this.pool.query<MembershipDbRow>(
      `SELECT account_id, group_url, status, assigned_at, joined_at, last_attempt_at, attempts,
              last_reason, last_commented_at, cooldown_until, comments_total, left_confirmations, updated_at
       FROM facebook_group_membership
       WHERE account_id = $1 AND status IN ('assigned','joining')
         AND (cooldown_until IS NULL OR cooldown_until <= now())
       ORDER BY assigned_at ASC NULLS LAST, updated_at ASC
       LIMIT 1`,
      [accountId],
    );
    return rows[0] ? toMembershipRow(rows[0]) : null;
  }

  async markJoining(accountId: string, groupUrlInput: string, reason = 'attempting'): Promise<boolean> {
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) return false;
    const result = await this.pool.query(
      `UPDATE facebook_group_membership
       SET status = 'joining', last_attempt_at = now(), attempts = attempts + 1, last_reason = $3, updated_at = now()
       WHERE account_id = $1 AND group_url = $2 AND status IN ('assigned','joining')`,
      [accountId, groupUrl, reason],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markJoined(accountId: string, groupUrlInput: string, reason = 'joined'): Promise<void> {
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) return;
    await this.pool.query(
      `UPDATE facebook_group_membership
       SET status = 'joined', joined_at = COALESCE(joined_at, now()), last_attempt_at = now(), last_reason = $3, updated_at = now()
       WHERE account_id = $1 AND group_url = $2`,
      [accountId, groupUrl, reason],
    );
  }

  async markOutcome(
    accountId: string,
    groupUrlInput: string,
    status: Exclude<FacebookGroupMembershipStatus, 'assigned' | 'joining' | 'joined' | 'left'>,
    reason: string,
  ): Promise<void> {
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) return;
    await this.pool.query(
      `UPDATE facebook_group_membership
       SET status = $3, last_attempt_at = now(), last_reason = $4,
           cooldown_until = NULL, updated_at = now()
       WHERE account_id = $1 AND group_url = $2`,
      [accountId, groupUrl, status, reason],
    );
  }

  async markRetryableFailure(
    accountId: string,
    groupUrlInput: string,
    reason: string,
    options: { maxAttempts?: number; backoffMs?: number } = {},
  ): Promise<'retryable' | 'failed'> {
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) return 'failed';
    const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 3));
    const backoffSeconds = Math.max(1, Math.floor((options.backoffMs ?? 6 * 60 * 60 * 1000) / 1000));
    const { rows } = await this.pool.query<{ status: 'retryable' | 'failed' }>(
      `UPDATE facebook_group_membership
       SET status = CASE WHEN attempts >= $4 THEN 'failed' ELSE 'assigned' END,
           last_attempt_at = now(),
           last_reason = $3,
           cooldown_until = CASE WHEN attempts >= $4 THEN cooldown_until ELSE now() + ($5::double precision * interval '1 second') END,
           updated_at = now()
       WHERE account_id = $1 AND group_url = $2
       RETURNING CASE WHEN status = 'failed' THEN 'failed' ELSE 'retryable' END AS status`,
      [accountId, groupUrl, reason, maxAttempts, backoffSeconds],
    );
    return rows[0]?.status ?? 'failed';
  }

  async coverageCandidates(
    accountId: string,
    options: FacebookGroupCoverageCandidateOptions = {},
  ): Promise<FacebookGroupMembershipRow[]> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 5), 1), 50);
    const cols = `account_id, group_url, status, assigned_at, joined_at, last_attempt_at, attempts,
              last_reason, last_commented_at, cooldown_until, comments_total, left_confirmations, updated_at`;
    // 放开时限兜底：丢弃预热 / 冷却 / cooldown_until 三重闸，只留 status='joined'，仍按「最久没评优先」取窗口。
    // 上层仅在正常约束落空时才用它，并把 pick 标记为 relaxed 交人审把关（见 server.ts facebookCoverageConfigFor）。
    if (options.relaxed === true) {
      const { rows } = await this.pool.query<MembershipDbRow>(
        `SELECT ${cols}
         FROM facebook_group_membership
         WHERE account_id = $1
           -- 守卫读改读本域投影（change automation-accounts-projection）：账号在投影里查得到、且投影
           -- 仍在新鲜期内，才认这个账号可以去覆盖评论。缺行 / 陈旧 / 投影从未刷过，三种情况都判否
           -- （不作为覆盖候选、不替一个我们已经说不准还在不在的账号去评论）。
           AND EXISTS (SELECT 1 FROM automation_account_projection a WHERE a.account_id = $1)
           AND EXISTS (
             SELECT 1 FROM automation_sync_read_consumer_checkpoint apj_checkpoint
             WHERE apj_checkpoint.execution_target = $3
               AND apj_checkpoint.consumer = 'automation'
               AND apj_checkpoint.stream = 'automation_account_projection'
               AND apj_checkpoint.state = 'ready'
               AND apj_checkpoint.fresh_until_ms >
                   floor(extract(epoch FROM now()) * 1000)
           )
           AND status = 'joined'
           AND joined_at IS NOT NULL
         ORDER BY last_commented_at ASC NULLS FIRST, joined_at ASC, group_url ASC
         LIMIT $2`,
        [accountId, limit, this.executionTarget],
      );
      return rows.map(toMembershipRow);
    }
    const cooldownSeconds = Math.max(0, Math.floor((options.cooldownMs ?? 72 * 60 * 60 * 1000) / 1000));
    const warmupSeconds = Math.max(0, Math.floor((options.warmupMs ?? 24 * 60 * 60 * 1000) / 1000));
    const { rows } = await this.pool.query<MembershipDbRow>(
      `SELECT ${cols}
       FROM facebook_group_membership
       WHERE account_id = $1
         -- 见 relaxed 分支同一说明：守卫读改读本域投影，缺行 / 陈旧一律判否。
         AND EXISTS (SELECT 1 FROM automation_account_projection a WHERE a.account_id = $1)
         AND EXISTS (
           SELECT 1 FROM automation_sync_read_consumer_checkpoint apj_checkpoint
           WHERE apj_checkpoint.execution_target = $5
             AND apj_checkpoint.consumer = 'automation'
             AND apj_checkpoint.stream = 'automation_account_projection'
             AND apj_checkpoint.state = 'ready'
             AND apj_checkpoint.fresh_until_ms >
                 floor(extract(epoch FROM now()) * 1000)
         )
         AND status = 'joined'
         AND joined_at IS NOT NULL
         AND joined_at <= now() - ($3::double precision * interval '1 second')
         AND (cooldown_until IS NULL OR cooldown_until <= now())
         AND (last_commented_at IS NULL OR last_commented_at <= now() - ($2::double precision * interval '1 second'))
       ORDER BY last_commented_at ASC NULLS FIRST, joined_at ASC, group_url ASC
       LIMIT $4`,
      [accountId, cooldownSeconds, warmupSeconds, limit, this.executionTarget],
    );
    return rows.map(toMembershipRow);
  }

  async markCoverageCommented(
    accountId: string,
    groupUrlInput: string,
    options: { cooldownMs?: number; reason?: string } = {},
  ): Promise<void> {
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) return;
    const cooldownSeconds = Math.max(0, Math.floor((options.cooldownMs ?? 72 * 60 * 60 * 1000) / 1000));
    await this.pool.query(
      `UPDATE facebook_group_membership
       SET last_commented_at = now(),
           comments_total = comments_total + 1,
           cooldown_until = CASE WHEN $3::integer > 0 THEN now() + ($3::double precision * interval '1 second') ELSE cooldown_until END,
           left_confirmations = 0,
           last_reason = $4,
           updated_at = now()
       WHERE account_id = $1 AND group_url = $2 AND status = 'joined'`,
      [accountId, groupUrl, cooldownSeconds, options.reason ?? 'coverage_commented'],
    );
  }

  async recordCoverageLeftSignal(
    accountId: string,
    groupUrlInput: string,
    reason: string,
    options: { requiredConfirmations?: number; demoteNow?: boolean } = {},
  ): Promise<'joined' | 'left' | 'missing'> {
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) return 'missing';
    const required = Math.max(1, Math.trunc(options.requiredConfirmations ?? 3));
    const { rows } = await this.pool.query<{ status: FacebookGroupMembershipStatus }>(
      `UPDATE facebook_group_membership
       SET left_confirmations = CASE WHEN $5 THEN left_confirmations ELSE left_confirmations + 1 END,
           status = CASE WHEN $5 OR left_confirmations + 1 >= $4 THEN 'left' ELSE status END,
           last_attempt_at = now(),
           last_reason = $3,
           updated_at = now()
       WHERE account_id = $1 AND group_url = $2 AND status = 'joined'
       RETURNING status`,
      [accountId, groupUrl, reason, required, options.demoteNow === true],
    );
    const status = rows[0]?.status;
    if (!status) return 'missing';
    return status === 'left' ? 'left' : 'joined';
  }

  async countJoinedToday(accountId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM facebook_group_membership
       WHERE account_id = $1
         AND status = 'joined'
         AND joined_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`,
      [accountId],
    );
    return Number(rows[0]?.n ?? '0');
  }

  async reclaimStaleAssignments(ttlMs: number): Promise<number> {
    const ttlSeconds = Math.max(1, Math.floor(ttlMs / 1000));
    const res = await this.pool.query(
      `DELETE FROM facebook_group_membership
       WHERE status IN ('assigned','joining')
         AND assigned_at IS NOT NULL
         AND assigned_at < now() - ($1::double precision * interval '1 second')`,
      [ttlSeconds],
    );
    return res.rowCount ?? 0;
  }

  async listAssignments(limit = 200): Promise<FacebookGroupMembershipRow[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const { rows } = await this.pool.query<MembershipDbRow>(
      `SELECT account_id, group_url, status, assigned_at, joined_at, last_attempt_at, attempts,
              last_reason, last_commented_at, cooldown_until, comments_total, left_confirmations, updated_at
       FROM facebook_group_membership
       ORDER BY updated_at DESC, group_url ASC
       LIMIT $1`,
      [safeLimit],
    );
    return rows.map(toMembershipRow);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class FacebookGroupJoinAuditStore {
  private readonly pool: pg.Pool;

  constructor(options: FacebookGroupStoreOptions = {}) {
    this.pool = poolFrom(options);
  }

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await ensureCapabilitySchema(this.pool, {
      capability: 'facebook_group_join_audit',
      sinceVersion: '0067_baseline_facebook_tables',
      ddl: [FACEBOOK_GROUP_JOIN_AUDIT_SCHEMA_SQL],
    });
  }

  async append(row: FacebookGroupJoinAuditRow): Promise<void> {
    try {
      const groupUrl = row.groupUrl ? canonicalFacebookGroupUrl(row.groupUrl) : null;
      await this.pool.query(
        `INSERT INTO facebook_group_join_audit
           (account_id, group_url, outcome, phase, verdict, reason, shadow, observation, trigger_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          row.accountId,
          groupUrl,
          row.outcome,
          row.phase ?? null,
          row.verdict ?? null,
          row.reason ?? null,
          row.shadow ?? false,
          row.observation === undefined ? null : JSON.stringify(row.observation),
          row.triggerSource ?? null,
        ],
      );
    } catch (err) {
      console.warn(`[fb-group-join-audit] append failed account=${row.accountId}:`, (err as Error).message);
    }
  }

  async latestScheduledResults(
    accountIds: readonly string[],
  ): Promise<Map<string, FacebookGroupJoinRecentScheduledResult>> {
    const uniqueAccountIds = [...new Set(accountIds.filter((accountId) => accountId.trim() !== ''))];
    if (uniqueAccountIds.length === 0) return new Map();
    const { rows } = await this.pool.query<{
      account_id: string;
      outcome: FacebookGroupJoinAuditOutcome;
      reason: string | null;
      group_url: string | null;
      created_at: Date | string;
    }>(
      `SELECT DISTINCT ON (account_id) account_id, outcome, reason, group_url, created_at
       FROM facebook_group_join_audit
       WHERE account_id = ANY($1::text[]) AND trigger_source = 'scheduled'
       ORDER BY account_id, created_at DESC, id DESC`,
      [uniqueAccountIds],
    );
    return new Map(rows.map((row) => [
      row.account_id,
      {
          outcome: row.outcome,
          reason: row.reason ?? null,
          groupUrl: row.group_url ?? null,
          createdAt: iso(row.created_at)!,
      },
    ]));
  }

  async latestScheduledResult(accountId: string): Promise<FacebookGroupJoinRecentScheduledResult | null> {
    return (await this.latestScheduledResults([accountId])).get(accountId) ?? null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
