/**
 * 委托任务**读写窄面**（7 方法）的正式跨进程传输实现：路由表 + 服务端注册 + 类型化客户端。
 *
 * 这个文件从「证明性接线（behavior-zero）」升级成正式实现（change
 * split-cloud-automation-production-runtime）。**方法签名一个没动**——客户端仍 `implements`
 * 同一个 kernel 端口 `DelegatedTaskServicePort`，故「组装根可以原样注入本地实例」这条性质保住了，
 * 不需要任何一层适配器。补的只是它缺的三样：
 *
 *   1. **逐条 Bearer**（`registerBearer`）：此前 7 条完全无鉴权，与同进程里逐条鉴权的路由并存，
 *      同一个域两套口径。
 *   2. **信封**（版本 + 执行目标，`parseApiDirectEnvelope`）：`executionTarget` 由客户端**构造时**
 *      从本进程部署事实注入、接收方逐字比对，**调用方没有任何入口能选它**。这不是风格问题——
 *      DEV/OL 长期共库，dev 的进程配错 URL 指到 ol，委托任务是真副作用（发帖 / 评论），
 *      此前没有任何东西会拦。
 *   3. **业务拒绝可跨线还原**（本文件最要紧的一条，见下）。
 *
 * ── 第 3 条为什么是这个文件的存在理由 ───────────────────────────────────────────
 *
 * 线格式对一个「带 string `code` 的裸抛出物」**只保 `code` + `message`**，`name` 与 `status`
 * 在那一跳被丢（`internal-http.ts` 的 `encodeHandlerError` 第二分支）。而三个文件六个调用点已经
 * 从 `instanceof` 迁到结构化守卫 `isDelegatedTaskServiceError`，那个守卫判的正是 `name`
 * ⇒ **迁移在真跨进程链路上仍然恒 false**，迁移只治了「原型链没了」这一半。
 *
 * 后果不是报错，是静默降级：卡片上的版本冲突退化成一条普通错误提示且不再回刷新卡、
 * 客户端 API 的 409 / 422 一律塌成 500、后台控制台发起的委托任务同样塌成一条泛化 500。
 *
 * 补法（线格式**对传输层自己的错误类是保附加位的**，这是唯一现成的通路）：
 *   - 服务端：{@link withDelegatedBusinessErrorOrigin} 把业务错误包一层 `InternalHttpError`，
 *     `name` / `status` 进附加位；
 *   - 客户端：{@link restoreDelegatedTaskServiceError} 先按
 *     {@link isOperatorCommandTransportErrorCode} 的**补集**判据认出「这是处理器给的业务原因码」，
 *     再从附加位还原。**`status` 只认服务端带过来的那个，还原不出就按传输失败处置**——
 *     客户端补一个默认 400 会把 409 / 422 一并压平，而那个错误类的 `status` 构造默认值恰好就是 400，
 *     所以「补默认」看着人畜无害。
 *
 * 405 / 404 / 401 / 400 那几条走线格式的另一个简易出口、本来就不带附加位；它们是传输层自己的
 * 拒绝、不含业务错误，**不在本机制范围内**（补集判据会把它们判成传输失败 = 结果未知，这是对的）。
 *
 * ── 读 / 写分开走两个出口（不是风格，是「结果未知」的落点）────────────────────────
 * `get` / `list` 是读，失败译成「读不到」；`createDraft` / `confirm` / `pause` / `resume` / `cancel`
 * 有真副作用，失败译成**结果未知**（`api_authority_result_unknown`），**MUST NOT** 推断成成功或失败。
 *
 * 允许引 kernel：`to === kernel` 恒 allowed（见 boundary-scan.classifyEdge），
 * 故本文件对 kernel 契约的 import 不产生任何需豁免的跨层边。
 */
import type { DeploymentTarget } from '../deployment-target.js';
import {
  delegatedTaskErrorOriginOf,
  restoreDelegatedTaskServiceError,
} from '../kernel/operator-command-port.js';
import { InternalHttpError, type InternalHttpClient, type InternalHttpServer } from './internal-http.js';
import {
  callApiDirectRead,
  callApiDirectWrite,
  isNonNegativeInteger,
  isRecord,
  parseApiDirectEnvelope,
  requireFiniteNumber,
  requireRecord,
  requireString,
} from './api-direct-http-common.js';
import type {
  DelegatedActionFamily,
  DelegatedTask,
  DelegatedTaskConfirmationSummary,
  DelegatedTaskIntent,
  DelegatedTaskServicePort,
  DelegatedTaskStatus,
} from '../kernel/delegated-task-types.js';

/**
 * 每个端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。
 *
 * `satisfies Record<keyof Port, string>`：端口加了方法而路由表没跟上 ⇒ **typecheck 当场红**，
 * 不会等到运行期 404。**但它只保证表全，保证不了每条都被注册函数挂上**（实测变异过：
 * 注册时漏挂一条，typecheck 完全绿、只有用例红）——所以下面那条逐路由的注册对账用例不是冗余的。
 */
export const DELEGATED_TASK_ROUTES = {
  createDraft: 'delegated-task/create-draft',
  confirm: 'delegated-task/confirm',
  pause: 'delegated-task/pause',
  resume: 'delegated-task/resume',
  cancel: 'delegated-task/cancel',
  get: 'delegated-task/get',
  list: 'delegated-task/list',
} as const satisfies Record<keyof DelegatedTaskServicePort, string>;

type CreateDraftResult = Awaited<ReturnType<DelegatedTaskServicePort['createDraft']>>;
type ListFilter = Parameters<DelegatedTaskServicePort['list']>[0];

/* ─────────────────────────────────────────── 线上形状守卫（两个文件共用） */

/**
 * 逐字段存在性检查。**缺字段 MUST 判成形状不符**，MUST NOT 放行成一个属性为 `undefined` 的对象——
 * 后者跨进程后会被下游当成「这个事实是空的」（红线：缺席不得压成空值）。
 */
export function hasAllKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => value[key] !== undefined);
}

export const DELEGATED_TASK_REQUIRED_KEYS = [
  'id',
  'executionTarget',
  'accountId',
  'accountName',
  'platform',
  'action',
  'actionFamily',
  'targetSuccessCount',
  'maxAttempts',
  'deadlineAt',
  'notBefore',
  'executionWindow',
  'sourceConstraints',
  'targetConstraints',
  'approvalMode',
  'priority',
  'source',
  'status',
  'progress',
  'dedupeKey',
  'version',
  'createdAt',
  'updatedAt',
] as const;

export const DELEGATED_TASK_NULLABLE_KEYS = [
  'sourceRef',
  'originChatId',
  'currentStep',
  'terminalOutcome',
  'nextEligibleAt',
  'claimToken',
  'claimExpiresAt',
  'confirmedAt',
  'completedAt',
] as const;

export const DELEGATED_CONFIRMATION_REQUIRED_KEYS = [
  'taskId',
  'version',
  'title',
  'accountName',
  'platformLabel',
  'actionLabel',
  'target',
  'attempts',
  'schedule',
  'approval',
  'priority',
  'constraints',
  'capability',
] as const;

function isDelegatedTaskProgress(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.successCount) &&
    isNonNegativeInteger(value.attemptCount) &&
    isNonNegativeInteger(value.skippedCount) &&
    isNonNegativeInteger(value.failureCount)
  );
}

export function isDelegatedTask(value: unknown): value is DelegatedTask {
  if (!isRecord(value)) return false;
  if (!hasAllKeys(value, DELEGATED_TASK_REQUIRED_KEYS)) return false;
  // 可空字段 MUST 显式在场（值可为 null）：漏发与「确实没有」在下游是两码事。
  if (!DELEGATED_TASK_NULLABLE_KEYS.every((key) => key in value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.accountId === 'string' &&
    typeof value.accountName === 'string' &&
    typeof value.platform === 'string' &&
    typeof value.action === 'string' &&
    typeof value.status === 'string' &&
    typeof value.dedupeKey === 'string' &&
    Number.isInteger(value.version) &&
    isNonNegativeInteger(value.targetSuccessCount) &&
    isNonNegativeInteger(value.maxAttempts) &&
    typeof value.pauseRequested === 'boolean' &&
    typeof value.cancelRequested === 'boolean' &&
    isDelegatedTaskProgress(value.progress)
  );
}

export function isDelegatedConfirmation(
  value: unknown,
): value is DelegatedTaskConfirmationSummary {
  if (!isRecord(value)) return false;
  if (!hasAllKeys(value, DELEGATED_CONFIRMATION_REQUIRED_KEYS)) return false;
  return (
    typeof value.taskId === 'string' &&
    Number.isInteger(value.version) &&
    Array.isArray(value.constraints) &&
    value.constraints.every((item) => typeof item === 'string') &&
    (value.capability === 'supported' || value.capability === 'beta')
  );
}

function isCreateDraftResult(value: unknown): value is CreateDraftResult {
  if (!isRecord(value)) return false;
  return (
    isDelegatedTask(value.task) &&
    isDelegatedConfirmation(value.confirmation) &&
    typeof value.created === 'boolean' &&
    typeof value.autoQueued === 'boolean'
  );
}

function isDelegatedTaskArray(value: unknown): value is DelegatedTask[] {
  return Array.isArray(value) && value.every(isDelegatedTask);
}

/* ─────────────────────────────────────────── 入参解析（服务端侧） */

type VersionArgs = { taskId: string; version?: number };

function optionalVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireFiniteNumber(value, 'version');
}

/** `createDraft` 的意图**刻意只校验到「是个对象」**：意图的字段级校验是服务自己的职责，
 * 在传输层再写一份等于把那份 schema 复制成两份，两份漂了不会报错、只会各自编译过。 */
function createDraftInput(value: unknown): DelegatedTaskIntent {
  return requireRecord(value, 'delegated task intent') as unknown as DelegatedTaskIntent;
}

function confirmInput(value: unknown): { taskId: string; version: number } {
  const input = requireRecord(value, 'confirm args');
  return {
    taskId: requireString(input.taskId, 'taskId'),
    version: requireFiniteNumber(input.version, 'version'),
  };
}

function versionedInput(value: unknown): VersionArgs {
  const input = requireRecord(value, 'task version args');
  const version = optionalVersion(input.version);
  return {
    taskId: requireString(input.taskId, 'taskId'),
    ...(version === undefined ? {} : { version }),
  };
}

function taskIdInput(value: unknown): { taskId: string } {
  const input = requireRecord(value, 'task id args');
  return { taskId: requireString(input.taskId, 'taskId') };
}

/** `list` 的筛选面**全可选**，且缺席即「不筛这一维」——空对象是合法输入，不是形状错误。 */
function listFilterInput(value: unknown): ListFilter {
  const input = requireRecord(value, 'list filter');
  const filter: {
    accountId?: string;
    actionFamily?: DelegatedActionFamily;
    statuses?: DelegatedTaskStatus[];
    limit?: number;
  } = {};
  if (input.accountId !== undefined) filter.accountId = requireString(input.accountId, 'accountId');
  if (input.actionFamily !== undefined) {
    filter.actionFamily = requireString(input.actionFamily, 'actionFamily') as DelegatedActionFamily;
  }
  if (input.statuses !== undefined) {
    if (!Array.isArray(input.statuses)) {
      throw new InternalHttpError('api_direct_invalid_request', 'statuses must be an array');
    }
    filter.statuses = input.statuses.map((s, i) =>
      requireString(s, `statuses[${i}]`),
    ) as DelegatedTaskStatus[];
  }
  if (input.limit !== undefined) filter.limit = requireFiniteNumber(input.limit, 'limit');
  return filter;
}

/* ─────────────────────────────────────────── 服务端注册（automation 侧） */

/**
 * 把本地端口抛出的**业务拒绝**包一层传输层错误，好让它的 `name` / `status` 过得去那一跳。
 *
 * 不是业务拒绝的抛出物**原样冒泡**：传输层自己的错误照走线格式第一分支（附加位本来就保），
 * 没有具名 code 的抛出物照记 `handler_error`（那正是「处理器抛了个没名字的东西」= 未知，
 * MUST NOT 被伪造成某个业务原因）。
 */
async function withDelegatedBusinessErrorOrigin<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const origin = delegatedTaskErrorOriginOf(error);
    if (!origin) throw error;
    // 结构化读 message：跨进程来的业务错误是裸对象，`instanceof Error` 恒 false。
    const raw = error as { code: string; message?: unknown };
    const message = typeof raw.message === 'string' && raw.message.length > 0 ? raw.message : raw.code;
    throw new InternalHttpError(raw.code, message, origin);
  }
}

/**
 * 把一个本地 `DelegatedTaskServicePort` 的方法逐一注册为内部 HTTP route。
 * 只做信封解包 → 入参解析 → 转调本地端口 → 原样回传结果；不含任何业务逻辑。
 */
export function registerDelegatedTaskRoutes(
  server: InternalHttpServer,
  local: DelegatedTaskServicePort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(DELEGATED_TASK_ROUTES.createDraft, callerToken, (args) => {
    const intent = parseApiDirectEnvelope(args, executionTarget, createDraftInput);
    return withDelegatedBusinessErrorOrigin(() => local.createDraft(intent));
  });
  server.registerBearer(DELEGATED_TASK_ROUTES.confirm, callerToken, (args) => {
    const a = parseApiDirectEnvelope(args, executionTarget, confirmInput);
    return withDelegatedBusinessErrorOrigin(() => local.confirm(a.taskId, a.version));
  });
  server.registerBearer(DELEGATED_TASK_ROUTES.pause, callerToken, (args) => {
    const a = parseApiDirectEnvelope(args, executionTarget, versionedInput);
    return withDelegatedBusinessErrorOrigin(() => local.pause(a.taskId, a.version));
  });
  server.registerBearer(DELEGATED_TASK_ROUTES.resume, callerToken, (args) => {
    const a = parseApiDirectEnvelope(args, executionTarget, versionedInput);
    return withDelegatedBusinessErrorOrigin(() => local.resume(a.taskId, a.version));
  });
  server.registerBearer(DELEGATED_TASK_ROUTES.cancel, callerToken, (args) => {
    const a = parseApiDirectEnvelope(args, executionTarget, versionedInput);
    return withDelegatedBusinessErrorOrigin(() => local.cancel(a.taskId, a.version));
  });
  server.registerBearer(DELEGATED_TASK_ROUTES.get, callerToken, (args) => {
    const a = parseApiDirectEnvelope(args, executionTarget, taskIdInput);
    return withDelegatedBusinessErrorOrigin(() => local.get(a.taskId));
  });
  server.registerBearer(DELEGATED_TASK_ROUTES.list, callerToken, (args) => {
    const filter = parseApiDirectEnvelope(args, executionTarget, listFilterInput);
    return withDelegatedBusinessErrorOrigin(() => local.list(filter));
  });
}

/* ─────────────────────────────────────────────── 客户端（api 侧） */

/**
 * 客户端侧的**唯一**失败出口：先按补集判据还原业务拒绝，还原不出就把传输失败原样抛出去。
 *
 * 顺序不能倒：先还原、后冒泡。倒过来（先把一切译成传输失败）就是今天这个 bug 的形态——
 * 业务拒绝被吞成「服务不可用」，运营看到「服务挂了」，真相是「账号已暂停」。
 */
function throwDelegatedFailure(error: unknown): never {
  const restored = restoreDelegatedTaskServiceError(error);
  if (restored) throw restored;
  throw error;
}

/**
 * `DelegatedTaskServicePort` 的 HTTP 实现：满足同一个 kernel 接口，
 * 每个方法转成一次带信封 + Bearer 的内部 HTTP 调用。
 *
 * `executionTarget` **由构造参数注入**（组装根按本机部署事实给），
 * 7 个方法的入参里都没有 target 位——调用方无从选择。
 */
export class DelegatedTaskHttpClient implements DelegatedTaskServicePort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  private write<T>(
    route: string,
    input: unknown,
    validate: (value: unknown) => value is T,
  ): Promise<T> {
    return callApiDirectWrite(
      this.http,
      route,
      this.callerToken,
      this.executionTarget,
      input,
      validate,
      'api_authority_result_unknown',
    ).catch(throwDelegatedFailure);
  }

  private read<T>(
    route: string,
    input: unknown,
    validate: (value: unknown) => value is T,
  ): Promise<T> {
    return callApiDirectRead(
      this.http,
      route,
      this.callerToken,
      this.executionTarget,
      input,
      validate,
    ).catch(throwDelegatedFailure);
  }

  createDraft(intent: DelegatedTaskIntent): Promise<CreateDraftResult> {
    return this.write(DELEGATED_TASK_ROUTES.createDraft, intent, isCreateDraftResult);
  }

  confirm(taskId: string, version: number): Promise<DelegatedTask> {
    return this.write(DELEGATED_TASK_ROUTES.confirm, { taskId, version }, isDelegatedTask);
  }

  pause(taskId: string, version?: number): Promise<DelegatedTask> {
    return this.write(DELEGATED_TASK_ROUTES.pause, { taskId, version }, isDelegatedTask);
  }

  resume(taskId: string, version?: number): Promise<DelegatedTask> {
    return this.write(DELEGATED_TASK_ROUTES.resume, { taskId, version }, isDelegatedTask);
  }

  cancel(taskId: string, version?: number): Promise<DelegatedTask> {
    return this.write(DELEGATED_TASK_ROUTES.cancel, { taskId, version }, isDelegatedTask);
  }

  get(taskId: string): Promise<DelegatedTask> {
    return this.read(DELEGATED_TASK_ROUTES.get, { taskId }, isDelegatedTask);
  }

  list(filter?: {
    accountId?: string;
    actionFamily?: DelegatedActionFamily;
    statuses?: DelegatedTaskStatus[];
    limit?: number;
  }): Promise<DelegatedTask[]> {
    return this.read(DELEGATED_TASK_ROUTES.list, filter ?? {}, isDelegatedTaskArray);
  }
}

/** re-export 便于消费方一处引用（含确认摘要类型，client 的 createDraft 返回里用到）。 */
export type { DelegatedTaskConfirmationSummary };
