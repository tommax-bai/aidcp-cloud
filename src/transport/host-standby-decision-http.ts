/**
 * 宿主层让位判决遥测的跨进程只读通道（change report-host-standby-decisions）。
 *
 * 事实由 automation 段（边-云网关）收下并持在进程内；面板属 api 段。拆进程后 api 进程读不到
 * automation 的进程内状态，因此走与其它面板投影同一形态的内部 HTTP：**服务端注册 + 类型化客户端 +
 * 路径常量三件套写在一处**。复制成两份的现形方式不是编译报错，是两端路径悄悄对不上、只有真跑起来才 404。
 *
 * 两侧都实现同一个 kernel 只读端口，面板侧对「本地实现 / HTTP 客户端」零感知。
 */
import type {
  HostStandbyDecisionReader,
  HostStandbyDecisionRecord,
} from '../kernel/host-standby-decision-port.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';

export const HOST_STANDBY_DECISION_ROUTES = {
  list: 'host-standby-decision/list',
} as const;

/** 在 automation 内部 API 上挂只读路由。**只注册读**：本通道没有、也不该有写侧入口。 */
export function registerHostStandbyDecisionRoutes(
  server: InternalHttpServer,
  local: HostStandbyDecisionReader,
): void {
  server.register(HOST_STANDBY_DECISION_ROUTES.list, () => local.listHostStandbyDecisions());
}

/** 只读端口的 HTTP 实现。传输失败原样抛：MUST NOT 回空数组冒充「当前没有环境卡住」。 */
export class HostStandbyDecisionHttpClient implements HostStandbyDecisionReader {
  constructor(private readonly http: InternalHttpClient) {}

  listHostStandbyDecisions(): Promise<HostStandbyDecisionRecord[]> {
    return this.http.call<HostStandbyDecisionRecord[]>(HOST_STANDBY_DECISION_ROUTES.list, {});
  }
}
