/**
 * Narrow approval-policy storage.
 *
 * Account comment policy is an all-source standing authorization. Group publish
 * policy controls only whether a review draft gets an additional Feishu button
 * card. Missing rows preserve the legacy behavior.
 */
import pg from 'pg';
import { resolveEnvPgConfig } from '../kernel/pg-config.js';
import { RETIRED_ACCOUNT_ID } from '../account-store.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';

const { Pool } = pg;

export const ACCOUNT_COMMENT_APPROVAL_MODES = ['source_rules', 'auto_approve_all'] as const;
export type AccountCommentApprovalMode = (typeof ACCOUNT_COMMENT_APPROVAL_MODES)[number];

export const GROUP_PUBLISH_APPROVAL_DELIVERIES = ['client_and_feishu', 'client_only'] as const;
export type GroupPublishApprovalDelivery = (typeof GROUP_PUBLISH_APPROVAL_DELIVERIES)[number];

export const APPROVAL_POLICY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS account_comment_approval_policy (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  mode        TEXT NOT NULL CHECK (mode IN ('source_rules','auto_approve_all')),
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS group_publish_approval_policy (
  group_label TEXT PRIMARY KEY,
  delivery    TEXT NOT NULL CHECK (delivery IN ('client_and_feishu','client_only')),
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export interface AccountCommentApprovalPolicyRow {
  accountId: string;
  mode: AccountCommentApprovalMode;
  configured: boolean;
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface GroupPublishApprovalPolicyRow {
  groupLabel: string;
  delivery: GroupPublishApprovalDelivery;
  configured: boolean;
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface AccountGroupPublishApprovalPolicy {
  groupLabel: string | null;
  delivery: GroupPublishApprovalDelivery;
}

export type SetAccountCommentApprovalPolicyResult =
  | { ok: true; row: AccountCommentApprovalPolicyRow }
  | { ok: false; reason: 'account_not_found' | 'retired_account' | 'invalid_mode' };

export type SetGroupPublishApprovalPolicyResult =
  | { ok: true; row: GroupPublishApprovalPolicyRow }
  | { ok: false; reason: 'group_not_found' | 'invalid_delivery' | 'invalid_group' };

export interface ApprovalPolicyStoreOptions {
  pool?: pg.Pool;
  /** schema 保障能力注入端口（必填、无默认）：组合根传 automation 的 ensureCapabilitySchema，本文件只从 kernel 取类型。 */
  schemaEnsurer: SchemaEnsurer;
}

function isMissingTable(error: unknown): boolean {
  return (error as { code?: string }).code === '42P01';
}

function accountMode(value: unknown): AccountCommentApprovalMode {
  return value === 'auto_approve_all' ? 'auto_approve_all' : 'source_rules';
}

function groupDelivery(value: unknown): GroupPublishApprovalDelivery {
  return value === 'client_only' ? 'client_only' : 'client_and_feishu';
}

export class ApprovalPolicyStore {
  private readonly pool: pg.Pool;

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: ApprovalPolicyStoreOptions) {
    this.schemaEnsurer = options.schemaEnsurer;
    this.pool = options.pool ?? new Pool(resolveEnvPgConfig());
  }

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'approval_policy',
      sinceVersion: '0056_scoped_approval_policy',
      ddl: [APPROVAL_POLICY_SCHEMA_SQL],
    });
  }

  async getAccountCommentMode(accountId: string): Promise<AccountCommentApprovalMode> {
    const account = (accountId ?? '').trim();
    if (!account || account === RETIRED_ACCOUNT_ID) return 'source_rules';
    try {
      const { rows } = await this.pool.query<{ mode: string }>(
        `SELECT mode FROM account_comment_approval_policy WHERE account_id=$1`,
        [account],
      );
      return accountMode(rows[0]?.mode);
    } catch (error) {
      if (isMissingTable(error)) return 'source_rules';
      throw error;
    }
  }

  async getGroupPublishPolicyForAccount(accountId: string): Promise<AccountGroupPublishApprovalPolicy> {
    const account = (accountId ?? '').trim();
    if (!account || account === RETIRED_ACCOUNT_ID) return { groupLabel: null, delivery: 'client_and_feishu' };
    try {
      const { rows } = await this.pool.query<{ group_label: string | null; delivery: string | null }>(
        `SELECT NULLIF(btrim(a.group_label), '') AS group_label, p.delivery
           FROM accounts a
           LEFT JOIN group_publish_approval_policy p ON p.group_label=NULLIF(btrim(a.group_label), '')
          WHERE a.account_id=$1`,
        [account],
      );
      return {
        groupLabel: rows[0]?.group_label ?? null,
        delivery: groupDelivery(rows[0]?.delivery),
      };
    } catch (error) {
      if (isMissingTable(error)) return { groupLabel: null, delivery: 'client_and_feishu' };
      throw error;
    }
  }

  async listAccountPolicies(): Promise<AccountCommentApprovalPolicyRow[]> {
    const { rows } = await this.pool.query<{
      account_id: string; mode: string | null; updated_by: string | null; updated_at: Date | null;
    }>(
      `SELECT a.account_id,p.mode,p.updated_by,p.updated_at
         FROM accounts a
         LEFT JOIN account_comment_approval_policy p ON p.account_id=a.account_id
        WHERE a.account_id<>$1
        ORDER BY a.account_id`,
      [RETIRED_ACCOUNT_ID],
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      mode: accountMode(row.mode),
      configured: row.mode != null,
      updatedBy: row.updated_by ?? null,
      updatedAt: row.updated_at?.getTime() ?? null,
    }));
  }

  async listGroupPolicies(): Promise<GroupPublishApprovalPolicyRow[]> {
    const { rows } = await this.pool.query<{
      group_label: string; delivery: string | null; updated_by: string | null; updated_at: Date | null;
    }>(
      `SELECT groups.group_label,p.delivery,p.updated_by,p.updated_at
         FROM (SELECT DISTINCT btrim(group_label) AS group_label
                 FROM accounts
                WHERE group_label IS NOT NULL AND btrim(group_label) <> '') groups
         LEFT JOIN group_publish_approval_policy p ON p.group_label=groups.group_label
        ORDER BY groups.group_label`,
    );
    return rows.map((row) => ({
      groupLabel: row.group_label,
      delivery: groupDelivery(row.delivery),
      configured: row.delivery != null,
      updatedBy: row.updated_by ?? null,
      updatedAt: row.updated_at?.getTime() ?? null,
    }));
  }

  async setAccountCommentMode(
    accountId: string,
    mode: AccountCommentApprovalMode,
    updatedBy: string | null,
  ): Promise<SetAccountCommentApprovalPolicyResult> {
    const account = (accountId ?? '').trim();
    if (account === RETIRED_ACCOUNT_ID) return { ok: false, reason: 'retired_account' };
    if (!ACCOUNT_COMMENT_APPROVAL_MODES.includes(mode)) return { ok: false, reason: 'invalid_mode' };
    const exists = await this.pool.query(`SELECT 1 FROM accounts WHERE account_id=$1`, [account]);
    if (!exists.rows[0]) return { ok: false, reason: 'account_not_found' };
    const { rows } = await this.pool.query<{
      account_id: string; mode: string; updated_by: string | null; updated_at: Date;
    }>(
      `INSERT INTO account_comment_approval_policy(account_id,mode,updated_by,updated_at)
       VALUES($1,$2,$3,now())
       ON CONFLICT(account_id) DO UPDATE
         SET mode=EXCLUDED.mode,updated_by=EXCLUDED.updated_by,updated_at=now()
       RETURNING account_id,mode,updated_by,updated_at`,
      [account, mode, updatedBy],
    );
    const row = rows[0];
    return { ok: true, row: {
      accountId: row.account_id,
      mode: accountMode(row.mode),
      configured: true,
      updatedBy: row.updated_by ?? null,
      updatedAt: row.updated_at.getTime(),
    } };
  }

  async setGroupPublishDelivery(
    groupLabel: string,
    delivery: GroupPublishApprovalDelivery,
    updatedBy: string | null,
  ): Promise<SetGroupPublishApprovalPolicyResult> {
    const group = (groupLabel ?? '').trim();
    if (!group) return { ok: false, reason: 'invalid_group' };
    if (!GROUP_PUBLISH_APPROVAL_DELIVERIES.includes(delivery)) return { ok: false, reason: 'invalid_delivery' };
    const exists = await this.pool.query(
      `SELECT 1 FROM accounts WHERE btrim(group_label)=$1 LIMIT 1`,
      [group],
    );
    if (!exists.rows[0]) return { ok: false, reason: 'group_not_found' };
    const { rows } = await this.pool.query<{
      group_label: string; delivery: string; updated_by: string | null; updated_at: Date;
    }>(
      `INSERT INTO group_publish_approval_policy(group_label,delivery,updated_by,updated_at)
       VALUES($1,$2,$3,now())
       ON CONFLICT(group_label) DO UPDATE
         SET delivery=EXCLUDED.delivery,updated_by=EXCLUDED.updated_by,updated_at=now()
       RETURNING group_label,delivery,updated_by,updated_at`,
      [group, delivery, updatedBy],
    );
    const row = rows[0];
    return { ok: true, row: {
      groupLabel: row.group_label,
      delivery: groupDelivery(row.delivery),
      configured: true,
      updatedBy: row.updated_by ?? null,
      updatedAt: row.updated_at.getTime(),
    } };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
