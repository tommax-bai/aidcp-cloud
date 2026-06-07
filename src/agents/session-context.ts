/**
 * 会话上下文，追踪当前浏览路径的来源信息。
 * 各角色通过此上下文获取 sourcePageType，确保 BackToFeed 能返回正确的列表页。
 */
export class SessionContext {
  private _sourcePageType: 'feed' | 'search' = 'feed';
  private _currentNoteId: string | null = null;
  private _consecutiveScrolls: number = 0;
  private _visitedNoteIds: Set<string> = new Set();

  get sourcePageType(): 'feed' | 'search' { return this._sourcePageType; }
  get currentNoteId(): string | null { return this._currentNoteId; }
  get consecutiveScrolls(): number { return this._consecutiveScrolls; }

  setSourcePageType(type: 'feed' | 'search'): void { this._sourcePageType = type; }
  setCurrentNoteId(id: string | null): void { this._currentNoteId = id; }

  incrementScrolls(): number { return ++this._consecutiveScrolls; }
  resetScrolls(): void { this._consecutiveScrolls = 0; }

  markVisited(noteId: string): void { this._visitedNoteIds.add(noteId); }
  isVisited(noteId: string): boolean { return this._visitedNoteIds.has(noteId); }

  reset(): void {
    this._sourcePageType = 'feed';
    this._currentNoteId = null;
    this._consecutiveScrolls = 0;
    // 注意：visitedNoteIds 不重置，跨轮次保持
  }
}
