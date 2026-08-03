/**
 * 内容排期调度器那一族窄口的 transport 三件套（路由表 + 服务端注册 + 客户端）。
 *
 * 方向是 **api → automation**：排期器住在接口进程，它每分钟要问的事实与三类扳机住在自动化进程。
 * 形状逐条照 4a 已建立的 paired command / operator command 办（`paired-command-http.ts`、
 * `operator-command-http.ts`），**不发明第二套机制**：
 *   ① 路由常量 `as const satisfies Record<keyof Port, string>` —— 端口加了方法而路由表没跟上时
 *      **typecheck 当场失败**，不会等到运行期 404；
 *   ② `registerContentSchedulingRoutes(server, local, callerToken, executionTarget)` —— 服务端注册，
 *      每条都走 `registerBearer` + `parseApiDirectEnvelope`（版本 + target 双校验）；
 *   ③ `ContentSchedulingHttpClient implements ContentSchedulingAutomationPort` —— 满足同一个 kernel
 *      接口，`executionTarget` 由构造参数注入，调用方无从选择。
 *
 * **九条读口全部走 `callApiDirectRead`**：失败抛 `api_authority_unavailable`。这不是风格选择 ——
 * 它们的失败方向由调用方按「哪边更严」判（见 kernel 契约文件头），客户端一旦 catch 成缺省值，
 * 那个决定就从调用方手里被悄悄拿走了，而且外部看不出区别。
 *
 * **三条扳机走 `callApiDirectWrite`**：失败抛 `api_authority_result_unknown`。触发有真实副作用
 * （可能已经开跑了），「超时了就当没发生」和「超时了就当发了」都是编造事实。
 */
import type { DeploymentTarget } from '../deployment-target.js';
import {
  isScheduledApprovalMode,
  isScheduledCommentVariant,
  isScheduledDelegatedFamily,
  isScheduledTriggerAcceptance,
  type ContentSchedulingAutomationPort,
  type ScheduledAccountInput,
  type ScheduledBusyView,
  type ScheduledCommentTriggerInput,
  type ScheduledCountView,
  type ScheduledDailyCapView,
  type ScheduledDelegatedOwnershipInput,
  type ScheduledJoinTriggerInput,
  type ScheduledOnlineAccountsView,
  type ScheduledPostExecutionInput,
  type ScheduledPostTriggerInput,
  type ScheduledRiskStatusView,
  type ScheduledTriggerAcceptance,
} from '../kernel/content-scheduling-port.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import {
  ApiDirectHttpError,
  callApiDirectRead,
  callApiDirectWrite,
  isNonNegativeInteger,
  isNullableString,
  isRecord,
  parseApiDirectEnvelope,
  requireRecord,
  requireString,
} from './api-direct-http-common.js';

/* ───────────────────────────────────────────────────────── 路由表 */

/**
 * `satisfies Record<keyof Port, string>` 是这一族「漏注册」的第一道机械闸：端口加一个方法、
 * 这里不加一条路由，typecheck 当场红。第二道（「main 里到底注册了没有」）在自动化仓的
 * 路由清单闸里，那道 typecheck 抓不到。
 */
export const CONTENT_SCHEDULING_ROUTES = {
  listOnlineAccounts: 'automation-authority/content-scheduling/v1/online-accounts',
  readRiskStatus: 'automation-authority/content-scheduling/v1/risk-status',
  readPublishBusy: 'automation-authority/content-scheduling/v1/publish-busy',
  readCommentBusy: 'automation-authority/content-scheduling/v1/comment-busy',
  readJoinBusy: 'automation-authority/content-scheduling/v1/join-busy',
  readDelegatedOwnershipBusy:
    'automation-authority/content-scheduling/v1/delegated-ownership-busy',
  readCommentedTodayCount: 'automation-authority/content-scheduling/v1/commented-today',
  readJoinedTodayCount: 'automation-authority/content-scheduling/v1/joined-today',
  readJoinDailyCap: 'automation-authority/content-scheduling/v1/join-daily-cap',
  triggerScheduledPost: 'automation-authority/content-scheduling/v1/trigger-post',
  triggerScheduledComment: 'automation-authority/content-scheduling/v1/trigger-comment',
  triggerScheduledJoin: 'automation-authority/content-scheduling/v1/trigger-join',
} as const satisfies Record<keyof ContentSchedulingAutomationPort, string>;

/* ─────────────────────────────────────────── 入参解析（服务端侧） */

function emptyInput(value: unknown): Record<string, never> {
  requireRecord(value, 'content scheduling input');
  return {};
}

function accountInput(value: unknown): ScheduledAccountInput {
  const input = requireRecord(value, 'content scheduling account input');
  return { accountId: requireString(input.accountId, 'accountId') };
}

function delegatedOwnershipInput(value: unknown): ScheduledDelegatedOwnershipInput {
  const input = requireRecord(value, 'delegated ownership input');
  const family = input.family;
  if (!isScheduledDelegatedFamily(family)) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'family must be comment or publish',
    );
  }
  return { accountId: requireString(input.accountId, 'accountId'), family };
}

function approvalModeOf(value: unknown): ScheduledPostTriggerInput['approvalMode'] {
  if (!isScheduledApprovalMode(value)) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'approvalMode must be manual_review or auto_approve',
    );
  }
  return value;
}

function postExecutionInput(value: unknown): ScheduledPostExecutionInput {
  const input = requireRecord(value, 'scheduled post execution');
  const executionTarget = requireString(input.executionTarget, 'execution.executionTarget');
  if (executionTarget !== 'dev' && executionTarget !== 'ol') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'execution.executionTarget must be dev or ol',
    );
  }
  // envKey 只作诊断，可空。**MUST NOT 把缺席补成空字符串**：那是个看着像数据的假值，
  // 与「记录了个空」再也分不开（迁移 0109 正是为此放宽了 NOT NULL）。
  const envKey = input.envKey;
  if (!isNullableString(envKey)) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'execution.envKey must be a string or null',
    );
  }
  return {
    executionTarget,
    envKey,
    hourCell: requireString(input.hourCell, 'execution.hourCell'),
  };
}

function postTriggerInput(value: unknown): ScheduledPostTriggerInput {
  const input = requireRecord(value, 'scheduled post trigger');
  return {
    accountId: requireString(input.accountId, 'accountId'),
    approvalMode: approvalModeOf(input.approvalMode),
    execution: postExecutionInput(input.execution),
  };
}

function commentTriggerInput(value: unknown): ScheduledCommentTriggerInput {
  const input = requireRecord(value, 'scheduled comment trigger');
  const variant = input.variant;
  if (!isScheduledCommentVariant(variant)) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'variant must be comment or contact_comment',
    );
  }
  return {
    accountId: requireString(input.accountId, 'accountId'),
    approvalMode: approvalModeOf(input.approvalMode),
    variant,
  };
}

function joinTriggerInput(value: unknown): ScheduledJoinTriggerInput {
  return accountInput(value);
}

/* ─────────────────────────────────────────── 应答形状守卫（客户端侧） */

function isOnlineAccountsView(value: unknown): value is ScheduledOnlineAccountsView {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return false;
  return value.accounts.every(
    (entry) =>
      isRecord(entry)
      && typeof entry.accountId === 'string'
      && isNullableString(entry.envKey),
  );
}

function isRiskStatusView(value: unknown): value is ScheduledRiskStatusView {
  return isRecord(value) && typeof value.status === 'string';
}

function isBusyView(value: unknown): value is ScheduledBusyView {
  return isRecord(value) && typeof value.busy === 'boolean';
}

function isCountView(value: unknown): value is ScheduledCountView {
  return isRecord(value) && isNonNegativeInteger(value.count);
}

function isDailyCapView(value: unknown): value is ScheduledDailyCapView {
  return isRecord(value) && isNonNegativeInteger(value.cap);
}

/* ─────────────────────────────────────────── 服务端注册（automation 侧） */

export function registerContentSchedulingRoutes(
  server: InternalHttpServer,
  local: ContentSchedulingAutomationPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(CONTENT_SCHEDULING_ROUTES.listOnlineAccounts, callerToken, (args) => {
    parseApiDirectEnvelope(args, executionTarget, emptyInput);
    return local.listOnlineAccounts();
  });
  server.registerBearer(CONTENT_SCHEDULING_ROUTES.readRiskStatus, callerToken, (args) =>
    local.readRiskStatus(parseApiDirectEnvelope(args, executionTarget, accountInput)),
  );
  server.registerBearer(CONTENT_SCHEDULING_ROUTES.readPublishBusy, callerToken, (args) =>
    local.readPublishBusy(parseApiDirectEnvelope(args, executionTarget, accountInput)),
  );
  server.registerBearer(CONTENT_SCHEDULING_ROUTES.readCommentBusy, callerToken, (args) =>
    local.readCommentBusy(parseApiDirectEnvelope(args, executionTarget, accountInput)),
  );
  server.registerBearer(CONTENT_SCHEDULING_ROUTES.readJoinBusy, callerToken, (args) =>
    local.readJoinBusy(parseApiDirectEnvelope(args, executionTarget, accountInput)),
  );
  server.registerBearer(
    CONTENT_SCHEDULING_ROUTES.readDelegatedOwnershipBusy,
    callerToken,
    (args) =>
      local.readDelegatedOwnershipBusy(
        parseApiDirectEnvelope(args, executionTarget, delegatedOwnershipInput),
      ),
  );
  server.registerBearer(
    CONTENT_SCHEDULING_ROUTES.readCommentedTodayCount,
    callerToken,
    (args) =>
      local.readCommentedTodayCount(
        parseApiDirectEnvelope(args, executionTarget, accountInput),
      ),
  );
  server.registerBearer(CONTENT_SCHEDULING_ROUTES.readJoinedTodayCount, callerToken, (args) =>
    local.readJoinedTodayCount(parseApiDirectEnvelope(args, executionTarget, accountInput)),
  );
  server.registerBearer(CONTENT_SCHEDULING_ROUTES.readJoinDailyCap, callerToken, (args) =>
    local.readJoinDailyCap(parseApiDirectEnvelope(args, executionTarget, accountInput)),
  );
  server.registerBearer(CONTENT_SCHEDULING_ROUTES.triggerScheduledPost, callerToken, (args) =>
    local.triggerScheduledPost(
      parseApiDirectEnvelope(args, executionTarget, postTriggerInput),
    ),
  );
  server.registerBearer(
    CONTENT_SCHEDULING_ROUTES.triggerScheduledComment,
    callerToken,
    (args) =>
      local.triggerScheduledComment(
        parseApiDirectEnvelope(args, executionTarget, commentTriggerInput),
      ),
  );
  server.registerBearer(CONTENT_SCHEDULING_ROUTES.triggerScheduledJoin, callerToken, (args) =>
    local.triggerScheduledJoin(
      parseApiDirectEnvelope(args, executionTarget, joinTriggerInput),
    ),
  );
}

/* ─────────────────────────────────────────────── 客户端（api 侧） */

export class ContentSchedulingHttpClient implements ContentSchedulingAutomationPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

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
    );
  }

  private trigger(route: string, input: unknown): Promise<ScheduledTriggerAcceptance> {
    return callApiDirectWrite(
      this.http,
      route,
      this.callerToken,
      this.executionTarget,
      input,
      isScheduledTriggerAcceptance,
      'api_authority_result_unknown',
    );
  }

  listOnlineAccounts(): Promise<ScheduledOnlineAccountsView> {
    return this.read(CONTENT_SCHEDULING_ROUTES.listOnlineAccounts, {}, isOnlineAccountsView);
  }

  readRiskStatus(input: ScheduledAccountInput): Promise<ScheduledRiskStatusView> {
    return this.read(CONTENT_SCHEDULING_ROUTES.readRiskStatus, input, isRiskStatusView);
  }

  readPublishBusy(input: ScheduledAccountInput): Promise<ScheduledBusyView> {
    return this.read(CONTENT_SCHEDULING_ROUTES.readPublishBusy, input, isBusyView);
  }

  readCommentBusy(input: ScheduledAccountInput): Promise<ScheduledBusyView> {
    return this.read(CONTENT_SCHEDULING_ROUTES.readCommentBusy, input, isBusyView);
  }

  readJoinBusy(input: ScheduledAccountInput): Promise<ScheduledBusyView> {
    return this.read(CONTENT_SCHEDULING_ROUTES.readJoinBusy, input, isBusyView);
  }

  readDelegatedOwnershipBusy(
    input: ScheduledDelegatedOwnershipInput,
  ): Promise<ScheduledBusyView> {
    return this.read(
      CONTENT_SCHEDULING_ROUTES.readDelegatedOwnershipBusy,
      input,
      isBusyView,
    );
  }

  readCommentedTodayCount(input: ScheduledAccountInput): Promise<ScheduledCountView> {
    return this.read(CONTENT_SCHEDULING_ROUTES.readCommentedTodayCount, input, isCountView);
  }

  readJoinedTodayCount(input: ScheduledAccountInput): Promise<ScheduledCountView> {
    return this.read(CONTENT_SCHEDULING_ROUTES.readJoinedTodayCount, input, isCountView);
  }

  readJoinDailyCap(input: ScheduledAccountInput): Promise<ScheduledDailyCapView> {
    return this.read(CONTENT_SCHEDULING_ROUTES.readJoinDailyCap, input, isDailyCapView);
  }

  triggerScheduledPost(input: ScheduledPostTriggerInput): Promise<ScheduledTriggerAcceptance> {
    return this.trigger(CONTENT_SCHEDULING_ROUTES.triggerScheduledPost, input);
  }

  triggerScheduledComment(
    input: ScheduledCommentTriggerInput,
  ): Promise<ScheduledTriggerAcceptance> {
    return this.trigger(CONTENT_SCHEDULING_ROUTES.triggerScheduledComment, input);
  }

  triggerScheduledJoin(input: ScheduledJoinTriggerInput): Promise<ScheduledTriggerAcceptance> {
    return this.trigger(CONTENT_SCHEDULING_ROUTES.triggerScheduledJoin, input);
  }
}
