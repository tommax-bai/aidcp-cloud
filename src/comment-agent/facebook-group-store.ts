import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';

const { Pool } = pg;

export type FacebookGroupJoinGating = 'unknown' | 'instant' | 'gated';
export type FacebookGroupMembershipStatus =
  | 'assigned'
  | 'joining'
  | 'joined'
  | 'pending'
  | 'gated'
  | 'no_button'
  | 'checkpoint'
  | 'failed'
  | 'left';

export interface FacebookGroupStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

export interface FacebookGroupTargetInput {
  url: string;
  name?: string | null;
}

export interface FacebookGroupTargetRow {
  groupUrl: string;
  groupName: string | null;
  joinGating: FacebookGroupJoinGating;
  priority: number;
  enabled: boolean;
  importBatch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FacebookGroupTargetListRow extends FacebookGroupTargetRow {
  accountId: string | null;
  membershipStatus: FacebookGroupMembershipStatus | null;
  joinedAt: string | null;
  lastAttemptAt: string | null;
  lastReason: string | null;
  lastCommentedAt: string | null;
  commentsTotal: number;
}

export interface FacebookGroupImportResult {
  imported: number;
  duplicate: number;
  invalid: number;
  rows: FacebookGroupTargetRow[];
}

export interface FacebookGroupTargetListOptions {
  limit?: number;
  offset?: number;
  status?: FacebookGroupMembershipStatus | 'unassigned';
  enabled?: boolean;
}

export interface FacebookGroupTargetListResult {
  items: FacebookGroupTargetListRow[];
  total: number;
}

export interface FacebookGroupAccountProgress {
  accountId: string;
  assigned: number;
  joining: number;
  joined: number;
  pending: number;
  gated: number;
  failed: number;
  lastJoinedAt: string | null;
  lastCommentedAt: string | null;
}

export interface FacebookGroupMembershipRow {
  accountId: string;
  groupUrl: string;
  status: FacebookGroupMembershipStatus;
  assignedAt: string | null;
  joinedAt: string | null;
  lastAttemptAt: string | null;
  attempts: number;
  lastReason: string | null;
  lastCommentedAt: string | null;
  cooldownUntil: string | null;
  commentsTotal: number;
  leftConfirmations: number;
  updatedAt: string;
}

export interface FacebookGroupCoverageCandidateOptions {
  limit?: number;
  cooldownMs?: number;
  warmupMs?: number;
}

export type FacebookGroupJoinAuditOutcome =
  | 'shadow_observed'
  | 'quota_denied'
  | 'claimed'
  | 'joined'
  | 'already_member'
  | 'gated_skip'
  | 'pending'
  | 'questionnaire_required'
  | 'no_button'
  | 'login_required'
  | 'blocked_by_captcha'
  | 'nav_error'
  | 'join_failed'
  | 'ambiguous_skip'
  | 'no_targets';

export interface FacebookGroupJoinAuditRow {
  accountId: string;
  groupUrl?: string | null;
  outcome: FacebookGroupJoinAuditOutcome;
  phase?: 'pre_click' | 'post_click' | 'scheduler' | 'shadow';
  verdict?: string;
  reason?: string;
  shadow?: boolean;
  observation?: unknown;
}

interface TargetDbRow {
  group_url: string;
  group_name: string | null;
  join_gating: FacebookGroupJoinGating;
  priority: number;
  enabled: boolean;
  import_batch: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TargetListDbRow extends TargetDbRow {
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

function toTargetRow(r: TargetDbRow): FacebookGroupTargetRow {
  return {
    groupUrl: r.group_url,
    groupName: r.group_name ?? null,
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
  join_gating  TEXT NOT NULL DEFAULT 'unknown'
               CHECK (join_gating IN ('unknown','instant','gated')),
  priority     INTEGER NOT NULL DEFAULT 0,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  import_batch TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS group_name TEXT;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS join_gating TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS import_batch TEXT;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_fb_group_target_enabled_gating
  ON facebook_group_target (enabled, join_gating, priority DESC, created_at ASC);
`;

export const FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facebook_group_membership (
  id                  BIGSERIAL PRIMARY KEY,
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
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fb_group_join_audit_account
  ON facebook_group_join_audit (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fb_group_join_audit_group
  ON facebook_group_join_audit (group_url, created_at DESC);
`;

export class FacebookGroupTargetStore {
  private readonly pool: pg.Pool;

  constructor(options: FacebookGroupStoreOptions = {}) {
    this.pool = poolFrom(options);
  }

  async init(): Promise<void> {
    await this.pool.query(FACEBOOK_GROUP_TARGET_SCHEMA_SQL);
  }

  async importTargets(
    inputs: FacebookGroupTargetInput[],
    importBatch: string | null = null,
  ): Promise<FacebookGroupImportResult> {
    let invalid = 0;
    let duplicate = 0;
    const seen = new Set<string>();
    const rows: FacebookGroupTargetRow[] = [];
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
      const { rows: inserted } = await this.pool.query<TargetDbRow>(
        `INSERT INTO facebook_group_target (group_url, group_name, import_batch)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_url) DO NOTHING
         RETURNING group_url, group_name, join_gating, priority, enabled, import_batch, created_at, updated_at`,
        [groupUrl, normalizeName(input.name), importBatch],
      );
      if (!inserted[0]) {
        duplicate++;
        continue;
      }
      rows.push(toTargetRow(inserted[0]));
    }
    return { imported: rows.length, duplicate, invalid, rows };
  }

  async setEnabled(groupUrlInput: string, enabled: boolean): Promise<FacebookGroupTargetRow | null> {
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) return null;
    const { rows } = await this.pool.query<TargetDbRow>(
      `UPDATE facebook_group_target
       SET enabled = $2, updated_at = now()
       WHERE group_url = $1
       RETURNING group_url, group_name, join_gating, priority, enabled, import_batch, created_at, updated_at`,
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
      `SELECT t.group_url, t.group_name, t.join_gating, t.priority, t.enabled, t.import_batch,
              t.created_at, t.updated_at,
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

  async nextJoinCandidate(): Promise<FacebookGroupTargetRow | null> {
    const { rows } = await this.pool.query<TargetDbRow>(
      `SELECT t.group_url, t.group_name, t.join_gating, t.priority, t.enabled, t.import_batch, t.created_at, t.updated_at
       FROM facebook_group_target t
       WHERE t.enabled = true
         AND t.join_gating IN ('unknown','instant')
         AND NOT EXISTS (
           SELECT 1 FROM facebook_group_membership m WHERE m.group_url = t.group_url
         )
       ORDER BY t.priority DESC, t.created_at ASC, t.group_url ASC
       LIMIT 1`,
    );
    return rows[0] ? toTargetRow(rows[0]) : null;
  }

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
       FROM accounts a
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

  constructor(options: FacebookGroupStoreOptions = {}) {
    this.pool = poolFrom(options);
  }

  async init(): Promise<void> {
    await this.pool.query(FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL);
  }

  async claimNext(accountId: string): Promise<FacebookGroupMembershipRow | null> {
    const { rows } = await this.pool.query<MembershipDbRow>(
      `INSERT INTO facebook_group_membership (account_id, group_url, status, assigned_at, last_attempt_at, attempts)
       SELECT $1, t.group_url, 'assigned', now(), now(), 0
       FROM facebook_group_target t
       WHERE t.enabled = true
         AND t.join_gating IN ('unknown','instant')
         AND NOT EXISTS (
           SELECT 1 FROM facebook_group_membership m WHERE m.group_url = t.group_url
         )
       ORDER BY t.priority DESC, t.created_at ASC, t.group_url ASC
       LIMIT 1
       ON CONFLICT (group_url) DO NOTHING
       RETURNING account_id, group_url, status, assigned_at, joined_at, last_attempt_at, attempts,
                 last_reason, last_commented_at, cooldown_until, comments_total, left_confirmations, updated_at`,
      [accountId],
    );
    return rows[0] ? toMembershipRow(rows[0]) : null;
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

  async markJoining(accountId: string, groupUrlInput: string, reason = 'attempting'): Promise<void> {
    const groupUrl = canonicalFacebookGroupUrl(groupUrlInput);
    if (!groupUrl) return;
    await this.pool.query(
      `UPDATE facebook_group_membership
       SET status = 'joining', last_attempt_at = now(), attempts = attempts + 1, last_reason = $3, updated_at = now()
       WHERE account_id = $1 AND group_url = $2`,
      [accountId, groupUrl, reason],
    );
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
       SET status = $3, last_attempt_at = now(), last_reason = $4, updated_at = now()
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
    const cooldownSeconds = Math.max(0, Math.floor((options.cooldownMs ?? 72 * 60 * 60 * 1000) / 1000));
    const warmupSeconds = Math.max(0, Math.floor((options.warmupMs ?? 24 * 60 * 60 * 1000) / 1000));
    const { rows } = await this.pool.query<MembershipDbRow>(
      `SELECT account_id, group_url, status, assigned_at, joined_at, last_attempt_at, attempts,
              last_reason, last_commented_at, cooldown_until, comments_total, left_confirmations, updated_at
       FROM facebook_group_membership
       WHERE account_id = $1
         AND status = 'joined'
         AND joined_at IS NOT NULL
         AND joined_at <= now() - ($3::double precision * interval '1 second')
         AND (cooldown_until IS NULL OR cooldown_until <= now())
         AND (last_commented_at IS NULL OR last_commented_at <= now() - ($2::double precision * interval '1 second'))
       ORDER BY last_commented_at ASC NULLS FIRST, joined_at ASC, group_url ASC
       LIMIT $4`,
      [accountId, cooldownSeconds, warmupSeconds, limit],
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
    await this.pool.query(FACEBOOK_GROUP_JOIN_AUDIT_SCHEMA_SQL);
  }

  async append(row: FacebookGroupJoinAuditRow): Promise<void> {
    try {
      const groupUrl = row.groupUrl ? canonicalFacebookGroupUrl(row.groupUrl) : null;
      await this.pool.query(
        `INSERT INTO facebook_group_join_audit
           (account_id, group_url, outcome, phase, verdict, reason, shadow, observation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          row.accountId,
          groupUrl,
          row.outcome,
          row.phase ?? null,
          row.verdict ?? null,
          row.reason ?? null,
          row.shadow ?? false,
          row.observation === undefined ? null : JSON.stringify(row.observation),
        ],
      );
    } catch (err) {
      console.warn(`[fb-group-join-audit] append failed account=${row.accountId}:`, (err as Error).message);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
