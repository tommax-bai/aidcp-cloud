/**
 * 互动域读侧 / 请求账本的跨进程搬运。
 *
 * 两件可测的东西：
 *   1. server 侧：{@link registerInteractionStoreReaderRoutes} —— 把一个本地
 *      `InteractionStoreReaderPort` 的每个读侧 / 请求账本方法暴露为内部 HTTP route
 *      （跑在托管 InteractionStore 的进程里）。
 *   2. client 侧：{@link InteractionStoreReaderHttpClient} —— 用 {@link InternalHttpClient}
 *      调那些 route，**满足同一个 kernel 接口**（跑在收件箱 HTTP 面所在进程里）。
 *
 * 允许引 kernel：`to === kernel` 恒 allowed；本文件对 kernel 契约的 import 不产生需豁免的跨层边。
 *
 * ## 失败保真
 * 全族两侧都经 {@link interactionRoute} / {@link callInteraction}，保住互动失败的
 * `httpStatus` / `retryable` / `details` 三格 —— 通用传输骨架只搬 code + message，
 * 剩下两格会在跨进程那一跳上静默丢掉，理由与后果见 `./interaction-failure-wire.ts` 文件头。
 *
 * 本族**全部按 `read` 归类**：它们要么是读，要么是只改本域数据库、可凭幂等台账重来的写。
 * 真正的提交点（命令会离开进程、可能已上墙的那些）在 `./interaction-automation-http.ts`。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type { InteractionStoreReaderPort } from '../kernel/interaction-types.js';
import { callInteraction, interactionRoute } from './interaction-failure-wire.js';

type P<M extends keyof InteractionStoreReaderPort> = Parameters<InteractionStoreReaderPort[M]>;
type R<M extends keyof InteractionStoreReaderPort> = Awaited<ReturnType<InteractionStoreReaderPort[M]>>;

/**
 * 每个端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。
 * `satisfies` 钉住「每个端口方法都有一条、且不多不少」——新增端口方法时这里当场编译失败。
 */
export const INTERACTION_STORE_READER_ROUTES = {
  getAuth: 'interaction-store/get-auth',
  getSyncFreshness: 'interaction-store/get-sync-freshness',
  listInteractions: 'interaction-store/list-interactions',
  listReplyPreviewContexts: 'interaction-store/list-reply-preview-contexts',
  getDetail: 'interaction-store/get-detail',
  getJobContext: 'interaction-store/get-job-context',
  transitionMessageJob: 'interaction-store/transition-message-job',
  getRuntimeControls: 'interaction-store/get-runtime-controls',
  resetTestData: 'interaction-store/reset-test-data',
  updateRuntimeControls: 'interaction-store/update-runtime-controls',
  recordAudit: 'interaction-store/record-audit',
  claimApiRequest: 'interaction-store/claim-api-request',
  completeApiRequest: 'interaction-store/complete-api-request',
} as const satisfies Record<keyof InteractionStoreReaderPort, string>;

/**
 * 把一个本地 `InteractionStoreReaderPort` 的方法逐一注册为内部 HTTP route。
 * 只做参数解包 → 转调本地端口 → 原样回传结果；不含任何业务逻辑。
 */
export function registerInteractionStoreReaderRoutes(
  server: InternalHttpServer,
  local: InteractionStoreReaderPort,
): void {
  server.register(INTERACTION_STORE_READER_ROUTES.getAuth, interactionRoute((args) => {
    const a = args as { accountId: string; envKey: string };
    return local.getAuth(a.accountId, a.envKey);
  }));
  server.register(INTERACTION_STORE_READER_ROUTES.getSyncFreshness, interactionRoute((args) => {
    const a = args as { accountId: string; envKey: string };
    return local.getSyncFreshness(a.accountId, a.envKey);
  }));
  server.register(INTERACTION_STORE_READER_ROUTES.listInteractions, interactionRoute((args) =>
    local.listInteractions(args as P<'listInteractions'>[0]),
  ));
  server.register(INTERACTION_STORE_READER_ROUTES.listReplyPreviewContexts, interactionRoute((args) => {
    const a = args as { accountId: string; channel: P<'listReplyPreviewContexts'>[1]; limit: number };
    return local.listReplyPreviewContexts(a.accountId, a.channel, a.limit);
  }));
  server.register(INTERACTION_STORE_READER_ROUTES.getDetail, interactionRoute((args) => {
    const a = args as {
      accountId: string; envKey: string; threadId: string; limit: number;
      before?: P<'getDetail'>[4];
    };
    return local.getDetail(a.accountId, a.envKey, a.threadId, a.limit, a.before);
  }));
  server.register(INTERACTION_STORE_READER_ROUTES.getJobContext, interactionRoute((args) => {
    const a = args as { accountId: string; envKey: string; jobId: string };
    return local.getJobContext(a.accountId, a.envKey, a.jobId);
  }));
  server.register(INTERACTION_STORE_READER_ROUTES.transitionMessageJob, interactionRoute((args) =>
    local.transitionMessageJob(args as P<'transitionMessageJob'>[0]),
  ));
  server.register(INTERACTION_STORE_READER_ROUTES.getRuntimeControls, interactionRoute((args) => {
    const a = args as { accountId: string };
    return local.getRuntimeControls(a.accountId);
  }));
  server.register(INTERACTION_STORE_READER_ROUTES.resetTestData, interactionRoute((args) =>
    local.resetTestData(args as P<'resetTestData'>[0]),
  ));
  server.register(INTERACTION_STORE_READER_ROUTES.updateRuntimeControls, interactionRoute((args) =>
    local.updateRuntimeControls(args as P<'updateRuntimeControls'>[0]),
  ));
  server.register(INTERACTION_STORE_READER_ROUTES.recordAudit, interactionRoute((args) =>
    local.recordAudit(args as P<'recordAudit'>[0]),
  ));
  server.register(INTERACTION_STORE_READER_ROUTES.claimApiRequest, interactionRoute((args) =>
    local.claimApiRequest(args as P<'claimApiRequest'>[0]),
  ));
  server.register(INTERACTION_STORE_READER_ROUTES.completeApiRequest, interactionRoute((args) => {
    const a = args as { requestId: string; response: unknown };
    return local.completeApiRequest(a.requestId, a.response);
  }));
}

/**
 * `InteractionStoreReaderPort` 的 HTTP 实现：满足同一个 kernel 接口，
 * 每个方法转成一次 {@link callInteraction}。
 */
export class InteractionStoreReaderHttpClient implements InteractionStoreReaderPort {
  constructor(private readonly http: InternalHttpClient) {}

  getAuth(accountId: string, envKey: string): Promise<R<'getAuth'>> {
    return callInteraction<R<'getAuth'>>(
      this.http, INTERACTION_STORE_READER_ROUTES.getAuth, { accountId, envKey }, 'read',
    );
  }

  getSyncFreshness(accountId: string, envKey: string): Promise<R<'getSyncFreshness'>> {
    return callInteraction<R<'getSyncFreshness'>>(
      this.http, INTERACTION_STORE_READER_ROUTES.getSyncFreshness, { accountId, envKey }, 'read',
    );
  }

  listInteractions(query: P<'listInteractions'>[0]): Promise<R<'listInteractions'>> {
    return callInteraction<R<'listInteractions'>>(
      this.http, INTERACTION_STORE_READER_ROUTES.listInteractions, query, 'read',
    );
  }

  listReplyPreviewContexts(
    accountId: string,
    channel: P<'listReplyPreviewContexts'>[1],
    limit: number,
  ): Promise<R<'listReplyPreviewContexts'>> {
    return callInteraction<R<'listReplyPreviewContexts'>>(
      this.http,
      INTERACTION_STORE_READER_ROUTES.listReplyPreviewContexts,
      { accountId, channel, limit },
      'read',
    );
  }

  getDetail(
    accountId: string,
    envKey: string,
    threadId: string,
    limit: number,
    before?: P<'getDetail'>[4],
  ): Promise<R<'getDetail'>> {
    return callInteraction<R<'getDetail'>>(
      this.http,
      INTERACTION_STORE_READER_ROUTES.getDetail,
      { accountId, envKey, threadId, limit, before },
      'read',
    );
  }

  getJobContext(accountId: string, envKey: string, jobId: string): Promise<R<'getJobContext'>> {
    return callInteraction<R<'getJobContext'>>(
      this.http,
      INTERACTION_STORE_READER_ROUTES.getJobContext,
      { accountId, envKey, jobId },
      'read',
    );
  }

  transitionMessageJob(input: P<'transitionMessageJob'>[0]): Promise<R<'transitionMessageJob'>> {
    return callInteraction<R<'transitionMessageJob'>>(
      this.http, INTERACTION_STORE_READER_ROUTES.transitionMessageJob, input, 'read',
    );
  }

  getRuntimeControls(accountId: string): Promise<R<'getRuntimeControls'>> {
    return callInteraction<R<'getRuntimeControls'>>(
      this.http, INTERACTION_STORE_READER_ROUTES.getRuntimeControls, { accountId }, 'read',
    );
  }

  resetTestData(input: P<'resetTestData'>[0]): Promise<R<'resetTestData'>> {
    return callInteraction<R<'resetTestData'>>(
      this.http, INTERACTION_STORE_READER_ROUTES.resetTestData, input, 'read',
    );
  }

  updateRuntimeControls(input: P<'updateRuntimeControls'>[0]): Promise<R<'updateRuntimeControls'>> {
    return callInteraction<R<'updateRuntimeControls'>>(
      this.http, INTERACTION_STORE_READER_ROUTES.updateRuntimeControls, input, 'read',
    );
  }

  recordAudit(input: P<'recordAudit'>[0]): Promise<R<'recordAudit'>> {
    return callInteraction<R<'recordAudit'>>(
      this.http, INTERACTION_STORE_READER_ROUTES.recordAudit, input, 'read',
    );
  }

  claimApiRequest(input: P<'claimApiRequest'>[0]): Promise<R<'claimApiRequest'>> {
    return callInteraction<R<'claimApiRequest'>>(
      this.http, INTERACTION_STORE_READER_ROUTES.claimApiRequest, input, 'read',
    );
  }

  completeApiRequest(requestId: string, response: unknown): Promise<R<'completeApiRequest'>> {
    return callInteraction<R<'completeApiRequest'>>(
      this.http,
      INTERACTION_STORE_READER_ROUTES.completeApiRequest,
      { requestId, response },
      'read',
    );
  }
}
