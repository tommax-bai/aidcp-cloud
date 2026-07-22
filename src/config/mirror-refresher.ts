/**
 * 跨进程配置镜像刷新器（change config-mirror-cross-process-invalidation，§3 + §6）。
 *
 * 一个进程一个实例。每轮一次 `readAll()` 整表拉版本，只对**版本变化**的 key 触发对应 store 的
 * `refreshFromAuthority()`。它同时是「新鲜度事实源」：闸门取值口经 `src/config-mirror-freshness.ts`
 * 的同步查询口问它「这个副本还新鲜吗」。
 *
 * ## 三条容易写错的地方
 *
 * 1. **计时基准是「上一次成功完成版本比对」，不是「上一次成功 reload」。** 否则一个长期无变更的
 *    镜像会被永远算作陈旧——那会在完全健康的系统上把车队停死。
 * 2. **单轮查询失败 MUST 保留上次已知版本，MUST NOT 清空镜像。** 清空等于把「读不到」变成
 *    「库里没有」，正是本 change 要消灭的那类翻向。
 * 3. **停手是「不放行新的平台动作」，不是 kill 在跑的会话。** 本类只负责如实回答 fresh/stale 与
 *    记账；具体停手由各闸门取值口在**入口**收敛（会话启动闸、命令泵、schedulers）。
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

/** 某镜像的重载回调（内部复用 store 既有的 private reload()）。 */
export type MirrorReloader = () => Promise<void>;

export interface MirrorHealthEntry {
  mirrorKey: ConfigMirrorKey;
  tier: 'gate' | 'parameter';
  /** 已知版本；从未比对成功过则 null。 */
  version: number | null;
  /** 上一次**成功完成版本比对**的时刻（毫秒）。null = 从未成功。 */
  lastComparedAt: number | null;
  /** 上一次真正 reload 的时刻（毫秒），只用于日志/排障，**不参与陈旧判定**。 */
  lastReloadedAt: number | null;
  state: MirrorReadState;
  staleMs: number | null;
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
  version: number | null;
  lastComparedAt: number | null;
  lastReloadedAt: number | null;
  /** 已就该镜像发过预警（staleMs/2）；恢复新鲜后复位。 */
  warnedAt: number | null;
  /** 已就该镜像发过陈旧告警；恢复新鲜后复位。 */
  staleAlertedAt: number | null;
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
      const changed: ConfigMirrorKey[] = [];
      for (const key of CONFIG_MIRROR_KEYS) {
        const state = this.states.get(key)!;
        const next = versions.get(key) ?? null;
        const prev = state.version;
        state.lastComparedAt = now; // 比对成功即更新，与是否重载无关
        if (next !== null && next !== prev) {
          state.version = next;
          if (!opts.baseline) changed.push(key);
          else this.logger.debug?.(`[config-mirror] 基线版本 mirror=${key} version=${next}`);
        }
      }
      for (const key of changed) {
        const state = this.states.get(key)!;
        const reload = this.reloaders[key];
        if (!reload) continue;
        try {
          await reload();
          state.lastReloadedAt = this.clock();
          this.logger.log(`[config-mirror] 镜像已重载 mirror=${key} version=${state.version}`);
        } catch (err) {
          // 重载失败不回退版本记录会掩盖问题：退回上一版本号，下一轮再试。
          state.version = null;
          this.logger.warn(
            `[config-mirror] 镜像重载失败 mirror=${key}: ${err instanceof Error ? err.message : String(err)}`,
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
    }
  }

  /** 进入 stale 前先在 `staleMs / 2` 处打一次预警；转回 fresh 时复位。 */
  private evaluateStaleness(): void {
    const now = this.clock();
    for (const key of CONFIG_MIRROR_KEYS) {
      const descriptor = CONFIG_MIRRORS[key];
      if (descriptor.staleMs === null) continue; // 参数镜像不停手
      const state = this.states.get(key)!;
      const age = this.ageOf(state, now);
      if (age > descriptor.staleMs) {
        if (state.staleAlertedAt === null) {
          state.staleAlertedAt = now;
          this.emitAlert(key, age, state.version, 'stale');
        }
        continue;
      }
      if (age > descriptor.staleMs / 2) {
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
    this.logger.warn(
      `[config-mirror] ${severity === 'stale' ? '镜像已陈旧' : '镜像即将陈旧'} mirror=${mirrorKey} ` +
        `陈旧=${staleSeconds}s 最后已知版本=${lastKnownVersion ?? 'none'} target=${this.executionTarget}`,
    );
    try {
      this.onStaleAlert?.({
        mirrorKey,
        staleSeconds,
        lastKnownVersion,
        executionTarget: this.executionTarget,
        severity,
      });
    } catch {
      /* 告警出口异常绝不连累刷新循环 */
    }
  }

  /** 副本年龄：距上一次**成功比对**多久。从未成功比对过 → 视为无穷大（按 stale 收敛）。 */
  private ageOf(state: MirrorRuntimeState, now: number): number {
    if (state.lastComparedAt === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, now - state.lastComparedAt);
  }

  /** `ConfigMirrorFreshnessSource` 实现：同步、零 IO、永不抛。 */
  stateOf(mirrorKey: ConfigMirrorKey): MirrorReadState {
    const descriptor = CONFIG_MIRRORS[mirrorKey];
    if (descriptor.staleMs === null) return 'fresh'; // 参数镜像永不停手（陈旧只告警）
    const state = this.states.get(mirrorKey);
    if (!state) return 'fresh';
    return this.ageOf(state, this.clock()) > descriptor.staleMs ? 'stale' : 'fresh';
  }

  /** `ConfigMirrorFreshnessSource` 实现：记一次因陈旧的拒绝（持久、按小时聚合）。 */
  noteStaleRefusal(mirrorKey: ConfigMirrorKey, context?: string): void {
    const at = this.clock();
    this.logger.warn(
      `[config-mirror] 因副本陈旧拒绝真实平台动作 mirror=${mirrorKey}` +
        `${context ? ` ctx=${context}` : ''} target=${this.executionTarget}`,
    );
    void this.versionStore
      .recordStaleRefusal(mirrorKey, this.executionTarget, at)
      .catch((err: unknown) => {
        this.logger.warn(
          `[config-mirror] 拒绝记账失败（不影响停手判定）mirror=${mirrorKey}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  /** 只读健康投影：**标注数据时刻**（asOf），不只回响应时刻。 */
  health(): MirrorHealthProjection {
    const asOf = this.clock();
    const entries: MirrorHealthEntry[] = CONFIG_MIRROR_KEYS.map((key) => {
      const descriptor = CONFIG_MIRRORS[key];
      const state = this.states.get(key)!;
      const age = this.ageOf(state, asOf);
      const staleMs = descriptor.staleMs;
      const stale = staleMs !== null && age > staleMs;
      return {
        mirrorKey: key,
        tier: descriptor.tier,
        version: state.version,
        lastComparedAt: state.lastComparedAt,
        lastReloadedAt: state.lastReloadedAt,
        state: stale ? 'stale' : 'fresh',
        staleMs,
        staleForMs: stale && Number.isFinite(age) ? age : 0,
      };
    });
    return { asOf, enabled: this.enabled, pollMs: this.pollMs, entries };
  }
}
