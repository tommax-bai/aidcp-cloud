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
export const PROTOCOL_VERSION = 1;

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
