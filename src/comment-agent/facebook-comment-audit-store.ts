/**
 * Facebook 定时评论每次触发的审计行（facebook-scheduled-comment 2.7）。
 *
 * best-effort：调用方 fire-and-forget、吞错，绝不波及评论主链路（红线，镜像 publish-pipeline-log-store）。
 * 目的：把每次触发的结果（含影子）落成可查记录，让「静默停摆」（连续 login_required / quota_denied /
 * no_targets / compose_skipped）从「翻 journalctl」变「查表」，并给告警器计数。不记任何 secrets —— 只记
 * 账号、结果、原因、容器/关键词标签、影子标志、时间；评论正文不入库（存长度，需要时另存 hash）。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';

const { Pool } = pg;

/** 触发结果分类（稳定字符串，供查询/告警计数）。 */
export type FacebookCommentOutcome =
  | 'shadow_ok' // 影子：撰写+校验通过，未提交
  | 'commented' // 真发且服务器确认成功
  | 'no_targets' // 无关键词/容器（fail-closed）
  | 'quota_denied' // canDo / 日上限拒
  | 'cooldown_denied' // 冷却拒
  | 'compose_skipped' // 校验器拒（不修不发）
  | 'no_strong_candidate' // 搜索无可评论候选
  | 'login_required' // 登录失效 / checkpoint
  | 'submit_failed' // 提交失败
  | 'verification_ambiguous' // 提交后无法确认
  | 'not_wired'; // 真发执行尚未接入（当前）

export interface FacebookCommentAuditRow {
  accountId: string;
  outcome: FacebookCommentOutcome;
  reason?: string;
  shadow: boolean;
  keyword?: string;
  container?: string;
  textLength?: number;
}

export const FACEBOOK_COMMENT_AUDIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facebook_comment_audit (
  id           BIGSERIAL PRIMARY KEY,
  account_id   TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  reason       TEXT,
  shadow       BOOLEAN NOT NULL DEFAULT false,
  keyword      TEXT,
  container    TEXT,
  text_length  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fb_comment_audit_account ON facebook_comment_audit (account_id, created_at DESC);
`;

export interface FacebookCommentAuditStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

export class FacebookCommentAuditStore {
  private readonly pool: pg.Pool;

  constructor(options: FacebookCommentAuditStoreOptions = {}) {
    this.pool =
      options.pool ??
      new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
  }

  async init(): Promise<void> {
    await this.pool.query(FACEBOOK_COMMENT_AUDIT_SCHEMA_SQL);
  }

  /**
   * best-effort 写一行审计。绝不抛：调用方 `void audit.append(...)` 即可，写失败只吞（记 warn）。
   */
  async append(row: FacebookCommentAuditRow): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO facebook_comment_audit (account_id, outcome, reason, shadow, keyword, container, text_length)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.accountId,
          row.outcome,
          row.reason ?? null,
          row.shadow,
          row.keyword ?? null,
          row.container ?? null,
          row.textLength ?? null,
        ],
      );
    } catch (err) {
      console.warn(`[fb-comment-audit] append 失败（不影响评论主链路）account=${row.accountId}:`, (err as Error).message);
    }
  }
}
