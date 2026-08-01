/**
 * 配置镜像失效通道的**跨域契约**（change block3-l3-config-mirror-bump-decouple）。
 *
 * ## 为什么这些东西必须离开 `src/config/mirror-version-store.ts`
 *
 * 镜像版本表 `config_mirror_version` 属 **api**；而四类限频配置（`quota_config` /
 * `pacing_floor_config` / `session_config_global` / `resume_config_global`）属 **automation**。
 * 原实现里，automation 的四个 store 在**自己的写事务里、同一条物理连接上**调 api 版本表的
 * `bumpInTx` —— 单库时看不出问题，两库一分立刻断成两笔独立提交：配置已落库、版本没进，
 * 或反之。这是「静默丢失原子性」，没有任何错误、没有任何日志。
 *
 * 本文件把三样东西抬进 kernel，使 automation 侧的 store 不再 import api 属主的模块：
 *   1. `ConfigMirrorKey` —— 15 处镜像的闭集合（纯类型）。
 *   2. `MirrorVersionBumper` + `writeWithMirrorBump` —— 「业务写与失效信号同一笔提交」的抽象。
 *      **注意抽象的措辞**：它保证的是「同一笔提交」，不保证「写进版本表」。属主域各自注入自己的
 *      实现——api 侧直接推版本表（同库、同事务）；automation 侧写**本域**的事务型 outbox 行
 *      （同库、同事务），再由中继异步推给 api。两者都满足「业务写失败 ⇒ 失效信号不存在」。
 *   3. `ConfigMirrorBumpSink` —— 消费方（api）接收一条已确认落库的失效信号的窄端口。
 *
 * kernel 准入：只 `import type pg`，无 SQL 字面量（`BEGIN` / `COMMIT` / `ROLLBACK` 是事务控制，
 * 不是 DML/DDL）、无 HTTP 路由、无 LLM、无进程内活状态、不反向依赖业务层。
 */

import type pg from 'pg';
import type { PgOwner } from './pg-owner-connection-resolver.js';

/**
 * 全部进程内配置镜像的闭集合（15 处，描述符表在 `src/config/mirror-registry.ts`）。
 *
 * 新增一处镜像 MUST 在此登记：`CONFIG_MIRRORS` 是 `Record<ConfigMirrorKey, …>`，
 * 漏登记即 typecheck 失败（与两份 protocol.ts 的 `Record<MessageType,true>` 同款防漂移手法）。
 *
 * 历史位置为 `src/config-mirror-freshness.ts`（那里现在等值再导出），随本 change 抬进 kernel：
 * automation 与 api 两侧的写入方都要引用它，留在任一属主域都会造出一条跨域 import。
 */
export type ConfigMirrorKey =
  | 'quota_config'
  | 'pacing_floor_config'
  | 'session_config_global'
  | 'resume_config_global'
  | 'persona_config'
  | 'content_schedule'
  | 'model_config'
  | 'role_config'
  | 'category_config'
  | 'hot_lead_config'
  | 'facebook_comment_config'
  | 'facebook_group_join_automation_config'
  | 'facebook_operation_policy'
  | 'account_status'
  | 'client_environment_slow_start'
  | 'client_environment_automation_gate';

/** `pg.Pool` 与 `pg.PoolClient` 的公共子集——写路径按需在两者间切换。 */
export interface MirrorQueryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * 失效信号的**事务型入队**接口（写方依赖的最小契约）。注入式：**缺省即不入队**，行为逐位退回
 * 本 change 之前的现状（启动 + 本进程写入刷新），供单测与秒级回滚。
 *
 * `bumpDomain` 是本实现所写之物**所属的库**。它是防「跨库事务」复发的机械判据：实现方
 * MUST 只在与 `bumpDomain` 同一个库的连接上被调用；组合根注入时 MUST 让它等于该配置表的属主。
 */
export interface MirrorVersionBumper {
  /** 本实现写入的目标所属属主库。api = 直接推版本表；automation = 写本域 outbox。 */
  readonly bumpDomain: PgOwner;
  /** 在**已开启的事务**内入队失效信号。MUST NOT 自开事务——它必须与配置写入同生共死。 */
  bumpInTx(client: MirrorQueryable, mirrorKey: ConfigMirrorKey): Promise<void>;
  /** 可选加速器：事务提交后触发（发通知 / 唤醒中继）。非承重通道，失败只记日志。 */
  notifyAfterCommit?(mirrorKey: ConfigMirrorKey): void;
}

/**
 * 配置写入的统一包装：**持久化与失效信号入队在同一个事务内**。
 *
 * - `bumper` 缺省（单测 / 秒级回滚）→ 直接在 pool 上跑 `run`，行为与本通道引入之前**逐位一致**
 *   （不开事务、不入队）。这条分支的存在是为了让既有的假 pool 单测无需实现 `connect()`。
 * - `bumper` 存在 → `BEGIN` → `run(client)` → `bumpInTx(client)` → `COMMIT`；任一步抛错
 *   → `ROLLBACK` 并原样抛出：写库失败 MUST NOT 入队失效信号，也 MUST NOT 刷新本进程镜像。
 *
 * 🔴 **红线**：`pool` 与 `bumper` MUST 同库。`bumper.bumpDomain` 声明的就是这一点；把 automation
 *    的 pool 配 api 的 bumper（或反之）＝ 跨库两阶段提交，正是本 change 消灭的形态。
 */
export async function writeWithMirrorBump<T>(
  pool: pg.Pool,
  bumper: MirrorVersionBumper | undefined,
  mirrorKey: ConfigMirrorKey,
  run: (q: MirrorQueryable) => Promise<T>,
): Promise<T> {
  if (!bumper) return run(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await bumper.bumpInTx(client, mirrorKey);
    await client.query('COMMIT');
    bumper.notifyAfterCommit?.(mirrorKey);
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误，绝不用回滚错误盖掉真因 */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 跨域失效信号在 outbox 里的主题名。生产方与中继共用，防漂移。 */
export const CONFIG_MIRROR_BUMP_TOPIC = 'config_mirror.bump';

/** 一条待投递的失效信号。`dedupKey` 由生产侧的持久 id 派生，全局唯一且可重放。 */
export interface ConfigMirrorBumpRequest {
  mirrorKey: string;
  /** 幂等键：同一个 dedupKey 投递多次，消费方 MUST 只推进一次版本。 */
  dedupKey: string;
}

export interface ConfigMirrorBumpResult {
  /** true = 本次真的推进了版本；false = 早已应用过（重放），**不是失败**。 */
  applied: boolean;
}

/**
 * 消费方（`config_mirror_version` 的属主 = api）接收失效信号的窄端口。
 *
 * 实现 MUST 幂等：同一 `dedupKey` 收两次，第二次返回 `{applied:false}` 而不是报错，也不重复推版本。
 * 实现 MUST 诚实失败：应用不成功一律抛错，让中继保留 outbox 游标、下一轮重放；
 * MUST NOT 吞错返回成功（那会让一条失效信号永久蒸发，红线「绝不静默假成功」所禁）。
 */
export interface ConfigMirrorBumpSink {
  applyBump(request: ConfigMirrorBumpRequest): Promise<ConfigMirrorBumpResult>;
}


/* ── 配置副本新鲜度 / 停手闸的跨域契约（change cloud-coupling-phase4-runtime-ports） ──────
 *
 * 事实源（ambient 单例）与判定实现都留在 api（`src/config-mirror-freshness.ts` /
 * `src/config/mirror-stop-work.ts`）——它们持模块级可变单例与只读表单例，进不了 kernel。
 * 这里只放**形状**：automation 侧的命令泵 / 会话启动闸 / 风控慢启动锚点按端口问，
 * 由组合根注入 api 侧的实现。未注入 = 恒不停手，逐位等于「未安装事实源 → fresh」的既有语义。
 */

/** 副本读取状态。`stale` = 距上一次**成功完成版本比对**已超过该镜像声明的陈旧上限。 */
export type MirrorReadState = 'fresh' | 'stale';

/** 新鲜度事实源。运行期由镜像刷新器实现并 install 进 api 侧的 ambient 槽位。 */
export interface ConfigMirrorFreshnessSource {
  stateOf(mirrorKey: ConfigMirrorKey): MirrorReadState;
  /**
   * 因副本陈旧而拒绝一次真实平台动作时记账（按 mirrorKey、按小时可查）。
   * 与设计内克制（配额耗尽、模型判定不做、冷却未过）**分别计数**，绝不混计。
   */
  noteStaleRefusal(mirrorKey: ConfigMirrorKey, context?: string): void;
}

/** 停手判据的结果。`halted:true` 时带上触发的 mirrorKey，供日志、告警与拒绝记账用。 */
export type PlatformActionHalt =
  | { halted: false }
  | { halted: true; mirrorKey: ConfigMirrorKey };

/**
 * 停手闸的窄端口。四个方法逐一对应 automation 侧今天的四处直调。
 * `platformActionHalt` / `noteStaleRefusal` **会记账**；`isStale` / `hasStaleGateMirror` 纯读。
 */
export interface ConfigMirrorGatePort {
  isStale(mirrorKey: ConfigMirrorKey): boolean;
  hasStaleGateMirror(): boolean;
  platformActionHalt(context?: string): PlatformActionHalt;
  noteStaleRefusal(mirrorKey: ConfigMirrorKey, context?: string): void;
}
