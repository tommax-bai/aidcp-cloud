/**
 * 通知联系人名册存储（PostgreSQL，aidcp 库）。change notification-contact-registry，迁移 0016。
 *
 * 把「给本账号发过通知的人」（评论/@/点赞/收藏/关注）沉淀成可人工运营的联系人名册：
 *  - notification_event：只追加的事件流水 = 真相（机器写）；主键 (account_id, dedup_key)，
 *    ON CONFLICT DO NOTHING 保证重扫/重启幂等。dedup_key 按 kind 计算、与飞书去重水位解耦，
 *    评论/@ 含内容判别（红线：同人同篇不同评论绝不撞键丢失）。
 *  - notification_contact_meta：人工字段（微信预留 / 标签 / 备注）唯一落点（巡视绝不碰、人工只碰它）。
 *  - 「联系人列表」= 读时按 COALESCE(主页ID, 昵称, dedup_key) 分组聚合算出（不物化；只左连 meta=1:1，不放大计数）。
 *
 * 红线：边轻云重（边缘只抽取上报，记录全在此云端层）；绝不静默假成功（缺昵称/主页ID 如实留空、
 * 结构异常空行丢弃而非记空联系人、互动次数读时 COUNT 实算）；记账被调用方 try/catch 包住、绝不拖垮巡视。
 * PII：存别人昵称 + 评论原文 + 主页ID（平台公开内容，与飞书通知同源），带每账号留存上限。
 */

import pg from 'pg';
// DEFAULT_PG_CONFIG 的真实归属是 kernel（pg-config.ts），pg-anchor-cache 只是再导出；api
// 直连 kernel（api→kernel 恒允许），取值逐字不变，消去 api→automation 这一跨边界豁免。
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import type { NotificationItem } from '../comm/protocol.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';

const { Pool } = pg;

export const NOTIFICATION_CONTACT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_event (
  account_id   TEXT        NOT NULL,
  dedup_key    TEXT        NOT NULL,
  reason       TEXT        NOT NULL,
  from_user    TEXT,
  from_user_id TEXT,
  content      TEXT,
  note_title   TEXT,
  seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_notification_event_account_seen ON notification_event (account_id, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_event_account_user ON notification_event (account_id, from_user_id);

CREATE TABLE IF NOT EXISTS notification_contact_meta (
  account_id TEXT        NOT NULL,
  sender_key TEXT        NOT NULL,
  wechat     TEXT,
  note       TEXT,
  tags       TEXT[]      NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  PRIMARY KEY (account_id, sender_key)
);
`;

/** 一个联系人（读时聚合产物）。时间戳为 epoch ms。 */
export interface NotificationContact {
  /** 该联系人归属的账号（全账号视图下据此区分同一人在不同账号下的两行 + 路由人工字段写入）。 */
  accountId: string;
  senderKey: string;
  nickname: string | null;
  userId: string | null;
  firstReason: string;
  reasons: string[];
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
  wechat: string | null;
  note: string | null;
  tags: string[];
  updatedBy: string | null;
  updatedAt: number | null;
}

/** 人工字段写入（只改侧表，绝不碰事件流水）。 */
export interface NotificationContactManual {
  wechat?: string | null;
  note?: string | null;
  tags?: string[];
}

export interface NotificationContactStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  /** schema 保障能力注入端口（必填、无默认）：组合根传 automation 的 ensureCapabilitySchema，本文件只从 kernel 取类型。 */
  schemaEnsurer: SchemaEnsurer;
  /** 每账号事件保留上限（行数），超出裁最旧。默认 5000。 */
  retentionMax?: number;
}

/** 稳定短哈希（FNV-1a → base36），用于评论去重键的内容判别，绑定键长。 */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const trimOrNull = (s: string | undefined | null): string | null => {
  const t = (s ?? '').trim();
  return t.length ? t : null;
};

/**
 * 事件去重键（本变更自定义，与飞书去重水位解耦）：
 *  - 评论/@：身份 + 笔记锚点 + 内容哈希 —— 同人同篇不同评论各自独立、同一条重扫折叠（红线：不丢真实事件）。
 *  - 点赞/收藏：身份 + 笔记锚点 + kind —— 一人对一篇的一次赞/藏唯一。
 *  - 关注：身份 + kind —— 一人关注你一次（取关再关属罕见，折叠可接受）。
 * 身份取 主页ID > 昵称 > 空；三者皆空且无锚点无内容的结构异常项由 appendEvents 丢弃。
 */
export function notificationDedupKey(it: NotificationItem): string {
  const id = trimOrNull(it.fromUserId) ?? trimOrNull(it.fromUser) ?? '';
  const anchor = trimOrNull(it.itemKey) ?? trimOrNull(it.noteTitle) ?? '';
  switch (it.kind) {
    case 'like':
    case 'collect':
      return `${it.kind}|${id}|${anchor}`;
    case 'follow':
      return `follow|${id}`;
    case 'comment':
    case 'mention':
    default:
      return `${it.kind}|${id}|${anchor}|${shortHash(trimOrNull(it.content) ?? '')}`;
  }
}

export class NotificationContactStore {
  private readonly pool: pg.Pool;
  private readonly retentionMax: number;

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: NotificationContactStoreOptions) {
    this.schemaEnsurer = options.schemaEnsurer;
    this.retentionMax = options.retentionMax ?? 5000;
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

  /** schema 探测（不建表）。 */
  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'notification_contact',
      sinceVersion: '0016_notification_contacts',
      ddl: [NOTIFICATION_CONTACT_SCHEMA_SQL],
    });
  }

  /**
   * 追加一批通知发送者事件（按账号；幂等）。结构异常项（无身份且无内容无锚点）诚实丢弃。
   * 写后按账号裁到留存上限（删最旧）。
   */
  async appendEvents(accountId: string, items: NotificationItem[]): Promise<void> {
    if (!accountId || !Array.isArray(items) || items.length === 0) return;
    const rows = items
      .map((it) => {
        const fromUser = trimOrNull(it.fromUser);
        const fromUserId = trimOrNull(it.fromUserId);
        const content = trimOrNull(it.content);
        const anchor = trimOrNull(it.itemKey) ?? trimOrNull(it.noteTitle);
        // 诚实有效性闸：无任何身份/锚点/内容的结构异常行丢弃（绝不记成空联系人）。
        if (!fromUser && !fromUserId && !anchor && !content) return null;
        return {
          dedupKey: notificationDedupKey(it),
          reason: it.kind,
          fromUser,
          fromUserId,
          content,
          noteTitle: trimOrNull(it.noteTitle),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length === 0) return;

    // 多行 INSERT ... ON CONFLICT DO NOTHING（同批次内重复键由 DISTINCT 兜底，避免单语句冲突）。
    const seen = new Set<string>();
    const unique = rows.filter((r) => (seen.has(r.dedupKey) ? false : (seen.add(r.dedupKey), true)));
    const params: unknown[] = [accountId];
    const tuples: string[] = [];
    for (const r of unique) {
      const base = params.length;
      tuples.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
      params.push(r.dedupKey, r.reason, r.fromUser, r.fromUserId, r.content, r.noteTitle);
    }
    await this.pool.query(
      `INSERT INTO notification_event (account_id, dedup_key, reason, from_user, from_user_id, content, note_title)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (account_id, dedup_key) DO NOTHING`,
      params,
    );

    // 每账号留存上限：超出删最旧（bound 无界增长 + 第三方 PII 保留）。
    await this.pool.query(
      `DELETE FROM notification_event
       WHERE account_id = $1
         AND dedup_key NOT IN (
           SELECT dedup_key FROM notification_event
           WHERE account_id = $1 ORDER BY seen_at DESC LIMIT $2
         )`,
      [accountId, this.retentionMax],
    );
  }

  /**
   * 联系人列表（读时聚合）。按 (账号, COALESCE(主页ID, 昵称, dedup_key)) 分组，只左连人工侧表（1:1，不放大计数）。
   * accountId 给定＝按该账号过滤；缺省（undefined/空）＝全账号合并视图（运营便利，每行仍带 accountId、写入按行账号路由隔离）。
   * 缺表（迁移未跑）回落空。
   */
  async listContacts(accountId?: string, limit = 200, offset = 0): Promise<NotificationContact[]> {
    try {
      const params: unknown[] = [];
      let accountFilter = '';
      if (accountId) {
        params.push(accountId);
        accountFilter = `WHERE e.account_id = $${params.length}`;
      }
      params.push(Math.max(1, Math.min(limit, 1000)));
      const limitIdx = params.length;
      params.push(Math.max(0, offset));
      const offsetIdx = params.length;
      const { rows } = await this.pool.query<{
        account_id: string;
        sender_key: string;
        nickname: string | null;
        user_id: string | null;
        first_reason: string;
        reasons: string[];
        first_seen: Date;
        last_seen: Date;
        event_count: string;
        wechat: string | null;
        note: string | null;
        tags: string[] | null;
        updated_by: string | null;
        updated_at: Date | null;
      }>(
        `SELECT
           e.account_id                                              AS account_id,
           COALESCE(e.from_user_id, e.from_user, e.dedup_key)         AS sender_key,
           MAX(e.from_user)                                           AS nickname,
           MAX(e.from_user_id)                                        AS user_id,
           MIN(e.seen_at)                                             AS first_seen,
           MAX(e.seen_at)                                             AS last_seen,
           COUNT(*)                                                   AS event_count,
           (array_agg(e.reason ORDER BY e.seen_at ASC))[1]            AS first_reason,
           array_agg(DISTINCT e.reason)                               AS reasons,
           m.wechat                                                   AS wechat,
           m.note                                                     AS note,
           COALESCE(m.tags, '{}')                                     AS tags,
           m.updated_by                                               AS updated_by,
           m.updated_at                                               AS updated_at
         FROM notification_event e
         LEFT JOIN notification_contact_meta m
           ON m.account_id = e.account_id
          AND m.sender_key = COALESCE(e.from_user_id, e.from_user, e.dedup_key)
         ${accountFilter}
         GROUP BY e.account_id, COALESCE(e.from_user_id, e.from_user, e.dedup_key),
                  m.wechat, m.note, m.tags, m.updated_by, m.updated_at
         ORDER BY MAX(e.seen_at) DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params,
      );
      return rows.map((r) => ({
        accountId: r.account_id,
        senderKey: r.sender_key,
        nickname: r.nickname ?? null,
        userId: r.user_id ?? null,
        firstReason: r.first_reason,
        reasons: r.reasons ?? [],
        firstSeen: r.first_seen.getTime(),
        lastSeen: r.last_seen.getTime(),
        eventCount: Number(r.event_count),
        wechat: r.wechat ?? null,
        note: r.note ?? null,
        tags: r.tags ?? [],
        updatedBy: r.updated_by ?? null,
        updatedAt: r.updated_at ? r.updated_at.getTime() : null,
      }));
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') return []; // undefined_table：迁移未跑 → 回落空
      throw err;
    }
  }

  /** 人工字段 upsert（只动侧表；绝不碰事件流水）。返回写后联系人（若该 senderKey 有事件）。 */
  async setManual(
    accountId: string,
    senderKey: string,
    manual: NotificationContactManual,
    updatedBy: string | null,
  ): Promise<void> {
    if (!accountId || !senderKey) return;
    const tags = Array.isArray(manual.tags) ? manual.tags : [];
    await this.pool.query(
      `INSERT INTO notification_contact_meta (account_id, sender_key, wechat, note, tags, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (account_id, sender_key)
       DO UPDATE SET wechat = EXCLUDED.wechat, note = EXCLUDED.note, tags = EXCLUDED.tags,
                     updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [accountId, senderKey, trimOrNull(manual.wechat), trimOrNull(manual.note), tags, updatedBy],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
