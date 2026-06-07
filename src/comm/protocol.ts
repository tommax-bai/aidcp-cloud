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
  // —— 发布编排（Publish Agent 驱动）——
  | 'publish.approval_request' // edge → cloud：请求发送发布审批卡片
  | 'publish.request' // cloud → edge：请求在浏览器中发布一篇帖子
  | 'publish.result' // edge → cloud：发布结果回传
  // —— 角色驱动指令（cloud → edge，RoleDispatcher 驱动）——
  | 'page.scroll'          // 页面滚动
  | 'interaction.like'     // 点赞
  | 'interaction.collect'  // 收藏
  | 'interaction.follow'   // 关注
  | 'navigation.back'      // 返回上一页
  | 'note.browse_images'   // 浏览笔记图片
  | 'note.scroll_comments' // 滚动评论区
  // —— Edge 上报（edge → cloud，RoleDispatcher 消费）——
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
}

export interface WelcomePayload {
  /** 云端分配的会话 id */
  sessionId: string;
  serverVersion: string;
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
}

export interface NoteClosePayload {
  reason?: string;
}

/** 让边缘执行一次搜索（cloud → edge）。 */
export interface SearchExecutePayload {
  /** 搜索关键词 */
  keyword: string;
  /** 关键词来源策略（观测用） */
  source?: 'extract_from_liked' | 'random_from_interests' | 'new_concept' | 'manager';
  /** 本次搜索最多浏览的结果数 */
  maxResults?: number;
}

/** 结束本次浏览会话（cloud → edge）。 */
export interface SessionEndPayload {
  reason: string;
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
}

export interface RiskCanDoPayload {
  action: 'view' | 'like' | 'collect' | 'comment' | 'follow' | 'publish';
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

/** 确认收到笔记（cloud → edge），异步处理中。 */
export interface NoteAckPayload {
  /** 确认收到 */
  received: boolean;
}

// —— 角色驱动指令 Payload（cloud → edge）——

export interface PageScrollPayload {
  reason?: string;  // feed_scroll | search_scroll
}

export interface InteractionLikePayload {
  noteId: string;
  reason?: string;
}

export interface InteractionCollectPayload {
  noteId: string;
  reason?: string;
}

export interface InteractionFollowPayload {
  authorId?: string;
  reason?: string;
}

export interface NavigationBackPayload {
  reason?: string;  // quality_rejected | back_to_feed | profile_done
  targetPage?: 'feed' | 'search';
}

export interface NoteBrowseImagesPayload {
  noteId: string;
}

export interface NoteScrollCommentsPayload {
  noteId: string;
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
  }>;
}

export interface NoteDetailPayload {
  noteId: string;
  title: string;
  content: string;
  author?: string;
  authorId?: string;
  likeCount: number;
  collectCount: number;
}

export interface ProfileDetailPayload {
  authorId: string;
  postsCount: number;
  followersCount: number;
}

export interface ActionCompletedPayload {
  action: string;
  ok: boolean;
  reason?: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

/** payload 类型映射（便于类型安全地构造/解析） */
export interface PayloadMap {
  hello: HelloPayload;
  welcome: WelcomePayload;
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
  'publish.request': PublishRequestPayload;
  'publish.result': PublishResultPayload;
  // 角色驱动指令
  'page.scroll': PageScrollPayload;
  'interaction.like': InteractionLikePayload;
  'interaction.collect': InteractionCollectPayload;
  'interaction.follow': InteractionFollowPayload;
  'navigation.back': NavigationBackPayload;
  'note.browse_images': NoteBrowseImagesPayload;
  'note.scroll_comments': NoteScrollCommentsPayload;
  // Edge 上报
  'page.cards': PageCardsPayload;
  'note.detail': NoteDetailPayload;
  'profile.detail': ProfileDetailPayload;
  'action.completed': ActionCompletedPayload;
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
