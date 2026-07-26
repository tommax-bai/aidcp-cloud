/**
 * 候审卡投递判定的跨进程三件套（服务端注册 + 客户端 + 路径常量）。范式逐字照
 * {@link file://./curated-content-http.ts}：只做参数解包 → 转调本地端口 → 原样回传，零业务逻辑。
 *
 * 服务端跑在 **api** 进程（那两张属主表在它的库里），客户端跑在 **content** 进程。
 *
 * **本文件与别的三件套有一处实质不同：客户端不透传异常。**
 * 这条口的语义是 fail-open —— 判不出来就照发飞书卡（见 kernel 接口文档）。
 * 单体里「读库失败 → send:true」是在实现体内部兜住的；拆进程后**新增了一整类失败**
 * （对端没起 / 端口没配 / 网络断 / 超时），它们在实现体之外，实现体的 try/catch 够不着。
 * 若让它们原样抛给调用方，`PublishExecutorRole` 那侧只会看到一个异常 ——
 * 结果不是「多发一张卡」，而是**整个候审出口失败**。故在客户端这一层把远程失败翻成
 * `{ send: true, reason: 'delivery_port_unreachable' }`。
 *
 * MUST NOT 把它「优化」成透传异常，也 MUST NOT 在失败时回 `send:false`：
 * 少发一张卡 = 一篇稿子没人知道要审；多发一张卡 = 有人多看一眼。方向只能朝后者倒。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type { ReviewCardDeliveryDecision, ReviewCardDeliveryPort } from '../kernel/review-card-delivery-port.js';

/** 端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const REVIEW_CARD_DELIVERY_ROUTES = {
  resolveReviewCardDelivery: 'review-card-delivery/resolve',
} as const;

/** 把一个本地判定实现注册为内部 HTTP route（跑在持有那两张 api 属主表的进程里）。 */
export function registerReviewCardDeliveryRoutes(
  server: InternalHttpServer,
  local: ReviewCardDeliveryPort,
): void {
  server.register(REVIEW_CARD_DELIVERY_ROUTES.resolveReviewCardDelivery, (args) => {
    const a = args as { accountId: string };
    return local.resolveReviewCardDelivery(a.accountId);
  });
}

/**
 * `ReviewCardDeliveryPort` 的 HTTP 实现。远程不可达时**不抛**，回 fail-open 结果并留一行 warn ——
 * 静默降级与静默失败都不接受，但降级方向必须是「照发」。
 */
export class ReviewCardDeliveryHttpClient implements ReviewCardDeliveryPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {}

  async resolveReviewCardDelivery(accountId: string): Promise<ReviewCardDeliveryDecision> {
    try {
      return await this.http.call<ReviewCardDeliveryDecision>(
        REVIEW_CARD_DELIVERY_ROUTES.resolveReviewCardDelivery,
        { accountId },
      );
    } catch (error) {
      this.logger.warn(
        `[approval-policy] 候审卡投递判定远程不可达，保留飞书卡 account=${accountId}: ${(error as Error).message}`,
      );
      return { send: true, reason: 'delivery_port_unreachable' };
    }
  }
}
