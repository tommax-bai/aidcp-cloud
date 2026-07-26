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
import { InternalHttpError, type InternalHttpClient, type InternalHttpServer } from './internal-http.js';
import type {
  RestrictedRecoveryOutcome,
  RiskCommandAccepted,
  RiskCommandExecutionTarget,
  RiskCommandOutcome,
  RiskCommandPort,
  SubmitRestrictedRecoveryInput,
  SubmitRiskQuotaLevelInput,
  SubmitRiskSignalInput,
} from '../kernel/risk-command-types.js';
import { RISK_COMMAND_CONTRACT_VERSION } from '../kernel/risk-command-types.js';

/** 每个端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const RISK_COMMAND_ROUTES = {
  submitSignal: 'risk-command/submit-signal',
  submitQuotaLevel: 'risk-command/submit-quota-level',
  outcomeOf: 'risk-command/outcome-of',
  submitRestrictedRecovery: 'risk-command/v1/submit-restricted-recovery',
  restrictedRecoveryOutcomeOf: 'risk-command/v1/restricted-recovery-outcome-of',
} as const;

export interface RiskCommandHttpServerOptions {
  /** automation 进程本地 target；缺失/非法时 recovery route fail-closed。 */
  executionTarget?: string;
}

export interface RiskCommandHttpClientOptions {
  /** api 进程本地 target；只能来自运行配置，不能来自客户请求。 */
  executionTarget?: string;
}

function isExecutionTarget(value: unknown): value is RiskCommandExecutionTarget {
  return value === 'dev' || value === 'ol';
}

function recoveryArgs(
  args: unknown,
  localExecutionTarget: string | undefined,
): Record<string, unknown> {
  if (!isExecutionTarget(localExecutionTarget)) {
    throw new InternalHttpError(
      'risk_command_target_unavailable',
      'risk-command recovery owner has no valid local execution target',
    );
  }
  if (args === null || typeof args !== 'object') {
    throw new InternalHttpError('risk_command_bad_request', 'risk-command recovery request must be an object');
  }
  const request = args as Record<string, unknown>;
  if (request.contractVersion !== RISK_COMMAND_CONTRACT_VERSION) {
    throw new InternalHttpError(
      'risk_command_contract_version_unsupported',
      `unsupported risk-command contract version: ${String(request.contractVersion)}`,
    );
  }
  if (!isExecutionTarget(request.executionTarget) || request.executionTarget !== localExecutionTarget) {
    throw new InternalHttpError(
      'risk_command_target_mismatch',
      `risk-command target ${String(request.executionTarget)} does not match local target`,
    );
  }
  return request;
}

/** 把一个本地 `RiskCommandPort` 的方法逐一注册为内部 HTTP route。只做解包 → 转调 → 原样回传。 */
export function registerRiskCommandRoutes(
  server: InternalHttpServer,
  local: RiskCommandPort,
  options: RiskCommandHttpServerOptions = {},
): void {
  server.register(RISK_COMMAND_ROUTES.submitSignal, (args) => local.submitSignal(args as SubmitRiskSignalInput));
  server.register(RISK_COMMAND_ROUTES.submitQuotaLevel, (args) =>
    local.submitQuotaLevel(args as SubmitRiskQuotaLevelInput),
  );
  server.register(RISK_COMMAND_ROUTES.outcomeOf, (args) => {
    const a = args as { commandId: string };
    return local.outcomeOf(a.commandId);
  });
  server.register(RISK_COMMAND_ROUTES.submitRestrictedRecovery, (args) => {
    const request = recoveryArgs(args, options.executionTarget);
    return local.submitRestrictedRecovery(request.input as SubmitRestrictedRecoveryInput);
  });
  server.register(RISK_COMMAND_ROUTES.restrictedRecoveryOutcomeOf, (args) => {
    const request = recoveryArgs(args, options.executionTarget);
    return local.restrictedRecoveryOutcomeOf(
      String(request.commandId ?? ''),
      String(request.envKey ?? ''),
      String(request.accountId ?? ''),
    );
  });
}

/** `RiskCommandPort` 的 HTTP 实现：满足同一个 kernel 接口，每个方法一次内部调用。 */
export class RiskCommandHttpClient implements RiskCommandPort {
  private readonly executionTarget?: RiskCommandExecutionTarget;

  constructor(
    private readonly http: InternalHttpClient,
    options: RiskCommandHttpClientOptions = {},
  ) {
    if (isExecutionTarget(options.executionTarget)) this.executionTarget = options.executionTarget;
  }

  submitSignal(input: SubmitRiskSignalInput): Promise<RiskCommandAccepted> {
    return this.http.call<RiskCommandAccepted>(RISK_COMMAND_ROUTES.submitSignal, input);
  }

  submitQuotaLevel(input: SubmitRiskQuotaLevelInput): Promise<RiskCommandAccepted> {
    return this.http.call<RiskCommandAccepted>(RISK_COMMAND_ROUTES.submitQuotaLevel, input);
  }

  outcomeOf(commandId: string): Promise<RiskCommandOutcome> {
    return this.http.call<RiskCommandOutcome>(RISK_COMMAND_ROUTES.outcomeOf, { commandId });
  }

  submitRestrictedRecovery(input: SubmitRestrictedRecoveryInput): Promise<RiskCommandAccepted> {
    const wire = this.recoveryWire({ input });
    return this.http.call<RiskCommandAccepted>(RISK_COMMAND_ROUTES.submitRestrictedRecovery, wire);
  }

  restrictedRecoveryOutcomeOf(
    commandId: string,
    envKey: string,
    accountId: string,
  ): Promise<RestrictedRecoveryOutcome> {
    const wire = this.recoveryWire({ commandId, envKey, accountId });
    return this.http.call<RestrictedRecoveryOutcome>(RISK_COMMAND_ROUTES.restrictedRecoveryOutcomeOf, wire);
  }

  private recoveryWire(body: Record<string, unknown>): Record<string, unknown> {
    if (!this.executionTarget) {
      throw new InternalHttpError(
        'risk_command_target_unavailable',
        'risk-command recovery client has no valid local execution target',
      );
    }
    return {
      contractVersion: RISK_COMMAND_CONTRACT_VERSION,
      executionTarget: this.executionTarget,
      ...body,
    };
  }
}
