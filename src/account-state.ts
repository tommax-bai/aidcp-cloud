/**
 * 账号状态管理器 — 内存存储账号暂停/活跃状态。
 * MVP 阶段无需持久化，重启后状态丢失（默认活跃）。
 */

export type AccountStatus = 'active' | 'paused';

export interface AccountState {
  accountId: string;
  status: AccountStatus;
  pausedAt?: number;
}

export class AccountStateManager {
  private states = new Map<string, AccountState>();

  /** 暂停指定账号 */
  pause(accountId: string): void {
    this.states.set(accountId, {
      accountId,
      status: 'paused',
      pausedAt: Date.now(),
    });
  }

  /** 恢复指定账号 */
  resume(accountId: string): void {
    this.states.set(accountId, {
      accountId,
      status: 'active',
      pausedAt: undefined,
    });
  }

  /** 检查账号是否已暂停 */
  isPaused(accountId: string): boolean {
    const state = this.states.get(accountId);
    return state?.status === 'paused';
  }

  /** 获取账号状态（不存在则返回默认 active） */
  getStatus(accountId: string): AccountState {
    return this.states.get(accountId) ?? { accountId, status: 'active' };
  }
}
