/**
 * 账号状态管理器 — 暂停/活跃状态。
 *
 * 内存缓存（热路径同步读：pauseStateOf/getStatus，浏览闭环命令泵前用）+ 持久化
 * （pause/resume 异步写 AccountStore）。启动时从 store 加载（init），使被暂停账号在
 * 云端重启后仍为 paused，不静默复活——修复旧 bug「暂停态仅在内存、重启丢失、
 * getStatus 默认 active 致被暂停账号复活」。
 *
 * ## 三态（change config-mirror-cross-process-invalidation task 4.6）
 *
 * 读取结果是 `paused | active | unknown`，**不是布尔**。
 *
 * - 副本**新鲜**时：命中 paused → `paused`；命中/未命中且新鲜 → `active`。
 *   「缓存 miss = active」在同进程全量镜像下正确——镜像即库，miss 只发生在从未注册/从未暂停的账号。
 * - 副本**陈旧**时：一律 `unknown`，MUST NOT 沿用「miss = active」。跨进程副本下「副本里没有」
 *   ≠「库里没有」：那条回退等价于「运营点了暂停、后台回写入成功、账号继续对真实平台动作」，
 *   属红线「绝不静默假成功」所禁。`unknown` 由调用方按停手处理（不下发新命令），
 *   已在跑的会话走既有自然结束路径收敛。
 *
 * 无 store 时退化为纯内存（向后兼容 / 单测）。
 */

import type { AccountStore } from './account-store.js';
import { isMirrorStale } from './config-mirror-freshness.js';

export type AccountStatus = 'active' | 'paused';

/** 暂停态读取结果（三态）。`unknown` = 副本陈旧、无法确认，MUST 按停手处理。 */
export type AccountPauseState = 'paused' | 'active' | 'unknown';

export interface AccountState {
  accountId: string;
  status: AccountPauseState;
  pausedAt?: number;
}

export class AccountStateManager {
  private states = new Map<string, AccountState>();
  private readonly store?: AccountStore;

  constructor(store?: AccountStore) {
    this.store = store;
  }

  /** 从持久化存储加载全部账号暂停态进内存缓存（启动时调用一次；无 store 则空操作）。 */
  async init(): Promise<void> {
    if (!this.store) return;
    const records = await this.store.listAll();
    // 构建新 Map → 原子替换引用（禁止原地 clear+fill）：跨进程刷新器会在任意时刻触发重载，
    // 原地清空会让并发的同步现读在中途读到「全都没暂停」。
    const next = new Map<string, AccountState>();
    for (const r of records) {
      next.set(r.accountId, {
        accountId: r.accountId,
        status: r.status,
        ...(r.pausedAt != null ? { pausedAt: r.pausedAt } : {}),
      });
    }
    this.states = next;
  }

  /** 跨进程失效刷新入口（task 3.2）：只由刷新器在版本变化时调用。 */
  async refreshFromAuthority(): Promise<void> {
    await this.init();
  }

  /** 暂停账号：同步改缓存（热路径立即生效）+ 持久化（未注册账号自动建行）。 */
  async pause(accountId: string): Promise<void> {
    const at = Date.now();
    this.states.set(accountId, { accountId, status: 'paused', pausedAt: at });
    await this.store?.setPaused(accountId, true, at);
  }

  /** 恢复账号：同步改缓存 + 持久化。 */
  async resume(accountId: string): Promise<void> {
    this.states.set(accountId, { accountId, status: 'active' });
    await this.store?.setPaused(accountId, false, null);
  }

  /**
   * 账号暂停态（同步读缓存，热路径，三态）。
   *
   * 副本陈旧 → `unknown`；MUST NOT 退回「miss = active」。
   *
   * **纯取值口，不记账**：本方法每条 `note.arrived` 都会走一次，也被飞书 `/status`、徽章投影这类
   * 「什么都没拒绝」的读调用；每次落一条 PG 写既污染「因陈旧拒绝真实平台动作」这个指标，也会在
   * 权威不可达时把写压堆到刷新器自我恢复所依赖的同一个连接池上。记账收口在真正的拒绝点
   * （`src/comm/handler.ts` 的 note.arrived 停手分支）。
   */
  pauseStateOf(accountId: string): AccountPauseState {
    if (isMirrorStale('account_status')) return 'unknown';
    return this.states.get(accountId)?.status === 'paused' ? 'paused' : 'active';
  }

  /**
   * 获取账号状态（同步读缓存，三态）。缓存为持久化镜像，被暂停账号一定命中 paused、永不复活；
   * 副本新鲜时缓存 miss（从未注册/从未暂停的账号）视为 active；副本陈旧一律 unknown。
   */
  getStatus(accountId: string): AccountState {
    const state = this.pauseStateOf(accountId);
    if (state === 'paused') {
      return this.states.get(accountId) ?? { accountId, status: 'paused' };
    }
    return { accountId, status: state };
  }
}
