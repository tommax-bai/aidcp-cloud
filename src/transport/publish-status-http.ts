/**
 * 证明性接线（behavior-zero）：把 Block① 抽好的 kernel 读接口 `PublishStatusReader`
 * 坐实成「可被内部 HTTP 化」。范式逐字照 {@link file://./curated-content-http.ts}。
 *
 * 两件可测的东西：
 *   1. server 侧：{@link registerPublishStatusRoutes} —— 把一个本地 `PublishStatusReader`
 *      的只读方法暴露为内部 HTTP route（跑在托管发布编排器的进程里）。
 *   2. client 侧：{@link PublishStatusHttpClient} —— 用 {@link InternalHttpClient} 调那个 route，
 *      **满足同一个 kernel 接口** `PublishStatusReader`（跑在取数方进程里）。
 *
 * **不在 server.ts 独立起 server**：组合根默认仍注入本地实例（见 data-gateway 默认 local）。
 * 这里只是把「这个接口能被 HTTP 化」变成编译期成立、单测可验的代码。
 *
 * 允许引 kernel：`to === kernel` 恒 allowed；本文件对 kernel 契约的 import 不产生需豁免的跨层边。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type { PublishQueueStatus, PublishStatusReader } from '../kernel/publish-status-types.js';

/** 端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const PUBLISH_STATUS_ROUTES = {
  getStatus: 'publish-status/get-status',
} as const;

/**
 * 把一个本地 `PublishStatusReader` 的方法注册为内部 HTTP route。
 * `getStatus` 无参数——handler 忽略 args 直接转调本地端口；不含任何业务逻辑。
 */
export function registerPublishStatusRoutes(
  server: InternalHttpServer,
  local: PublishStatusReader,
): void {
  server.register(PUBLISH_STATUS_ROUTES.getStatus, () => local.getStatus());
}

/**
 * `PublishStatusReader` 的 HTTP 实现：满足同一个 kernel 接口，
 * 无参方法 `getStatus` 转成一次 {@link InternalHttpClient.call}（传空 args）。
 */
export class PublishStatusHttpClient implements PublishStatusReader {
  constructor(private readonly http: InternalHttpClient) {}

  getStatus(): Promise<PublishQueueStatus> {
    return this.http.call<PublishQueueStatus>(PUBLISH_STATUS_ROUTES.getStatus, {});
  }
}
