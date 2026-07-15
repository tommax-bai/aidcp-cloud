/**
 * 对外客户身份 + 客户↔环境归属存储（PostgreSQL，aidcp 库）。change edge-client-customer-auth。
 *
 * 与内部运营 console 的登录体系**物理隔离**：独立表、独立密钥（见 client-auth-server）。承载：
 *  - `client_users`：客户身份（name 唯一、key 以 scrypt+盐 hash、启用状态、轮换时间）。
 *  - `client_env_scope`：由内部管理员授予的客户↔环境归属（fail-closed + 每环境全局唯一 active owner）。
 *    env_key = 环境 profileId（AdsPower 分身 id；edge 本地即知、云端见为 edgeId=ads-<profileId>），
 *    刻意**不加 FK 到 accounts**（避免与账号单写者 / ensureAccount 时序耦合）。label/platform 冗余以便后台展示。
 *
 * 红线（对齐 group-route-store 家族范式）：
 *  - schema 在 init() 里 CREATE TABLE IF NOT EXISTS 自建（本仓无 migration 执行器）。
 *  - 单写者（UPDATE/UPSERT/事务 + RETURNING 读回为真），绝不乐观假成功。
 *  - **N2 结构性无泄漏**：客户可达的环境读只有吃 userId 的 scoped 方法（listEnvScope / ownsEnv），不存在取全量。
 *  - 读缺表（42P01，首启竞态）**fail-closed**：登录→凭据错、可见环境→空、启用态→false；绝不把读失败冒充放行。
 *  - key 明文绝不落库、绝不回读；只 create/rotate 时由上层一次性回显。
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { resolveEnvPgConfig } from '../cache/pg-config.js';
import { generateKey, hashKey, verifyKey, decoyVerify } from './key.js';

const { Pool } = pg;

export const CLIENT_USERS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS client_users (
  user_id     TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,
  key_hash    TEXT        NOT NULL,
  key_salt    TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
  rotated_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS client_env_scope (
  user_id     TEXT        NOT NULL REFERENCES client_users(user_id) ON DELETE CASCADE,
  env_key     TEXT        NOT NULL,
  label       TEXT,
  platform    TEXT,
  source      TEXT        NOT NULL DEFAULT 'admin' CHECK (source IN ('admin','client')),
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, env_key)
);
CREATE INDEX IF NOT EXISTS client_env_scope_env_idx ON client_env_scope (env_key);
-- 管理侧「环境注册表」（change client-user-env-registry）：系统已知的全部环境，**独立于归属**。
-- 有此表前，后台「待分配」池只能从 client_env_scope 反推（= 只认识已分过的环境），无法表达「已导入但未分配给任何人」。
-- 此表让环境可以只登记、不归属：一次性导入存量环境（source='import'）+ 边缘一连上来自动登记（source='auto'）都灌这里，
-- 后台「待分配」= 本表 ∪ 归属表 的并集减去当前端用户已归属。env_key = 环境 profileId（不带 ads- 前缀，与 edge 口径一致）。
CREATE TABLE IF NOT EXISTS client_environments (
  env_key     TEXT        PRIMARY KEY,
  label       TEXT,
  platform    TEXT,
  source      TEXT        NOT NULL DEFAULT 'import' CHECK (source IN ('import','auto','admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS client_env_scope_audit (
  audit_id     BIGSERIAL   PRIMARY KEY,
  user_id      TEXT        NOT NULL,
  env_key      TEXT        NOT NULL,
  label        TEXT,
  platform     TEXT,
  source       TEXT        NOT NULL CHECK (source IN ('admin','client')),
  assigned_by  TEXT,
  assigned_at  TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by   TEXT,
  reason       TEXT        NOT NULL CHECK (reason IN ('legacy_self_claim','scope_replaced')),
  UNIQUE (user_id, env_key, assigned_at, reason)
);
CREATE INDEX IF NOT EXISTS client_env_scope_audit_scope_idx
  ON client_env_scope_audit (user_id, env_key, revoked_at DESC);
DO $$
BEGIN
  LOCK TABLE client_env_scope IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO client_environments (env_key, label, platform, source, created_at, updated_at)
  SELECT DISTINCT ON (env_key) env_key, label, platform, 'import', assigned_at, now()
  FROM client_env_scope
  ORDER BY env_key, assigned_at DESC
  ON CONFLICT (env_key) DO UPDATE
    SET label = COALESCE(client_environments.label, EXCLUDED.label),
        platform = COALESCE(client_environments.platform, EXCLUDED.platform),
        updated_at = now();
  INSERT INTO client_env_scope_audit
    (user_id, env_key, label, platform, source, assigned_by, assigned_at, revoked_at, revoked_by, reason)
  SELECT user_id, env_key, label, platform, source, assigned_by, assigned_at,
         now(), 'schema:init', 'legacy_self_claim'
  FROM client_env_scope WHERE source = 'client'
  ON CONFLICT (user_id, env_key, assigned_at, reason) DO NOTHING;
  DELETE FROM client_env_scope WHERE source = 'client';
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'client_env_scope'::regclass
      AND conname = 'client_env_scope_authoritative_source'
  ) THEN
    ALTER TABLE client_env_scope
      ADD CONSTRAINT client_env_scope_authoritative_source
      CHECK (source = 'admin') NOT VALID;
  END IF;
END $$;
ALTER TABLE client_env_scope VALIDATE CONSTRAINT client_env_scope_authoritative_source;
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_env_scope_active_env
  ON client_env_scope (env_key);
CREATE INDEX IF NOT EXISTS client_env_scope_active_user_idx
  ON client_env_scope (user_id, assigned_at);
`;

/** 客户视图（管理端读；**绝不含 key/hash/salt**）。 */
export interface ClientUserView {
  userId: string;
  name: string;
  status: 'enabled' | 'disabled';
  envCount: number;
  rotatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 一条环境归属（管理端 / 客户端读）。 */
export interface ClientEnvScopeRow {
  envKey: string;
  label: string | null;
  platform: string | null;
  source: 'admin' | 'client';
  assignedAt: number;
}

/** 某环境被归属到的一个客户（管理侧全局注册表用；仅 userId + name，绝不含 key）。 */
export interface ClientEnvAssignee {
  userId: string;
  name: string;
}

/**
 * 管理侧全局环境注册表的一行（change client-user-env-picker）：系统已知的一个环境 + 它被分配给哪些客户。
 * 跨用户聚合，**仅供内部 panel 端点消费**（见 listAllEnvironments 红线）。
 */
export interface ClientEnvironmentView {
  envKey: string;
  label: string | null;
  platform: string | null;
  assignees: ClientEnvAssignee[];
  assigneeCount: number;
}

export type CreateUserResult =
  | { ok: true; user: ClientUserView; plainKey: string }
  | { ok: false; reason: 'invalid_name' | 'name_taken' };

export type RotateKeyResult = { ok: true; plainKey: string } | { ok: false; reason: 'not_found' };

export type MutateUserResult = { ok: true; user: ClientUserView } | { ok: false; reason: 'not_found' | 'invalid_name' | 'name_taken' };

export type SetScopeResult =
  | { ok: true; scope: ClientEnvScopeRow[] }
  | { ok: false; reason: 'not_found' | 'unknown_environment' | 'env_already_assigned'; envKey?: string };

export type InteractionScopeAuthorization<T> =
  | { ok: true; accountId: string; value: T }
  | { ok: false; reason: 'disabled' | 'not_authorized' };

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}

export interface ClientUserStoreOptions {
  pool?: pg.Pool;
}

export class ClientUserStore {
  private readonly pool: pg.Pool;

  constructor(options: ClientUserStoreOptions = {}) {
    this.pool = options.pool ?? new Pool(resolveEnvPgConfig());
  }

  async init(): Promise<void> {
    await this.pool.query(CLIENT_USERS_SCHEMA_SQL);
  }

  // ── 鉴权侧（供 client-auth-server；fail-closed）──────────────────────────

  /**
   * 校验 name+key 登录。命中且 enabled 且 key 对 → { ok, userId }。
   * name 未命中 / 停用 / key 错 → **跑一次 decoyVerify 抹平时延** → { ok:false }（不可区分）。
   * 缺表（首启竞态）→ decoy + false（fail-closed）。
   */
  async verifyLogin(name: string, key: string): Promise<{ ok: true; userId: string } | { ok: false }> {
    const trimmed = (name ?? '').trim();
    try {
      const { rows } = await this.pool.query<{
        user_id: string;
        key_hash: string;
        key_salt: string;
        status: string;
      }>(`SELECT user_id, key_hash, key_salt, status FROM client_users WHERE name = $1`, [trimmed]);
      const row = rows[0];
      if (!row || row.status !== 'enabled') {
        decoyVerify(key); // 抹平「不存在 / 停用」与「key 错」的时延差
        return { ok: false };
      }
      if (!verifyKey(key ?? '', row.key_hash, row.key_salt)) return { ok: false };
      return { ok: true, userId: row.user_id };
    } catch (err) {
      if (isMissingTable(err)) {
        decoyVerify(key);
        return { ok: false };
      }
      throw err;
    }
  }

  /** 该客户当前是否启用（N3：每请求回库复核；缺表 / 无行 → false，fail-closed）。 */
  async isEnabled(userId: string): Promise<boolean> {
    try {
      const { rows } = await this.pool.query<{ status: string }>(
        `SELECT status FROM client_users WHERE user_id = $1`,
        [userId],
      );
      return rows[0]?.status === 'enabled';
    } catch (err) {
      if (isMissingTable(err)) return false;
      throw err;
    }
  }

  /** 某客户可见环境清单。只返回内部管理员授予且未撤销的权威归属；缺表 → 空。 */
  async listEnvScope(userId: string): Promise<ClientEnvScopeRow[]> {
    try {
      const { rows } = await this.pool.query<{
        env_key: string;
        label: string | null;
        platform: string | null;
        source: string;
        assigned_at: Date;
      }>(
        `SELECT env_key, label, platform, source, assigned_at
         FROM client_env_scope
         WHERE user_id = $1 AND source = 'admin'
         ORDER BY assigned_at ASC`,
        [userId],
      );
      return rows.map((r) => ({
        envKey: r.env_key,
        label: r.label,
        platform: r.platform,
        source: 'admin',
        assignedAt: r.assigned_at.getTime(),
      }));
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  /**
   * 客户是否显式拥有某环境。客户侧所有带 envKey 的业务请求必须先走这里；
   * 缺表、空参数或未归属一律 false，避免用全量环境列表做内存过滤而意外放宽权限。
   */
  async ownsEnv(userId: string, envKey: string): Promise<boolean> {
    const key = (envKey ?? '').trim();
    if (!userId || !key) return false;
    try {
      const { rows } = await this.pool.query<{ owned: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM client_env_scope
           WHERE user_id = $1 AND env_key = $2
             AND source = 'admin'
         ) AS owned`,
        [userId, key],
      );
      return rows[0]?.owned === true;
    } catch (err) {
      if (isMissingTable(err)) return false;
      throw err;
    }
  }

  /**
   * 在一个数据库事务和共享锁范围内校验客户 interaction 请求的完整边界：
   * enabled user + active authoritative env ownership + env/account/platform binding。
   * operation 在锁仍持有时执行，避免启停、换归属或账号重绑发生 TOCTOU。
   */
  async withAuthorizedInteractionScope<T>(
    userId: string,
    envKey: string,
    operation: (scope: { accountId: string }) => Promise<T>,
  ): Promise<InteractionScopeAuthorization<T>> {
    const key = (envKey ?? '').trim();
    if (!userId || !key) return { ok: false, reason: 'not_authorized' };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query<{ status: string }>(
        `SELECT status FROM client_users WHERE user_id = $1 FOR SHARE`,
        [userId],
      );
      if (user.rows[0]?.status !== 'enabled') {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'disabled' };
      }
      const binding = await client.query<{ account_id: string }>(
        `SELECT a.account_id
         FROM client_env_scope s
         JOIN client_environments e ON e.env_key = s.env_key
         JOIN interaction_auth_state a
           ON a.env_key = s.env_key AND a.platform = e.platform
         JOIN accounts acc
           ON acc.account_id = a.account_id AND acc.platform = a.platform
         WHERE s.user_id = $1 AND s.env_key = $2
           AND s.source = 'admin'
         FOR SHARE OF s, e, a, acc`,
        [userId, key],
      );
      const accountId = binding.rows[0]?.account_id;
      if (!accountId) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_authorized' };
      }
      const value = await operation({ accountId });
      await client.query('COMMIT');
      return { ok: true, accountId, value };
    } catch (err) {
      await client.query('ROLLBACK');
      if (isMissingTable(err)) return { ok: false, reason: 'not_authorized' };
      throw err;
    } finally {
      client.release();
    }
  }

  // ── 管理侧（供 panel /api/client-users*；受内部 JWT）────────────────────

  private async viewOf(userId: string): Promise<ClientUserView | null> {
    const { rows } = await this.pool.query<{
      user_id: string;
      name: string;
      status: string;
      rotated_at: Date | null;
      created_at: Date;
      updated_at: Date;
      env_count: string;
    }>(
      `SELECT u.user_id, u.name, u.status, u.rotated_at, u.created_at, u.updated_at,
              (SELECT count(*) FROM client_env_scope s
               WHERE s.user_id = u.user_id AND s.source = 'admin') AS env_count
       FROM client_users u WHERE u.user_id = $1`,
      [userId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      userId: r.user_id,
      name: r.name,
      status: r.status === 'disabled' ? 'disabled' : 'enabled',
      envCount: Number(r.env_count),
      rotatedAt: r.rotated_at ? r.rotated_at.getTime() : null,
      createdAt: r.created_at.getTime(),
      updatedAt: r.updated_at.getTime(),
    };
  }

  /** 列全部客户（**绝不含 key/hash**）；缺表回落空。 */
  async listUsers(): Promise<ClientUserView[]> {
    try {
      const { rows } = await this.pool.query<{ user_id: string }>(
        `SELECT user_id FROM client_users ORDER BY created_at ASC`,
      );
      const views: ClientUserView[] = [];
      for (const r of rows) {
        const v = await this.viewOf(r.user_id);
        if (v) views.push(v);
      }
      return views;
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  /** 创建客户：生成明文 key（一次性回显）+ 落 hash；name 空 → invalid_name，重名 → name_taken。 */
  async createUser(name: string, createdBy: string | null): Promise<CreateUserResult> {
    const trimmed = (name ?? '').trim();
    if (!trimmed || trimmed.length > 64) return { ok: false, reason: 'invalid_name' };
    void createdBy; // 审计留缝：client_users 暂不存 created_by（YAGNI，需要时加列）
    const existing = await this.pool.query(`SELECT 1 FROM client_users WHERE name = $1`, [trimmed]);
    if (existing.rows.length > 0) return { ok: false, reason: 'name_taken' };
    const userId = crypto.randomUUID();
    const plainKey = generateKey();
    const { hash, salt } = hashKey(plainKey);
    try {
      await this.pool.query(
        `INSERT INTO client_users (user_id, name, key_hash, key_salt, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'enabled', now(), now())`,
        [userId, trimmed, hash, salt],
      );
    } catch (err) {
      // UNIQUE(name) 竞态兜底
      if ((err as { code?: string })?.code === '23505') return { ok: false, reason: 'name_taken' };
      throw err;
    }
    const user = await this.viewOf(userId);
    return { ok: true, user: user!, plainKey };
  }

  /** 改名 / 启停（补丁式，未传字段不动）。 */
  async updateUser(
    userId: string,
    patch: { name?: string; status?: 'enabled' | 'disabled' },
    updatedBy: string | null,
  ): Promise<MutateUserResult> {
    const current = await this.viewOf(userId);
    if (!current) return { ok: false, reason: 'not_found' };
    let name = current.name;
    if (patch.name !== undefined) {
      const t = patch.name.trim();
      if (!t || t.length > 64) return { ok: false, reason: 'invalid_name' };
      if (t !== current.name) {
        const dup = await this.pool.query(`SELECT 1 FROM client_users WHERE name = $1 AND user_id <> $2`, [t, userId]);
        if (dup.rows.length > 0) return { ok: false, reason: 'name_taken' };
      }
      name = t;
    }
    const status = patch.status ?? current.status;
    void updatedBy;
    await this.pool.query(
      `UPDATE client_users SET name = $2, status = $3, updated_at = now() WHERE user_id = $1`,
      [userId, name, status],
    );
    const user = await this.viewOf(userId);
    return { ok: true, user: user! };
  }

  /** 轮换 key：换 hash+盐、bump rotated_at；旧 key 立即失效，回显一次新明文。 */
  async rotateKey(userId: string): Promise<RotateKeyResult> {
    const plainKey = generateKey();
    const { hash, salt } = hashKey(plainKey);
    const { rowCount } = await this.pool.query(
      `UPDATE client_users SET key_hash = $2, key_salt = $3, rotated_at = now(), updated_at = now() WHERE user_id = $1`,
      [userId, hash, salt],
    );
    if (!rowCount) return { ok: false, reason: 'not_found' };
    return { ok: true, plainKey };
  }

  /** 读某客户归属（管理端）。 */
  async getScope(userId: string): Promise<ClientEnvScopeRow[]> {
    return this.listEnvScope(userId);
  }

  /**
   * 批量登记环境进管理侧注册表（change client-user-env-registry）。**不涉及归属**——只是让环境「被系统认识」，
   * 从而出现在后台「待分配」池里供人工分配。用于：① 一次性导入存量环境（source='import'）；
   * ② 边缘一连上来自动登记（source='auto'，见 server.ts onEdgeRegistered）；③ 后台手动登记（source='admin'）。
   *
   * 幂等 upsert：已存在则只用**非空**新值补 label/platform（COALESCE，不拿 null 覆盖既有好值）、bump updated_at；
   * source 只在首次插入时定，冲突不降级。envKey 去空白 + 去重；空 envKey 跳过。返回实际写入的去重条数。
   * **不做任何归属推断**——绝不误把环境塞给某个客户（fail-closed 归属边界不破）。
   */
  async registerEnvironments(
    items: { envKey: string; label?: string | null; platform?: string | null }[],
    source: 'import' | 'auto' | 'admin' = 'import',
  ): Promise<number> {
    const seen = new Set<string>();
    const clean = items
      .map((i) => ({
        envKey: (i.envKey ?? '').trim(),
        label: (i.label ?? '')?.toString().trim() || null,
        platform: (i.platform ?? '')?.toString().trim() || null,
      }))
      .filter((i) => i.envKey && !seen.has(i.envKey) && (seen.add(i.envKey), true));
    if (!clean.length) return 0;
    for (const i of clean) {
      await this.pool.query(
        `INSERT INTO client_environments (env_key, label, platform, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, now(), now())
         ON CONFLICT (env_key) DO UPDATE
           SET label = COALESCE(EXCLUDED.label, client_environments.label),
               platform = COALESCE(EXCLUDED.platform, client_environments.platform),
               updated_at = now()`,
        [i.envKey, i.label, i.platform, source],
      );
    }
    return clean.length;
  }

  /**
   * 管理侧全局环境注册表：系统已知的全部环境 + 每个环境被归属到的客户清单（含名）+ 归属人数。
   * 环境全集 = 注册表 `client_environments` ∪ 已归属 `client_env_scope`（并集）——故**未分配给任何人的环境也会列出**
   * （assigneeCount=0），这正是后台「待分配」池要的。label/platform 优先取归属行的最新非空值，回落注册表登记值。
   *
   * **红线（N2）**：这是**跨用户聚合**读，与「客户可达读只有吃 userId 的 scoped 方法」直接冲突——
   * **只准接入受内部 JWT 的 panel 端点（GET /api/client-environments），绝不注入 client-auth-server**，
   * 否则客户可拿到跨客户归属、结构性泄漏。缺表（首启竞态）fail-closed 回落空数组。
   */
  async listAllEnvironments(): Promise<ClientEnvironmentView[]> {
    try {
      const { rows } = await this.pool.query<{
        env_key: string;
        label: string | null;
        platform: string | null;
        assignees: { userId: string; name: string }[] | null;
      }>(
        `WITH keys AS (
           SELECT env_key FROM client_environments
           UNION
           SELECT env_key FROM client_env_scope
         )
         SELECT k.env_key,
                COALESCE(
                  (array_agg(s.label ORDER BY s.assigned_at DESC) FILTER (WHERE s.label IS NOT NULL))[1],
                  max(e.label)
                ) AS label,
                COALESCE(
                  (array_agg(s.platform ORDER BY s.assigned_at DESC) FILTER (WHERE s.platform IS NOT NULL))[1],
                  max(e.platform)
                ) AS platform,
                json_agg(json_build_object('userId', u.user_id, 'name', u.name) ORDER BY u.name)
                  FILTER (WHERE u.user_id IS NOT NULL) AS assignees
         FROM keys k
         LEFT JOIN client_environments e ON e.env_key = k.env_key
         LEFT JOIN client_env_scope s
           ON s.env_key = k.env_key AND s.source = 'admin'
         LEFT JOIN client_users u ON u.user_id = s.user_id
         GROUP BY k.env_key
         ORDER BY k.env_key ASC`,
      );
      return rows.map((r) => {
        const assignees = (r.assignees ?? []).map((a) => ({ userId: a.userId, name: a.name }));
        return {
          envKey: r.env_key,
          label: r.label,
          platform: r.platform,
          assignees,
          assigneeCount: assignees.length,
        };
      });
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  /**
   * 整批替换某客户归属。只接受权威注册表已有环境；label/platform 从注册表读取，
   * 不信任调用者提交的元数据。事务锁住 user + registry + active grants，保证一个环境
   * 只有一个 active owner，且不会与客户 interaction 请求发生 TOCTOU。
   */
  async setScope(
    userId: string,
    items: { envKey: string; label?: string | null; platform?: string | null }[],
    assignedBy: string | null,
  ): Promise<SetScopeResult> {
    const seen = new Set<string>();
    const clean = items
      .map((i) => (i.envKey ?? '').trim())
      .filter((envKey) => envKey && !seen.has(envKey) && (seen.add(envKey), true))
      .sort();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query(`SELECT 1 FROM client_users WHERE user_id = $1 FOR UPDATE`, [userId]);
      if (user.rows.length === 0) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const registered = clean.length
        ? await client.query<{ env_key: string; label: string | null; platform: string | null }>(
            `SELECT env_key, label, platform FROM client_environments
             WHERE env_key = ANY($1::text[]) ORDER BY env_key FOR UPDATE`,
            [clean],
          )
        : { rows: [] };
      const registeredByKey = new Map(registered.rows.map((row) => [row.env_key, row]));
      const unknown = clean.find((envKey) => !registeredByKey.has(envKey));
      if (unknown) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'unknown_environment', envKey: unknown };
      }
      if (clean.length) {
        const conflict = await client.query<{ env_key: string }>(
          `SELECT env_key FROM client_env_scope
           WHERE env_key = ANY($1::text[]) AND user_id <> $2
             AND source = 'admin'
           ORDER BY env_key LIMIT 1 FOR UPDATE`,
          [clean, userId],
        );
        if (conflict.rows[0]) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'env_already_assigned', envKey: conflict.rows[0].env_key };
        }
      }
      await client.query(
        `INSERT INTO client_env_scope_audit
           (user_id, env_key, label, platform, source, assigned_by, assigned_at,
            revoked_at, revoked_by, reason)
         SELECT user_id, env_key, label, platform, source, assigned_by, assigned_at,
                now(), $2, 'scope_replaced'
         FROM client_env_scope WHERE user_id = $1 AND source = 'admin'
         ON CONFLICT (user_id, env_key, assigned_at, reason) DO NOTHING`,
        [userId, assignedBy],
      );
      await client.query(`DELETE FROM client_env_scope WHERE user_id = $1 AND source = 'admin'`, [userId]);
      for (const envKey of clean) {
        const environment = registeredByKey.get(envKey)!;
        await client.query(
          `INSERT INTO client_env_scope
             (user_id, env_key, label, platform, source, assigned_by, assigned_at)
           VALUES ($1, $2, $3, $4, 'admin', $5, now())
           ON CONFLICT (user_id, env_key) DO UPDATE
             SET label = EXCLUDED.label,
                 platform = EXCLUDED.platform,
                 source = 'admin',
                 assigned_by = EXCLUDED.assigned_by,
                 assigned_at = now()`,
          [userId, envKey, environment.label, environment.platform, assignedBy],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { code?: string; constraint?: string })?.code === '23505' &&
          (err as { constraint?: string })?.constraint === 'uq_client_env_scope_active_env') {
        return { ok: false, reason: 'env_already_assigned' };
      }
      throw err;
    } finally {
      client.release();
    }
    return { ok: true, scope: await this.listEnvScope(userId) };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
