/**
 * 四条运营指令的 transport 三件套（路由表 + 服务端注册 + 客户端），**本轮只定义、不接线**。
 *
 * 形状逐条照 4a 已建立的 paired command（`paired-command-http.ts` 的 edge-resume /
 * facebook-scope / publish-ui-update / persona-generator 四组）：
 *   1. 路由常量 `as const satisfies Record<keyof Port, string>` —— 端口加方法而路由表没跟上时
 *      **typecheck 当场失败**，不会等到运行期 404；
 *   2. `registerXxxCommandRoutes(server, local, callerToken, executionTarget)` —— 服务端注册，
 *      每条路由都走 `registerBearer` + `parseApiDirectEnvelope`（版本 + target 双校验）；
 *   3. `XxxHttpClient implements XxxPort` —— 客户端满足同一个 kernel 接口，`executionTarget`
 *      **由构造参数注入**（组合根按本机部署事实给），调用方无从选择。
 *
 * 三条语义在这一层的落点：
 *   - **target 服务端注入**：客户端构造参数 + 接收方 `parseApiDirectEnvelope` 逐字比对，不符即
 *     `api_direct_target_mismatch`。
 *   - **结果未知**：`callApiDirectWrite` / `callApiDirectRead` 把超时 / 连不上 / 形状不符统一译成
 *     `ApiDirectHttpError`（写路径 code = `api_authority_result_unknown`）。**抛，不是回一个 false**。
 *   - **未送达 ≠ 未知**：`not_delivered` 是接收方**答出来的**带内结论，走回执守卫、不走异常。
 *
 * **口径已统一**（此前这里记着一处「刻意不对齐」）：既有 `delegated-task-http.ts` 的 7 条委托路由
 * 曾是 4a 信封之前写的、用无鉴权 `server.register` + 裸 `http.call`、不带版本也不带 target；
 * 现已一并迁到信封 + Bearer 形态，两个文件共用同一套信封 helper 与同一份委托任务形状守卫。
 * **两个文件都留、都不是重复实现**：一个是端口面（7 方法的读写窄面），一个是指令面（四条运营指令，
 * 含委托的自由文本入口）；合成一个会让路由表失去 `satisfies Record<keyof Port, string>` 那道
 * 「端口加方法而路由没跟上就编译红」的保护。
 */
import type { DeploymentTarget } from '../deployment-target.js';
import {
  OPERATOR_COMMAND_CONTRACT_VERSION,
  isOperatorCommandRejection,
  isOperatorCommandUndeliveredReason,
  type AutomationDispatchActivity,
  type AutomationDispatchCommandInput,
  type AutomationDispatchCommandPort,
  type AutomationDispatchCommandReceipt,
  type DelegatedTaskTextCommandInput,
  type DelegatedTaskTextCommandPort,
  type DelegatedTaskTextCommandReceipt,
  type DelegatedTaskTextOutcome,
  type ManualCommentCommandInput,
  type ManualCommentCommandPort,
  type ManualCommentCommandReceipt,
  type ManualPublishCommandInput,
  type ManualPublishCommandPort,
  type ManualPublishCommandReceipt,
} from '../kernel/operator-command-port.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import {
  ApiDirectHttpError,
  callApiDirectRead,
  callApiDirectWrite,
  isNonNegativeInteger,
  isRecord,
  parseApiDirectEnvelope,
  requireRecord,
  requireString,
} from './api-direct-http-common.js';
// 委托任务的线上形状守卫**只有一份**，家在它所校验的那个端口面旁边（`delegated-task-http.ts`）。
// 本文件的自由文本回执里嵌着一个 DelegatedTask，用的就是那一份——复制第二份会各自编译过、
// 各自测试过，只在两边字段口径真的漂了的那一刻才看得出对不上。
import { isDelegatedConfirmation, isDelegatedTask } from './delegated-task-http.js';

/** 四条指令共用 4a 的契约版本号（见 kernel 侧说明：分开编号只会各自漂移）。 */
export const OPERATOR_COMMAND_HTTP_CONTRACT_VERSION = OPERATOR_COMMAND_CONTRACT_VERSION;

/* ───────────────────────────────────────────────────────── 路由表 */

export const DELEGATED_TASK_TEXT_COMMAND_ROUTES = {
  createFromText: 'automation-command/delegated-task-text/v1/create-from-text',
} as const satisfies Record<keyof DelegatedTaskTextCommandPort, string>;

export const MANUAL_PUBLISH_COMMAND_ROUTES = {
  triggerManualPublish: 'automation-command/manual-publish/v1/trigger',
} as const satisfies Record<keyof ManualPublishCommandPort, string>;

export const MANUAL_COMMENT_COMMAND_ROUTES = {
  triggerManualComment: 'automation-command/manual-comment/v1/trigger',
} as const satisfies Record<keyof ManualCommentCommandPort, string>;

export const AUTOMATION_DISPATCH_COMMAND_ROUTES = {
  setDispatch: 'automation-command/dispatch/v1/set',
  readDispatchActivity: 'automation-command/dispatch/v1/activity',
} as const satisfies Record<keyof AutomationDispatchCommandPort, string>;

/* ─────────────────────────────────────────── 入参解析（服务端侧） */

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ApiDirectHttpError('api_direct_invalid_request', `${label} must be a boolean`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function delegatedTaskTextInput(value: unknown): DelegatedTaskTextCommandInput {
  const input = requireRecord(value, 'delegated task text command');
  // `text` 用 requireString：空文本 MUST NOT 静默过闸——那正是「落一条无意图的委托」的入口。
  const sourceRef = optionalString(input.sourceRef, 'sourceRef');
  const originChatId = optionalString(input.originChatId, 'originChatId');
  return {
    commandId: requireString(input.commandId, 'commandId'),
    text: requireString(input.text, 'text'),
    ...(sourceRef === undefined ? {} : { sourceRef }),
    ...(originChatId === undefined ? {} : { originChatId }),
  };
}

function manualPublishInput(value: unknown): ManualPublishCommandInput {
  const input = requireRecord(value, 'manual publish command');
  const manualApprovalChatId = optionalString(
    input.manualApprovalChatId,
    'manualApprovalChatId',
  );
  return {
    commandId: requireString(input.commandId, 'commandId'),
    accountId: requireString(input.accountId, 'accountId'),
    ...(manualApprovalChatId === undefined ? {} : { manualApprovalChatId }),
  };
}

function manualCommentInput(value: unknown): ManualCommentCommandInput {
  const input = requireRecord(value, 'manual comment command');
  // manualOverride 必填：缺席 MUST NOT 被压成 false（也不得压成 true）——它是运营授权事实。
  if (typeof input.manualOverride !== 'boolean') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'manualOverride must be an explicit boolean',
    );
  }
  const injectContact = optionalBoolean(input.injectContact, 'injectContact');
  const joinFirst = optionalBoolean(input.joinFirst, 'joinFirst');
  const joinGroupUrl = optionalString(input.joinGroupUrl, 'joinGroupUrl');
  const force = optionalBoolean(input.force, 'force');
  const fastReturnToFeed = optionalBoolean(input.fastReturnToFeed, 'fastReturnToFeed');
  return {
    commandId: requireString(input.commandId, 'commandId'),
    accountId: requireString(input.accountId, 'accountId'),
    manualOverride: input.manualOverride,
    ...(injectContact === undefined ? {} : { injectContact }),
    ...(joinFirst === undefined ? {} : { joinFirst }),
    ...(joinGroupUrl === undefined ? {} : { joinGroupUrl }),
    ...(force === undefined ? {} : { force }),
    ...(fastReturnToFeed === undefined ? {} : { fastReturnToFeed }),
  };
}

function automationDispatchInput(value: unknown): AutomationDispatchCommandInput {
  const input = requireRecord(value, 'automation dispatch command');
  if (input.action !== 'start' && input.action !== 'stop') {
    throw new ApiDirectHttpError('api_direct_invalid_request', 'action must be start or stop');
  }
  return {
    commandId: requireString(input.commandId, 'commandId'),
    accountId: requireString(input.accountId, 'accountId'),
    action: input.action,
  };
}

/** 读端口的空入参：仍走信封，故版本与 target 照常校验。 */
function emptyInput(value: unknown): Record<string, never> {
  requireRecord(value, 'dispatch activity request');
  return {};
}

/* ─────────────────────────────────────────── 回执守卫（客户端侧） */

function isUndelivered(value: Record<string, unknown>, commandId: string): boolean {
  return (
    value.outcome === 'not_delivered' &&
    value.commandId === commandId &&
    isOperatorCommandUndeliveredReason(value.reason)
  );
}

function isCollision(value: Record<string, unknown>, commandId: string): boolean {
  return value.outcome === 'collision' && value.commandId === commandId;
}

function isAppliedOrDuplicate(value: Record<string, unknown>): boolean {
  return value.outcome === 'applied' || value.outcome === 'duplicate';
}

function isDelegatedTextOutcome(value: unknown): value is DelegatedTaskTextOutcome {
  if (!isRecord(value)) return false;
  if (value.kind === 'control') {
    return (
      typeof value.taskId === 'string' &&
      value.taskId.length > 0 &&
      (value.action === 'pause' ||
        value.action === 'resume' ||
        value.action === 'cancel' ||
        value.action === 'status')
    );
  }
  if (value.kind !== 'task') return false;
  return (
    isDelegatedTask(value.task) &&
    isDelegatedConfirmation(value.confirmation) &&
    typeof value.created === 'boolean' &&
    typeof value.autoQueued === 'boolean'
  );
}

function delegatedTextReceiptFor(
  input: DelegatedTaskTextCommandInput,
): (value: unknown) => value is DelegatedTaskTextCommandReceipt {
  return (value: unknown): value is DelegatedTaskTextCommandReceipt => {
    if (!isRecord(value)) return false;
    if (isCollision(value, input.commandId) || isUndelivered(value, input.commandId)) return true;
    if (value.commandId !== input.commandId) return false;
    if (value.outcome === 'rejected') return isOperatorCommandRejection(value.rejection);
    return isAppliedOrDuplicate(value) && isDelegatedTextOutcome(value.result);
  };
}

function isApprovalCardResult(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || typeof value.sent !== 'boolean') return false;
  return (
    value.targetSource === 'manual_source' ||
    value.targetSource === 'account_scope' ||
    value.targetSource === 'default_chat' ||
    value.targetSource === 'client_only_policy' ||
    value.targetSource === 'none'
  );
}

function isTriggerOutcome(value: unknown): boolean {
  if (!isRecord(value) || typeof value.reason !== 'string') return false;
  if (value.result === 'skipped' || value.result === 'blocked') return true;
  if (value.result !== 'triggered') return false;
  if (typeof value.status !== 'string') return false;
  if (
    value.recordId !== undefined &&
    value.recordId !== null &&
    !Number.isInteger(value.recordId)
  ) {
    return false;
  }
  if (value.failureReason !== undefined && typeof value.failureReason !== 'string') return false;
  return isApprovalCardResult(value.approvalCard);
}

function manualPublishReceiptFor(
  input: ManualPublishCommandInput,
): (value: unknown) => value is ManualPublishCommandReceipt {
  return (value: unknown): value is ManualPublishCommandReceipt => {
    if (!isRecord(value)) return false;
    if (isCollision(value, input.commandId) || isUndelivered(value, input.commandId)) return true;
    return (
      value.commandId === input.commandId &&
      value.accountId === input.accountId &&
      isAppliedOrDuplicate(value) &&
      isTriggerOutcome(value.result)
    );
  };
}

function isCommentCommandReceipt(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.ok !== 'boolean') return false;
  if (value.level !== 'success' && value.level !== 'warning' && value.level !== 'error') {
    return false;
  }
  if (typeof value.title !== 'string' || typeof value.message !== 'string') return false;
  return value.code === undefined || typeof value.code === 'string';
}

function manualCommentReceiptFor(
  input: ManualCommentCommandInput,
): (value: unknown) => value is ManualCommentCommandReceipt {
  return (value: unknown): value is ManualCommentCommandReceipt => {
    if (!isRecord(value)) return false;
    if (isCollision(value, input.commandId) || isUndelivered(value, input.commandId)) return true;
    return (
      value.commandId === input.commandId &&
      value.accountId === input.accountId &&
      isAppliedOrDuplicate(value) &&
      isCommentCommandReceipt(value.result)
    );
  };
}

function isDispatchState(value: unknown, accountId: string): boolean {
  return (
    isRecord(value) &&
    value.accountId === accountId &&
    (value.dispatch === 'started' || value.dispatch === 'stopped') &&
    typeof value.changed === 'boolean' &&
    isNonNegativeInteger(value.edgesOnline)
  );
}

function dispatchReceiptFor(
  input: AutomationDispatchCommandInput,
): (value: unknown) => value is AutomationDispatchCommandReceipt {
  return (value: unknown): value is AutomationDispatchCommandReceipt => {
    if (!isRecord(value)) return false;
    if (isCollision(value, input.commandId) || isUndelivered(value, input.commandId)) return true;
    return (
      value.commandId === input.commandId &&
      isAppliedOrDuplicate(value) &&
      isDispatchState(value.state, input.accountId)
    );
  };
}

/**
 * 状态灯读数守卫。**三态严格**：`unavailable` 必须带具名 reason，
 * 且 `known` 必须真的带一个布尔 —— 少一个字段就判形状不符并抛，
 * MUST NOT 让它退化成 `active === undefined` 被下游当成「停着」。
 */
function isDispatchActivity(value: unknown): value is AutomationDispatchActivity {
  if (!isRecord(value)) return false;
  if (value.state === 'known') return typeof value.active === 'boolean';
  return value.state === 'unavailable' && isOperatorCommandUndeliveredReason(value.reason);
}

/* ─────────────────────────────────────────── 服务端注册（automation 侧） */

export function registerDelegatedTaskTextCommandRoutes(
  server: InternalHttpServer,
  local: DelegatedTaskTextCommandPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    DELEGATED_TASK_TEXT_COMMAND_ROUTES.createFromText,
    callerToken,
    (args) =>
      local.createFromText(
        parseApiDirectEnvelope(args, executionTarget, delegatedTaskTextInput),
      ),
  );
}

export function registerManualPublishCommandRoutes(
  server: InternalHttpServer,
  local: ManualPublishCommandPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    MANUAL_PUBLISH_COMMAND_ROUTES.triggerManualPublish,
    callerToken,
    (args) =>
      local.triggerManualPublish(
        parseApiDirectEnvelope(args, executionTarget, manualPublishInput),
      ),
  );
}

export function registerManualCommentCommandRoutes(
  server: InternalHttpServer,
  local: ManualCommentCommandPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    MANUAL_COMMENT_COMMAND_ROUTES.triggerManualComment,
    callerToken,
    (args) =>
      local.triggerManualComment(
        parseApiDirectEnvelope(args, executionTarget, manualCommentInput),
      ),
  );
}

export function registerAutomationDispatchCommandRoutes(
  server: InternalHttpServer,
  local: AutomationDispatchCommandPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    AUTOMATION_DISPATCH_COMMAND_ROUTES.setDispatch,
    callerToken,
    (args) =>
      local.setDispatch(parseApiDirectEnvelope(args, executionTarget, automationDispatchInput)),
  );
  server.registerBearer(
    AUTOMATION_DISPATCH_COMMAND_ROUTES.readDispatchActivity,
    callerToken,
    (args) => {
      parseApiDirectEnvelope(args, executionTarget, emptyInput);
      return local.readDispatchActivity();
    },
  );
}

/* ─────────────────────────────────────────────── 客户端（api 侧） */

export class DelegatedTaskTextCommandHttpClient implements DelegatedTaskTextCommandPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  createFromText(
    input: DelegatedTaskTextCommandInput,
  ): Promise<DelegatedTaskTextCommandReceipt> {
    return callApiDirectWrite(
      this.http,
      DELEGATED_TASK_TEXT_COMMAND_ROUTES.createFromText,
      this.callerToken,
      this.executionTarget,
      input,
      delegatedTextReceiptFor(input),
      'api_authority_result_unknown',
    );
  }
}

export class ManualPublishCommandHttpClient implements ManualPublishCommandPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  triggerManualPublish(
    input: ManualPublishCommandInput,
  ): Promise<ManualPublishCommandReceipt> {
    return callApiDirectWrite(
      this.http,
      MANUAL_PUBLISH_COMMAND_ROUTES.triggerManualPublish,
      this.callerToken,
      this.executionTarget,
      input,
      manualPublishReceiptFor(input),
      'api_authority_result_unknown',
    );
  }
}

export class ManualCommentCommandHttpClient implements ManualCommentCommandPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  triggerManualComment(
    input: ManualCommentCommandInput,
  ): Promise<ManualCommentCommandReceipt> {
    return callApiDirectWrite(
      this.http,
      MANUAL_COMMENT_COMMAND_ROUTES.triggerManualComment,
      this.callerToken,
      this.executionTarget,
      input,
      manualCommentReceiptFor(input),
      'api_authority_result_unknown',
    );
  }
}

export class AutomationDispatchCommandHttpClient implements AutomationDispatchCommandPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  setDispatch(
    input: AutomationDispatchCommandInput,
  ): Promise<AutomationDispatchCommandReceipt> {
    return callApiDirectWrite(
      this.http,
      AUTOMATION_DISPATCH_COMMAND_ROUTES.setDispatch,
      this.callerToken,
      this.executionTarget,
      input,
      dispatchReceiptFor(input),
      'api_authority_result_unknown',
    );
  }

  /**
   * 状态灯是**读**：走 `callApiDirectRead`，失败抛 `api_authority_unavailable`。
   * 调用方（dashboard summary）MUST 把抛出译成「读不到」，**MUST NOT catch 成 `active:false`**——
   * 那就是把「云端答不上来」画成「调度引擎正常停着」。
   */
  readDispatchActivity(): Promise<AutomationDispatchActivity> {
    return callApiDirectRead(
      this.http,
      AUTOMATION_DISPATCH_COMMAND_ROUTES.readDispatchActivity,
      this.callerToken,
      this.executionTarget,
      {},
      isDispatchActivity,
    );
  }
}

/* ─────────────────────────────────────────────── 接线期欠账（显式登记） */

/**
 * 本轮**只定义契约**，以下几项 MUST 在接线那一轮处理，登记在此以免变成静默遗漏。
 * 它们都不是本文件能自己修的（涉及既有文件 / 组合根 / 归属表）。
 */
export const OPERATOR_COMMAND_WIRING_DEBT = [
  '三条写指令（自由文本委托 / 手动发帖 / 手动评论）的接收方 MUST 建持久幂等台账（按 commandId 判重并回放首次结果），跨进程重启仍成立；调度启停刻意不建——它改的是进程内布尔，给它持久台账会让重启后一次真实启动被判 duplicate 并回放陈旧事实',
  '四组路由的服务端注册与客户端 MUST 在组装根接上接收方与内部客户端；四个 api 侧接线点（飞书自由文本 / 飞书入站 deps / 客户端 API 发布队列视图 / 面板与客户端 API 主接线）MUST 全部改指同一个取数聚合口',
  'ApiDirectWriteErrorCode 可按 4a 惯例补四个逐命令的 *_result_unknown 码；本轮统一用 api_authority_result_unknown，不改既有 kernel 文件',
] as const;

/**
 * 已消的欠账（保留一行说明，免得后来人以为漏了）：
 *
 *   - 「既有 7 条路由不带信封」——**已消**，两个文件现在同一套信封 + Bearer + 形状守卫。
 *   - 「六个调用点用 `instanceof` 认业务错误、跨进程恒 false」——**已消，且是两半一起消的**：
 *     迁到结构化守卫只治了「原型链没了」，另一半是 `name` / `status` 在线格式那一跳被丢，
 *     由 `delegated-task-http.ts` 的服务端附加位 + kernel 的补集判据还原关掉。
 *     **只做前一半是纸面完成**：守卫判的正是那个被丢掉的字段。
 */
export const OPERATOR_COMMAND_WIRING_DEBT_CLOSED = [
  'delegated-task-http.ts 的 7 条路由已迁到信封 + Bearer 形态（含业务拒绝可跨线还原）',
  '六个 instanceof 调用点已迁结构化守卫，且线格式已把 name / status 带过那一跳',
] as const;
