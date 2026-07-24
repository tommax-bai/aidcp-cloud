/**
 * 证明性接线（behavior-zero）：把 Block① 抽好的 kernel 读接口 `InteractionStoreReaderPort`
 * 坐实成「可被内部 HTTP 化」。范式逐字照 {@link file://./delegated-task-http.ts}。
 *
 * 两件可测的东西：
 *   1. server 侧：{@link registerInteractionStoreReaderRoutes} —— 把一个本地
 *      `InteractionStoreReaderPort` 的每个读侧 / 请求账本方法暴露为内部 HTTP route
 *      （跑在托管 InteractionStore 的进程里）。
 *   2. client 侧：{@link InteractionStoreReaderHttpClient} —— 用 {@link InternalHttpClient}
 *      调那些 route，**满足同一个 kernel 接口**（跑在收件箱 HTTP 面所在进程里）。
 *
 * **不在 server.ts 独立起 server**：组合根默认仍注入本地实例（见 data-gateway 默认 local）。
 * 允许引 kernel：`to === kernel` 恒 allowed；本文件对 kernel 契约的 import 不产生需豁免的跨层边。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type { InteractionStoreReaderPort } from '../kernel/interaction-types.js';

type P<M extends keyof InteractionStoreReaderPort> = Parameters<InteractionStoreReaderPort[M]>;
type R<M extends keyof InteractionStoreReaderPort> = Awaited<ReturnType<InteractionStoreReaderPort[M]>>;

/** 每个端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
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
} as const;

/**
 * 把一个本地 `InteractionStoreReaderPort` 的方法逐一注册为内部 HTTP route。
 * 只做参数解包 → 转调本地端口 → 原样回传结果；不含任何业务逻辑。
 */
export function registerInteractionStoreReaderRoutes(
  server: InternalHttpServer,
  local: InteractionStoreReaderPort,
): void {
  server.register(INTERACTION_STORE_READER_ROUTES.getAuth, (args) => {
    const a = args as { accountId: string; envKey: string };
    return local.getAuth(a.accountId, a.envKey);
  });
  server.register(INTERACTION_STORE_READER_ROUTES.getSyncFreshness, (args) => {
    const a = args as { accountId: string; envKey: string };
    return local.getSyncFreshness(a.accountId, a.envKey);
  });
  server.register(INTERACTION_STORE_READER_ROUTES.listInteractions, (args) =>
    local.listInteractions(args as P<'listInteractions'>[0]),
  );
  server.register(INTERACTION_STORE_READER_ROUTES.listReplyPreviewContexts, (args) => {
    const a = args as { accountId: string; channel: P<'listReplyPreviewContexts'>[1]; limit: number };
    return local.listReplyPreviewContexts(a.accountId, a.channel, a.limit);
  });
  server.register(INTERACTION_STORE_READER_ROUTES.getDetail, (args) => {
    const a = args as {
      accountId: string; envKey: string; threadId: string; limit: number;
      before?: P<'getDetail'>[4];
    };
    return local.getDetail(a.accountId, a.envKey, a.threadId, a.limit, a.before);
  });
  server.register(INTERACTION_STORE_READER_ROUTES.getJobContext, (args) => {
    const a = args as { accountId: string; envKey: string; jobId: string };
    return local.getJobContext(a.accountId, a.envKey, a.jobId);
  });
  server.register(INTERACTION_STORE_READER_ROUTES.transitionMessageJob, (args) =>
    local.transitionMessageJob(args as P<'transitionMessageJob'>[0]),
  );
  server.register(INTERACTION_STORE_READER_ROUTES.getRuntimeControls, (args) => {
    const a = args as { accountId: string };
    return local.getRuntimeControls(a.accountId);
  });
  server.register(INTERACTION_STORE_READER_ROUTES.resetTestData, (args) =>
    local.resetTestData(args as P<'resetTestData'>[0]),
  );
  server.register(INTERACTION_STORE_READER_ROUTES.updateRuntimeControls, (args) =>
    local.updateRuntimeControls(args as P<'updateRuntimeControls'>[0]),
  );
  server.register(INTERACTION_STORE_READER_ROUTES.recordAudit, (args) =>
    local.recordAudit(args as P<'recordAudit'>[0]),
  );
  server.register(INTERACTION_STORE_READER_ROUTES.claimApiRequest, (args) =>
    local.claimApiRequest(args as P<'claimApiRequest'>[0]),
  );
  server.register(INTERACTION_STORE_READER_ROUTES.completeApiRequest, (args) => {
    const a = args as { requestId: string; response: unknown };
    return local.completeApiRequest(a.requestId, a.response);
  });
}

/**
 * `InteractionStoreReaderPort` 的 HTTP 实现：满足同一个 kernel 接口，
 * 每个方法转成一次 {@link InternalHttpClient.call}。
 */
export class InteractionStoreReaderHttpClient implements InteractionStoreReaderPort {
  constructor(private readonly http: InternalHttpClient) {}

  getAuth(accountId: string, envKey: string): Promise<R<'getAuth'>> {
    return this.http.call<R<'getAuth'>>(INTERACTION_STORE_READER_ROUTES.getAuth, { accountId, envKey });
  }

  getSyncFreshness(accountId: string, envKey: string): Promise<R<'getSyncFreshness'>> {
    return this.http.call<R<'getSyncFreshness'>>(INTERACTION_STORE_READER_ROUTES.getSyncFreshness, { accountId, envKey });
  }

  listInteractions(query: P<'listInteractions'>[0]): Promise<R<'listInteractions'>> {
    return this.http.call<R<'listInteractions'>>(INTERACTION_STORE_READER_ROUTES.listInteractions, query);
  }

  listReplyPreviewContexts(
    accountId: string,
    channel: P<'listReplyPreviewContexts'>[1],
    limit: number,
  ): Promise<R<'listReplyPreviewContexts'>> {
    return this.http.call<R<'listReplyPreviewContexts'>>(
      INTERACTION_STORE_READER_ROUTES.listReplyPreviewContexts,
      { accountId, channel, limit },
    );
  }

  getDetail(
    accountId: string,
    envKey: string,
    threadId: string,
    limit: number,
    before?: P<'getDetail'>[4],
  ): Promise<R<'getDetail'>> {
    return this.http.call<R<'getDetail'>>(
      INTERACTION_STORE_READER_ROUTES.getDetail,
      { accountId, envKey, threadId, limit, before },
    );
  }

  getJobContext(accountId: string, envKey: string, jobId: string): Promise<R<'getJobContext'>> {
    return this.http.call<R<'getJobContext'>>(
      INTERACTION_STORE_READER_ROUTES.getJobContext,
      { accountId, envKey, jobId },
    );
  }

  transitionMessageJob(input: P<'transitionMessageJob'>[0]): Promise<R<'transitionMessageJob'>> {
    return this.http.call<R<'transitionMessageJob'>>(INTERACTION_STORE_READER_ROUTES.transitionMessageJob, input);
  }

  getRuntimeControls(accountId: string): Promise<R<'getRuntimeControls'>> {
    return this.http.call<R<'getRuntimeControls'>>(INTERACTION_STORE_READER_ROUTES.getRuntimeControls, { accountId });
  }

  resetTestData(input: P<'resetTestData'>[0]): Promise<R<'resetTestData'>> {
    return this.http.call<R<'resetTestData'>>(INTERACTION_STORE_READER_ROUTES.resetTestData, input);
  }

  updateRuntimeControls(input: P<'updateRuntimeControls'>[0]): Promise<R<'updateRuntimeControls'>> {
    return this.http.call<R<'updateRuntimeControls'>>(INTERACTION_STORE_READER_ROUTES.updateRuntimeControls, input);
  }

  recordAudit(input: P<'recordAudit'>[0]): Promise<R<'recordAudit'>> {
    return this.http.call<R<'recordAudit'>>(INTERACTION_STORE_READER_ROUTES.recordAudit, input);
  }

  claimApiRequest(input: P<'claimApiRequest'>[0]): Promise<R<'claimApiRequest'>> {
    return this.http.call<R<'claimApiRequest'>>(INTERACTION_STORE_READER_ROUTES.claimApiRequest, input);
  }

  completeApiRequest(requestId: string, response: unknown): Promise<R<'completeApiRequest'>> {
    return this.http.call<R<'completeApiRequest'>>(
      INTERACTION_STORE_READER_ROUTES.completeApiRequest,
      { requestId, response },
    );
  }
}
