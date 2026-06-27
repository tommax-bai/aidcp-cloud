import type { NotificationCategory } from '../event-bus/types.js';

/** 通知巡视的会话内共享状态（角色间只经此 + 事件协调，不偷看兄弟角色私有变量）。 */
export interface ExcursionState {
  active: boolean;
  epoch: number | null;
  phase: 'idle' | 'requested' | 'suspended' | 'opening' | 'ended';
  /** 每类「清理尝试」次数（loop-to-zero 的有界兜底）：到上限仍有未读 → 诚实放弃该类、不空转、不假报已清。 */
  categoryAttempts: Map<NotificationCategory, number>;
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
  /**
   * 已发飞书的评论/@ 去重集合（跨巡视保持，像 visited；不在 reset 清，避免重复打扰）。
   * 注意：这是「飞书通知去重」维度，与「巡视是否触发」正交——后者的 epoch「已处理过」闸已删除
   * （change notification-clear-to-zero）。巡视扫得更勤 → 同条评论会被反复看到，故此去重水位务必保留、勿连带删。
   */
  private _notifiedItemKeys: Set<string> = new Set();

  // ─── 登录账号真实昵称采集（change account-real-nickname）─────────────────────────
  /** 握手同步算的「需采集」判定（真实账号且库内 nickname 为 NULL）。per-connection 决策，
   *  跨 browse-session 重启保持（**不**在 reset 清，否则重连后永不再采）；采到后由角色置 false。 */
  private _pendingNicknameCapture = false;
  /** 本人主页采集在途标记。**仅**用于 chokepoint 放行 self profile_open + 超时 + 防重复收尾，
   *  绝不用于持久化/隔离身份判定（身份恒由 detail.authorId===accountId 决定）。瞬时态——reset 必清。 */
  private _selfCaptureInFlight = false;
  /** 采空尝试计数（K 上限有界兜底：genuinely 抽不到的主页退避而非永绕）。per-connection 保持。 */
  private _selfCaptureAttempts = 0;
  private static readonly SELF_CAPTURE_MAX_ATTEMPTS = 3;
  /** 本人主页采集 ~20s 兜底超时句柄（edge 静默/CDP 崩时恢复浏览）。瞬时态——reset 必清。 */
  private _selfCaptureTimer: ReturnType<typeof setTimeout> | null = null;
  static readonly SELF_CAPTURE_TIMEOUT_MS = 20_000;

  private static freshExcursion(): ExcursionState {
    return { active: false, epoch: null, phase: 'idle', categoryAttempts: new Map() };
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
    this._excursion = { active: true, epoch, phase: 'requested', categoryAttempts: new Map() };
  }
  setExcursionPhase(phase: ExcursionState['phase']): void { this._excursion.phase = phase; }
  /**
   * 结束巡视：清瞬时态 + 解除暂停。幂等。
   * 不再保留「已处理过 epoch 水位」——巡视的再触发由「未读真清零 → 下一次无→有翻转」驱动
   * （change notification-clear-to-zero：真有新消息就处理，不因处理过而拒绝）；notifiedItemKeys 仍跨巡视保留（见上）。
   */
  endExcursion(): void {
    this._excursion = { active: false, epoch: null, phase: 'idle', categoryAttempts: new Map() };
    this._browseSuspended = false;
  }
  /** 本趟该分类已尝试清理的次数（loop-to-zero 有界兜底用）。 */
  getCategoryAttempts(cat: NotificationCategory): number { return this._excursion.categoryAttempts.get(cat) ?? 0; }
  /** 记一次该分类清理尝试，返回累计次数。 */
  incrementCategoryAttempts(cat: NotificationCategory): number {
    const n = (this._excursion.categoryAttempts.get(cat) ?? 0) + 1;
    this._excursion.categoryAttempts.set(cat, n);
    return n;
  }

  setBrowseSuspended(b: boolean): void { this._browseSuspended = b; }

  // ─── 登录账号真实昵称采集（change account-real-nickname）访问口 ───
  get pendingNicknameCapture(): boolean { return this._pendingNicknameCapture; }
  setPendingNicknameCapture(b: boolean): void { this._pendingNicknameCapture = b; }
  get selfCaptureInFlight(): boolean { return this._selfCaptureInFlight; }
  setSelfCaptureInFlight(b: boolean): void { this._selfCaptureInFlight = b; }
  get selfCaptureAttempts(): number { return this._selfCaptureAttempts; }
  /** 采空 +1，返回累计；达上限后角色不再绕。 */
  incrementSelfCaptureAttempts(): number { return ++this._selfCaptureAttempts; }
  get selfCaptureMaxAttempts(): number { return SessionContext.SELF_CAPTURE_MAX_ATTEMPTS; }
  get selfCaptureTimer(): ReturnType<typeof setTimeout> | null { return this._selfCaptureTimer; }
  setSelfCaptureTimer(h: ReturnType<typeof setTimeout> | null): void { this._selfCaptureTimer = h; }

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
    // 本人昵称采集瞬时态必清（在途标记 + 定时器）：否则 chokepoint 永久放行 profile_open / 超时空响。
    if (this._selfCaptureTimer !== null) { clearTimeout(this._selfCaptureTimer); this._selfCaptureTimer = null; }
    this._selfCaptureInFlight = false;
    // 注意：visitedNoteIds / recentEvaluatedIds / notifiedItemKeys 不重置，跨轮次保持；
    //       pendingNicknameCapture / selfCaptureAttempts 是 per-connection 决策/预算，亦**不**在此清。
  }
}
