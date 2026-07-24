/**
 * 证明性接线（behavior-zero）：把 Block① 抽好的 kernel 读接口 `CuratedContentReader`
 * 坐实成「可被内部 HTTP 化」。范式逐字照 {@link file://./delegated-task-http.ts}。
 *
 * 两件可测的东西：
 *   1. server 侧：{@link registerCuratedContentRoutes} —— 把一个本地 `CuratedContentReader`
 *      的每个只读方法暴露为内部 HTTP route（跑在托管精选库存储的进程里）。
 *   2. client 侧：{@link CuratedContentHttpClient} —— 用 {@link InternalHttpClient} 调那些 route，
 *      **满足同一个 kernel 接口** `CuratedContentReader`（跑在取数方进程里）。
 *
 * **不在 server.ts 独立起 server**：组合根默认仍注入本地实例（见 data-gateway 默认 local）。
 * 这里只是把「这个接口能被 HTTP 化」变成编译期成立、单测可验的代码。
 *
 * 允许引 kernel：`to === kernel` 恒 allowed；本文件对 kernel 契约的 import 不产生需豁免的跨层边。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type { CuratedContentReader } from '../kernel/curated-content-types.js';

/** 每个端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const CURATED_CONTENT_ROUTES = {
  listForClient: 'curated-content/list-for-client',
  getOneForAccount: 'curated-content/get-one-for-account',
} as const;

type ListForClientOpts = Parameters<CuratedContentReader['listForClient']>[1];
type ListForClientResult = Awaited<ReturnType<CuratedContentReader['listForClient']>>;
type GetOneResult = Awaited<ReturnType<CuratedContentReader['getOneForAccount']>>;

/**
 * 把一个本地 `CuratedContentReader` 的方法逐一注册为内部 HTTP route。
 * 只做参数解包 → 转调本地端口 → 原样回传结果；不含任何业务逻辑。
 */
export function registerCuratedContentRoutes(
  server: InternalHttpServer,
  local: CuratedContentReader,
): void {
  server.register(CURATED_CONTENT_ROUTES.listForClient, (args) => {
    const a = args as { accountId: string; opts: ListForClientOpts };
    return local.listForClient(a.accountId, a.opts);
  });
  server.register(CURATED_CONTENT_ROUTES.getOneForAccount, (args) => {
    const a = args as { id: number; accountId: string };
    return local.getOneForAccount(a.id, a.accountId);
  });
}

/**
 * `CuratedContentReader` 的 HTTP 实现：满足同一个 kernel 接口，
 * 每个方法转成一次 {@link InternalHttpClient.call}。
 */
export class CuratedContentHttpClient implements CuratedContentReader {
  constructor(private readonly http: InternalHttpClient) {}

  listForClient(accountId: string, opts: ListForClientOpts): Promise<ListForClientResult> {
    return this.http.call<ListForClientResult>(CURATED_CONTENT_ROUTES.listForClient, { accountId, opts });
  }

  getOneForAccount(id: number, accountId: string): Promise<GetOneResult> {
    return this.http.call<GetOneResult>(CURATED_CONTENT_ROUTES.getOneForAccount, { id, accountId });
  }
}
