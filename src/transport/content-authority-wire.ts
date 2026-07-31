/**
 * automation → content 属主端口在**线上那一跳**的公共译码层（两个方向各一半）。
 *
 * 它是从 {@link file://./content-authority-http.ts} 里逐字提出来的——那份文件把同一套译码写成了
 * 私有函数，本 change 又要为另外两条端口（FB 发帖素材、模型用量记账）落三件套。
 * **复制第二份是这里最不能做的事**：这一层是一张失败映射表，两份表各自编译通过、各自测试通过，
 * 只有真跑起来、且只在**失败发生的那一刻**才看得出对不上——而失败路径正是最少被真跑到的那条。
 * 所以规范落点是这里一份。**`content-authority-http.ts` 已于 2026-07-31 改指过来、私有副本已删**
 * （`content-media-usage-http.ts` 欠账第 1 条，已移入其 `_CLOSED` 清单）。
 * 结清时逐条比过两份实现：语义一致、尚未漂移——所以那次是防患，不是修 bug。
 * **今后任何新的 content 属主端口三件套一律取用本文件，MUST NOT 再复制第三份。**
 *
 * 两个方向各自要解决的问题（照抄原文，别按直觉简化）：
 *   - **服务端**：属主抛出物一律译成带 `code` 的 `ContentPortError` 再出网。线格式只透传带
 *     string `code` 的抛出物，属主侧既有哨兵错误未必有 `code`，不译就会在这一跳被压成泛化的
 *     `handler_error`，具名原因当场丢失。
 *   - **客户端**：`name` / `reason` 跨这一跳会全丢（线上只剩 `code` + `message`），所以 MUST 先用
 *     `contentPortReasonFromCode` 还原、再重新抛一个 `ContentPortError`；还原不出来的**逐条显式**
 *     判定，认不出的落 `remote_error` 并把原始 code 写进 `detail`，
 *     **MUST NOT 默默套一个默认 reason**——那会把「对面不提供这个方法」吞成「对面报错了」。
 *
 * 零属主表 SQL、零业务判定，满足 `aidcp-transport` 准入。
 */
import type { DeploymentTarget } from '../deployment-target.js';
import {
  CONTENT_PORT_ERROR_CODE_PREFIX,
  ContentPortError,
  contentPortReasonFromCode,
  isContentPortError,
  isContentPortFailureReason,
} from '../kernel/content-port-error.js';
import {
  InternalHttpError,
  type InternalHttpClient,
} from './internal-http.js';
import { apiDirectEnvelope, isRecord } from './api-direct-http-common.js';

function contentPortErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}

function contentPortErrorCodeOf(error: unknown): string | null {
  return isRecord(error) && typeof error.code === 'string' ? error.code : null;
}

/**
 * 把属主抛出的任何东西译成**线上还认得出来**的失败。
 *
 * 三条分支各有各的必要性：
 *   ① 已是具名 content 端口错误 → **重建**而不是原样抛。`ContentPortErrorShape` 的 `code` 是可选的，
 *      而线格式只透传带 string `code` 的抛出物；原样抛一个没有 `code` 的实现方错误，
 *      reason 会在这一跳被压成 `handler_error`。
 *   ② reason 超出本进程枚举（对面版本更新）→ 原样带过去，**不收窄成兜底原因**
 *      （kernel 明写：未知取值由调用方原样记录并按不可用处置）。
 *   ③ 其它任何抛出物 → 具名 `remote_error`，原始 code 与消息进 `detail`。属主侧那些自带 name 与
 *      reason 的领域错误（精选库的缺表错误、FB 素材池那一族）正是靠这一条才没在跨进程后
 *      退化成一句 `handler_error`：它们的具名 code 会原样出现在 `detail` 里，供日志与告警定位。
 *      **`detail` MUST NOT 参与任何判定**——automation 方向的失败信号只有 `ContentPortError` 一个 name，
 *      要按属主的具名原因分支就得改端口，不是去 parse 文案。
 */
function ownerFailureAsWireError(error: unknown, operation: string): unknown {
  if (isContentPortError(error)) {
    if (isContentPortFailureReason(error.reason)) {
      return new ContentPortError(error.reason, error.operation ?? operation, error.detail);
    }
    return new InternalHttpError(
      `${CONTENT_PORT_ERROR_CODE_PREFIX}${error.reason}`,
      contentPortErrorMessage(error),
    );
  }
  const code = contentPortErrorCodeOf(error);
  const message = contentPortErrorMessage(error);
  return new ContentPortError(
    'remote_error',
    operation,
    code === null ? message : `${code}: ${message}`,
  );
}

/**
 * 属主侧的方法在场探针。**这个 `typeof` 探针只有放在这一侧才有意义**：它问的是本进程里那个
 * 真实存储对象有没有这个方法。同一个探针写在 automation 侧就恒为真（客户端类总是定义着方法），
 * 那正是本 change 要消掉的死代码。属主缺方法时答具名 `unsupported_method`，
 * 让概念池那条回落分支有一个**真会发生**的触发条件。
 *
 * 另一条更常见的触发路径不经过这里：对面跑的是旧版本、根本没注册这条路由 → 404
 * `route_not_found` → 客户端译成 `unsupported_method`（见 {@link clientFailureAsContentPortError}）。
 */
export function ownerHasMethod(port: object, method: string): boolean {
  return typeof (port as Record<string, unknown>)[method] === 'function';
}

export async function runOwnerCall<T>(
  operation: string,
  present: boolean,
  invoke: () => Promise<T>,
): Promise<T> {
  if (!present) {
    throw new ContentPortError(
      'unsupported_method',
      operation,
      'owner implementation does not provide this method',
    );
  }
  try {
    return await invoke();
  } catch (error) {
    throw ownerFailureAsWireError(error, operation);
  }
}

/**
 * 把这一跳上的任何失败译回具名 {@link ContentPortError}。
 *
 * 顺序有讲究：先用 `contentPortReasonFromCode` 还原属主给的具名原因（`unsupported_method`
 * 唯一能活着过来的路径），还原不出来的再逐条显式判定。**认不出的一律 `remote_error` +
 * 原始 code 进 `detail`，MUST NOT 套一个默认 reason。**
 */
function clientFailureAsContentPortError(
  error: unknown,
  operation: string,
): ContentPortError {
  const code = contentPortErrorCodeOf(error);
  const message = contentPortErrorMessage(error);
  const recovered = contentPortReasonFromCode(code);
  if (recovered !== null) return new ContentPortError(recovered, operation, message);

  switch (code) {
    case 'timeout':
      // 连上了但没在预算内答完。**与「对面回答了空」是两回事**，这正是本端口存在的理由之一。
      return new ContentPortError('timeout', operation, message);
    case 'transport_error':
      return new ContentPortError('unreachable', operation, message);
    case 'bad_response':
      return new ContentPortError('malformed_response', operation, message);
    case 'route_not_found':
      // 对面在、令牌也对，就是没有这条路由：版本落后 / 路由没注册。**这是回落分支最现实的触发点。**
      return new ContentPortError('unsupported_method', operation, message);
    case 'internal_http_auth_config_invalid':
      // 本进程的令牌根本没配好，**一个字节都没发出去**——这是「这条端口没配置」的字面情形。
      return new ContentPortError('not_configured', operation, `${code}: ${message}`);
    case 'internal_http_unauthorized':
      // 401 是对面明确拒绝，不是没配。混进 `not_configured` 会让「令牌轮换没同步」
      // 读起来像「这条端口本来就没开」，运维会去查错的地方。
      return new ContentPortError('remote_error', operation, `${code}: ${message}`);
    case 'api_direct_version_unsupported':
      // **刻意不判 `unsupported_method`**：版本不符是整条通道对不上，回落方法与首选方法同属一个
      // 契约版本、照样会失败。判成回落只会让调用方多打一次注定失败的请求，
      // 并把一次通道级配置错误伪装成一次能力缺口。
      return new ContentPortError('remote_error', operation, `${code}: ${message}`);
    default:
      return new ContentPortError(
        'remote_error',
        operation,
        code === null ? message : `${code}: ${message}`,
      );
  }
}

export interface ContentAuthorityChannel {
  readonly http: InternalHttpClient;
  readonly callerToken: string;
  readonly executionTarget: DeploymentTarget;
}

export async function callContentAuthority<T>(
  channel: ContentAuthorityChannel,
  route: string,
  operation: string,
  input: unknown,
  validate: (value: unknown) => value is T,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await channel.http.callBearer<unknown>(
      route,
      apiDirectEnvelope(channel.executionTarget, input),
      channel.callerToken,
    );
  } catch (error) {
    throw clientFailureAsContentPortError(error, operation);
  }
  // 形状不符 MUST 抛。**MUST NOT 兜底成空数组 / false / 0**——那就是把一次契约漂移
  // （kernel pin 没跟上：编译过、跑起来才错）伪装成一个真实答案。
  if (!validate(raw)) {
    throw new ContentPortError(
      'malformed_response',
      operation,
      `unexpected response shape from ${route}`,
    );
  }
  return raw;
}
