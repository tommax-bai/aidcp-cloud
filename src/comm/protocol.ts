/**
 * 边-云 WebSocket 通信协议定义（消息类型 + 信封）。
 *
 * 设计原则：
 * - 单一信封 {v, type, id, ts, payload}，便于路由与版本演进；
 * - 请求/响应通过 id 关联（与 CDP 客户端思路一致）；
 * - 类型尽量贴合定位层既有结构（ElementDescriptor / ActionResult），
 *   云端只做"规划 + 选元素 + 锚点缓存"，原子操作仍由边缘执行。
 *
 * 该文件是边-云两侧的唯一契约来源（edge 侧可复制或引用同名定义）。
 */

/** 协议版本号 */
export const PROTOCOL_VERSION = 2;

/** 所有消息的类型枚举 */
export type MessageType =
  // —— 连接握手 ——
  | 'hello' // edge → cloud：边缘上线，声明能力/会话
  | 'welcome' // cloud → edge：握手确认
  // —— 陪伴界面数据回填（cloud → edge，主动推送）——
  | 'ui.snapshot' // cloud → edge：账号资料快照 + 发布审批状态回填（昵称/最近发布/pending·approved·rejected·failed），边缘核心转 [ui-event] 行给桌面壳
  // —— 任务规划 ——
  | 'plan.request' // edge → cloud：给定高层目标，请求拆解为步骤
  | 'plan.response' // cloud → edge：返回有序步骤清单
  // —— 元素选择（缓存缺口时的文本 LLM 选择题）——
  | 'select.request' // edge → cloud：给定目标 + 元素清单，请云端选一个
  | 'select.response' // cloud → edge：返回选中的元素 index
  // —— 锚点缓存读写 ——
  | 'anchor.get' // edge → cloud：按 actionId 取主缓存锚点
  | 'anchor.get.result' // cloud → edge：锚点或空
  | 'anchor.report' // edge → cloud：上报一次命中/校验结果，驱动反污染晋升
  // —— 执行结果回传（观测/训练用）——
  | 'action.result' // edge → cloud：上报某 actionId 的最终 ActionResult
  // —— 浏览会话编排（ManagerAgent 驱动）——
  | 'note.content' // edge → cloud：上报一条笔记的标题/摘要/指标，供评估与概念抽取
  | 'note.ack'    // cloud → edge：确认收到笔记，异步处理中
  | 'browse.next' // cloud → edge：滚动/滑到下一条笔记
  | 'browse.scroll' // cloud → edge：在当前页面滚动
  | 'note.open' // cloud → edge：打开一条笔记
  | 'note.close' // cloud → edge：关闭当前笔记
  | 'search.execute' // cloud → edge：执行一次关键词搜索
  | 'session.end' // cloud → edge：结束本次浏览会话
  // —— 风控预算与互动判定 ——
  | 'session.budget.request' // edge → cloud：请求本次 browse session 预算
  | 'session.budget' // cloud → edge：下发本次 browse session 预算
  | 'risk.canDo' // edge → cloud：互动前请求是否允许执行 action
  | 'risk.canDo.result' // cloud → edge：allow / deny
  | 'risk.record' // edge → cloud：互动成功后记录 action
  | 'risk.record.result' // cloud → edge：记录结果
  | 'risk.captcha_detected' // edge → cloud：检测到验证码/未知阻断弹窗，已本地暂停，请云端置风控态 + 停发命令 + 通知人工
  | 'risk.captcha_cleared' // edge → cloud：验证码/未知阻断弹窗已清除，已恢复浏览
  // —— 发布编排（Publish Agent 驱动）——
  | 'publish.approval_request' // edge → cloud：请求发送发布审批卡片
  | 'publish.request' // cloud → edge：请求在浏览器中发布一篇帖子（v1 整页路径，地基阶段并行保留）
  | 'publish.result' // edge → cloud：发布结果回传（v1 整页路径）
  | 'publish.command' // cloud → edge：下发一条参数化发布原子指令（A 阶段1 指令驱动路径）
  | 'publish.command.result' // edge → cloud：回传单条发布指令的执行结果
  // —— 角色驱动指令（cloud → edge，RoleDispatcher 驱动）——
  | 'page.scroll'          // 页面滚动
  | 'interaction.like'     // 点赞
  | 'interaction.collect'  // 收藏
  | 'interaction.follow'   // 关注
  | 'interaction.comment'  // 发评论（浏览闭环写互动）
  | 'interaction.like_comment' // 给「别人的某条评论」点赞（详情页拟人微互动）
  | 'navigation.back'      // 返回上一页
  | 'note.browse_images'   // 浏览笔记图片
  | 'note.scroll_comments' // 滚动评论区
  | 'profile.open'         // 进入作者主页（专用指令，取代 open_note{type:'profile'}）
  | 'notification.open'             // cloud → edge：导航到通知首页（仅导航，不再复合）
  | 'notification.browse_comments'  // cloud → edge：进「评论和@」+ 滚动 + 抽取
  | 'notification.browse_likes'     // cloud → edge：进「赞和收藏」（v1 看一眼清未读）
  | 'notification.browse_follows'   // cloud → edge：进「新增关注」（v1 看一眼清未读）
  | 'notification.back_home'        // cloud → edge：返回通知首页
  // —— Edge 上报（edge → cloud，RoleDispatcher 消费）——
  | 'notification.detected' // edge → cloud：检测到「消息」有未读（仅信号）
  | 'notification.home'     // edge → cloud：通知首页各类未读快照
  | 'notification.items'    // edge → cloud：上报抽取的评论/@ 项
  | 'page.cards'           // Edge 上报当前可见卡片列表
  | 'note.detail'          // Edge 上报笔记详情
  | 'profile.detail'       // Edge 上报个人主页数据
  | 'action.completed'     // Edge 确认 action 执行完成
  // —— 通用 ——
  | 'error' // 任一方 → 对方：错误信息
  | 'ping'
  | 'pong';

/** 通信信封 */
export interface Envelope<T = unknown> {
  /** 协议版本 */
  v: number;
  type: MessageType;
  /** 请求/响应关联 id（响应回填请求的 id） */
  id: string;
  /** 发送时间戳（毫秒）；由发送方填充 */
  ts: number;
  payload: T;
}

// —————————————————————— 各消息 payload ——————————————————————

export interface HelloPayload {
  /** 边缘节点标识 */
  edgeId: string;
  /** 业务/站点标识（如 "xhs"） */
  app?: string;
  /** 边缘端能力声明 */
  capabilities?: string[];
  /** 该边缘当前驱动的账号标识（用于风控归属与验证码事件定位；缺省视为默认账号） */
  accountId?: string;
  /** 人类可读的机器标签（如 "win-aliyun-3"），验证码卡片据此告诉运维去哪台机器处置 */
  machineLabel?: string;
  /** 远程桌面 / 可达地址（如 RDP/VNC 地址或跳板说明），用于人工远程处置 */
  remoteAddr?: string;
}

/**
 * 每类操作的兜底 floor 语义标识（最小间隔 gating；change pacing-floor-config-min-interval）。
 * 语义不是"操作后无条件附加固定等待"，而是"两次操作间的最小间隔下限"——边缘记上次操作
 * 完成时刻，收到下一操作时若距上次已达 floor 则立即执行（不累加、吸收云端往返），否则只补差额。
 */
export type PacingOp =
  | 'action'
  | 'scroll'
  | 'card_gap'
  | 'detail_dwell'
  | 'feed_card_read'
  | 'content_glance'
  | 'content_read';

/** 单类操作的兜底区间（毫秒）；边缘据此现采样目标、只补差额。值已含云端读出口 clamp 护栏、非零。 */
export interface PacingFloorPayload {
  minMs: number;
  maxMs: number;
}

/**
 * 节奏快照（cloud → edge，随 welcome 握手响应下发；change pacing-floor-config-min-interval）。
 * 承载全局节奏兜底：风控档标量 tempo（边缘乘算）+ 每类操作 floor 默认区间。可选、向后兼容
 * （旧端忽略）；缺失 / 某字段缺失时边缘逐字段回落内置非零默认，绝不零延迟。与 session.budget
 * 的 `PacingDefaultsPayload`（已废弃为下发路径的死通道）区分。
 */
export interface PacingSnapshotPayload {
  /** 风控档全局节奏乘子（normal=1.0 / warned=1.3 / restricted=1.6），边缘乘算 */
  tempo: number;
  /** 每类操作兜底 floor 默认区间（已含 clamp 护栏、非零）；逐字段可缺、边缘逐项回落内置默认 */
  opFloorsMs: Partial<Record<PacingOp, PacingFloorPayload>>;
}

export interface WelcomePayload {
  /** 云端分配的会话 id */
  sessionId: string;
  serverVersion: string;
  /**
   * 节奏快照（change pacing-floor-config-min-interval）：tempo + 每类操作兜底 floor 区间。
   * 可选、向后兼容（旧端忽略）；边缘据此做操作间最小间隔 gating 与详情页停留兜底。
   */
  pacing?: PacingSnapshotPayload;
}

/**
 * 陪伴界面数据快照（cloud → edge 主动推送，change edge-companion-ui 8.1）。
 * 发送时机：① 边缘 hello 注册完成后回填全量快照；② 发布审批生命周期变化时增量推送。
 * 红线：字段全部可选、缺失=云端无该数据；边缘 MUST NOT 以占位/猜测补全（宁缺毋假）。
 */
export type UiDailyUsageAction = 'view' | 'like' | 'collect' | 'comment' | 'follow' | 'publish';
export type UiDailyUsageCounts = Partial<Record<UiDailyUsageAction, number>>;

export interface UiDailyUsagePayload {
  /** Epoch ms when cloud assembled the account daily usage projection. */
  asOf: number;
  quotaLevel?: 'conservative' | 'normal' | 'aggressive';
  totals: UiDailyUsageCounts;
  quotas?: UiDailyUsageCounts;
  saturated?: UiDailyUsageAction[];
}

export interface UiSnapshotPayload {
  /** 账号身份；nickname 为云端账号主数据里的小红书真实昵称（accounts.nickname），空/缺失时边缘不得转发 identity 事件 */
  account?: { id: string; nickname?: string };
  /** 最近一次成功发布的摘要；at = epoch ms（来源 publish_log.published_at，为草稿入库时间近似） */
  lastPublish?: { title: string; at: number };
  /**
   * 发布审批状态。云端只推边缘看不到的状态（pending/approved/rejected/failed 终判）；
   * published 由边缘在提交成功处自知、不经此通道；reminded 仅在真的再次提醒后才推——
   * 云端当前无再提醒机制，故此值现阶段不会出现（枚举保留，绝不谎称已提醒）。
   */
  publish?: {
    state: 'pending' | 'reminded' | 'approved' | 'published' | 'rejected' | 'failed';
    title?: string;
    /** 界面「编号」对暗号用，与飞书审批卡「编号」字段一致（取发布记录 id，如 "#83"） */
    code?: string;
  };
  /** Account-scoped today usage and optional current daily quota context for the companion UI. */
  dailyUsage?: UiDailyUsagePayload;
}

/** 规划请求：高层自然语言目标 */
export interface PlanRequestPayload {
  /** 如 "给当前这条笔记点赞并关注作者" */
  goal: string;
  /** 可选上下文（当前页面 url、站点等） */
  context?: Record<string, string>;
}

/** 规划后的单步 */
export interface PlanStep {
  /** 业务锚点标识，如 "note.like_button" */
  actionId: string;
  /** 原子操作 */
  op: 'click' | 'input' | 'scroll';
  /** 给元素选择器的自然语言目标 */
  goal: string;
  /** input 操作的值 */
  value?: string;
}

export interface PlanResponsePayload {
  steps: PlanStep[];
  /** 规划说明（调试） */
  reason: string;
}

/** 云端选元素请求：把边缘抽取的元素清单送上来选 */
export interface SelectRequestPayload {
  goal: string;
  /** 边缘抽取的可交互元素清单（与 ElementDescriptor 对齐的精简结构） */
  elements: RemoteElement[];
}

/** 跨网传输的元素描述（ElementDescriptor 的网络投影） */
export interface RemoteElement {
  index: number;
  role: string;
  tag: string;
  text: string;
  attributes: Record<string, string>;
}

export interface SelectResponsePayload {
  /** 选中的元素 index；无合适项为 null */
  index: number | null;
  reason: string;
}

export interface AnchorGetPayload {
  actionId: string;
}

/** 锚点的网络投影（与 locating 的 Anchor 对齐） */
export interface RemoteAnchor {
  actionId: string;
  role?: string;
  text?: string;
  textMatch?: 'exact' | 'contains';
  attributes?: Record<string, string>;
  scope?: {
    role?: string;
    containsText?: string;
    attributes?: Record<string, string>;
  };
}

export interface AnchorGetResultPayload {
  anchor: RemoteAnchor | null;
}

/** 命中/校验结果上报，驱动云端反污染晋升流程 */
export interface AnchorReportPayload {
  actionId: string;
  /** 本次解析来源 */
  source: 'cache' | 'llm';
  /** 后置校验是否通过 */
  validated: boolean;
  /** llm 来源且校验通过时，附带候选锚点供暂存/晋升 */
  candidate?: RemoteAnchor;
}

export interface ActionResultPayload {
  actionId: string;
  ok: boolean;
  outcome: 'success' | 'escalated' | 'no_target' | 'guard_blocked';
  attempts: number;
  reason: string;
  escalation?: string;
}

/** 一条笔记的内容投影（edge → cloud），供引擎评估互动与抽取概念。 */
export interface NoteContentPayload {
  /** 笔记唯一标识（用于去重/记录来源） */
  noteId: string;
  title: string;
  /** 正文摘要（边缘截取，控制长度） */
  summary: string;
  /** 点赞数 */
  likeCount: number;
  /** 收藏数 */
  collectCount: number;
  /** 可选作者名 */
  author?: string;
}

/** 让边缘滑到下一条笔记（cloud → edge）。 */
export interface BrowseNextPayload {
  /** 调试说明（为什么继续刷） */
  reason?: string;
}

export interface BrowseScrollPayload {
  reason?: string;
}

export interface NoteOpenPayload {
  noteId?: string;
  index?: number;
  reason?: string;
  /** 打开前犹豫 / 感知时间中心值（毫秒，可选；时间指令见 §角色驱动指令） */
  thinkMs?: number;
}

export interface NoteClosePayload {
  reason?: string;
  /** 关闭前当前页应达到的总停留时间中心值（毫秒，可选） */
  dwellMs?: number;
}

/** 让边缘执行一次搜索（cloud → edge）。 */
export interface SearchExecutePayload {
  /** 搜索关键词 */
  keyword: string;
  /** 关键词来源策略（观测用） */
  source?: 'extract_from_liked' | 'random_from_interests' | 'new_concept' | 'manager';
  /** 本次搜索最多浏览的结果数 */
  maxResults?: number;
  /**
   * 结果页原生排序标签（change comment-search-command）。缺省=不切（综合，维持自治浏览旧行为）。
   * 边缘据此点搜索结果页对应排序 tab；定位失败 honest 降级、不冒充。
   */
  sort?: 'comprehensive' | 'latest' | 'most_liked' | 'most_collected' | 'most_commented';
  /**
   * 结果页原生时间范围筛选（change comment-search-command）。缺省=不筛（不限时间）。
   */
  timeWindow?: 'all' | 'one_day' | 'one_week' | 'half_year';
}

/** 结束本次浏览会话（cloud → edge）。 */
export interface SessionEndPayload {
  reason: string;
  /**
   * 正常结束后云端已安排/预计的休息时长（毫秒）。仅用于边端 UI 提示；
   * 缺失表示本次结束不会自动续场，或旧云端未提供该信息。
   */
  autoResumeInMs?: number;
  /** 会话汇总统计（观测用） */
  stats?: {
    likedCount: number;
    skippedCount: number;
    searchCount: number;
    durationMs: number;
  };
}

/** 请求 cloud 发送发布审批卡片（edge → cloud）。 */
export interface PublishApprovalRequestPayload {
  /** 单次发布请求唯一标识 */
  requestId: string;
  /** 帖子标题（小红书标题） */
  title: string;
  /** 正文（200-500 字） */
  content: string;
  /** 话题标签（3-5 个） */
  tags: string[];
  /** 可选边缘节点标识（观测用） */
  edgeId?: string;
}

export interface SessionBudgetRequestPayload {
  accountId?: string;
}

export interface SessionBudgetPayload {
  durationMs: number;
  maxActions: number;
  quotaLevel: 'conservative' | 'normal' | 'aggressive';
  viewOnly: boolean;
  startedAt: number;
  /**
   * 极薄节奏默认块（指令级节奏 Command Pacing）。可选、仅供边缘**自主动作 / 断连兜底**用；
   * 内容相关的 read/pause/fatigue 系数**不**在此下发——它们收口在云端，随决策指令以
   * `dwellMs`/`thinkMs` 下发。旧端忽略本字段并走内置默认。
   */
  pacing?: PacingDefaultsPayload;
}

/** session.budget 的兜底节奏默认（不含内容系数）。 */
export interface PacingDefaultsPayload {
  /** 全局节奏乘子（风控状态驱动：normal=1.0 / warned=1.3 / restricted=1.6） */
  tempo: number;
  /** 详情页最小停留下限区间（毫秒） */
  dwellFloorMs: { min: number; max: number };
}

export interface RiskCanDoPayload {
  action: 'view' | 'like' | 'collect' | 'comment' | 'follow' | 'publish' | 'comment_like';
  accountId?: string;
}

export interface RiskCanDoResultPayload {
  action: RiskCanDoPayload['action'];
  allowed: boolean;
  reason?: string;
}

export interface RiskRecordPayload {
  action: RiskCanDoPayload['action'];
  accountId?: string;
}

export interface RiskRecordResultPayload {
  action: RiskCanDoPayload['action'];
  recorded: boolean;
  reason?: string;
}

/**
 * 检测到验证码/未知阻断弹窗（edge → cloud，fire-and-forget）。
 * 由 edge 旁路监测体在「类别翻转进 captcha/unknown」时发一次（边缘已先本地暂停）。
 * 云端据此置风控态(restricted)、停止下发浏览命令、按 (edgeId,account) 去重后通知飞书人工处理。
 * 注意：检测/暂停/恢复全在 edge 本地完成，本消息只是通知，云端从不被边缘动作回查。
 */
export interface BlockingOverlayDomFeaturePayload {
  tag: string;
  id?: string;
  className?: string;
  role?: string;
  ariaModal?: string;
  selector?: string;
  text?: string;
  rect?: { x: number; y: number; width: number; height: number };
  style?: { position?: string; zIndex?: string; opacity?: string };
  hasIframe?: boolean;
  iframeSrcs?: string[];
  hasClose?: boolean;
  matchReasons?: string[];
}

export interface BlockingOverlaySnapshotPayload {
  kind: 'captcha' | 'unknown';
  /** URL captured at the first local transition into captcha/unknown for this episode. */
  firstDetectedUrl?: string;
  capturedAt: number;
  text?: string;
  dom?: BlockingOverlayDomFeaturePayload;
  candidates: BlockingOverlayDomFeaturePayload[];
}

export interface CaptchaDetectedPayload {
  /** 边缘节点标识 */
  edgeId?: string;
  /** 弹窗类别：captcha=已识别的风控挑战；unknown=可见阻断遮罩但本地未能归类（请云端命名） */
  kind: 'captcha' | 'unknown';
  /** 触发时页面 URL（best-effort） */
  url?: string;
  /** 首次阻断现场快照（best-effort）：遮罩文案 + DOM 特征 + 首次检测 URL。 */
  overlay?: BlockingOverlaySnapshotPayload;
  /** 关联账号（如有） */
  accountId?: string;
  /** 简短说明（观测用） */
  reason?: string;
}

/** 验证码/未知阻断弹窗已清除（edge → cloud，fire-and-forget）。 */
export interface CaptchaClearedPayload {
  edgeId?: string;
  url?: string;
  accountId?: string;
}

/** 请求在浏览器中发布一篇帖子（cloud → edge）。 */
export interface PublishRequestPayload {
  /** 帖子标题（小红书标题） */
  title: string;
  /** 正文（200-500 字） */
  content: string;
  /** 话题标签（3-5 个） */
  tags: string[];
  /** 可选配图（本任务暂不实现） */
  images?: string[];
}

/** 发布结果回传（edge → cloud）。 */
export interface PublishResultPayload {
  /** 是否发布成功 */
  ok: boolean;
  /** 发布成功后的平台帖子 id */
  postId?: string;
  /** 失败原因 */
  error?: string;
}

/** 发布原子指令的种类（A 设计 E1-E10）。 */
export type PublishCommandKind =
  | 'navigate_entry'
  | 'select_mode'
  | 'upload_image'
  | 'set_cover'
  | 'fill_field'
  | 'add_with_candidate'
  | 'set_option'
  | 'set_schedule'
  | 'submit_publish'
  | 'capture_postId';

/**
 * 各 kind 的参数（按 kind 区分；元数据维度本阶段先占位预留）。
 * 边轻云重：候选项（candidates）由云端预生成下发，边缘只定位点击、不实时拉取。
 */
export interface PublishCommandParams {
  /** fill_field：字段类型 */
  fieldType?: 'title' | 'content';
  /** fill_field / add_with_candidate：要填入或匹配的文本值 */
  value?: string;
  /** add_with_candidate：候选项种类（话题/@/地点/合集） */
  candidateKind?: 'topic' | 'mention' | 'location' | 'collection';
  /** add_with_candidate：云端预生成的候选文本（边缘定位点击用） */
  candidates?: string[];
  /** upload_image / set_cover：图片 URL */
  imageUrl?: string;
  /** set_option：开关项种类（可见范围/评论权限/各声明等，后续 stage 启用） */
  optionKind?: string;
  /** set_option：开关项取值 */
  optionValue?: string;
  /** set_schedule：定时发布时刻（毫秒时间戳；缺省则云端不下发此指令） */
  publishTime?: number;
}

/**
 * 一条参数化发布指令（cloud → edge）。
 * `recordId + seq` 为业务级永久关联键（请求/结果配对靠它）；`envelope.id` 仅供日志。
 * 注意：此 `recordId`（数字，PublishLogStore.insert 返回）与 AC-PUB 审批文件的 `requestId`（字符串）是两个不同的键。
 */
export interface PublishCommandPayload {
  /** 发布记录主键 */
  recordId: number;
  /** 指令在本次发布序列中的序号（从 0 递增） */
  seq: number;
  /** 指令种类 */
  kind: PublishCommandKind;
  /** 指令参数 */
  params: PublishCommandParams;
  /** 边缘执行超时（毫秒，缺省由边缘兜底） */
  timeoutMs?: number;
  /** 简短说明（观测用） */
  reason?: string;
}

/**
 * 单条发布指令的执行结果（edge → cloud），按 `recordId + seq` 关联回请求。
 * 红线：`ok` 按真实结果回报，绝不静默假成功——找不到目标 `no_target`、后置校验失败 `post_validation_failed`。
 */
export interface PublishCommandResultPayload {
  recordId: number;
  seq: number;
  kind: PublishCommandKind;
  /** 是否成功 */
  ok: boolean;
  /** 成功时的产出值（如 capture_postId 的真实 postId） */
  value?: string;
  /**
   * capture_postId 附带：带 xsec_token 的完整小红书详情页分享 URL（可点开真实笔记）。
   * 抓不到则不带（undefined）——诚实置空，绝不用裸 id 拼打不开的假链接（change publish-history-account-and-detail）。
   */
  postUrl?: string;
  /** 失败原因（no_target / post_validation_failed / kind_not_implemented / escalated 等） */
  error?: string;
  /** 诊断细节（定位/校验观测） */
  details?: {
    actionId?: string;
    outcome?: string;
    attempts?: number;
    durationMs?: number;
  };
}

/** 确认收到笔记（cloud → edge），异步处理中。 */
export interface NoteAckPayload {
  /** 确认收到 */
  received: boolean;
}

// —— 角色驱动指令 Payload（cloud → edge）——
//
// 时间指令（timing directive，指令级节奏 Command Pacing）：以下决策指令携带可选时间字段，
// 由云端基于已上报内容 + 风控状态 + 会话进度算出**中心值**：
//   - `thinkMs`：执行该动作**前**的犹豫 / 感知时间（动作之前）；
//   - `dwellMs`：离开当前页前应达到的**总停留时间**（用于 back / close）。
// 全部可选、向后兼容（旧端忽略）。边缘收到后叠加 lognormal 抖动再执行，缺失则走内置默认兜底。

export interface PageScrollPayload {
  reason?: string;  // feed_scroll | search_scroll
  /** feed 翻页停留时长中心值（毫秒，可选）：按本次新卡数算，返回未刷新时省略（feed-scroll-card-floor）。 */
  dwellMs?: number;
}

export interface InteractionLikePayload {
  noteId: string;
  reason?: string;
  /** 点赞前犹豫时间中心值（毫秒，可选） */
  thinkMs?: number;
}

export interface InteractionCollectPayload {
  noteId: string;
  reason?: string;
  /** 收藏前犹豫时间中心值（毫秒，可选） */
  thinkMs?: number;
}

export interface InteractionFollowPayload {
  authorId?: string;
  reason?: string;
  /** 关注前犹豫时间中心值（毫秒，可选） */
  thinkMs?: number;
}

export interface InteractionCommentPayload {
  noteId: string;
  /** 评论正文（云端已撰写 / 去AI味 / 人审通过后下发）。边缘**逐字符拟人输入**这一段。 */
  text: string;
  /**
   * 群聊引流码（change account-group-chat-injection，可选）：非空时边缘在 `text` 逐字输入完成后，
   * 用**单次整段插入**（Input.insertText，绕过 @/# 提及/主题补全）追加「换行 + 此码」——串码直接粘贴、不逐字敲。
   * 人审卡展示的是「text + 换行 + 此码」的完整终稿（AC-PUB 审=发）。缺省 = 不注入（普通评论）。
   */
  groupChatCode?: string;
  reason?: string;
  /** 发评论前犹豫时间中心值（毫秒，可选） */
  thinkMs?: number;
}

/** cloud → edge：给详情页内某一条评论点赞。靠稳定锚点 commentAnchorId 定位，绝不按序号。 */
export interface InteractionLikeCommentPayload {
  /** 目标评论的稳定 DOM 锚点（形如 comment-<id>）；边缘据此 getElementById 重新定位 */
  commentAnchorId: string;
  /** 所在笔记 id（当前详情页） */
  noteId: string;
  reason?: string;
  /** 点赞前犹豫时间中心值（毫秒，可选） */
  thinkMs?: number;
}

export interface NavigationBackPayload {
  reason?: string;  // quality_rejected | back_to_feed | profile_done
  targetPage?: 'feed' | 'search';
  /** 返回前当前页应达到的总停留时间中心值（毫秒，可选；治详情页秒退） */
  dwellMs?: number;
}

export interface NoteBrowseImagesPayload {
  noteId: string;
  /** 浏览图片数量（由 Cloud 控制） */
  count?: number;
  /** 开始浏览前犹豫时间中心值（毫秒，可选） */
  thinkMs?: number;
  /** 浏览图片的停留时长中心值（毫秒，可选） */
  dwellMs?: number;
}

export interface NoteScrollCommentsPayload {
  noteId: string;
  /** 滚动评论区次数（由 Cloud 控制） */
  count?: number;
  /** 开始滚动前犹豫时间中心值（毫秒，可选） */
  thinkMs?: number;
  /** 浏览评论区的停留时长中心值（毫秒，可选） */
  dwellMs?: number;
}

/** 进入作者主页（cloud → edge）。取代被静默丢弃的 open_note{type:'profile'}。 */
export interface ProfileOpenPayload {
  /** 作者标识（观测/兜底用；边缘优先点详情页作者头像进入，不强依赖该值） */
  authorId?: string;
  reason?: string;
  /** 进入主页前犹豫时间中心值（毫秒，可选） */
  thinkMs?: number;
  /** 云端指定直驱（change account-real-nickname）：true=直接 Page.navigate 到 /user/profile/<authorId>、不抓取当前页第一个作者链；缺省/false 维持点详情页作者头像进入路径逐字不变。边缘对此字段一视同仁、只执行，不含「这是不是自己」判定。 */
  direct?: boolean;
}

// —— Edge 上报 Payload（edge → cloud）——

export interface PageCardsPayload {
  cards: Array<{
    index: number;
    title: string;
    author?: string;
    likeCount: number;
    collectCount: number;
    coverDesc?: string;
    noteId?: string;
    isVideo?: boolean;
  }>;
}

export interface NoteDetailPayload {
  noteId: string;
  title: string;
  content: string;
  /** 媒体类型：缺省按 image_text 兼容老边端；边端仅从真实卡片/详情态判断，MUST NOT 臆造 video。 */
  mediaType?: 'image_text' | 'video';
  author?: string;
  authorId?: string;
  likeCount: number;
  collectCount: number;
  /** 作者区关注按钮当下真实态（change skip-profile-visit-if-followed）：已关注/互关→true；
   *  缺省/读取失败=未探到→云端回退原主页评估。边缘只读取上报、MUST NOT 臆造。 */
  authorFollowed?: boolean;
  /** 详情页带 xsec_token 的完整链接（change interaction-feed-enrichment，供面板「按笔记互动」可点跳转）。
   *  诚实置空：地址栏无 token 时不带、绝不用裸 id 拼打不开的假链接（同发布链 postUrl 约定）。 */
  url?: string;
}

export interface ProfileDetailPayload {
  authorId: string;
  /** 作品数：小红书主页【不公开】，恒为 0/未知——关注决策 MUST NOT 依赖此字段（保留仅为向后兼容） */
  postsCount: number;
  followersCount: number;
  /** 获赞与收藏数（主页 .user-interactions 提供）：关注决策的真实质量信号。缺失=未抽到 */
  likesCollects?: number;
  /** 作者资料是否成功抽取；false=进了主页但没抽到数字，供云端区分"数据缺失"与"真 0 粉丝" */
  extracted?: boolean;
  /** 作者真实昵称（change interaction-feed-enrichment，供面板关注记录显示真名）；抓不到则诚实置空。 */
  nickname?: string;
  /** 作者主页链接（change interaction-feed-enrichment，供面板关注记录可点跳转）；抓不到则诚实置空。 */
  url?: string;
}

/** edge → cloud：滚动评论时随手抽取的一条候选评论（供云端 comment_like_appraiser 评估 + 选中后回点）。 */
export interface CommentCandidate {
  /** 稳定 DOM 锚点（形如 comment-<id>），回点时据此 getElementById 重新定位 */
  anchorId: string;
  /** 评论作者昵称（可空） */
  author?: string;
  /** 评论正文片段 */
  text: string;
  /** 是否已是「已赞」状态（svg use === '#liked'）；供云端预过滤，绝不回点已赞 */
  alreadyLiked?: boolean;
  /** 该评论的点赞数（change curated-inspiration-corpus Phase 2b；解析「1.2万」等惯例，抓不到为 undefined，不编造） */
  likeCount?: number;
}

export interface ActionCompletedPayload {
  action: string;
  ok: boolean;
  reason?: string;
  /** 仅 scroll_comments 回执携带：本次滚动终态视口抽到的候选评论清单（best-effort，可空） */
  candidates?: CommentCandidate[];
}

/** edge → cloud：检测到「消息」有未读（仅信号；epoch 每次由无变有 +1，用于去重，不随未读数量变）。 */
export interface NotificationDetectedPayload {
  edgeId?: string;
  accountId?: string;
  epoch: number;
  unreadCount?: number;
}

/** cloud → edge：导航到通知首页（仅导航；落地后边缘上报 notification.home 各类未读）。 */
export interface NotificationOpenPayload {
  thinkMs?: number;
}

/** 单条通知项（边缘抽取的原始数据；评论/@ 含正文，点赞/收藏/关注为互动型；是否值得通知由云端判定）。 */
export interface NotificationItem {
  kind: 'comment' | 'mention' | 'like' | 'collect' | 'follow';
  fromUser: string;
  /** 发送者主页ID（从通知行头像 /user/profile/<id> 解析；取不到留空）= 跨类型稳定身份。 */
  fromUserId?: string;
  content: string;
  noteTitle?: string;
  itemKey?: string;
}

/** edge → cloud：上报本次巡视抽取的评论/@ 项。 */
export interface NotificationItemsPayload {
  items: NotificationItem[];
  epoch?: number;
}

/** edge → cloud：通知首页各类未读快照（喂给分诊）。计数 >0 即该类有未读。 */
export interface NotificationHomePayload {
  comments: number;
  likes: number;
  follows: number;
  epoch?: number;
}

/** cloud → edge：进「评论和@」+ 滚动加载 + 抽取（→ notification.items）。 */
export interface NotificationBrowseCommentsPayload {
  thinkMs?: number;
  /** 最多滚动加载次数（由 Cloud 控制） */
  scrollMax?: number;
}

/** cloud → edge：进「赞和收藏」（v1 看一眼清未读，不抽取）。 */
export interface NotificationBrowseLikesPayload {
  thinkMs?: number;
}

/** cloud → edge：进「新增关注」（v1 看一眼清未读，不抽取）。 */
export interface NotificationBrowseFollowsPayload {
  thinkMs?: number;
}

/** cloud → edge：返回通知首页（落地后重报 notification.home）。 */
export interface NotificationBackHomePayload {
  thinkMs?: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

/** payload 类型映射（便于类型安全地构造/解析） */
export interface PayloadMap {
  hello: HelloPayload;
  welcome: WelcomePayload;
  'ui.snapshot': UiSnapshotPayload;
  'plan.request': PlanRequestPayload;
  'plan.response': PlanResponsePayload;
  'select.request': SelectRequestPayload;
  'select.response': SelectResponsePayload;
  'anchor.get': AnchorGetPayload;
  'anchor.get.result': AnchorGetResultPayload;
  'anchor.report': AnchorReportPayload;
  'action.result': ActionResultPayload;
  'note.content': NoteContentPayload;
  'note.ack': NoteAckPayload;
  'browse.next': BrowseNextPayload;
  'browse.scroll': BrowseScrollPayload;
  'note.open': NoteOpenPayload;
  'note.close': NoteClosePayload;
  'search.execute': SearchExecutePayload;
  'session.end': SessionEndPayload;
  'publish.approval_request': PublishApprovalRequestPayload;
  'session.budget.request': SessionBudgetRequestPayload;
  'session.budget': SessionBudgetPayload;
  'risk.canDo': RiskCanDoPayload;
  'risk.canDo.result': RiskCanDoResultPayload;
  'risk.record': RiskRecordPayload;
  'risk.record.result': RiskRecordResultPayload;
  'risk.captcha_detected': CaptchaDetectedPayload;
  'risk.captcha_cleared': CaptchaClearedPayload;
  'publish.request': PublishRequestPayload;
  'publish.result': PublishResultPayload;
  'publish.command': PublishCommandPayload;
  'publish.command.result': PublishCommandResultPayload;
  // 角色驱动指令
  'page.scroll': PageScrollPayload;
  'interaction.like': InteractionLikePayload;
  'interaction.collect': InteractionCollectPayload;
  'interaction.follow': InteractionFollowPayload;
  'interaction.comment': InteractionCommentPayload;
  'interaction.like_comment': InteractionLikeCommentPayload;
  'navigation.back': NavigationBackPayload;
  'note.browse_images': NoteBrowseImagesPayload;
  'note.scroll_comments': NoteScrollCommentsPayload;
  'profile.open': ProfileOpenPayload;
  // Edge 上报
  'page.cards': PageCardsPayload;
  'note.detail': NoteDetailPayload;
  'profile.detail': ProfileDetailPayload;
  'action.completed': ActionCompletedPayload;
  'notification.open': NotificationOpenPayload;
  'notification.browse_comments': NotificationBrowseCommentsPayload;
  'notification.browse_likes': NotificationBrowseLikesPayload;
  'notification.browse_follows': NotificationBrowseFollowsPayload;
  'notification.back_home': NotificationBackHomePayload;
  'notification.detected': NotificationDetectedPayload;
  'notification.home': NotificationHomePayload;
  'notification.items': NotificationItemsPayload;
  error: ErrorPayload;
  ping: Record<string, never>;
  pong: Record<string, never>;
}

/** 构造一个信封（ts 由调用方注入，避免在库内部读时钟便于测试） */
export function makeEnvelope<K extends MessageType>(
  type: K,
  id: string,
  ts: number,
  payload: K extends keyof PayloadMap ? PayloadMap[K] : unknown,
): Envelope {
  return { v: PROTOCOL_VERSION, type, id, ts, payload };
}

/** 运行时校验一个对象是否为合法信封 */
export function isEnvelope(x: unknown): x is Envelope {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.v === 'number' &&
    typeof e.type === 'string' &&
    typeof e.id === 'string' &&
    typeof e.ts === 'number' &&
    'payload' in e
  );
}

/** 安全解析一帧 JSON 文本为信封；失败返回 null */
export function parseEnvelope(data: string): Envelope | null {
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  return isEnvelope(obj) ? obj : null;
}
