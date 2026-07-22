/**
 * 跨进程配置镜像刷新器（change config-mirror-cross-process-invalidation，§3 + §6）。
 *
 * 一个进程一个实例。每轮一次 `readAll()` 整表拉版本，只对**版本变化**的 key 触发对应 store 的
 * `refreshFromAuthority()`。它同时是「新鲜度事实源」：闸门取值口经 `src/config-mirror-freshness.ts`
 * 的同步查询口问它「这个副本还新鲜吗」。
 *
 * ## 五条容易写错的地方
 *
 * 1. **计时基准是「上一次成功完成版本比对」，不是「上一次成功 reload」。** 否则一个长期无变更的
 *    镜像会被永远算作陈旧——那会在完全健康的系统上把车队停死。
 * 2. **单轮查询失败 MUST 保留上次已知版本，MUST NOT 清空镜像。** 清空等于把「读不到」变成
 *    「库里没有」，正是本 change 要消灭的那类翻向。
 * 3. **停手是「不放行新的平台动作」，不是 kill 在跑的会话。** 本类只负责如实回答 fresh/stale 与
 *    记账；具体停手由各闸门取值口在**入口**收敛（会话启动闸、命令泵、schedulers）。
 * 4. **「比对成功但重载一直失败」MUST NOT 被折叠成新鲜。** 比对告诉我们权威版本变了，重载失败
 *    意味着副本**已知落后**——这比「读不到版本」是更确定的坏消息。只看比对时刻，会让一个明知落后
 *    的闸门副本照常放行平台动作、并在健康投影上显示 `fresh`。故另记「连续重载失败起点」，
 *    副本年龄取二者较大值（见 `ageOf`）。
 * 5. **拒绝记账 MUST NOT 是「每次调用一条 PG 写」。** 三态判据被挂在热读路径上（每条出站信封、
 *    每次配额求值），逐次落库会在**权威不可达**时把写压堆到刷新器自我恢复所依赖的同一个池上。
 *    故按 mirrorKey 做时间窗聚合：窗口内第一次立刻写（可观测性不迟到），其余在内存累加、
 *    每窗口最多再写一次（见 `noteStaleRefusal` / `flushRefusalBucket`）。
 */

import type pg from 'pg';
import {
  installConfigMirrorFreshnessSource,
  type ConfigMirrorFreshnessSource,
  type ConfigMirrorKey,
  type MirrorReadState,
} from '../config-mirror-freshness.js';
import { CONFIG_MIRRORS, CONFIG_MIRROR_KEYS } from './mirror-registry.js';
import { MirrorVersionStore } from './mirror-version-store.js';

/** 轮询周期默认值与硬上界。超界 MUST 拒绝启动并打诚实错误，MUST NOT 静默截断。 */
export const DEFAULT_MIRROR_POLL_MS = 5_000;
export const MAX_MIRROR_POLL_MS = 30_000;
const MIN_MIRROR_POLL_MS = 500;

/**
 * 参数镜像的**观测**陈旧阈值：只用于告警与健康投影，**不参与停手**（`stateOf` 对参数镜像恒 `fresh`）。
 *
 * 参数镜像（模型 / 角色 / 类目 / 引流阈值 / FB 配置的非启用位）陈旧时按合同「继续用最后已知良值」，
 * 但「继续用」不等于「无需知道」——一小时读不到模型配置权威却在投影上显示 `fresh`，等于把一次
 * 持续故障做成了运营看不见的静默态。阈值取闸门的 5 倍：参数漂移不紧急，但必须可见。
 */
export const PARAMETER_MIRROR_OBSERVE_STALE_MS = 300_000;

/** 拒绝记账的聚合窗口：同一 mirrorKey 每窗口最多两条 PG 写（窗口首次一条 + 到期一条）。 */
const REFUSAL_FLUSH_WINDOW_MS = 60_000;

/** 某镜像的重载回调（内部复用 store 既有的 private reload()）。 */
export type MirrorReloader = () => Promise<void>;

export interface MirrorHealthEntry {
  mirrorKey: ConfigMirrorKey;
  tier: 'gate' | 'parameter';
  /** 已成功装载进本进程副本的版本；从未成功装载过则 null。 */
  version: number | null;
  /** 上一次**成功完成版本比对**的时刻（毫秒）。null = 从未成功。 */
  lastComparedAt: number | null;
  /** 上一次真正 reload 的时刻（毫秒），只用于日志/排障，**不参与陈旧判定**。 */
  lastReloadedAt: number | null;
  /** 连续重载失败的起点（毫秒）。非 null = 副本**已知落后**于权威。 */
  reloadFailingSince: number | null;
  /** 观测口径的副本状态：闸门与参数镜像都如实回答（参数镜像 stale 也不停手，见 `haltsOnStale`）。 */
  state: MirrorReadState;
  /** **停手**阈值；参数镜像为 null（陈旧只告警、不停手）。 */
  staleMs: number | null;
  /** **观测**阈值：`state` 就是按它算的。闸门 = staleMs，参数镜像 = PARAMETER_MIRROR_OBSERVE_STALE_MS。 */
  observeStaleMs: number;
  /** 该镜像陈旧时是否会触发停手（= tier === 'gate'）。 */
  haltsOnStale: boolean;
  /** 已陈旧多久（毫秒）；新鲜时 0。 */
  staleForMs: number;
}

export interface MirrorHealthProjection {
  /** 数据时刻：本投影中各字段的求值时刻（**不是**响应时刻）。 */
  asOf: number;
  enabled: boolean;
  pollMs: number;
  entries: MirrorHealthEntry[];
}

export interface MirrorRefresherOptions {
  /** MUST 复用组合根已有的 Pool，MUST NOT 另开连接池。 */
  pool: pg.Pool;
  /** 每个 mirrorKey 的重载回调；未登记的 key 只做版本跟踪、不重载。 */
  reloaders?: Partial<Record<ConfigMirrorKey, MirrorReloader>>;
  /** 轮询周期毫秒；缺省读 env `AIDCP_CONFIG_MIRROR_POLL_MS`。 */
  pollMs?: number;
  /** 整体开关；缺省读 env `AIDCP_CONFIG_MIRROR_REFRESH`（默认开）。 */
  enabled?: boolean;
  executionTarget?: string;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error' | 'debug'>;
  /** 具名告警出口（`config_mirror_stale`）。best-effort、吞错。 */
  onStaleAlert?: (input: {
    mirrorKey: ConfigMirrorKey;
    staleSeconds: number;
    lastKnownVersion: number | null;
    executionTarget: string;
    severity: 'warning' | 'stale';
    /** 参数镜像陈旧**不停手**（继续用最后已知良值）；告警文案与优先级 MUST 据此区分，绝不谎称已停手。 */
    tier: 'gate' | 'parameter';
    /** 副本是否**已知落后**（比对读到了新版本但重载持续失败），而非只是「读不到权威」。 */
    reloadFailing: boolean;
  }) => void;
  versionStore?: MirrorVersionStore;
}

/** 解析轮询周期。超硬上界 MUST 抛（拒绝启动），MUST NOT 静默截断。 */
export function resolveMirrorPollMs(raw: string | number | undefined): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MIRROR_POLL_MS;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_MIRROR_POLL_MS) {
    throw new Error(
      `[config-mirror] AIDCP_CONFIG_MIRROR_POLL_MS=${String(raw)} 非法：必须是 ≥${MIN_MIRROR_POLL_MS} 的整数毫秒`,
    );
  }
  if (n > MAX_MIRROR_POLL_MS) {
    throw new Error(
      `[config-mirror] AIDCP_CONFIG_MIRROR_POLL_MS=${n} 超过硬上界 ${MAX_MIRROR_POLL_MS}ms：` +
        `陈旧上限由轮询周期给出，放宽周期会让闸门镜像的陈旧上限失去意义 → 拒绝启动（绝不静默截断）`,
    );
  }
  return n;
}

/** 解析整体开关（默认开）。 */
export function resolveMirrorRefreshEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return true;
  return raw.toLowerCase() !== 'false' && raw !== '0';
}

interface MirrorRuntimeState {
  /** 已**成功装载**进本进程副本的版本（重载失败时回退到上一个成功值，绝不停留在没装进来的那个）。 */
  version: number | null;
  lastComparedAt: number | null;
  lastReloadedAt: number | null;
  /** 连续重载失败的起点；任一次重载成功即复位为 null。非 null = 副本已知落后于权威。 */
  reloadFailingSince: number | null;
  /** 已就该镜像发过预警（staleMs/2）；恢复新鲜后复位。 */
  warnedAt: number | null;
  /** 已就该镜像发过陈旧告警；恢复新鲜后复位。 */
  staleAlertedAt: number | null;
}

/** 拒绝记账的按 mirrorKey 聚合桶（内存累加 → 每窗口最多一次落库）。 */
interface RefusalBucket {
  pending: number;
  lastFlushAt: number | null;
  lastLoggedAt: number | null;
}

export class ConfigMirrorRefresher implements ConfigMirrorFreshnessSource {
  private readonly versionStore: MirrorVersionStore;
  private readonly reloaders: Partial<Record<ConfigMirrorKey, MirrorReloader>>;
  private readonly pollMs: number;
  private readonly enabled: boolean;
  private readonly executionTarget: string;
  private readonly clock: () => number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error' | 'debug'>;
  private readonly onStaleAlert?: MirrorRefresherOptions['onStaleAlert'];
  private readonly states = new Map<ConfigMirrorKey, MirrorRuntimeState>();
  private readonly refusalBuckets = new Map<ConfigMirrorKey, RefusalBucket>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private started = false;

  constructor(options: MirrorRefresherOptions) {
    this.versionStore = options.versionStore ?? new MirrorVersionStore({ pool: options.pool });
    this.reloaders = options.reloaders ?? {};
    this.pollMs = options.pollMs ?? resolveMirrorPollMs(process.env.AIDCP_CONFIG_MIRROR_POLL_MS);
    this.enabled = options.enabled ?? resolveMirrorRefreshEnabled(process.env.AIDCP_CONFIG_MIRROR_REFRESH);
    this.executionTarget = options.executionTarget ?? process.env.AIDCP_DEPLOY_ENV ?? 'unknown';
    this.clock = options.clock ?? (() => Date.now());
    this.logger = options.logger ?? console;
    this.onStaleAlert = options.onStaleAlert;
    for (const key of CONFIG_MIRROR_KEYS) {
      this.states.set(key, {
        version: null,
        lastComparedAt: null,
        lastReloadedAt: null,
        reloadFailingSince: null,
        warnedAt: null,
        staleAlertedAt: null,
      });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getPollMs(): number {
    return this.pollMs;
  }

  /**
   * 建表 + 跑一轮建立基线 + 安装新鲜度事实源 + 起周期。
   * 关闭时（env 回滚）**不安装事实源**——所有闸门按今日现状运行（镜像即库）。
   */
  async start(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn(
        '[config-mirror] AIDCP_CONFIG_MIRROR_REFRESH=false → 刷新器不启动，行为退回今日现状（启动 + 本进程写入刷新）',
      );
      return;
    }
    if (this.started) return;
    this.started = true;
    await this.versionStore.init();
    // 建立基线：首轮把库里已有版本读进来但**不触发重载**（init() 刚 reload 过），
    // 同时把 lastComparedAt 打上——否则进程刚起来就会被判成 stale。
    await this.runOnce({ baseline: true });
    installConfigMirrorFreshnessSource(this);
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log(
      `[config-mirror] 刷新器已启动：T_poll=${this.pollMs}ms，闸门镜像陈旧即停手（target=${this.executionTarget}）`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
    // 停机前把聚合桶里的尾巴写掉，绝不让「已经拒绝过但还没落库」的计数随进程消失。
    this.flushDueRefusals(true);
    installConfigMirrorFreshnessSource(null);
  }

  /**
   * 跑一轮版本比对。
   *
   * 成功：**每个已登记 key 的 `lastComparedAt` 都更新**（无论本轮是否发生重载）。
   * 失败：记 warn、保留上次已知版本与 `lastComparedAt`（时间一到自然转 stale，由闸门停手）。
   */
  async runOnce(opts: { baseline?: boolean } = {}): Promise<void> {
    if (this.running) return; // 上一轮还没回来就跳过，绝不叠加并发查询
    this.running = true;
    const startedAt = this.clock();
    try {
      const versions = await this.versionStore.readAll();
      const now = this.clock();
      const changed: Array<{ key: ConfigMirrorKey; prev: number | null; next: number }> = [];
      for (const key of CONFIG_MIRROR_KEYS) {
        const state = this.states.get(key)!;
        const next = versions.get(key) ?? null;
        const prev = state.version;
        state.lastComparedAt = now; // 比对成功即更新，与是否重载无关
        if (next !== null && next !== prev) {
          if (!opts.baseline) {
            changed.push({ key, prev, next });
          } else {
            // 基线轮：store 刚 init() 过，副本即权威，直接记为已装载。
            state.version = next;
            this.logger.debug?.(`[config-mirror] 基线版本 mirror=${key} version=${next}`);
          }
        }
      }
      for (const { key, prev, next } of changed) {
        const state = this.states.get(key)!;
        const reload = this.reloaders[key];
        if (!reload) {
          // 未登记重载器的 key 只做版本跟踪：没有副本要装载，故版本即已知版本。
          state.version = next;
          continue;
        }
        try {
          await reload();
          state.version = next;
          state.lastReloadedAt = this.clock();
          state.reloadFailingSince = null;
          this.logger.log(`[config-mirror] 镜像已重载 mirror=${key} version=${next}`);
        } catch (err) {
          // 重载失败 → 副本仍停在上一个**成功装载**的版本（绝不记成已装载 next），
          // 并记下连续失败起点：从这一刻起本副本**已知落后**，ageOf 据此把它推向 stale。
          state.version = prev;
          state.reloadFailingSince ??= this.clock();
          this.logger.warn(
            `[config-mirror] 镜像重载失败 mirror=${key} 权威版本=${next} 副本停留=${prev ?? 'none'} ` +
              `已知落后=${Math.round((this.clock() - state.reloadFailingSince) / 1000)}s: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      this.logger.debug?.(
        `[config-mirror] 比对完成 耗时=${this.clock() - startedAt}ms 变化=${changed.length}`,
      );
    } catch (err) {
      this.logger.warn(
        `[config-mirror] 版本比对失败（保留上次已知版本，不清空镜像）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.running = false;
      this.evaluateStaleness();
      this.flushDueRefusals();
    }
  }

  /**
   * 进入 stale 前先在 `阈值 / 2` 处打一次预警；转回 fresh 时复位。
   *
   * 参数镜像同样评估——它们**不停手**，但「一小时读不到权威却在投影上显示新鲜」是把一次持续故障
   * 做成静默态。它们走 `PARAMETER_MIRROR_OBSERVE_STALE_MS` 观测阈值，只发告警。
   */
  private evaluateStaleness(): void {
    const now = this.clock();
    for (const key of CONFIG_MIRROR_KEYS) {
      const state = this.states.get(key)!;
      const threshold = this.observeStaleMsOf(key);
      const age = this.ageOf(state, now);
      if (age > threshold) {
        if (state.staleAlertedAt === null) {
          state.staleAlertedAt = now;
          this.emitAlert(key, age, state.version, 'stale');
        }
        continue;
      }
      if (age > threshold / 2) {
        if (state.warnedAt === null) {
          state.warnedAt = now;
          this.emitAlert(key, age, state.version, 'warning');
        }
        continue;
      }
      state.warnedAt = null;
      state.staleAlertedAt = null;
    }
  }

  private emitAlert(
    mirrorKey: ConfigMirrorKey,
    ageMs: number,
    lastKnownVersion: number | null,
    severity: 'warning' | 'stale',
  ): void {
    const staleSeconds = Math.round(ageMs / 1000);
    const tier = CONFIG_MIRRORS[mirrorKey].tier;
    const reloadFailing = this.states.get(mirrorKey)?.reloadFailingSince != null;
    this.logger.warn(
      `[config-mirror] ${severity === 'stale' ? '镜像已陈旧' : '镜像即将陈旧'} mirror=${mirrorKey} ` +
        `tier=${tier}${reloadFailing ? '（已知落后：重载持续失败）' : ''} ` +
        `陈旧=${staleSeconds}s 最后已知版本=${lastKnownVersion ?? 'none'} target=${this.executionTarget}`,
    );
    try {
      this.onStaleAlert?.({
        mirrorKey,
        staleSeconds,
        lastKnownVersion,
        executionTarget: this.executionTarget,
        severity,
        tier,
        reloadFailing,
      });
    } catch {
      /* 告警出口异常绝不连累刷新循环 */
    }
  }

  /**
   * 副本年龄 = 距「上一次可以断言副本与权威一致」多久，取两条判据的较大值：
   *  ① 距上一次**成功比对**多久（读不到权威版本）；
   *  ② 距**连续重载失败起点**多久（读到了新版本但装不进来——副本已知落后）。
   *
   * 从未成功比对过 → 无穷大（按 stale 收敛，停手侧安全）。
   */
  private ageOf(state: MirrorRuntimeState, now: number): number {
    const comparedAge = state.lastComparedAt === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, now - state.lastComparedAt);
    if (state.reloadFailingSince === null) return comparedAge;
    return Math.max(comparedAge, Math.max(0, now - state.reloadFailingSince));
  }

  /** 观测阈值：闸门用停手阈值本身，参数镜像用只发告警的观测阈值。 */
  private observeStaleMsOf(mirrorKey: ConfigMirrorKey): number {
    return CONFIG_MIRRORS[mirrorKey].staleMs ?? PARAMETER_MIRROR_OBSERVE_STALE_MS;
  }

  /** `ConfigMirrorFreshnessSource` 实现：同步、零 IO、永不抛。 */
  stateOf(mirrorKey: ConfigMirrorKey): MirrorReadState {
    const descriptor = CONFIG_MIRRORS[mirrorKey];
    if (descriptor.staleMs === null) return 'fresh'; // 参数镜像永不停手（陈旧只告警）
    const state = this.states.get(mirrorKey);
    if (!state) return 'fresh';
    return this.ageOf(state, this.clock()) > descriptor.staleMs ? 'stale' : 'fresh';
  }

  /**
   * `ConfigMirrorFreshnessSource` 实现：记一次因陈旧的拒绝（持久、按小时聚合）。
   *
   * **按 mirrorKey 做时间窗聚合**：调用点是热路径（每条出站信封、每次配额求值），逐次落库会在
   * 权威不可达时把写压堆到刷新器自我恢复所依赖的同一个池上。窗口内**第一次立刻写**（可观测性不迟到），
   * 其余在内存累加、由下一次到期的 flush 一次性写入（`recordStaleRefusal` 的 count 参数按累加值累加）。
   * 日志同样按窗口去重，避免一次故障刷爆日志。
   */
  noteStaleRefusal(mirrorKey: ConfigMirrorKey, context?: string): void {
    const at = this.clock();
    const bucket = this.refusalBuckets.get(mirrorKey)
      ?? { pending: 0, lastFlushAt: null, lastLoggedAt: null };
    bucket.pending += 1;
    this.refusalBuckets.set(mirrorKey, bucket);
    if (bucket.lastLoggedAt === null || at - bucket.lastLoggedAt >= REFUSAL_FLUSH_WINDOW_MS) {
      bucket.lastLoggedAt = at;
      this.logger.warn(
        `[config-mirror] 因副本陈旧拒绝真实平台动作 mirror=${mirrorKey}` +
          `${context ? ` ctx=${context}` : ''} target=${this.executionTarget}`,
      );
    }
    this.flushRefusalBucket(mirrorKey, bucket, at, false);
  }

  /** 把所有到期的聚合桶落库（刷新器每轮调用一次，即使没有新拒绝也能把尾巴收走）。 */
  private flushDueRefusals(force = false): void {
    const at = this.clock();
    for (const [key, bucket] of this.refusalBuckets) {
      this.flushRefusalBucket(key, bucket, at, force);
    }
  }

  private flushRefusalBucket(
    mirrorKey: ConfigMirrorKey,
    bucket: RefusalBucket,
    at: number,
    force: boolean,
  ): void {
    if (bucket.pending <= 0) return;
    if (!force && bucket.lastFlushAt !== null && at - bucket.lastFlushAt < REFUSAL_FLUSH_WINDOW_MS) return;
    const count = bucket.pending;
    bucket.pending = 0;
    bucket.lastFlushAt = at;
    void this.versionStore
      .recordStaleRefusal(mirrorKey, this.executionTarget, at, count)
      .catch((err: unknown) => {
        this.logger.warn(
          `[config-mirror] 拒绝记账失败（不影响停手判定）mirror=${mirrorKey} 丢失计数=${count}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  /**
   * 只读健康投影：**标注数据时刻**（asOf），不只回响应时刻。
   *
   * `state` 是**观测**口径：参数镜像超过观测阈值同样如实回 `stale`（它们陈旧不停手，靠 `haltsOnStale`
   * 区分）。让「一小时没成功比对过的 model_config」在运营面前显示 fresh，等于把持续故障做成静默态。
   *
   * 整体开关关掉（秒级回滚）时**全部回 fresh**：那时根本不存在跨进程副本语义（镜像即库，同今日现状），
   * 与 `mirrorStateOf` 的口径一致；由回包里的 `enabled:false` 说明「刷新器没在跑」，绝不让一次回滚
   * 在运营面前显示成 15 条全红。
   */
  health(): MirrorHealthProjection {
    const asOf = this.clock();
    const entries: MirrorHealthEntry[] = CONFIG_MIRROR_KEYS.map((key) => {
      const descriptor = CONFIG_MIRRORS[key];
      const state = this.states.get(key)!;
      const age = this.ageOf(state, asOf);
      const observeStaleMs = this.observeStaleMsOf(key);
      const stale = this.enabled && age > observeStaleMs;
      return {
        mirrorKey: key,
        tier: descriptor.tier,
        version: state.version,
        lastComparedAt: state.lastComparedAt,
        lastReloadedAt: state.lastReloadedAt,
        reloadFailingSince: state.reloadFailingSince,
        state: stale ? 'stale' : 'fresh',
        staleMs: descriptor.staleMs,
        observeStaleMs,
        haltsOnStale: descriptor.tier === 'gate',
        staleForMs: stale && Number.isFinite(age) ? age : 0,
      };
    });
    return { asOf, enabled: this.enabled, pollMs: this.pollMs, entries };
  }
}
