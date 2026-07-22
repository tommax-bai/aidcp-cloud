/**
 * 安全限额配置存储（quota_config 表，PostgreSQL）。
 *
 * change safety-quota-config（stream D）：把三档 × 动作 × 三窗口的限额数字做成可后台编辑 + 热加载。
 * 落库 + 内存镜像；实现 QuotaProvider 供 RiskController.effectiveQuotas() 每次现读（PUT 后无需重启）。
 *
 * 安全不变量（复刻 RoleConfigStore）：
 * - 绝不 brick：某 (tier,action) 缺行 / 字段非法 → 该动作回落 deriveWindowQuotas(level) 写死默认；永不抛。
 * - 写库成功才刷内存镜像（避免「镜像已变、库未变」不一致）。
 * - 零回归：表为空时 windowQuotasFor(level) 与 deriveWindowQuotas(level) 逐位一致（缺行全回落派生默认）。
 *
 * 红线：本 store 只读写 quota_config；绝不碰风控状态单写路径（risk_state / setQuotaLevel / applySignal）。
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0010_quota_config.sql 同源。
 *
 * ## 模块归属：本 store 归 aidcp-automation（change config-mirror-cross-process-invalidation task 1.2）
 *
 * 依据是既成事实而非偏好：`src/risk/` 对 `src/config/` 的 import 命中数为 **0**，而 `src/config/`
 * 对 `src/risk/` 的 import 有 **13 处**（本文件 :18-27 即其中之一）——依赖方向今天已单向倒置，
 * 配置层依赖风控层的常量与校验，风控层只持接口。本 store 在 `src/config/` 之外的引用只出现在
 * 组合根 `src/server.ts`。故把它与 `quota_config` 表判给 automation 是纯归属划线、零代码成本，
 * 一次消除一条跨服务同步读，`canDo` 的「每次现读、改完即热生效、MUST NOT 需要重启」逐字保住。
 * 权威表述见定稿方案 §11.4 要求一 / §5.1。
 *
 * 归属对齐 **MUST NOT** 被理解为「跨进程可见性问题已消失」：dev 与 ol 是两个 automation 进程共库，
 * 一次面板写入只到达其中一个进程的镜像。故写入路径接 `writeWithMirrorBump`（同事务推进版本），
 * 由另一 target 的刷新器在 T_poll 内拉到并 `refreshFromAuthority()`。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import { writeWithMirrorBump, type MirrorVersionBumper } from './mirror-version-store.js';
import { COOLDOWN_ACTIONS } from '../risk/action-cooldown.js';
import { MINUTE_BURST_CAP, deriveWindowQuotas } from '../risk/quotas.js';
import {
  RISK_ACTIONS,
  RISK_QUOTA_LEVELS,
  type QuotaProvider,
  type RiskAction,
  type RiskQuotaLevel,
  type WindowQuotas,
} from '../risk/types.js';
import { ensureCapabilitySchema } from '../schema/schema-capability.js';

const { Pool } = pg;

/** 单 (tier,action) 行的三窗口数字 + 审计（面板回显用）。 */
export interface QuotaConfigRow {
  tier: RiskQuotaLevel;
  action: RiskAction;
  daily: number;
  perMinute: number;
  perHour: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 写补丁：未传的窗口保持原值（或回落派生默认）。 */
export interface QuotaConfigPatch {
  daily?: number;
  perMinute?: number;
  perHour?: number;
}

export const QUOTA_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS quota_config (
  tier        TEXT NOT NULL,
  action      TEXT NOT NULL,
  daily       INTEGER NOT NULL,
  per_minute  INTEGER NOT NULL,
  per_hour    INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  PRIMARY KEY (tier, action)
);
`;

export interface QuotaConfigStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  /** 跨进程失效通道：写入与版本推进同事务。缺省 = 不推版本（行为逐位退回今日现状）。 */
  mirrorVersionBumper?: MirrorVersionBumper;
}

interface QuotaDbRow {
  tier: string;
  action: string;
  daily: number | string;
  per_minute: number | string;
  per_hour: number | string;
  updated_at: Date | string | null;
  updated_by: string | null;
}

// 键分隔符用 NUL（tier / action 都不可能含它，故撞不出键冲突）。
// 🔴 MUST 写成转义 \u0000，绝不要回到源码里嵌裸字节：两者运行时完全等价，但裸字节会让 git / grep
// 把整个文件当成 binary（diff 显示 Bin、搜索直接跳过）⇒ 主闸的取值路径既搜不到、改动也评不了。
const cacheKey = (tier: string, action: string): string => `${tier}\u0000${action}`;

/** 受冷却约束的动作（夹 perMinute 的作用域，见 windowQuotasFor 的红线）。 */
const COOLDOWN_ACTION_SET: ReadonlySet<string> = new Set<string>(COOLDOWN_ACTIONS);

/** 非负有限整数才算有效覆盖值，否则视作缺（回落派生默认）。 */
function validInt(raw: number | string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

export class QuotaConfigStore implements QuotaProvider {
  private readonly pool: pg.Pool;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  private cache = new Map<string, QuotaConfigRow>();

  constructor(options: QuotaConfigStoreOptions = {}) {
    this.mirrorVersionBumper = options.mirrorVersionBumper;
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

  /** schema 探测（不建表） + 载入内存镜像。 */
  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await ensureCapabilitySchema(this.pool, {
      capability: 'quota_config',
      sinceVersion: '0010_quota_config',
      ddl: [QUOTA_CONFIG_SCHEMA_SQL],
    });
    await this.reload();
  }

  /**
   * 跨进程失效刷新入口（change config-mirror-cross-process-invalidation task 3.2）：
   * 版本表显示本镜像被**别的进程**改过时，由刷新器调用。
   * 内部复用 `reload()`（构建新 Map → 原子替换引用），`reload()` 保持 private——
   * 直接把它改公开会让任何调用方都能绕过版本比对随手 reload，失去「有界陈旧度」这条可证明性。
   */
  async refreshFromAuthority(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<QuotaDbRow>(
      `SELECT tier, action, daily, per_minute, per_hour, updated_at, updated_by FROM quota_config`,
    );
    const next = new Map<string, QuotaConfigRow>();
    for (const r of rows) {
      // 仅纳入合法档位/动作的行（脏行忽略，回落派生默认）。
      if (!RISK_QUOTA_LEVELS.includes(r.tier as RiskQuotaLevel)) continue;
      if (!RISK_ACTIONS.includes(r.action as RiskAction)) continue;
      next.set(cacheKey(r.tier, r.action), {
        tier: r.tier as RiskQuotaLevel,
        action: r.action as RiskAction,
        daily: Number(r.daily),
        perMinute: Number(r.per_minute),
        perHour: Number(r.per_hour),
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        updatedBy: r.updated_by ?? null,
      });
    }
    this.cache = next;
  }

  /**
   * QuotaProvider 实现：某档位三窗口生效数字（canDo 每次现读，零 IO）。
   * 每动作逐窗口：库内合法值优先；缺行 / 非法 → 回落 deriveWindowQuotas(level)（零回归基线）。永不抛。
   *
   * **受冷却约束动作的 perMinute 夹 MINUTE_BURST_CAP**（change cooldown-as-backstop-not-quota §8）：
   * 把「兜底(动作冷却)必须比主闸松」这条不变量从**文档纪律**变成**算术**。冷却统一 15s ＝
   * 60s ÷ MINUTE_BURST_CAP.like(4)；若面板给 like 的 perMinute 填 6（派生路径 quotas.ts 夹、覆盖路径
   * 此前不夹），隐含间隔 10s < 15s ⇒ 兜底反超主闸、「配额旋钮被焊死」的病一字不差复发，且**无日志无告警**。
   * 夹在此处是**单点**：它同时是 canDo 的取值口和面板 catalog 的取值口（quota-config-facade.ts）
   * ⇒ 天然「显示的＝生效的」，且对已落库老行即时生效、无需改写库（回滚＝去掉这一夹）。
   *
   * 🔴 **红线一：只夹 perMinute，MUST NOT 夹 perHour / daily。**
   *    浏览行 perHour=80 > HOUR_BURST_CAP.view=60 **正在生效**，夹了会当场把浏览量从 80 砍到 60。
   *    分钟窗是四个冷却动作里唯一可能被冷却反超的窗口（其分钟 cap 蕴含的速率恒 ≥ 小时 cap，见单测），
   *    时 / 日窗不需要、也不该夹。
   *
   * 🔴 **红线二：只夹 COOLDOWN_ACTIONS，MUST NOT 夹 RISK_ACTIONS 全集。**
   *    夹的立论只覆盖受冷却约束的动作；对其余动作夹既无依据又有真实伤害——
   *    `MINUTE_BURST_CAP.dm_reply = 0` 是占位而非真上限，夹了会把运营显式配置的额度永久压成 0
   *    （配额 0 ⇒ canDo 恒拒）；而本函数在取值链**最上游**、下游无人救得回来
   *    ⇒ 视频号入站回复静默停摆（`quota_config` 覆盖是它唯一的启用路径）。
   *    两条红线是同一个陷阱的两个轴（窗口轴 / 动作轴）：**「对称地都夹一下」看着整齐，实为回归。**
   */
  windowQuotasFor(level: RiskQuotaLevel): WindowQuotas {
    const derived = deriveWindowQuotas(level);
    const minute = {} as WindowQuotas['minute'];
    const hour = {} as WindowQuotas['hour'];
    const day = {} as WindowQuotas['day'];
    for (const action of RISK_ACTIONS) {
      const row = this.cache.get(cacheKey(level, action));
      day[action] = validInt(row?.daily) ?? derived.day[action];
      const minuteRaw = validInt(row?.perMinute) ?? derived.minute[action];
      minute[action] = COOLDOWN_ACTION_SET.has(action)
        ? Math.min(minuteRaw, MINUTE_BURST_CAP[action])
        : minuteRaw;
      hour[action] = validInt(row?.perHour) ?? derived.hour[action];
    }
    return { minute, hour, day };
  }

  /** 取某 (tier,action) 覆盖行（缺行 undefined，面板审计用）。 */
  getRow(tier: RiskQuotaLevel, action: RiskAction): QuotaConfigRow | undefined {
    return this.cache.get(cacheKey(tier, action));
  }

  /** 全部覆盖行（面板列表用）。 */
  getAll(): Map<string, QuotaConfigRow> {
    return this.cache;
  }

  /**
   * 写库 + 刷内存镜像（热加载）。未传的窗口保持原值（无原值则回落派生默认，保证三列 NOT NULL）。
   * 先写库成功、再刷镜像（写库失败镜像不变）。调用方（facade）应已校验数字合法。
   */
  async set(
    tier: RiskQuotaLevel,
    action: RiskAction,
    patch: QuotaConfigPatch,
    updatedBy: string,
  ): Promise<QuotaConfigRow> {
    const prev = this.cache.get(cacheKey(tier, action));
    const derived = deriveWindowQuotas(tier);
    const nextDaily = patch.daily ?? prev?.daily ?? derived.day[action];
    const nextMinute = patch.perMinute ?? prev?.perMinute ?? derived.minute[action];
    const nextHour = patch.perHour ?? prev?.perHour ?? derived.hour[action];

    // 写库与版本推进同事务：写库失败 → 整体回滚 → 版本不进、镜像不刷（下面的 cache.set 不会执行）。
    const { rows } = await writeWithMirrorBump(this.pool, this.mirrorVersionBumper, 'quota_config', (q) =>
      q.query<QuotaDbRow>(
        `INSERT INTO quota_config (tier, action, daily, per_minute, per_hour, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       ON CONFLICT (tier, action)
       DO UPDATE SET daily = EXCLUDED.daily, per_minute = EXCLUDED.per_minute,
                     per_hour = EXCLUDED.per_hour, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING tier, action, daily, per_minute, per_hour, updated_at, updated_by`,
        [tier, action, nextDaily, nextMinute, nextHour, updatedBy],
      ),
    );
    const row = rows[0];
    const result: QuotaConfigRow = {
      tier,
      action,
      daily: nextDaily,
      perMinute: nextMinute,
      perHour: nextHour,
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row?.updated_by ?? updatedBy,
    };
    this.cache.set(cacheKey(tier, action), result);
    return result;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
