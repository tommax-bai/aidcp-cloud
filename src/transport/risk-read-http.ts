/**
 * 证明性接线（behavior-zero）：把 kernel 只读投影端口 `RiskReadPort` 坐实成「可被内部 HTTP 化」。
 * 范式逐字照 {@link file://./curated-content-http.ts}。
 *
 * 两件可测的东西：
 *   1. server 侧：{@link registerRiskReadRoutes} —— 把一个本地 `RiskReadPort` 的每个只读方法暴露为
 *      内部 HTTP route（跑在托管风控 registry 的进程里）。
 *   2. client 侧：{@link RiskReadHttpClient} —— 用 {@link InternalHttpClient} 调那些 route，
 *      **满足同一个 kernel 接口** `RiskReadPort`（跑在取数 / 展示方进程里）。
 *
 * **不在 server.ts 独立起 server**：组合根默认仍注入本地投影适配（见数据网关默认 local）。
 * 这里只把「这个只读端口能被 HTTP 化」变成编译期成立、单测可验的代码。**只读、零写方法**——
 * 与 kernel 端口同构，传输层无从引入任何风控写路径。
 *
 * 允许引 kernel：`to === kernel` 恒 allowed；本文件对 kernel 契约的 import 不产生需豁免的跨层边。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type {
  RiskReadPort,
  RiskStateView,
  WindowQuotasView,
  SlowStartViewData,
} from '../kernel/risk-read-types.js';

/** 每个端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const RISK_READ_ROUTES = {
  getState: 'risk-read/get-state',
  effectiveQuotas: 'risk-read/effective-quotas',
  slowStartView: 'risk-read/slow-start-view',
} as const;

/**
 * 把一个本地 `RiskReadPort` 的方法逐一注册为内部 HTTP route。
 * 只做参数解包 → 转调本地端口 → 原样回传结果；不含任何业务逻辑。
 */
export function registerRiskReadRoutes(server: InternalHttpServer, local: RiskReadPort): void {
  server.register(RISK_READ_ROUTES.getState, (args) => {
    const a = args as { accountId: string };
    return local.getState(a.accountId);
  });
  server.register(RISK_READ_ROUTES.effectiveQuotas, (args) => {
    const a = args as { accountId: string };
    return local.effectiveQuotas(a.accountId);
  });
  server.register(RISK_READ_ROUTES.slowStartView, (args) => {
    const a = args as { accountId: string };
    return local.slowStartView(a.accountId);
  });
}

/**
 * `RiskReadPort` 的 HTTP 实现：满足同一个 kernel 接口，每个方法转成一次
 * {@link InternalHttpClient.call}。全部只读，按 accountId 入参。
 */
export class RiskReadHttpClient implements RiskReadPort {
  constructor(private readonly http: InternalHttpClient) {}

  getState(accountId: string): Promise<RiskStateView> {
    return this.http.call<RiskStateView>(RISK_READ_ROUTES.getState, { accountId });
  }

  effectiveQuotas(accountId: string): Promise<WindowQuotasView> {
    return this.http.call<WindowQuotasView>(RISK_READ_ROUTES.effectiveQuotas, { accountId });
  }

  slowStartView(accountId: string): Promise<SlowStartViewData> {
    return this.http.call<SlowStartViewData>(RISK_READ_ROUTES.slowStartView, { accountId });
  }
}
