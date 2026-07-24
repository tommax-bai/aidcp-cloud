/**
 * 证明性接线（behavior-zero）：把一个已在 Block① 抽好的 kernel 读接口
 * `DelegatedTaskServicePort` 坐实成「可被内部 HTTP 化」。
 *
 * 这里只提供两件可测的东西：
 *   1. server 侧：{@link registerDelegatedTaskRoutes} —— 把一个本地 `DelegatedTaskServicePort`
 *      的每个方法暴露为内部 HTTP route（跑在托管该服务的进程里）。
 *   2. client 侧：{@link DelegatedTaskHttpClient} —— 用 {@link InternalHttpClient} 调那些 route，
 *      **满足同一个 kernel 接口** `DelegatedTaskServicePort`（跑在取数方进程里）。
 *
 * **不在 server.ts 接线、不改默认注入**：组合根仍注入本地实例。这里只是把
 * 「这个接口能被 HTTP 化」这件事变成编译期成立、单测可验的代码。
 *
 * 允许引 kernel：`to === kernel` 恒 allowed（见 boundary-scan.classifyEdge），
 * 故本文件对 kernel 契约的 import 不产生任何需豁免的跨层边。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type {
  DelegatedActionFamily,
  DelegatedTask,
  DelegatedTaskConfirmationSummary,
  DelegatedTaskIntent,
  DelegatedTaskServicePort,
  DelegatedTaskStatus,
} from '../kernel/delegated-task-types.js';

/** 每个端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const DELEGATED_TASK_ROUTES = {
  createDraft: 'delegated-task/create-draft',
  confirm: 'delegated-task/confirm',
  pause: 'delegated-task/pause',
  resume: 'delegated-task/resume',
  cancel: 'delegated-task/cancel',
  get: 'delegated-task/get',
  list: 'delegated-task/list',
} as const;

type CreateDraftResult = Awaited<ReturnType<DelegatedTaskServicePort['createDraft']>>;
type VersionArgs = { taskId: string; version?: number };
type ListFilter = Parameters<DelegatedTaskServicePort['list']>[0];

/**
 * 把一个本地 `DelegatedTaskServicePort` 的方法逐一注册为内部 HTTP route。
 * 只做参数解包 → 转调本地端口 → 原样回传结果；不含任何业务逻辑。
 */
export function registerDelegatedTaskRoutes(
  server: InternalHttpServer,
  local: DelegatedTaskServicePort,
): void {
  server.register(DELEGATED_TASK_ROUTES.createDraft, (args) =>
    local.createDraft(args as DelegatedTaskIntent),
  );
  server.register(DELEGATED_TASK_ROUTES.confirm, (args) => {
    const a = args as { taskId: string; version: number };
    return local.confirm(a.taskId, a.version);
  });
  server.register(DELEGATED_TASK_ROUTES.pause, (args) => {
    const a = (args ?? {}) as VersionArgs;
    return local.pause(a.taskId, a.version);
  });
  server.register(DELEGATED_TASK_ROUTES.resume, (args) => {
    const a = (args ?? {}) as VersionArgs;
    return local.resume(a.taskId, a.version);
  });
  server.register(DELEGATED_TASK_ROUTES.cancel, (args) => {
    const a = (args ?? {}) as VersionArgs;
    return local.cancel(a.taskId, a.version);
  });
  server.register(DELEGATED_TASK_ROUTES.get, (args) => {
    const a = args as { taskId: string };
    return local.get(a.taskId);
  });
  server.register(DELEGATED_TASK_ROUTES.list, (args) => local.list((args ?? undefined) as ListFilter));
}

/**
 * `DelegatedTaskServicePort` 的 HTTP 实现：满足同一个 kernel 接口，
 * 每个方法转成一次 {@link InternalHttpClient.call}。
 */
export class DelegatedTaskHttpClient implements DelegatedTaskServicePort {
  constructor(private readonly http: InternalHttpClient) {}

  createDraft(intent: DelegatedTaskIntent): Promise<CreateDraftResult> {
    return this.http.call<CreateDraftResult>(DELEGATED_TASK_ROUTES.createDraft, intent);
  }

  confirm(taskId: string, version: number): Promise<DelegatedTask> {
    return this.http.call<DelegatedTask>(DELEGATED_TASK_ROUTES.confirm, { taskId, version });
  }

  pause(taskId: string, version?: number): Promise<DelegatedTask> {
    return this.http.call<DelegatedTask>(DELEGATED_TASK_ROUTES.pause, { taskId, version });
  }

  resume(taskId: string, version?: number): Promise<DelegatedTask> {
    return this.http.call<DelegatedTask>(DELEGATED_TASK_ROUTES.resume, { taskId, version });
  }

  cancel(taskId: string, version?: number): Promise<DelegatedTask> {
    return this.http.call<DelegatedTask>(DELEGATED_TASK_ROUTES.cancel, { taskId, version });
  }

  get(taskId: string): Promise<DelegatedTask> {
    return this.http.call<DelegatedTask>(DELEGATED_TASK_ROUTES.get, { taskId });
  }

  list(filter?: {
    accountId?: string;
    actionFamily?: DelegatedActionFamily;
    statuses?: DelegatedTaskStatus[];
    limit?: number;
  }): Promise<DelegatedTask[]> {
    return this.http.call<DelegatedTask[]>(DELEGATED_TASK_ROUTES.list, filter ?? {});
  }
}

/** re-export 便于消费方一处引用（含确认摘要类型，client 的 createDraft 返回里用到）。 */
export type { DelegatedTaskConfirmationSummary };
