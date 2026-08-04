/**
 * 互动域失败跨内部 HTTP 的**保真搬运**。
 *
 * ## 这一层存在的唯一理由
 * 互动域的失败自带三格下游真正会用的信息：`httpStatus`（回给客户端的状态码）、
 * `retryable`（客户端该不该重试）、`details`（当前版本 / 当前状态 / 退避时长）。
 * 而通用传输骨架只搬 `code` + `message` —— 剩下两格在跨进程那一跳上会**静默丢掉**。
 *
 * 丢掉之后的具体后果不是报错，是一次**重复对外写入**：
 * `INTERACTION_SEND_AMBIGUOUS` 的语义是「命令已经发出去了，但我核不到结果」，
 * 它是 409、**不可重试**。丢了这两格，调用侧那句兜底会把它折成 500 + 可重试，
 * 于是客户端去重投一条**可能已经上墙的评论 / 私信**。本仓档案里最贵的三次重复对外写入
 * 根因全是这一类「把没认出来的原因折进兜底桶」。
 *
 * ## 两个方向各做一件事
 * - registrar 侧 {@link interactionRoute}：把属主抛出的互动失败编码进 wire details。
 * - client 侧 {@link callInteraction}：解码还原；解不出来时**按调用性质**给出不同结论。
 *
 * ## 结论怎么分档（判据是补集，不是白名单）
 * 只有两条路径能确定「命令根本没离开本进程」：对面明确答了**没有这条路由**，或明确答了
 * **没通过鉴权** —— 这两种情况下属主的处理函数一次都没跑。除此之外的一切
 * （超时 / 连接断 / 回包坏 / 处理函数抛了个认不出的东西）**一律按「可能已发出」处理**。
 * 反过来写成白名单迟早会漏，而漏的方向恰好是把「可能发出去了」说成「没发出去」。
 *
 * ## MUST NOT 在这一层加重试
 * 提交点的重试必须由**懂幂等台账的那一层**做，不能由搬运层代劳：搬运层看不见幂等键，
 * 它的重试就是原样再推一次。
 */
import {
  InteractionError,
  asInteractionFailure,
} from '../kernel/interaction-types.js';
import { InternalHttpError, type InternalHttpClient } from './internal-http.js';

/** wire `details` 里承载互动失败可恢复性的那一格。两侧共用，防漂移。 */
export const INTERACTION_FAILURE_DETAIL_KEY = 'interactionFailure';

/** 编码后的互动失败在线上的形状。 */
export interface InteractionFailureWire {
  code: string;
  message: string;
  httpStatus: number;
  retryable: boolean;
  details?: unknown;
}

/**
 * 调用性质。**提交点**＝命令会离开本进程、可能已经上墙的那些；其余都是 `read`
 * （含只改本域数据库、可凭幂等台账重来的写）。
 */
export type InteractionCallKind = 'read' | 'submission';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * registrar 侧：把互动失败编成带 details 的传输错误。
 * 非互动失败**原样抛**——它不该被本层解释成互动语义。
 */
export function encodeInteractionFailure(error: unknown): unknown {
  const failure = asInteractionFailure(error);
  if (!failure) return error;
  const wire: InteractionFailureWire = {
    code: failure.code,
    message: failure.message,
    httpStatus: failure.httpStatus,
    retryable: failure.retryable,
    ...(failure.details ? { details: failure.details } : {}),
  };
  return new InternalHttpError(failure.code, failure.message, {
    [INTERACTION_FAILURE_DETAIL_KEY]: wire,
  });
}

/** 把一个属主侧实现包成 route handler，使它抛出的互动失败带上可恢复性。 */
export function interactionRoute<T>(
  handler: (args: unknown) => T | Promise<T>,
): (args: unknown) => Promise<T> {
  return async (args: unknown): Promise<T> => {
    try {
      return await handler(args);
    } catch (error) {
      throw encodeInteractionFailure(error);
    }
  };
}

/** 从传输错误里把互动失败解回来；解不出来回 null。 */
export function decodeInteractionFailure(error: unknown): InteractionError | null {
  if (!(error instanceof InternalHttpError)) return null;
  const details = error.details;
  if (!isRecord(details)) return null;
  const wire = details[INTERACTION_FAILURE_DETAIL_KEY];
  if (!isRecord(wire)) return null;
  // 复用同一套结构判据：wire 形状与 InteractionError 的具名字段逐格对齐，
  // 这里**刻意不另写一份校验**——两份校验漂开时不报错，只是某一侧开始漏掉一类失败。
  return asInteractionFailure({ name: 'InteractionError', ...wire });
}

/**
 * 属主侧明确拒绝、且**处理函数一次都没跑**的那两个传输码。
 * 它们是「命令没离开本进程」的**唯二**证据，故单独列出（见文件头：其余一律按可能已发出算）。
 */
const NEVER_REACHED_HANDLER_CODES: ReadonlySet<string> = new Set([
  'route_not_found',
  'internal_http_unauthorized',
]);

/**
 * client 侧：把一次内部 HTTP 失败翻译成互动域失败。
 *
 * 三档，逐条说清为什么：
 *   ① 属主真的答了一个互动失败 ⇒ **原样还原**，一格都不改。
 *   ② 对面明确说「没这条路由」/「鉴权没过」⇒ 处理函数没跑过 ⇒ 这是一次**干净的未发生**。
 *      标不可重试：重试解决不了配置/部署问题，说可重试只会让客户端白转。
 *   ③ 其余一切 ⇒ **可能已发出**。提交点报「已发出但核不到」（409、不可重试）；
 *      读类报「上游暂时不可用」（503、可重试）。
 */
export function translateInteractionFailure(
  error: unknown,
  route: string,
  kind: InteractionCallKind,
): never {
  const decoded = decodeInteractionFailure(error);
  if (decoded) throw decoded;
  const message = error instanceof Error ? error.message : String(error);
  const transportCode = error instanceof InternalHttpError ? error.code : 'unknown';
  if (NEVER_REACHED_HANDLER_CODES.has(transportCode)) {
    throw new InteractionError(
      'INTERACTION_UPSTREAM_UNAVAILABLE',
      `互动能力的属主进程未提供 ${route}（${transportCode}）：${message}`,
      503,
      false,
      { reason: `interaction_channel_${transportCode}` },
    );
  }
  if (kind === 'submission') {
    throw new InteractionError(
      'INTERACTION_SEND_AMBIGUOUS',
      `${route} 的结果无法确认（${transportCode}）：指令可能已经发出，未自动重试。${message}`,
      409,
      false,
      { reason: `interaction_channel_${transportCode}` },
    );
  }
  throw new InteractionError(
    'INTERACTION_UPSTREAM_UNAVAILABLE',
    `互动能力的属主进程暂时不可达（${transportCode}）：${message}`,
    503,
    true,
    { reason: `interaction_channel_${transportCode}` },
  );
}

/**
 * 发一次互动域的内部 HTTP 调用。**零重试**（理由见文件头）。
 */
export async function callInteraction<T>(
  http: InternalHttpClient,
  route: string,
  args: unknown,
  kind: InteractionCallKind,
): Promise<T> {
  try {
    return await http.call<T>(route, args);
  } catch (error) {
    return translateInteractionFailure(error, route, kind);
  }
}
