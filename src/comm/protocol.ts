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
  // —— 验证码远程协助（captcha 暂停期间唯一允许穿透的恢复指令）——
  | 'captcha.assist.capture' // cloud → edge：请求原浏览器会话捕获当前验证码现场截图
  | 'captcha.assist.snapshot' // edge → cloud：返回验证码现场截图和坐标映射
  | 'captcha.assist.click' // cloud → edge：把人工点位派发到原浏览器会话
  | 'captcha.assist.click_result' // edge → cloud：返回点击后的 fresh 复检结果
  // —— Edge 页面写任务租约（同一 edge/CDP 单写）——
  | 'edge.task.acquire' // cloud → edge：申请任务级执行权；edge quiesced 后才确认
  | 'edge.task.acquired' // edge → cloud：执行权已授予，浏览已到命令安全边界
  | 'edge.task.release' // cloud → edge：释放任务级执行权
  | 'edge.task.released' // edge → cloud：释放已收敛
  // —— 发布编排（Publish Agent 驱动）——
  | 'publish.approval_request' // edge → cloud：请求发送发布审批卡片
  | 'publish.approval_action' // edge → cloud：客户端预览内提交发布/取消审批
  | 'publish.approval_action.result' // cloud → edge：返回审批动作受理结果
  | 'publish.draft_image_remove' // edge → cloud：客户端预览内删除待审稿件的某张配图
  | 'publish.draft_image_remove.result' // cloud → edge：返回删配图结果（含写后真态）
  | 'publish.request' // cloud → edge：请求在浏览器中发布一篇帖子（v1 整页路径，地基阶段并行保留）
  | 'publish.result' // edge → cloud：发布结果回传（v1 整页路径）
  | 'publish.command' // cloud → edge：下发一条参数化发布原子指令（A 阶段1 指令驱动路径）
  | 'publish.command.result' // edge → cloud：回传单条发布指令的执行结果
  // —— 角色驱动指令（cloud → edge，RoleDispatcher 驱动）——
  | 'page.scroll'          // 页面滚动
  | 'feed.refresh'         // 主 feed 深度到阈值后点右下「刷新」回顶换新批（cloud → edge）
  | 'pacing.update'        // 会话中途风控档位变化推送新 tempo（cloud → edge，pacing-fallback-hardening）
  | 'interaction.like'     // 点赞
  | 'interaction.collect'  // 收藏
  | 'interaction.follow'   // 关注
  | 'interaction.comment'  // 发评论（浏览闭环写互动）
  | 'interaction.like_comment' // 给「别人的某条评论」点赞（详情页拟人微互动）
  | 'group.join'           // Facebook 加群原子指令（独立 join 能力，绝不走 browse）
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
  // —— Persona 生成（edge → cloud 请求 / cloud → edge 响应，建号关键词驱动，客户自助 onboarding）——
  | 'persona.generate'        // edge → cloud：按关键词选择请求生成 persona
  | 'persona.generate.result' // cloud → edge：返回 soul.yaml/身份摘要或失败原因
  | 'persona.persist'         // edge → cloud：请求持久化确认后的 soul.yaml
  | 'persona.persist.result'  // cloud → edge：持久化结果
  // —— 入站互动管理（视频号 v1；双方确认 interaction_inbox_v1 后启用）——
  | 'interaction.auth.status' // edge → cloud：auth/browser/capability/identity 真态
  | 'interaction.sync.batch' // edge → cloud：可重放的增量同步批次
  | 'interaction.sync.ack' // cloud → edge：整批 accepted/duplicate/rejected
  | 'interaction.reply.result' // edge → cloud：confirmed/failed/ambiguous 发送真态
  | 'interaction.reply.result.ack' // cloud → edge：持久结果确认；ack 后才清 Edge outbox
  | 'interaction.reply.reconcile' // cloud → edge：只核验既有 attempt，绝不发起新平台写
  | 'interaction.reply.reconcile.result' // edge → cloud：重放/缺失/绑定冲突观察
  | 'interaction.sync.request' // cloud → edge：触发按 channel/scope 同步
  | 'interaction.reply.send' // cloud → edge：带稳定幂等键的文本回复
  | 'interaction.auth.reopen' // cloud → edge：请求原环境重开登录 sidecar
  | 'interaction.browser.control' // cloud → edge：授权有效时打开可见 sidecar / 转回 API-only
  | 'interaction.runtime.controls' // cloud → edge：按账号下发版本化有效能力
  | 'interaction.offboard.command' // cloud → edge：撤权后清理所属加密会话
  | 'interaction.offboard.result' // edge → cloud：可重放的凭证清理结果
  | 'interaction.offboard.ack' // cloud → edge：结果持久化确认；ack 后清 Edge outbox
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
  /** 运行时平台标识（如 "xiaohongshu"）；缺省按历史 xhs 处理 */
  platform?: string;
  /** 业务/站点标识（如 "xhs"） */
  app?: string;
  /** 边缘端能力声明 */
  capabilities?: string[];
  /** 该边缘当前驱动的账号标识（用于风控归属与验证码事件定位；缺省视为默认账号） */
  accountId?: string;
  /** 该账号的可读昵称；仅作展示补充，不参与身份确立或路由 */
  accountNickname?: string;
  /** 人类可读的机器标签（如 "win-aliyun-3"），验证码卡片据此告诉运维去哪台机器处置 */
  machineLabel?: string;
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
 * （旧端忽略）；缺失 / 某字段缺失时边缘逐字段回落内置非零默认，绝不零延迟。
 * 握手期采一次即固定；会话中途风控档位变化经独立 `pacing.update`（PacingUpdatePayload）实时补推。
 */
export interface PacingSnapshotPayload {
  /** 风控档全局节奏乘子（normal=1.0 / warned=1.3 / restricted=1.6），边缘乘算 */
  tempo: number;
  /** 每类操作兜底 floor 默认区间（已含 clamp 护栏、非零）；逐字段可缺、边缘逐项回落内置默认 */
  opFloorsMs: Partial<Record<PacingOp, PacingFloorPayload>>;
}

/**
 * 中途风控档位刷新（cloud → edge，change pacing-fallback-hardening）。会话稳定连接期间风控状态
 * 迁移导致 tempo 变化时，云端在统一命令出口去抖推送一次；边缘据此更新兜底节奏所用 tempo，
 * **不重置最小间隔锚点**（中途刷新 ≠ 重连）。可选、向后兼容（旧端忽略即用握手 tempo）。
 */
export interface PacingUpdatePayload {
  /** 新的风控档全局节奏乘子（normal=1.0 / warned=1.3 / restricted=1.6），边缘乘算 */
  tempo: number;
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
  /** Optional negotiated capabilities; old Cloud peers omit this field. */
  capabilities?: string[];
  /** Account-bound recovery barrier; missing is fail-closed when offboarding was negotiated. */
  interactionRecovery?: { offboardPending: boolean };
  /** Negotiated account-scoped effective controls; missing remains fail-closed. */
  interactionRuntime?: InteractionRuntimeControlsPayload;
}

// ————————————————— 视频号入站互动 v1（Session 00 frozen contract）—————————————————

export const INTERACTION_INBOX_CAPABILITY = 'interaction_inbox_v1' as const;
export const INTERACTION_REPLY_RECOVERY_CAPABILITY = 'interaction_reply_recovery_v1' as const;
export const INTERACTION_OFFBOARDING_CAPABILITY = 'interaction_offboarding_v1' as const;
export const INTERACTION_RUNTIME_CONTROLS_CAPABILITY = 'interaction_runtime_controls_v1' as const;
export const INTERACTION_BROWSER_CONTROL_CAPABILITY = 'interaction_browser_control_v1' as const;
export const INTERACTION_TEST_DATA_RESET_CAPABILITY = 'interaction_test_data_reset_v1' as const;
export type InteractionPlatform = 'wechat_channels';
export type InteractionChannel = 'comment' | 'dm';
export type InteractionMessageType = 'text' | 'image' | 'unknown';
export type InteractionMessageLifecycle = 'active' | 'deleted' | 'hidden';
export interface InteractionRuntimeControlsPayload {
  accountId: string;
  envKey: string;
  version: number;
  commentsReadEnabled: boolean;
  commentsReplyEnabled: boolean;
  dmReadEnabled: boolean;
  dmSendTextEnabled: boolean;
  dmSendImageEnabled: false;
}
export type InteractionAuthStatus =
  | 'login_required'
  | 'authenticating'
  | 'active'
  | 'reauth_required'
  | 'challenge_required'
  | 'degraded'
  | 'disabled';
export type InteractionBrowserState = 'closed' | 'opening' | 'open' | 'closing' | 'unavailable';
export type InteractionErrorCode =
  | 'INTERACTION_AUTH_REQUIRED'
  | 'INTERACTION_PERMISSION_DENIED'
  | 'INTERACTION_NOT_FOUND'
  | 'INTERACTION_SCOPE_MISMATCH'
  | 'INTERACTION_VERSION_CONFLICT'
  | 'INTERACTION_STATE_CONFLICT'
  | 'INTERACTION_VALIDATION_FAILED'
  | 'INTERACTION_CONFIG_MISSING'
  | 'INTERACTION_APPROVAL_REQUIRED'
  | 'INTERACTION_SEND_AMBIGUOUS'
  | 'INTERACTION_UNSUPPORTED_MESSAGE_TYPE'
  | 'INTERACTION_FEATURE_DISABLED'
  | 'INTERACTION_RATE_LIMITED'
  | 'INTERACTION_UPSTREAM_UNAVAILABLE'
  | 'INTERACTION_TEST_RESET_PARTIAL'
  | 'INTERACTION_INTERNAL_ERROR'
  | 'WECHAT_AUTH_REQUIRED'
  | 'WECHAT_CHALLENGE_REQUIRED'
  | 'WECHAT_IDENTITY_MISMATCH'
  | 'WECHAT_RATE_LIMITED'
  | 'WECHAT_PERMISSION_DENIED'
  | 'WECHAT_SCHEMA_CHANGED';
export type InteractionAuthReasonCode =
  | 'WECHAT_AUTH_REQUIRED'
  | 'WECHAT_CHALLENGE_REQUIRED'
  | 'WECHAT_IDENTITY_MISMATCH'
  | 'WECHAT_RATE_LIMITED'
  | 'WECHAT_PERMISSION_DENIED'
  | 'WECHAT_SCHEMA_CHANGED'
  | 'INTERACTION_FEATURE_DISABLED'
  | 'INTERACTION_UPSTREAM_UNAVAILABLE';

export interface InteractionEffectiveCapabilities {
  commentsRead: boolean;
  commentsReply: boolean;
  dmRead: boolean;
  dmSendText: boolean;
  dmSendImage: false;
}

export interface InteractionIdentitySummary {
  externalId: string;
  displayName: string;
  identityHash: string;
}

export interface InteractionAuthStatusPayload {
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  status: InteractionAuthStatus;
  browserState: InteractionBrowserState;
  capabilities: InteractionEffectiveCapabilities;
  /** Latest account-control version accepted by this Edge, or null before negotiation/application. */
  runtimeControlsVersion: number | null;
  identity: InteractionIdentitySummary | null;
  checkedAt: number;
  reasonCode: InteractionAuthReasonCode | null;
}

export interface InteractionParticipantSnapshot {
  externalId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface InteractionAttachmentMeta {
  mimeType: string | null;
  width: number | null;
  height: number | null;
  url: string | null;
}

export interface InteractionSyncThread {
  externalThreadId: string;
  sourceExternalId: string | null;
  sourceTitle: string | null;
  sourceCoverUrl: string | null;
  participant: InteractionParticipantSnapshot | null;
  updatedAt: number;
}

export interface InteractionSyncMessage {
  externalThreadId: string;
  externalMessageId: string;
  direction: 'inbound' | 'outbound';
  externalParentId: string | null;
  externalRootId: string | null;
  messageType: InteractionMessageType;
  contentText: string | null;
  attachmentMeta: InteractionAttachmentMeta | null;
  lifecycle: InteractionMessageLifecycle;
  platformCreatedAt: number;
  rawMetaSanitized: Record<string, string | number | boolean | null>;
}

export interface InteractionSyncBatchPayload {
  batchId: string;
  requestId: string | null;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  channel: InteractionChannel;
  scopeExternalId: string | null;
  cursorBefore: string | null;
  cursorAfter: string | null;
  hasMore: boolean;
  threads: InteractionSyncThread[];
  messages: InteractionSyncMessage[];
  observedAt: number;
}

export interface InteractionSyncAckPayload {
  batchId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  channel: InteractionChannel;
  scopeExternalId: string | null;
  status: 'accepted' | 'duplicate' | 'rejected';
  cursorAfter: string | null;
  persisted: { threads: number; messages: number };
  errorCode: InteractionErrorCode | null;
  receivedAt: number;
}

export interface InteractionSyncRequestPayload {
  requestId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  channel: InteractionChannel;
  scopeExternalId: string | null;
  reason: 'user_requested' | 'resume' | 'scheduled' | 'recovery' | 'test_reset';
  requestedAt: number;
}

export interface InteractionReplyTarget {
  threadExternalId: string;
  inboundMessageExternalId: string;
  parentExternalId: string | null;
}

export interface InteractionReplySendPayload {
  jobId: string;
  attemptId: string;
  idempotencyKey: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  channel: InteractionChannel;
  target: InteractionReplyTarget;
  content: { type: 'text'; text: string };
  expiresAt: number;
}

export type InteractionReplyErrorCategory =
  | 'auth_expired'
  | 'challenge_required'
  | 'identity_mismatch'
  | 'rate_limited'
  | 'permission_denied'
  | 'schema_changed'
  | 'transient_network'
  | 'unsupported_message_type'
  | 'invalid_scope'
  | 'invalid_command'
  | 'expired_command'
  | 'platform_rejected'
  | 'verification_failed'
  | 'internal_error';

export interface InteractionReplyResultPayload {
  jobId: string;
  attemptId: string;
  idempotencyKey: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  channel: InteractionChannel;
  status: 'confirmed' | 'failed' | 'ambiguous';
  externalMessageId: string | null;
  errorCategory: InteractionReplyErrorCategory | null;
  errorCode: InteractionErrorCode | null;
  verification: 'platform_ack' | 'history_lookup' | 'comment_lookup' | 'not_verified';
  retryAfterMs: number | null;
  finishedAt: number;
}

export interface InteractionReplyResultAckPayload {
  jobId: string;
  attemptId: string;
  idempotencyKey: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  status: 'accepted' | 'duplicate' | 'rejected';
  errorCode: InteractionErrorCode | null;
  receivedAt: number;
}

export interface InteractionReplyReconcilePayload {
  reconcileId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  attempts: Array<{
    cloudStatus: 'created' | 'dispatched' | 'ambiguous';
    command: InteractionReplySendPayload;
  }>;
  requestedAt: number;
}

export interface InteractionReplyReconcileResultPayload {
  reconcileId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  attempts: Array<{
    jobId: string;
    attemptId: string;
    idempotencyKey: string;
    state: 'result_replayed' | 'not_found' | 'binding_conflict';
    observedAt: number;
  }>;
  finishedAt: number;
}

export type InteractionOffboardReason = 'environment_unbind' | 'customer_terminated' | 'admin_revoked';

export interface InteractionOffboardCommandPayload {
  offboardId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  reason: InteractionOffboardReason;
  requestedAt: number;
  expiresAt: number;
}

export interface InteractionOffboardResultPayload {
  offboardId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  status: 'cleared' | 'already_cleared' | 'failed';
  errorCode: InteractionErrorCode | null;
  finishedAt: number;
}

export interface InteractionOffboardAckPayload {
  offboardId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  status: 'accepted' | 'duplicate' | 'rejected';
  errorCode: InteractionErrorCode | null;
  receivedAt: number;
}

export interface InteractionAuthReopenPayload {
  requestId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  reason: 'user_requested' | 'auth_expired' | 'identity_mismatch' | 'challenge_required';
  requestedAt: number;
}

export interface InteractionBrowserControlPayload {
  requestId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  action: 'open' | 'close';
  requestedAt: number;
}

/**
 * 陪伴界面数据快照（cloud → edge 主动推送，change edge-companion-ui 8.1）。
 * 发送时机：① 边缘 hello 注册完成后回填全量快照；② 发布审批生命周期变化时增量推送。
 * 红线：字段全部可选、缺失=云端无该数据；边缘 MUST NOT 以占位/猜测补全（宁缺毋假）。
 */
/**
 * 客户端指标键的**单一来源**（change platform-honest-usage-metrics）：联集从本数组派生，消费方
 * （server.ts 的 pickDailyUsageCounts / quotaSaturation）直接 import 本数组，不再各自手写一份清单。
 *
 * 键名与风控动作名（RISK_ACTIONS）**逐字同名**，故 `pickDailyUsageCounts(riskTotals)` 可直读、零映射。
 * 起短别名（如 join）就要一张裸 string 对裸 string 的 UI↔风控映射表——`action.completed.action` 已经
 * 用两侧各 21 条这样的映射证明过：那种表 typecheck 一声不吭，回错名不报错，只是角色永远等不到回执。
 *
 * ⚠️ 本联集的漂移 **`Record<MessageType,true>` 那道穷举抓不到**（它只穷举消息类型，本类型是载荷字段）。
 * 两份 protocol.ts 仍靠 CLAUDE.md §2 的逐字一致纪律；edge 的 main.cjs 是纯 JS、另有一份手写数组，
 * 靠 test/electron 的穿透断言钉住——漏加键的症状是「云端发了、界面不显示、没有任何报错」。
 */
export const UI_DAILY_USAGE_ACTIONS = [
  'view',
  'like',
  'collect',
  'comment',
  'follow',
  'publish',
  'join_group',
] as const;
export type UiDailyUsageAction = (typeof UI_DAILY_USAGE_ACTIONS)[number];
export type UiDailyUsageCounts = Partial<Record<UiDailyUsageAction, number>>;
export type UiDailyUsageWindow = 'session' | 'minute' | 'hour' | 'day';

export interface UiDailyUsageInspirationSummary {
  /** Count of account-scoped notes saved into the curated inspiration pool. */
  count: number;
  /** Sum of source-note likes for the saved inspirations, when observed by cloud. */
  sourceLikeCount?: number;
}

export interface UiDailyUsageWindowStatus {
  active?: boolean;
  startedAt?: number;
  windowMs?: number;
  expiresAt?: number;
  refreshAt?: number;
  releaseAt?: number;
  totals: UiDailyUsageCounts;
  quotas?: UiDailyUsageCounts;
  saturated?: UiDailyUsageAction[];
}

export interface UiDailyUsagePayload {
  /** Epoch ms when cloud assembled the account daily usage projection. */
  asOf: number;
  quotaLevel?: 'conservative' | 'normal' | 'aggressive';
  /** Backward-compatible alias for the day window totals. */
  totals: UiDailyUsageCounts;
  /** Backward-compatible alias for the day window quotas. */
  quotas?: UiDailyUsageCounts;
  /** Backward-compatible alias for the day window saturated actions. */
  saturated?: UiDailyUsageAction[];
  /** Optional curated inspiration result summary for value-oriented completion UI. */
  inspirationSummary?: UiDailyUsageInspirationSummary;
  /**
   * First-persona onboarding projection. Present only while the lifetime first-post
   * flow is searching/generating; `target=20` is UI expectation, never a quota.
   */
  firstPost?: {
    state: 'searching' | 'generating';
    viewed: number;
    target: 20;
    startedAt: number;
    sourceId?: string;
  };
  /**
   * 环境级慢启动投影（change environment-level-slow-start）。**字段缺省 = 未知（云端还没说）→ 整行不渲染**，
   * 照 personaBound 的三态判例：MUST NOT 把「未知」当「关」。
   *
   * `binding` 只在 active 时有意义：慢启动语义是 min(曲线, 档位)，而曲线写死、档位数字面板可热编辑，
   * 两者之间没有任何不变量保证曲线更紧 → 勾了却一格都没压是**真实可达**的状态。
   * binding=false MUST 如实标注「当前档位已更严，不额外限制」，MUST NOT 宣称「正在压低配额」。
   *
   * `eligible=false` 通常禁用；binding_unknown/binding_conflict 时环境配置仍可操作，
   * state 表达配置真态，客户端不得声称配额已经作用到账号。
   */
  slowStart?: UiSlowStartPayload;
  windows?: Partial<Record<UiDailyUsageWindow, UiDailyUsageWindowStatus>>;
}

/** 环境级慢启动状态：有唯一当前账号时与 clamp 同源，未绑定时只表达环境配置。 */
export interface UiSlowStartPayload {
  /** off = 未开启；active = 爬坡中；graduated = 已完成（上限已放开，但库里开关仍为真）。 */
  state: 'off' | 'active' | 'graduated';
  /** active 时 1..7。 */
  day?: number;
  /** 曲线总天数（恒 7）。 */
  totalDays: number;
  /** 起点（epoch ms，已对齐上海日起点）。 */
  since?: number;
  /** active 时：clamp 是否至少收紧一项。false = 勾了但当前档位已更严、不额外限制。 */
  binding?: boolean;
  /** 当前环境设置是否正作用到唯一账号；绑定缺失/冲突时设置仍可操作。 */
  eligible: boolean;
  ineligibleReason?:
    | 'platform_unsupported'
    | 'platform_unknown'
    | 'globally_disabled'
    | 'binding_unknown'
    | 'binding_conflict';
}

export interface UiBrowserStandbyPayload {
  /** Cloud-side switch after env/config resolution. */
  enabled: boolean;
  /** True only when the wait is deterministic, finite, and long enough for cold standby. */
  eligible: boolean;
  /** Machine-readable reason such as disabled/no_wait/short_wait/view_quota:hour. */
  reason: string;
  /** Milliseconds from generatedAt to the next forecasted eligible browser action. */
  waitMs: number;
  /** Epoch ms when cloud expects browser work to be eligible again. */
  wakeAt: number;
  /** Epoch ms used for the forecast calculation. */
  generatedAt: number;
  /** Deterministic source that produced this hint. */
  source: 'risk' | 'session';
  /** Cloud threshold used to decide eligibility. */
  minWaitMs: number;
  /** Suggested edge warmup before wakeAt. */
  warmupMs: number;
}

export interface UiSnapshotPayload {
  /** 账号身份；nickname 为云端账号主数据里的小红书真实昵称（accounts.nickname），空/缺失时边缘不得转发 identity 事件 */
  account?: { id: string; nickname?: string };
  /** 最近一次成功发布的摘要；at = epoch ms（来源 publish_log.published_at，为草稿入库时间近似） */
  lastPublish?: { title: string; at: number };
  /** 当前待审稿件的只读预览；正文/配图来自云端 publish_log，不含原稿来源字段。 */
  publishPreview?: UiPublishPreviewPayload;
  /**
   * 发布审批状态。云端只推边缘看不到的状态（pending/approved/submitted/rejected/failed）；
   * published 由边缘在同页取得帖子 ID 后自知、不经此通道；reminded 仅在真的再次提醒后才推——
   * 云端当前无再提醒机制，故此值现阶段不会出现（枚举保留，绝不谎称已提醒）。
   */
  publish?: {
    state: 'pending' | 'reminded' | 'approved' | 'submitted' | 'published' | 'rejected' | 'failed';
    title?: string;
    /** 界面「编号」对暗号用，与飞书审批卡「编号」字段一致（取发布记录 id，如 "#83"） */
    code?: string;
  };
  /** Account-scoped today usage and optional current daily quota context for the companion UI. */
  dailyUsage?: UiDailyUsagePayload;
  /** Optional long-wait browser cold-standby hint; old edges ignore this field. */
  browserStandby?: UiBrowserStandbyPayload;
  /**
   * 该账号是否已绑人设（云端 isPersonaBound 为权威判据）。**三态语义**（change persona-bound-tristate）：
   *   true    = 云端确认已绑；false = 云端确认未绑；**字段缺省 = 未知（云端还没说）**。
   * 云端是人设状态的唯一权威写方，故 true / false **都下发**；边缘 MUST NOT 把「未知」当「未绑」——
   * 弹人设向导只能由权威的 false 触发，绝不能由「等了一会儿还没收到」触发。
   * 旧契约（仅 true 时下发）把「云端说没有」与「云端还没说」压成同一个值，导致已设置人设的账号被反复误弹。
  */
  personaBound?: boolean;
  /**
   * Facebook 人设公开写作语言：字符串=Cloud 已确认值；null=已绑定存量人设缺字段；
   * 字段缺省=Cloud 尚未投影该事实。非 Facebook 环境不消费。
   */
  personaWritingLanguage?: PersonaWritingLanguage | null;
}

/** 陪伴客户端展示用的稿件快照；审批状态仍由同包内的 publish 字段单独表达。 */
export interface UiPublishPreviewPayload {
  recordId: number;
  code: string;
  kind: 'rewrite' | 'generated';
  title: string;
  content: string;
  topics: string[];
  images: string[];
  contentVersion: number;
  updatedAt: number;
  imageReferenceAudit?: {
    requestedCount: number;
    usableCount: number;
    status: 'none' | 'used' | 'unsupported' | 'unavailable' | 'skipped';
    generatedCount: number;
  };
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
  /** 独占评论任务的租约所有者；普通浏览省略。 */
  taskId?: string;
  noteId?: string;
  index?: number;
  reason?: string;
  /**
   * 直接打开的完整目标链接（change facebook-scheduled-comment，可选）。非空时边缘按此 permalink 直驱打开
   * （Facebook 定向评论：候选帖 permalink 直达详情页），不再依赖 feed 卡片索引/noteId 定位。
   * 缺省 = 走原有 index/noteId 卡片定位（小红书浏览闭环旧行为，向后兼容）。
   */
  url?: string;
  /**
   * 浏览读取所在界面（change platform-browse-protocol，可选）。'detail'=导航进详情页读取（今天默认）；
   * 'feed'=在信息流就地展开读取、不离开列表（Facebook 就地浏览，旗标+能力 gated）。缺省='detail'⇒逐位等价。
   */
  surface?: 'feed' | 'detail';
  /**
   * 打开目的（change platform-browse-protocol，可选）。'read'=打开并上报 note.detail（今天默认）；
   * 'navigate'=只把浏览器带到该详情页供后续评论迁移，MUST NOT 上报 note.detail（避免用 0 覆盖真实反应数），
   * 只回 action.completed{ok, observation, noteId}。缺省='read'。
   */
  purpose?: 'read' | 'navigate';
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
  /** 独占评论/维护任务的租约所有者；普通浏览省略。 */
  taskId?: string;
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
  /**
   * 站内搜索容器（change facebook-scheduled-comment，可选）。非空时边缘只在该容器内搜索，绝不全站搜。
   * Facebook 定向评论：容器为运营方自己的 / 已加入的主页或群的完整链接（`https://www.facebook.com/...`）；
   * 边缘先校验其为白名单内的合法 Facebook 链接，非法/非成员则 honest `permission_gated`、绝不回退全站。
   * 缺省 = 无容器约束（小红书全站搜索旧行为，向后兼容）。
   */
  container?: string;
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

/** 客户端稿件预览内提交审批动作（edge → cloud）。 */
export interface PublishApprovalActionPayload {
  requestId: string;
  approved: boolean;
  /** 客户端所见的稿件版本；云端写审批信号前再次比对，守住“审=发”。 */
  contentVersion?: number;
  /** 批准时可选发布方式；缺省表示旧客户端沿用稿件当前计划。取消动作不得携带。 */
  publishMode?: 'immediate' | 'scheduled';
  /** scheduled=北京时间目标 epoch ms；immediate 必须为 null。 */
  publishTime?: number | null;
}

/** 客户端审批动作结果（cloud → edge）。 */
export interface PublishApprovalActionResultPayload {
  requestId: string;
  ok: boolean;
  state?: 'approved' | 'rejected';
  alreadyDecided?: boolean;
  reason?: string;
  currentVersion?: number;
}

/**
 * 客户端稿件预览内删除待审稿件的某张配图（edge → cloud）。
 * 只表达“删这一张”的意图：保留子集由云端在库内真态上算出，绝不采信客户端提交的列表。
 */
export interface PublishDraftImageRemovePayload {
  requestId: string;
  /** 客户端所见的稿件版本；云端落库前比对，守住“审=发”。 */
  contentVersion: number;
  /** 待删的那张配图 URL；MUST 是该稿当前 images 的成员（只删不注入）。 */
  imageUrl: string;
}

/** 客户端删配图结果（cloud → edge）。ok:true 仅代表“该配图已从待审稿件移除”，不代表已发布。 */
export interface PublishDraftImageRemoveResultPayload {
  requestId: string;
  ok: boolean;
  /** 成功：写后回读的真态配图（保序）。 */
  images?: string[];
  /** 成功：自增后的稿件版本。 */
  contentVersion?: number;
  /** 失败：可区分拒因（invalid_request/account_unavailable/not_found/account_mismatch/already_decided/not_pending/version_stale/image_not_found/last_image/unavailable）。 */
  reason?: string;
  /** version_stale 时回带库内活版本。 */
  currentVersion?: number;
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
  // 注：曾有极薄节奏默认块 `pacing?: PacingDefaultsPayload`（tempo + dwellFloorMs），供边缘自主动作 /
  // 断连兜底用。实为双死通道（边缘从不请求 session.budget、也从不消费该字段），已于 change
  // pacing-fallback-hardening 从协议移除；兜底默认唯一下发路径为 welcome 快照（PacingSnapshotPayload）。
}

export interface RiskCanDoPayload {
  action: 'view' | 'like' | 'collect' | 'comment' | 'follow' | 'publish' | 'comment_like' | 'join_group';
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
 * Persona 生成（建号关键词驱动，客户自助 onboarding）。
 * edge → cloud：按客户勾选的关键词请求云端生成账号 persona（soul.yaml + 身份摘要）。
 * 安全：云端以握手绑定的 session.accountId 为准，不信任本载荷自报的 accountId。
 */
export type PersonaWritingLanguage = 'zh-CN' | 'en' | 'vi';

export interface PersonaGeneratePayload {
  accountId: string;
  /** 建号流程勾选的关键词集合（供 persona 生成种子化） */
  keywordSelections: string[];
  /** Facebook-only 账号公开写作语言；Cloud 按握手确认的平台校验。 */
  writingLanguage?: PersonaWritingLanguage;
  /** 幂等键：同 key 重复请求云端只生成一次、复用结果，防重连/重试重复扣费 */
  idempotencyKey: string;
}

/**
 * cloud → edge：persona 生成结果。
 * ok=false 时带 reason，MUST NOT 返回半成品/占位 soul.yaml（宁缺毋假、fail-closed）。
 */
export interface PersonaGenerateResultPayload {
  ok: boolean;
  /** 生成的 soul.yaml 全文（仅 ok 时存在）；失败置空，绝不占位冒充 */
  soulYaml?: string;
  /** 身份摘要（供边缘展示确认；仅 ok 时存在） */
  identitySummary?: string;
  /** 失败原因（ok=false 时存在，如 generation_failed / persona_invalid） */
  reason?: string;
}

/** edge → cloud：请求持久化客户确认后的 soul.yaml（走云端现有校验写入通道）。 */
export interface PersonaPersistPayload {
  accountId: string;
  soulYaml: string;
}

/** cloud → edge：持久化结果；失败带 reason（如 unknown_account / persona_required / persona_invalid）。 */
export interface PersonaPersistResultPayload {
  ok: boolean;
  reason?: string;
  /** true only when this persist created the account's lifetime first-post onboarding row. */
  firstPostOnboarding?: boolean;
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

export interface CaptchaAssistCapturePayload {
  /** Cloud-side incident id. Edge treats it as an opaque correlation id. */
  incidentId: string;
  /** Optional reason for observability: initial page load, manual refresh, retry after still_blocked. */
  reason?: 'initial' | 'refresh' | 'retry';
  requestedAt?: number;
  /** Best-effort screenshot bounds requested by cloud; edge may clamp further. */
  maxImageWidth?: number;
  maxImageHeight?: number;
  quality?: number;
  /**
   * Live capture mode (change captcha-assist-live-snapshot). When present, edge runs a
   * bounded, content-deduped, self-terminating capture loop and pushes a fresh
   * `captcha.assist.snapshot` only when the challenge image changes — so the console shows
   * a near-live challenge for self-refreshing / multi-step point-select captchas. Absent =
   * today's single-shot capture (zero regression). Edge clamps every value to a safe band.
   */
  live?: {
    /** Tick cadence hint in ms; edge clamps (e.g. 600..2000). */
    intervalMs?: number;
    /** Hard upper bound on total loop wall time in ms; edge clamps. */
    maxDurationMs?: number;
    /** Hard upper bound on tick count (iteration-bounded self-termination). */
    maxFrames?: number;
  };
}

export interface CaptchaAssistViewportPayload {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface CaptchaAssistCropPayload {
  /** CSS-pixel crop rectangle in the current browser viewport. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptchaAssistImagePayload {
  mime: 'image/png' | 'image/jpeg';
  /** Base64 encoded image bytes. Must be short-lived and never logged. */
  data: string;
  width: number;
  height: number;
}

export interface CaptchaAssistSnapshotPayload {
  incidentId: string;
  edgeId?: string;
  accountId?: string;
  snapshotId: string;
  capturedAt: number;
  expiresAt?: number;
  kind: 'captcha' | 'unknown';
  url?: string;
  viewport: CaptchaAssistViewportPayload;
  crop: CaptchaAssistCropPayload;
  image: CaptchaAssistImagePayload;
  /** Fresh overlay metadata captured with the screenshot. */
  overlay?: BlockingOverlaySnapshotPayload;
}

export interface CaptchaAssistClickPointPayload {
  /** Normalized x coordinate relative to the displayed snapshot image, [0, 1]. */
  x: number;
  /** Normalized y coordinate relative to the displayed snapshot image, [0, 1]. */
  y: number;
  label?: string;
}

/**
 * Operator mouse trajectory sample (change captcha-assist-trajectory-replay).
 * Normalized to the displayed snapshot image (same basis as click points).
 */
export interface CaptchaAssistTrajectorySamplePayload {
  /** Normalized x on the displayed snapshot image, [0, 1]. */
  x: number;
  /** Normalized y, [0, 1]. */
  y: number;
  /** Milliseconds relative to the first sample (monotonic non-decreasing). */
  t: number;
}
/**
 * Captured operator trajectory to replay in the original browser
 * (change captcha-assist-trajectory-replay). Points remain authoritative for WHERE the
 * press lands; the trajectory only contributes HOW the cursor moved and WHEN it pressed.
 */
export interface CaptchaAssistTrajectoryPayload {
  /** Schema version. */
  v: 1;
  /** Pointermove samples in time order. */
  samples: CaptchaAssistTrajectorySamplePayload[];
  /** For each points[i], the sample index at which that point was pressed. length === points.length. */
  clicks: number[];
}
/**
 * Focus classification carried back in the type report (change captcha-assist-text-answer).
 * `editable` = INPUT/TEXTAREA/contentEditable that can be cleared + read back (strongest proof);
 * `opaque` = any other element holding focus (iframe / canvas / tabindex container — typed but
 * unverifiable); `none` = no focus landed (structural failure ⇒ no_target, zero dispatch).
 */
export type CaptchaAssistFocusTier = 'editable' | 'opaque' | 'none';

/**
 * Honest forensics of a text-typing assist (change captcha-assist-text-answer).
 * MUST NOT ever carry the answer itself — only who/when/how-many-shaped facts. Lets the operator
 * distinguish «the answer was wrong» from «nothing was typed» (the whole point of this change).
 */
export interface CaptchaAssistTypeReportPayload {
  /** Focus tier at the moment characters were about to be dispatched. */
  focus: CaptchaAssistFocusTier;
  /** Tag of the focused element ('INPUT' / 'IFRAME' / 'CANVAS' …). For forensics only; MUST NOT branch on it. */
  focusTag?: string;
  /** Clear outcome: 'verified' = read-back confirmed empty; 'attempted' = cleared best-effort but unreadable. */
  cleared?: 'verified' | 'attempted';
  /** Characters actually dispatched. Report truthfully — never `typed || text.length`. */
  typed: number;
  /** Read-back verdict (editable only): 'match'/'mismatch'; 'unverifiable' when focus was opaque. */
  verified?: 'match' | 'mismatch' | 'unverifiable';
  /** Whether Enter was actually dispatched. */
  submitted: boolean;
}

export interface CaptchaAssistClickPayload {
  /** 验证码人工恢复的 system_recovery 任务租约。 */
  taskId?: string;
  incidentId: string;
  snapshotId: string;
  points: CaptchaAssistClickPointPayload[];
  requestedAt?: number;
  settleMs?: number;
  /**
   * Optional operator trajectory (change captcha-assist-trajectory-replay). Absent / invalid →
   * edge falls back to the synthetic humanized path (change captcha-assist-humanize-click).
   * Points stay authoritative for the press landing; edge clamps sampling/timing + adds jitter.
   */
  trajectory?: CaptchaAssistTrajectoryPayload;
  /**
   * Optional captcha answer to type into the focused field (change captcha-assist-text-answer).
   * Present ⇒ `points` MUST be exactly one (the field to focus). Edge types it with real keyboard
   * events (never Input.insertText), clears the field first, then submits via Enter if requested.
   *
   * SENSITIVE — this is the plaintext answer. MUST NOT be logged / persisted / echoed in any result
   * or incident / put in a URL (same rule as `image.data`). It lives only on the submitClick call
   * stack, is packed into the envelope, and is gone; audit keeps actor + when + charCount, never what.
   *
   * Actions-DSL seam (design D1): if a real multi-field form ever appears, promote `text`/`submit`
   * to `actions: (Click|Type|Key|Clear)[]` and derive `points` as the click sub-sequence. Not built now.
   */
  text?: string;
  /** Submit gesture after typing (change captcha-assist-text-answer). Only 'enter' — follows focus, immune to scroll. */
  submit?: 'enter';
}

export interface CaptchaAssistClickResultPayload {
  incidentId: string;
  snapshotId?: string;
  edgeId?: string;
  accountId?: string;
  status: 'cleared' | 'still_blocked' | 'stale_snapshot' | 'not_blocked' | 'invalid_target' | 'no_target' | 'failed';
  reason?: string;
  checkedAt: number;
  snapshot?: CaptchaAssistSnapshotPayload;
  /**
   * Which input mode actually drove the click (change captcha-assist-trajectory-replay):
   * 'trajectory' = replayed operator trajectory, 'synthetic' = humanized synthetic path.
   * Lets cloud/console correlate the outcome (cleared/still_blocked) with the input mode.
   */
  replayMode?: 'trajectory' | 'synthetic';
  /**
   * Whether this assist typed an answer (change captcha-assist-text-answer). 'click' = points only
   * (today's behavior); 'click_type' = focus + type + optional submit. Cloud uses it to detect
   * version skew: dispatched text but got back `inputMode !== 'click_type'` ⇒ old edge silently dropped it.
   */
  inputMode?: 'click' | 'click_type';
  /** Honest type-report (change captcha-assist-text-answer). Never carries the answer itself. */
  typeReport?: CaptchaAssistTypeReportPayload;
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

/** 发布原子指令的种类（E1-E12；仍由一对通用 publish.command/result 消息承载）。 */
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
  | 'capture_postId'
  /** 小红书定时提交后：捕获定时列表内部句柄，绝不当公开 postId。 */
  | 'capture_scheduled'
  /** 小红书目标时刻后：只读核验真实公开 postId/postUrl。 */
  | 'reconcile_scheduled';

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
  /** capture_scheduled / reconcile_scheduled：用于唯一匹配的冻结标题。 */
  scheduledTitle?: string;
  /** reconcile_scheduled：平台定时列表内部句柄；它不是公开 postId。 */
  scheduledPlatformId?: string;
}

/**
 * 一条参数化发布指令（cloud → edge）。
 * `recordId + seq` 为业务级永久关联键（请求/结果配对靠它）；`envelope.id` 仅供日志。
 * 注意：此 `recordId`（数字，PublishLogStore.insert 返回）与 AC-PUB 审批文件的 `requestId`（字符串）是两个不同的键。
 */
export interface PublishCommandPayload {
  /** 运行时平台；缺省按历史小红书处理。 */
  platform?: 'xiaohongshu' | 'facebook';
  /** 当前 edge 页面写任务租约；发布完整序列逐条携同一值。 */
  taskId: string;
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
  /**
   * 提交类命令专用：底层「按下」事件是否已真正派发到平台控制端口。
   * 仅在提交动作（发布提交 / 评论提交 / 加群点击 / 回车）把 press 事件发出去的那一刻置 true；
   * center 查找失败、no_target、打字中途被抢占等「压根没点」的失败保持 undefined/false。
   * 红线：当 `ok===false` 但 `submitDispatched===true` 时，帖子/评论可能已发出——cloud MUST 按
   *「已提交待确认」（submitted_unconfirmed）处置，绝不判 failed_before_submit、绝不自动重投（会双发）；
   * 反之 `ok===false && !submitDispatched` 才是「提交前失败」，可安全保持待审重投（change lease-strict-preemption）。
   */
  submitDispatched?: boolean;
  /**
   * 成功产出：capture_postId/reconcile_scheduled 为真实公开 postId；
   * capture_scheduled 为平台定时列表内部句柄（不得写 platform_post_id）。
   */
  value?: string;
  /**
   * capture_postId / reconcile_scheduled 附带：平台给出的完整小红书详情页分享 URL（可点开真实笔记）。
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

export interface FeedRefreshPayload {
  reason?: string;  // feed_refresh
  /** 点击「刷新」前犹豫时间中心值（毫秒，可选，复用 action 档节奏） */
  thinkMs?: number;
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
  /** 评论 commit 任务租约。 */
  taskId?: string;
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

export interface GroupJoinPayload {
  /** 加群任务租约。 */
  taskId?: string;
  /** Facebook group canonical/full URL. Edge validates host/path before navigation. */
  groupUrl: string;
  /**
   * false/absent = observe only. true = cloud has already judged the pre-click observation as safe
   * and explicitly instructs edge to click Join once.
   */
  click?: boolean;
  reason?: string;
  /** 点击前犹豫时间中心值（毫秒，可选；由调用方计算，边缘只在真实点击前使用） */
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
  /** 评论 prepare/commit 任务租约。 */
  taskId?: string;
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
  /**
   * Edge core/browser full-start generation. Stable for one core/browser run, changes after a complete restart.
   * Cloud uses this only to scope first-feed nickname capture; old edges may omit it.
   */
  startupId?: string;
  /**
   * 本次容器内搜索所在容器的**真实人类可读名称**（change facebook-container-display-name，可选）。
   * Facebook 定向评论：边缘在配置容器（群/主页）内搜索时，从群页读出真实群名回传，云端据此把配置里的容器名
   * 自动回填/刷新——让后台/审计/飞书一律展示群名而非群 id（id 对人无辨识度）。缺省=非容器搜索或未解析出名称。
   */
  containerName?: string;
}

/** Note detail image reference observed by edge. Edge only reports URL/metadata; it does not download. */
export interface NoteImagePayload {
  index: number;
  url: string;
  width?: number;
  height?: number;
  alt?: string;
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
  /** 发布相对时刻原始文本（change feed-hot-lead-group-comment）：如「3小时前 / 昨天 14:30 / 07-05」。
   *  边缘只从正文列底部日期容器抽原始串、不解析；云端解析成小时数并算热度速率。缺则诚实置空、MUST NOT 臆造。 */
  publishedAtText?: string;
  /** 作者区关注按钮当下真实态（change skip-profile-visit-if-followed）：已关注/互关→true；
   *  缺省/读取失败=未探到→云端回退原主页评估。边缘只读取上报、MUST NOT 臆造。 */
  authorFollowed?: boolean;
  /** 详情页带 xsec_token 的完整链接（change interaction-feed-enrichment，供面板「按笔记互动」可点跳转）。
   *  诚实置空：地址栏无 token 时不带、绝不用裸 id 拼打不开的假链接（同发布链 postUrl 约定）。 */
  url?: string;
  /** Original carousel image references; omitted/empty when not observed. */
  images?: NoteImagePayload[];
  /** Refresh-only detail after carousel browsing; cloud MUST NOT count it as a new view. */
  refreshOnly?: boolean;
  /**
   * 帖子下**他人评论**正文样本（change facebook-comment-read-before-write，可选）。
   * Facebook 定向评论：撰写前从帖子评论区抽取顶部若干条他人评论正文（去作者名/界面词），云端据此让撰写器
   * 顺着讨论、用**内容语言**写。best-effort、可空；边缘 MUST NOT 臆造。图片帖常无正文（`content` 空）时，
   * 这些评论就是撰写的主要文字依据。
   */
  comments?: string[];
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
  /**
   * 被实际作用的内容规范 id（change platform-browse-protocol，可选）。MUST 由边缘从**实际被点的 article DOM**
   * 重新派生规范 postId，MUST NOT 复制命令 payload。缺省时详情页回执回落会话当前笔记（老边端零回归）、
   * 信息流就地回执缺此则拒记账（不回落 currentNoteId）。
   */
  noteId?: string;
  /** 仅 group.join 回执携带：目标群 URL。 */
  groupUrl?: string;
  /**
   * 结构化观测（action-discriminated，可选，类型保持 unknown、按 action 收窄）：group.join 携带点击前观测；
   * note-scoped 互动（like/collect）回执携带独立见证包
   * {surface?;listKey?;author?;textPreviewHead?;reactionText?;articleIndex?}（现读被点 article），
   * 供云端归账仲裁逐字段比对选中卡。勿在此处收窄类型（会破坏 group.join 的既有用法）。
   */
  observation?: unknown;
  /** 仅 group.join 回执携带：点击后结构化观测。 */
  postObservation?: unknown;
  /** 仅 group.join 回执携带：本次 edge 是否真的点击过 Join。 */
  clicked?: boolean;
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
  taskId?: string;
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
  taskId?: string;
  thinkMs?: number;
  /** 最多滚动加载次数（由 Cloud 控制） */
  scrollMax?: number;
}

/** cloud → edge：进「赞和收藏」（v1 看一眼清未读，不抽取）。 */
export interface NotificationBrowseLikesPayload {
  taskId?: string;
  thinkMs?: number;
}

/** cloud → edge：进「新增关注」（v1 看一眼清未读，不抽取）。 */
export interface NotificationBrowseFollowsPayload {
  taskId?: string;
  thinkMs?: number;
}

/** cloud → edge：返回通知首页（落地后重报 notification.home）。 */
export interface NotificationBackHomePayload {
  taskId?: string;
  thinkMs?: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export type EdgeTaskKind =
  | 'publish'
  | 'comment_prepare'
  | 'comment_commit'
  | 'notification'
  | 'group_join'
  | 'system_recovery';

export type EdgeTaskPriority = 'system_recovery' | 'human' | 'automatic';

export interface EdgeTaskAcquirePayload {
  taskId: string;
  kind: EdgeTaskKind;
  priority: EdgeTaskPriority;
  /** 空闲租约时限；匹配业务命令可刷新，edge 仍受绝对上限保护。 */
  leaseMs: number;
  /** edge 本地等待 quiesce 的上限；届满仍未获授时取消该排队申请。 */
  acquireTimeoutMs?: number;
}

export interface EdgeTaskAcquiredPayload {
  taskId: string;
  kind: EdgeTaskKind;
  cancelledBrowseCommands: number;
}

export interface EdgeTaskReleasePayload {
  taskId: string;
  outcome?: 'completed' | 'failed' | 'cancelled';
}

export interface EdgeTaskReleasedPayload {
  taskId: string;
  /**
   * `cdp_unhealthy` = edge is connected and the browser is present, but control is not safe to take.
   * `browser_wake_failed` = the browser was deliberately parked (cold standby) and could not be woken
   *   within the wake deadline. MUST NOT be conflated with `cdp_unhealthy`: parking is a recoverable
   *   absence we caused ourselves, not a fault of the browser (change browser-slot-scheduling).
   * `preempted_by_task` = the running task's lease was released because a strictly higher-priority task
   *   preempted it (change lease-strict-preemption). Cloud MUST treat this as "not a failure": keep the
   *   preempted work pending and re-run it after the preemptor releases — never write a terminal failed
   *   state and never count it toward the publish circuit breaker.
   * `window_busy` = the preemption/acquire request is refused because the current holder is inside a
   *   non-preemptible commit window (a submit is already in flight). This is NOT a failure of either
   *   task; `windowRemainingMs` carries the holder's remaining window budget so cloud can wait exactly
   *   that long before re-queuing the acquire, instead of spinning (change lease-strict-preemption).
   * `yield_timeout` = the held writer received the cancel signal but did not stop within the bounded
   *   quiesce budget → treated as a control-plane fault. The lease/queue is torn down; recovery is a
   *   MANUAL operator action ("restart the browser client"), not self-healing (change lease-strict-preemption).
   */
  reason:
    | 'released'
    | 'expired'
    | 'duplicate'
    | 'not_owner'
    | 'cdp_unhealthy'
    | 'browser_wake_failed'
    | 'preempted_by_task'
    | 'window_busy'
    | 'yield_timeout';
  /**
   * `window_busy` only: the current holder's remaining commit-window budget in milliseconds. Present so
   * cloud can wait precisely and re-queue the acquire rather than poll-spin the preemptor
   * (change lease-strict-preemption). Omitted for every other reason.
   */
  windowRemainingMs?: number;
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
  'publish.approval_action': PublishApprovalActionPayload;
  'publish.approval_action.result': PublishApprovalActionResultPayload;
  'publish.draft_image_remove': PublishDraftImageRemovePayload;
  'publish.draft_image_remove.result': PublishDraftImageRemoveResultPayload;
  'session.budget.request': SessionBudgetRequestPayload;
  'session.budget': SessionBudgetPayload;
  'risk.canDo': RiskCanDoPayload;
  'risk.canDo.result': RiskCanDoResultPayload;
  'risk.record': RiskRecordPayload;
  'risk.record.result': RiskRecordResultPayload;
  'risk.captcha_detected': CaptchaDetectedPayload;
  'risk.captcha_cleared': CaptchaClearedPayload;
  'captcha.assist.capture': CaptchaAssistCapturePayload;
  'captcha.assist.snapshot': CaptchaAssistSnapshotPayload;
  'captcha.assist.click': CaptchaAssistClickPayload;
  'captcha.assist.click_result': CaptchaAssistClickResultPayload;
  'edge.task.acquire': EdgeTaskAcquirePayload;
  'edge.task.acquired': EdgeTaskAcquiredPayload;
  'edge.task.release': EdgeTaskReleasePayload;
  'edge.task.released': EdgeTaskReleasedPayload;
  'publish.request': PublishRequestPayload;
  'publish.result': PublishResultPayload;
  'publish.command': PublishCommandPayload;
  'publish.command.result': PublishCommandResultPayload;
  // 角色驱动指令
  'page.scroll': PageScrollPayload;
  'feed.refresh': FeedRefreshPayload;
  'pacing.update': PacingUpdatePayload;
  'interaction.like': InteractionLikePayload;
  'interaction.collect': InteractionCollectPayload;
  'interaction.follow': InteractionFollowPayload;
  'interaction.comment': InteractionCommentPayload;
  'interaction.like_comment': InteractionLikeCommentPayload;
  'group.join': GroupJoinPayload;
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
  // Persona 生成（建号关键词驱动，edge 发起请求/响应）
  'persona.generate': PersonaGeneratePayload;
  'persona.generate.result': PersonaGenerateResultPayload;
  'persona.persist': PersonaPersistPayload;
  'persona.persist.result': PersonaPersistResultPayload;
  'interaction.auth.status': InteractionAuthStatusPayload;
  'interaction.sync.batch': InteractionSyncBatchPayload;
  'interaction.sync.ack': InteractionSyncAckPayload;
  'interaction.reply.result': InteractionReplyResultPayload;
  'interaction.reply.result.ack': InteractionReplyResultAckPayload;
  'interaction.reply.reconcile': InteractionReplyReconcilePayload;
  'interaction.reply.reconcile.result': InteractionReplyReconcileResultPayload;
  'interaction.sync.request': InteractionSyncRequestPayload;
  'interaction.reply.send': InteractionReplySendPayload;
  'interaction.auth.reopen': InteractionAuthReopenPayload;
  'interaction.browser.control': InteractionBrowserControlPayload;
  'interaction.runtime.controls': InteractionRuntimeControlsPayload;
  'interaction.offboard.command': InteractionOffboardCommandPayload;
  'interaction.offboard.result': InteractionOffboardResultPayload;
  'interaction.offboard.ack': InteractionOffboardAckPayload;
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
