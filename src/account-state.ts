/**
 * 账号状态管理器 — 暂停/活跃状态。
 *
 * 内存缓存（热路径同步读：isPaused/getStatus，浏览闭环命令泵前用）+ 持久化
 * （pause/resume 异步写 AccountStore）。启动时从 store 加载（init），使被暂停账号在
 * 云端重启后仍为 paused，不静默复活——修复旧 bug「暂停态仅在内存、重启丢失、
 * getStatus 默认 active 致被暂停账号复活」。
 *
 * 缓存为持久化镜像：被暂停账号一定命中 paused，不再依赖「内存没有 → 默认 active」的回退
 * 来代表真实状态（spec accounts-master-data「去掉未知账号默认 active 回退」的落地）。
 * 缓存 miss 仅发生在从未注册/从未暂停的账号，视为 active（合理语义、不掩盖任何持久化暂停态）。
 * 无 store 时退化为纯内存（向后兼容 / 单测）。
 */

import type { AccountStore } from './account-store.js';

export type AccountStatus = 'active' | 'paused';

export interface AccountState {
  accountId: string;
  status: AccountStatus;
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
    this.states.clear();
    for (const r of records) {
      this.states.set(r.accountId, {
        accountId: r.accountId,
        status: r.status,
        ...(r.pausedAt != null ? { pausedAt: r.pausedAt } : {}),
      });
    }
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

  /** 检查账号是否已暂停（同步读缓存，热路径）。 */
  isPaused(accountId: string): boolean {
    return this.states.get(accountId)?.status === 'paused';
  }

  /**
   * 获取账号状态（同步读缓存）。缓存为持久化镜像，被暂停账号一定命中 paused、永不复活；
   * 缓存 miss（从未注册/从未暂停的账号）视为 active。
   */
  getStatus(accountId: string): AccountState {
    return this.states.get(accountId) ?? { accountId, status: 'active' };
  }
}
