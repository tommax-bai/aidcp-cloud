/**
 * SearchExecutor — 搜索执行角色。
 *
 * 职责：执行搜索动作。薄角色，确定性执行，不使用 LLM。
 * 收到 search.approved 后重置滚动计数器，emit feed.entered(search)。
 *
 * 消费事件：search.approved
 * 产出事件：feed.entered（pageType='search', trigger='search_completed'）
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName, SearchApprovedPayload } from '../event-bus/types.js';

export interface SearchExecutorOptions extends RoleOptions {
  sessionContext: SessionContext;
}

export class SearchExecutor extends BaseRole {
  readonly roleName: RoleName = 'search_executor';
  private readonly ctx: SessionContext;
  private readonly _searchedKeywords: string[] = [];
  private unsubscribers: (() => void)[] = [];

  constructor(options: SearchExecutorOptions) {
    super(options);
    this.ctx = options.sessionContext;
  }

  /** 获取已搜索过的关键词列表 */
  get searchedKeywords(): string[] {
    return [...this._searchedKeywords];
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('search.approved', (p) => this.handleSearchApproved(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private handleSearchApproved(payload: SearchApprovedPayload): void {
    // 记录搜索关键词
    this._searchedKeywords.push(payload.keyword);

    // 重置连续滚动计数
    this.ctx.resetScrolls();

    // emit feed.entered 表示搜索完成，进入搜索结果页
    this.emit('feed.entered', {
      pageType: 'search',
      trigger: 'search_completed',
      ts: Date.now(),
    });
  }
}
