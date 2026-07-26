/**
 * 「哪些参照稿已被触发过」的跨进程三件套。范式逐字照 {@link file://./curated-content-http.ts}。
 * 服务端跑在 **automation** 进程（委托任务台账在它的库里），客户端跑在 **content** 进程。
 *
 * 端口本体是现成的 kernel 契约 `TriggeredPublishRefsReader`。
 *
 * **失败原样抛，且这一条尤其不能吞。** 精选库拿这份集合来判「这条参照稿是不是已经用过了」：
 * 读不到时属主侧的既有实现是**抛具名的不可用错误**（`CuratedContentUnavailableError`），
 * 让调用方诚实拒绝，而不是当作「一条都没用过」。
 * 吞成空集合会让**每一条已用过的参照稿重新变成可用**——表现是同一份来稿被反复洗，
 * 而且看起来完全正常。这正是本仓红线点名的静默假成功。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type { TriggeredPublishRefsReader } from '../kernel/delegated-task-types.js';

/** 端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const TRIGGERED_PUBLISH_REFS_ROUTES = {
  triggeredPublishRefs: 'triggered-publish-refs/list',
} as const;

/** 把一个本地实现注册为内部 HTTP route。只做参数解包 → 转调 → 回传，零业务逻辑。 */
export function registerTriggeredPublishRefsRoutes(
  server: InternalHttpServer,
  local: TriggeredPublishRefsReader,
): void {
  server.register(TRIGGERED_PUBLISH_REFS_ROUTES.triggeredPublishRefs, (args) => {
    const a = args as { accountId: string; executionTarget: string };
    return local.triggeredPublishRefs(a.accountId, a.executionTarget);
  });
}

/** `TriggeredPublishRefsReader` 的 HTTP 实现：失败原样抛，绝不回空集合冒充「一条都没用过」。 */
export class TriggeredPublishRefsHttpClient implements TriggeredPublishRefsReader {
  constructor(private readonly http: InternalHttpClient) {}

  triggeredPublishRefs(
    accountId: string,
    executionTarget: string,
  ): Promise<{ curatedIds: string[]; sourceIds: string[] }> {
    return this.http.call<{ curatedIds: string[]; sourceIds: string[] }>(
      TRIGGERED_PUBLISH_REFS_ROUTES.triggeredPublishRefs,
      { accountId, executionTarget },
    );
  }
}
