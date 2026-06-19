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

  reset(): void {
    this._sourcePageType = 'feed';
    this._currentNoteId = null;
    this._consecutiveScrolls = 0;
    // 注意：visitedNoteIds / recentEvaluatedIds 不重置，跨轮次保持
  }
}
