/**
 * 风控**写命令**端口的内部 HTTP 化（change cloud-coupling-phase5 · P5-1）。
 * 范式逐字照 {@link file://./risk-read-http.ts}。
 *
 *   1. server 侧：{@link registerRiskCommandRoutes} —— 跑在 automation 进程里，把本地
 *      {@link RiskCommandPort} 的三个方法暴露为内部 route。
 *   2. client 侧：{@link RiskCommandHttpClient} —— 跑在 api 进程里，满足**同一个** kernel 接口。
 *
 * 与只读端口的关键差别，也是本文件唯一需要盯住的地方：这里过的是**写**。所以两侧都 MUST 守住
 * 「提交只回 commandId、结果只由 outcomeOf 回读」——传输层 MUST NOT 为了让界面好看，
 * 在 submit 的响应里补任何状态字段。补出来的一定是编的（automation 那一刻也还不知道结果）。
 *
 * 允许引 kernel：`to === kernel` 恒 allowed。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type {
  RiskCommandAccepted,
  RiskCommandOutcome,
  RiskCommandPort,
  SubmitRiskQuotaLevelInput,
  SubmitRiskSignalInput,
} from '../kernel/risk-command-types.js';

/** 每个端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const RISK_COMMAND_ROUTES = {
  submitSignal: 'risk-command/submit-signal',
  submitQuotaLevel: 'risk-command/submit-quota-level',
  outcomeOf: 'risk-command/outcome-of',
} as const;

/** 把一个本地 `RiskCommandPort` 的方法逐一注册为内部 HTTP route。只做解包 → 转调 → 原样回传。 */
export function registerRiskCommandRoutes(server: InternalHttpServer, local: RiskCommandPort): void {
  server.register(RISK_COMMAND_ROUTES.submitSignal, (args) => local.submitSignal(args as SubmitRiskSignalInput));
  server.register(RISK_COMMAND_ROUTES.submitQuotaLevel, (args) =>
    local.submitQuotaLevel(args as SubmitRiskQuotaLevelInput),
  );
  server.register(RISK_COMMAND_ROUTES.outcomeOf, (args) => {
    const a = args as { commandId: string };
    return local.outcomeOf(a.commandId);
  });
}

/** `RiskCommandPort` 的 HTTP 实现：满足同一个 kernel 接口，每个方法一次内部调用。 */
export class RiskCommandHttpClient implements RiskCommandPort {
  constructor(private readonly http: InternalHttpClient) {}

  submitSignal(input: SubmitRiskSignalInput): Promise<RiskCommandAccepted> {
    return this.http.call<RiskCommandAccepted>(RISK_COMMAND_ROUTES.submitSignal, input);
  }

  submitQuotaLevel(input: SubmitRiskQuotaLevelInput): Promise<RiskCommandAccepted> {
    return this.http.call<RiskCommandAccepted>(RISK_COMMAND_ROUTES.submitQuotaLevel, input);
  }

  outcomeOf(commandId: string): Promise<RiskCommandOutcome> {
    return this.http.call<RiskCommandOutcome>(RISK_COMMAND_ROUTES.outcomeOf, { commandId });
  }
}
