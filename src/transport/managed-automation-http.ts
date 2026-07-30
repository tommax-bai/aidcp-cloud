/**
 * 期1-4 托管自动化入口操作（Create/Cancel/Query）的内部 HTTP 传输层。
 *
 * 形态沿用本目录既有三件套先例（publish-dispatch-trigger-http.ts / delegated-task-http.ts）：
 * 路由常量 + register 函数 + 类型化客户端。鉴权用 InternalHttpServer.registerBearer
 * （401 → internal_http_unauthorized，timing-safe 比较）。
 *
 * 信封版本化：每个请求携带 version + executionTarget（客户端声明其目标环境），
 * 服务端与自身 target 比对——不符即以既有原因码 'execution_target_mismatch' 拒收，
 * 版本不符 'protocol_version_mismatch'（复用 contracts/reason-codes.ts，不新造）。
 * 提案内部**不含** executionTarget（契约纪律：target 由服务端注入，Agent/客户端不能指定），
 * 信封上的 target 只做「打对门」校验。
 *
 * 总开关：AIDCP_MANAGED_AUTOMATION_API_ENABLED === 'true' 才注册路由（默认关闭，
 * fail-closed，与 AIDCP_MANAGED_AUTOMATION_WORKER_ENABLED 同风格）。开关关闭时组合根
 * **不注册路由**（未注册路由由 InternalHttpServer 统一回 404 route_not_found）——
 * 选「不注册」而非「注册后回未启用」：仓内先例是绝不注册一条注定失败的路由
 * （见 server.ts 各 capability 缺失时 warn + 不注册），且关闭时不构造 stores、
 * 不探测 schema，行为与主干完全一致。
 */

import type {
  CancelTaskProposal,
  CreateTaskProposal,
  QueryTaskRequest,
} from '../managed-automation/contracts/agent-intents.js';
import type { ExecutionTarget } from '../managed-automation/contracts/common.js';
import type {
  CancelTaskResult,
  CreateTaskResult,
  QueryTaskResult,
} from '../managed-automation/service/task-entry-service.js';
import {
  InternalHttpError,
  type InternalHttpClient,
  type InternalHttpServer,
} from './internal-http.js';

/** 总开关 env 名（对齐 MANAGED_AUTOMATION_WORKER_ENV 的命名与语义）。 */
export const MANAGED_AUTOMATION_API_ENV = 'AIDCP_MANAGED_AUTOMATION_API_ENABLED';

/** 仅字面 'true' 视为开启（默认关闭，fail-closed）。 */
export function isManagedAutomationApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MANAGED_AUTOMATION_API_ENV] === 'true';
}

export const MANAGED_AUTOMATION_CONTRACT_VERSION = 1;

/** server / client 两侧共用的路由名，防漂移。 */
export const MANAGED_AUTOMATION_ROUTES = {
  createTask: 'managed-automation/v1/create-task',
  cancelTask: 'managed-automation/v1/cancel-task',
  queryTask: 'managed-automation/v1/query-task',
} as const;

/** 版本化请求信封。 */
export interface ManagedAutomationEnvelope<T> {
  version: typeof MANAGED_AUTOMATION_CONTRACT_VERSION;
  executionTarget: ExecutionTarget;
  payload: T;
}

/** 传输层对服务层的窄端口（TaskEntryService 结构化满足）。 */
export interface ManagedAutomationEntryPort {
  createTask(executionTarget: ExecutionTarget, proposal: CreateTaskProposal): Promise<CreateTaskResult>;
  cancelTask(executionTarget: ExecutionTarget, proposal: CancelTaskProposal): Promise<CancelTaskResult>;
  queryTask(executionTarget: ExecutionTarget, request: QueryTaskRequest): Promise<QueryTaskResult>;
}

function unwrap<T>(args: unknown, expectedTarget: ExecutionTarget): T {
  if (!args || typeof args !== 'object') {
    throw new InternalHttpError('invalid_task_proposal', '请求体缺失或非对象');
  }
  const envelope = args as Partial<ManagedAutomationEnvelope<T>>;
  if (envelope.version !== MANAGED_AUTOMATION_CONTRACT_VERSION) {
    throw new InternalHttpError(
      'protocol_version_mismatch',
      `信封版本 ${String(envelope.version)} 不受支持（期望 ${MANAGED_AUTOMATION_CONTRACT_VERSION}）`,
    );
  }
  if (envelope.executionTarget !== expectedTarget) {
    throw new InternalHttpError(
      'execution_target_mismatch',
      `信封 target=${String(envelope.executionTarget)} 与服务端 target=${expectedTarget} 不符，拒收`,
    );
  }
  if (envelope.payload === undefined || envelope.payload === null) {
    throw new InternalHttpError('invalid_task_proposal', '信封缺 payload');
  }
  return envelope.payload;
}

export interface ManagedAutomationRouteOptions {
  /** 服务端自身运行的 target（组合根注入，进服务层的 target 只来自这里）。 */
  executionTarget: ExecutionTarget;
  bearerToken: string;
}

/**
 * 注册三条入口路由。开关判定在组合根（server.ts）：关闭时本函数不被调用，
 * 未注册路由回 404 route_not_found（见文件头选择说明）。
 */
export function registerManagedAutomationRoutes(
  server: InternalHttpServer,
  service: ManagedAutomationEntryPort,
  opts: ManagedAutomationRouteOptions,
): void {
  server.registerBearer(MANAGED_AUTOMATION_ROUTES.createTask, opts.bearerToken, (args) =>
    service.createTask(opts.executionTarget, unwrap<CreateTaskProposal>(args, opts.executionTarget)));
  server.registerBearer(MANAGED_AUTOMATION_ROUTES.cancelTask, opts.bearerToken, (args) =>
    service.cancelTask(opts.executionTarget, unwrap<CancelTaskProposal>(args, opts.executionTarget)));
  server.registerBearer(MANAGED_AUTOMATION_ROUTES.queryTask, opts.bearerToken, (args) =>
    service.queryTask(opts.executionTarget, unwrap<QueryTaskRequest>(args, opts.executionTarget)));
}

/** 类型化客户端：满足与服务层同形的调用面，每个方法一次 callBearer。 */
export class ManagedAutomationHttpClient {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly bearerToken: string,
    private readonly executionTarget: ExecutionTarget,
  ) {}

  createTask(proposal: CreateTaskProposal): Promise<CreateTaskResult> {
    return this.call<CreateTaskProposal, CreateTaskResult>(MANAGED_AUTOMATION_ROUTES.createTask, proposal);
  }

  cancelTask(proposal: CancelTaskProposal): Promise<CancelTaskResult> {
    return this.call<CancelTaskProposal, CancelTaskResult>(MANAGED_AUTOMATION_ROUTES.cancelTask, proposal);
  }

  queryTask(request: QueryTaskRequest): Promise<QueryTaskResult> {
    return this.call<QueryTaskRequest, QueryTaskResult>(MANAGED_AUTOMATION_ROUTES.queryTask, request);
  }

  private call<TIn, TOut>(route: string, payload: TIn): Promise<TOut> {
    const envelope: ManagedAutomationEnvelope<TIn> = {
      version: MANAGED_AUTOMATION_CONTRACT_VERSION,
      executionTarget: this.executionTarget,
      payload,
    };
    return this.http.callBearer<TOut>(route, envelope, this.bearerToken);
  }
}
