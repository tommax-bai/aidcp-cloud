/**
 * 团队 → 飞书群路由存储（PostgreSQL，aidcp 库）。change feishu-per-team-notification-routing。
 *
 * 把「团队键（账号 `accounts.group_label`）→ 目标飞书群 chat_id」沉淀成可运营配置，
 * 供出站按账号路由：账号 → group_label → 本表 chat_id → 命中即投；命不中回落默认群链。
 *
 * 红线：
 *  - schema 在 init() 里 CREATE TABLE IF NOT EXISTS 自建（本仓无 migration 执行器，只写迁移文件的表可能永不建出）。
 *  - 单写者（UPDATE/UPSERT + RETURNING 读回为真），绝不乐观假成功；空 chat_id 判为「清除该团队路由」。
 *  - 绑定目标是 opaque chat_id（TEXT，非枚举）——结构性避免 cloud→console 枚举漂移白屏。
 *  - 读缺表（42P01，迁移未跑 / 首启竞态）回落 null，绝不把「读失败」冒充成路由命中或抛垮调用方。
 */

import pg from 'pg';
import { resolveEnvPgConfig } from './pg-config.js';
import { ensureCapabilitySchema } from '../schema/schema-capability.js';

const { Pool } = pg;

export const GROUP_ROUTE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS group_route (
  group_label TEXT        PRIMARY KEY,
  chat_id     TEXT        NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/** 一条团队路由（读时产物）。updatedAt 为 epoch ms。 */
export interface GroupRoute {
  groupLabel: string;
  chatId: string;
  updatedBy: string | null;
  updatedAt: number;
}

/** 写路由结果：诚实可区分——写入 / 清除（route=null）/ 无效键拒绝。 */
export type SetGroupRouteResult =
  | { ok: true; route: GroupRoute | null }
  | { ok: false; reason: 'invalid_key' };

export interface GroupRouteStoreOptions {
  pool?: pg.Pool;
}

export class GroupRouteStore {
  private readonly pool: pg.Pool;

  constructor(options: GroupRouteStoreOptions = {}) {
    this.pool = options.pool ?? new Pool(resolveEnvPgConfig());
  }

  /** schema 探测（不建表）。 */
  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await ensureCapabilitySchema(this.pool, {
      capability: 'group_route',
      sinceVersion: '0066_baseline_cache_corpus_tables',
      ddl: [GROUP_ROUTE_SCHEMA_SQL],
    });
  }

  /**
   * 读某团队键的目标群 chat_id。命中返回 chatId，缺行 / 缺表 → null。
   * 精确相等匹配（trim 后），绝不模糊 / 近似匹配（防映射错群 → 跨客户 PII 泄漏）。
   * 真读异常（非缺表）向上抛，由解析器逐层 try/catch 兜底回落默认群。
   */
  async getRoute(groupLabel: string): Promise<string | null> {
    const key = (groupLabel ?? '').trim();
    if (!key) return null;
    try {
      const { rows } = await this.pool.query<{ chat_id: string }>(
        `SELECT chat_id FROM group_route WHERE group_label = $1`,
        [key],
      );
      return rows.length > 0 ? rows[0].chat_id : null;
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') return null; // undefined_table：首启竞态 / 迁移未跑 → 回落 null
      throw err;
    }
  }

  /** 列全部路由（面板读；缺表回落空）。 */
  async listRoutes(): Promise<GroupRoute[]> {
    try {
      const { rows } = await this.pool.query<{
        group_label: string;
        chat_id: string;
        updated_by: string | null;
        updated_at: Date;
      }>(`SELECT group_label, chat_id, updated_by, updated_at FROM group_route ORDER BY group_label ASC`);
      return rows.map((r) => ({
        groupLabel: r.group_label,
        chatId: r.chat_id,
        updatedBy: r.updated_by ?? null,
        updatedAt: r.updated_at.getTime(),
      }));
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') return [];
      throw err;
    }
  }

  /**
   * 写 / 清除一条团队路由（单写者 + RETURNING 读回为真）。
   * - group_label trim 后空 → invalid_key（绝不落空键脏行）；
   * - chat_id trim 后空 / null → DELETE 该键（清除路由），返回 route=null；
   * - 否则 UPSERT，返回 RETURNING 回读的真值。
   */
  async setRoute(
    groupLabel: string,
    chatId: string | null,
    updatedBy: string | null,
  ): Promise<SetGroupRouteResult> {
    const key = (groupLabel ?? '').trim();
    if (!key) return { ok: false, reason: 'invalid_key' };
    const target = (chatId ?? '').trim();
    if (!target) {
      await this.pool.query(`DELETE FROM group_route WHERE group_label = $1`, [key]);
      return { ok: true, route: null };
    }
    const { rows } = await this.pool.query<{
      group_label: string;
      chat_id: string;
      updated_by: string | null;
      updated_at: Date;
    }>(
      `INSERT INTO group_route (group_label, chat_id, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (group_label) DO UPDATE
       SET chat_id = EXCLUDED.chat_id, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING group_label, chat_id, updated_by, updated_at`,
      [key, target, updatedBy],
    );
    const r = rows[0];
    return {
      ok: true,
      route: { groupLabel: r.group_label, chatId: r.chat_id, updatedBy: r.updated_by ?? null, updatedAt: r.updated_at.getTime() },
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
