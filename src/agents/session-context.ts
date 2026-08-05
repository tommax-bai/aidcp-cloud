import type { NotificationCategory } from '../event-bus/types.js';

/** 通知巡视的会话内共享状态（角色间只经此 + 事件协调，不偷看兄弟角色私有变量）。 */
export interface ExcursionState {
  active: boolean;
  epoch: number | null;
  phase: 'idle' | 'requested' | 'suspended' | 'opening' | 'ended';
  /** 每类「清理尝试」次数（loop-to-zero 的有界兜底）：到上限仍有未读 → 诚实放弃该类、不空转、不假报已清。 */
  categoryAttempts: Map<NotificationCategory, number>;
  /**
   * 本趟巡视**云端自己点名**正在看的那一栏（change route-notification-items-by-category）。
   * 分诊选中某类时单点写入（`notification.category_selected` 的唯一发出者就是分诊），巡视开始 / 结束清空。
   *
   * 为什么这一格必须存在：到达的通知条目**不带栏位身份**——「赞和收藏」/「新增关注」两栏在清未读回执之外
   * 顺带回传的发送者条目（喂通知联系人名册用）与「评论和@」栏抽取的评论项，走的是同一条上报通道。
   * 云端此前无条件把它们当评论抽取结果跑评论管线，实际拦住的只有分类器里一条按正文文案写的正则。
   * 而「现在在看哪一栏」本就是云端自己的决定，记在这里即可定性到达的批次——**不需要执行端多报一个字段，
   * 不改协议，对任何版本的执行端立即生效**。
   * `null` = 本趟尚未选中任何分类（三态里的「不知道」，MUST NOT 当成「是评论栏」）。
   */
  selectedCategory: NotificationCategory | null;
}

/**
 * 会话上下文，追踪当前浏览路径的来源信息。
 * 各角色通过此上下文获取 sourcePageType，确保 BackToFeed 能返回正确的列表页。
 */
export class SessionContext {
  private _sourcePageType: 'feed' | 'search' = 'feed';
  private _currentNoteId: string | null = null;
  /**
   * 当前笔记是否已从列表迁移进详情页（change platform-registry-shape：为「就地读」平台的评论迁移做闭合判据）。
   * 由云端**发出迁移命令时**置位（非边缘 echo），随当前笔记切换自动重置。就地读平台走过迁移 ⇒ 循环闭合必 back。
   * 小红书 / 阶段 0 FB 从不迁移（read=comment surface 相等），恒 false ⇒ 恒 back，零行为。
   */
  private _currentNoteMigratedToDetail = false;
  private _consecutiveScrolls: number = 0;
  /** 本会话累计已浏览的不重复 feed 卡数（change feed-refresh-on-depth）：达阈值改点右下「刷新」回顶换新批。
   *  per-session（reset 归零，像 _consecutiveScrolls；不像 lastFeedNoteIds 跨轮保持）。 */
  private _feedCardsBrowsed: number = 0;
  private _visitedNoteIds: Set<string> = new Set();

  /** 有界"近期已评估"卡片集合（按 recency，最多保留最近 N 个 noteId，超出淘汰最旧）。 */
  private _recentEvaluatedIds: string[] = [];
  private static readonly RECENT_EVALUATED_CAP = 30;

  /**
   * 上一批 feed 可见卡的 noteId 集合（feed-scroll-card-floor 简版差分基准）：每次 feed 上报覆盖。
   * 不在 reset 清（跨轮/重连保持，像 visitedNoteIds），避免重连把整屏误判为新卡而空叠停留。
   */
  private _lastFeedNoteIds: Set<string> = new Set();

  /** 本会话当前搜索行程累计已浏览的不重复"搜索结果"卡数（change bounded-search-excursion）：达阈值回首页、
   *  结束一次搜索行程。per-search-excursion（回首页 / reset 归零）。与 _feedCardsBrowsed 完全分离、互不干扰。 */
  private _searchCardsBrowsed: number = 0;
  /** 上一批搜索结果可见卡的 noteId 集合（搜索卡差分基准，独立于 _lastFeedNoteIds）：回首页 / reset 时清。 */
  private _lastSearchNoteIds: Set<string> = new Set();

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
  /** 启动期昵称刷新标记。由 NicknameEnricher 在首批 page.cards{startupId} 采集时置 true。
   *  跨 browse-session 重启保持；不再由 hello / session_start 预先置位。 */
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
    return { active: false, epoch: null, phase: 'idle', categoryAttempts: new Map(), selectedCategory: null };
  }

  get sourcePageType(): 'feed' | 'search' { return this._sourcePageType; }
  get currentNoteId(): string | null { return this._currentNoteId; }
  get consecutiveScrolls(): number { return this._consecutiveScrolls; }

  setSourcePageType(type: 'feed' | 'search'): void { this._sourcePageType = type; }
  setCurrentNoteId(id: string | null): void {
    // 笔记切换即重置迁移标志（per-note 语义）：新笔记从未迁移。
    if (id !== this._currentNoteId) this._currentNoteMigratedToDetail = false;
    this._currentNoteId = id;
  }

  /** 当前笔记是否已迁移进详情页（就地读平台评论迁移的闭合判据）。 */
  get currentNoteMigratedToDetail(): boolean { return this._currentNoteMigratedToDetail; }
  /** 云端发出迁移命令时置位（非边缘 echo）。随笔记切换 / reset 自动清。 */
  markNoteMigratedToDetail(): void { this._currentNoteMigratedToDetail = true; }

  incrementScrolls(): number { return ++this._consecutiveScrolls; }
  resetScrolls(): void { this._consecutiveScrolls = 0; }

  /** 本会话累计已浏览 feed 卡数（change feed-refresh-on-depth）。 */
  get feedCardsBrowsed(): number { return this._feedCardsBrowsed; }
  addFeedCardsBrowsed(n: number): void { if (n > 0) this._feedCardsBrowsed += n; }
  resetFeedCardsBrowsed(): void { this._feedCardsBrowsed = 0; }

  /** 当前搜索行程累计已浏览"搜索结果"卡数（change bounded-search-excursion）。 */
  get searchCardsBrowsed(): number { return this._searchCardsBrowsed; }
  addSearchCardsBrowsed(n: number): void { if (n > 0) this._searchCardsBrowsed += n; }
  /** 结束一次搜索行程：清累计数与搜索卡差分基准（回首页时调）。 */
  resetSearchCardsBrowsed(): void {
    this._searchCardsBrowsed = 0;
    this._lastSearchNoteIds = new Set();
  }

  /**
   * 算本批相对"上一批搜索结果卡"的新卡数（不在上一批集合中的去重数量），随即用本批 noteId 覆盖基准集合。
   * 与 feedBatchNewCount 同构但用独立的搜索基准，故 feed/search 差分互不污染。缺 noteId 的卡由调用方剔除、计为非新卡。
   */
  searchBatchNewCount(noteIds: string[]): number {
    const incoming = new Set(noteIds);
    let newCount = 0;
    for (const id of incoming) if (!this._lastSearchNoteIds.has(id)) newCount++;
    this._lastSearchNoteIds = incoming;
    return newCount;
  }

  markVisited(noteId: string): void { this._visitedNoteIds.add(noteId); }
  isVisited(noteId: string): boolean { return this._visitedNoteIds.has(noteId); }

  /** 本场已看过（打开过）的笔记数（change humanize-interaction-prompts）：注入判定 prompt 作会话状态，
   *  使判定带序列依赖（第 2 篇 vs 第 15 篇兴致不同）。跨轮保持，与 visitedNoteIds 同生命周期。 */
  get visitedCount(): number { return this._visitedNoteIds.size; }

  /**
   * 最近若干次真实互动的有界记录（change humanize-interaction-prompts）：由互动评估角色在 emit
   * interaction.completed 后追加（如 'like' / 'collect' / 'like+collect'），供后续判定 prompt 注入
   * 「刚点过什么」的当下状态。有界 recency（最多 RECENT_INTERACTIONS_CAP），跨轮保持、reset 不清
   * （与 visited 同——会话内连续性信号）。
   */
  private _recentInteractions: string[] = [];
  private static readonly RECENT_INTERACTIONS_CAP = 6;
  recordInteraction(label: string): void {
    if (!label) return;
    this._recentInteractions.push(label);
    if (this._recentInteractions.length > SessionContext.RECENT_INTERACTIONS_CAP) {
      this._recentInteractions.shift();
    }
  }
  /** 最近互动的只读快照（最旧→最新）。 */
  get recentInteractions(): readonly string[] { return this._recentInteractions; }

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

  /**
   * feed-scroll-card-floor：算本批相对"上一批 feed 卡"的新卡数（不在上一批集合中的去重数量），
   * 随即用本批 noteId 覆盖基准集合。缺 noteId 的卡由调用方剔除、计为非新卡。
   * 返回未刷新（同一批 noteId）→ 0；部分重叠 → 只计真正的新卡。
   */
  feedBatchNewCount(noteIds: string[]): number {
    const incoming = new Set(noteIds);
    let newCount = 0;
    for (const id of incoming) if (!this._lastFeedNoteIds.has(id)) newCount++;
    this._lastFeedNoteIds = incoming;
    return newCount;
  }

  // ─── 通知巡视状态（共享底座，角色间只读这一份） ───
  get excursion(): Readonly<ExcursionState> { return this._excursion; }
  get excursionActive(): boolean { return this._excursion.active; }
  get excursionEpoch(): number | null { return this._excursion.epoch; }
  /**
   * 本趟巡视当前选中的分类（`null` = 尚未选中）。到达的通知条目靠它定性——
   * 这是云端**自己点名**的事实，不经执行端往返。见 `ExcursionState.selectedCategory`。
   */
  get excursionSelectedCategory(): NotificationCategory | null { return this._excursion.selectedCategory; }
  get browseSuspended(): boolean { return this._browseSuspended; }

  /** 准入通过：开一次巡视（同步 check-then-set，准入角色须同步调用）。 */
  beginExcursion(epoch: number): void {
    this._excursion = {
      active: true, epoch, phase: 'requested', categoryAttempts: new Map(), selectedCategory: null,
    };
  }
  setExcursionPhase(phase: ExcursionState['phase']): void { this._excursion.phase = phase; }
  /**
   * 结束巡视：清瞬时态 + 解除暂停。幂等。
   * 不再保留「已处理过 epoch 水位」——巡视的再触发由「未读真清零 → 下一次无→有翻转」驱动
   * （change notification-clear-to-zero：真有新消息就处理，不因处理过而拒绝）；notifiedItemKeys 仍跨巡视保留（见上）。
   */
  endExcursion(): void {
    this._excursion = SessionContext.freshExcursion();
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
  /**
   * 记下本趟巡视**云端自己点名**要看的那一栏（唯一写入口，由分诊在选中时调）。
   * 非巡视期不写：巡视外的杂散选择不该给一个不存在的巡视定性。
   */
  noteCategorySelected(cat: NotificationCategory): void {
    if (!this._excursion.active) return;
    this._excursion.selectedCategory = cat;
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
    this._currentNoteMigratedToDetail = false;
    this._consecutiveScrolls = 0;
    this._feedCardsBrowsed = 0; // per-session feed 深度预算，重连即重置（change feed-refresh-on-depth）
    this._searchCardsBrowsed = 0; // per-search-excursion 搜索卡预算，重连即重置（change bounded-search-excursion）
    this._lastSearchNoteIds = new Set(); // 搜索卡差分基准随重连清（对齐 _searchCardsBrowsed 生命周期）
    // 通知巡视瞬时态 + 暂停开关必清（断连/重连/结束后不残留 active/暂停，否则永久冻结浏览）
    this._excursion = SessionContext.freshExcursion();
    this._browseSuspended = false;
    // 本人昵称采集瞬时态必清（在途标记 + 定时器）：否则 chokepoint 永久放行 profile_open / 超时空响。
    if (this._selfCaptureTimer !== null) { clearTimeout(this._selfCaptureTimer); this._selfCaptureTimer = null; }
    this._selfCaptureInFlight = false;
    // 注意：visitedNoteIds / recentEvaluatedIds / notifiedItemKeys / lastFeedNoteIds 不重置，跨轮次保持；
    //       pendingNicknameCapture / selfCaptureAttempts 是 per-connection 刷新标记/预算，亦**不**在此清。
  }
}
