import type { NotificationCategory } from '../event-bus/types.js';

/** 通知巡视的会话内共享状态（角色间只经此 + 事件协调，不偷看兄弟角色私有变量）。 */
export interface ExcursionState {
  active: boolean;
  epoch: number | null;
  phase: 'idle' | 'requested' | 'suspended' | 'opening' | 'ended';
  lastHandledEpoch: number | null;
  processedCategories: Set<NotificationCategory>;
}

/**
 * 会话上下文，追踪当前浏览路径的来源信息。
 * 各角色通过此上下文获取 sourcePageType，确保 BackToFeed 能返回正确的列表页。
 */
export class SessionContext {
  private _sourcePageType: 'feed' | 'search' = 'feed';
  private _currentNoteId: string | null = null;
  private _consecutiveScrolls: number = 0;
  private _visitedNoteIds: Set<string> = new Set();

  /** 有界"近期已评估"卡片集合（按 recency，最多保留最近 N 个 noteId，超出淘汰最旧）。 */
  private _recentEvaluatedIds: string[] = [];
  private static readonly RECENT_EVALUATED_CAP = 30;

  /** 通知巡视瞬时状态（reset 必清——断连/结束后绝不残留 active/暂停，否则永久冻结浏览）。 */
  private _excursion: ExcursionState = SessionContext.freshExcursion();
  /** 浏览暂停开关（巡视期扣住 browse 类命令）。存此处 → reset 一并清，断连不冻结。 */
  private _browseSuspended = false;
  /** 已发飞书的评论/@ 去重集合（跨巡视保持，像 visited；不在 reset 清，避免重复打扰）。 */
  private _notifiedItemKeys: Set<string> = new Set();

  private static freshExcursion(): ExcursionState {
    return { active: false, epoch: null, phase: 'idle', lastHandledEpoch: null, processedCategories: new Set() };
  }

  get sourcePageType(): 'feed' | 'search' { return this._sourcePageType; }
  get currentNoteId(): string | null { return this._currentNoteId; }
  get consecutiveScrolls(): number { return this._consecutiveScrolls; }

  setSourcePageType(type: 'feed' | 'search'): void { this._sourcePageType = type; }
  setCurrentNoteId(id: string | null): void { this._currentNoteId = id; }

  incrementScrolls(): number { return ++this._consecutiveScrolls; }
  resetScrolls(): void { this._consecutiveScrolls = 0; }

  markVisited(noteId: string): void { this._visitedNoteIds.add(noteId); }
  isVisited(noteId: string): boolean { return this._visitedNoteIds.has(noteId); }

  /**
   * 标记一张卡片"近期已评估"（用于熟悉度折扣，非用于跳过评估）。
   * 维护有界 recency：重复出现的 noteId 移到队尾刷新 recency；超出容量淘汰最旧。
   */
  markEvaluated(noteId: string): void {
    if (!noteId) return;
    const i = this._recentEvaluatedIds.indexOf(noteId);
    if (i >= 0) this._recentEvaluatedIds.splice(i, 1);
    this._recentEvaluatedIds.push(noteId);
    if (this._recentEvaluatedIds.length > SessionContext.RECENT_EVALUATED_CAP) {
      this._recentEvaluatedIds.shift();
    }
  }

  /** 该卡片是否在"最近约 N 个已评估"窗口内（熟悉）。 */
  isRecentlyEvaluated(noteId: string): boolean {
    return !!noteId && this._recentEvaluatedIds.includes(noteId);
  }

  // ─── 通知巡视状态（共享底座，角色间只读这一份） ───
  get excursion(): Readonly<ExcursionState> { return this._excursion; }
  get excursionActive(): boolean { return this._excursion.active; }
  get excursionEpoch(): number | null { return this._excursion.epoch; }
  get browseSuspended(): boolean { return this._browseSuspended; }

  /** 准入通过：开一次巡视（同步 check-then-set，准入角色须同步调用）。 */
  beginExcursion(epoch: number): void {
    this._excursion = { active: true, epoch, phase: 'requested', lastHandledEpoch: epoch, processedCategories: new Set() };
  }
  setExcursionPhase(phase: ExcursionState['phase']): void { this._excursion.phase = phase; }
  /**
   * 结束巡视：清瞬时态 + 解除暂停。幂等。
   * 保留 lastHandledEpoch（本会话内已处理的 epoch 水位，防同一 epoch 被重复检测再次开巡视；
   * 仅 reset() 在断连时清零），以及 notifiedItemKeys。
   */
  endExcursion(): void {
    const last = this._excursion.lastHandledEpoch;
    this._excursion = { active: false, epoch: null, phase: 'idle', lastHandledEpoch: last, processedCategories: new Set() };
    this._browseSuspended = false;
  }
  /** 本趟是否已处理过该分类（防分诊死循环）。 */
  isCategoryProcessed(cat: NotificationCategory): boolean { return this._excursion.processedCategories.has(cat); }
  markCategoryProcessed(cat: NotificationCategory): void { this._excursion.processedCategories.add(cat); }

  setBrowseSuspended(b: boolean): void { this._browseSuspended = b; }

  /** 评论/@ 是否已发过飞书（去重；仅在确认收到分类结果时推进，失败/超时不推进）。 */
  isItemNotified(key: string): boolean { return !!key && this._notifiedItemKeys.has(key); }
  markItemNotified(key: string): void { if (key) this._notifiedItemKeys.add(key); }

  reset(): void {
    this._sourcePageType = 'feed';
    this._currentNoteId = null;
    this._consecutiveScrolls = 0;
    // 通知巡视瞬时态 + 暂停开关必清（断连/重连/结束后不残留 active/暂停，否则永久冻结浏览）
    this._excursion = SessionContext.freshExcursion();
    this._browseSuspended = false;
    // 注意：visitedNoteIds / recentEvaluatedIds / notifiedItemKeys 不重置，跨轮次保持
  }
}
