/**
 * 风控写命令的 automation 侧实现（change cloud-coupling-phase5 · P5-1）。
 *
 * 面板不再持有 `RiskController`：它拿到的是 kernel 的 {@link RiskCommandPort}，只能「提交 + 回读」。
 * 本文件是那个端口跑在 **automation 进程**里的实现——
 *   - 提交 = 往 `event_outbox` 落一条 `risk.command`（只写数据、不碰风控运行时）；
 *   - 回读 = 查 `risk_command_outcome` 结果账本，查不到再确认命令是否真的存在。
 *   - 落地 = {@link recordApplied} / {@link recordFailed}，由组合根的单写者回调在应用完之后调用。
 *
 * **本文件不 import `RiskController`**：单写仍只发生在组合根注入给 outbox 消费者的那一个回调里。
 * 这里只做数据进出，保证「命令是数据、写是行为，行为只在一处发生」。
 *
 * 三态判定的顺序不可颠倒（红线：静默假成功）：
 *   1. 结果账本有行 → applied / failed（真态，单写者写完回读的）；
 *   2. 无行但 outbox 有该命令 → processing（如实：还没轮到，或正卡住重放）；
 *   3. 两处都没有 → unknown（**绝不回落 processing**，否则界面永远转圈、失败永不可见）。
 */
import type pg from 'pg';

import type {
  RestrictedRecoveryOutcome,
  RestrictedRecoveryFailureReason,
  RestrictedRecoveryResumeFailure,
  RestrictedRecoveryRiskState,
  RiskCommandAccepted,
  RiskCommandExecutionTarget,
  RiskCommandOutcome,
  RiskCommandPort,
  SubmitRestrictedRecoveryInput,
  SubmitRiskQuotaLevelInput,
  SubmitRiskSignalInput,
} from '../kernel/risk-command-types.js';
import type { RiskQuotaLevel, RiskSignal, RiskSignalKind, RiskState } from './types.js';
import {
  emitRiskCommand,
  RISK_COMMAND_TOPIC,
  type RiskCommand,
  type RiskCommandApply,
} from '../transport/risk-command-outbox.js';

export interface RiskCommandServiceOptions {
  pool: pg.Pool;
  /** 归属目标（'dev' | 'ol'）。构造时 fail-closed；本服务 MUST NOT 从请求推导。 */
  executionTarget: string;
  logger?: Pick<Console, 'warn'>;
}

interface OutcomeRow {
  command_id: string | number;
  state: string;
  status: string | null;
  quota_level: string | null;
  reason: string | null;
  decided_at: Date;
}

interface RestrictedRecoveryOutcomeRow extends OutcomeRow {
  env_key: string | null;
  account_id: string;
  command_kind: string;
  signal_count: number | string | null;
  last_signal_at: number | string | null;
  status_since: number | string | null;
  state_updated_at: number | string | null;
  recovery_changed: boolean | null;
  recovery_refusal: string | null;
  resumed_edges: number | string | null;
  resume_failure: string | null;
  resume_state: string | null;
}

export type RestrictedRecoveryStage =
  | 'missing'
  | 'submitted'
  | 'applying'
  | 'refused'
  | 'failed'
  | 'applied_resume_incomplete'
  | 'applied_resume_pending'
  | 'applied_resume_claimed'
  | 'applied_resume_completed';

function isExecutionTarget(value: string): value is RiskCommandExecutionTarget {
  return value === 'dev' || value === 'ol';
}

function asFiniteNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicRecoveryFailureReason(value: string | null): RestrictedRecoveryFailureReason {
  switch (value) {
    case 'recovery_application_failed':
    case 'recovery_application_indeterminate':
    case 'recovery_result_recording_failed':
    case 'recovery_write_after_invalid':
    case 'recovery_outcome_incomplete':
      return value;
    default:
      return 'recovery_application_failed';
  }
}

function recoveryRiskFromRow(row: RestrictedRecoveryOutcomeRow): RestrictedRecoveryRiskState | null {
  const signalCount = asFiniteNumber(row.signal_count);
  const lastSignalAt = asFiniteNumber(row.last_signal_at);
  const statusSince = asFiniteNumber(row.status_since);
  const updatedAt = asFiniteNumber(row.state_updated_at);
  if (
    !row.status ||
    !row.quota_level ||
    signalCount === null ||
    statusSince === null ||
    updatedAt === null
  ) {
    return null;
  }
  return {
    accountId: row.account_id,
    status: row.status,
    quotaLevel: row.quota_level,
    signalCount,
    lastSignalAt,
    statusSince,
    updatedAt,
  };
}

export class PgRiskCommandService implements RiskCommandPort {
  private readonly pool: pg.Pool;
  private readonly executionTarget: RiskCommandExecutionTarget;
  private readonly logger: Pick<Console, 'warn'>;

  constructor(options: RiskCommandServiceOptions) {
    if (!isExecutionTarget(options.executionTarget)) {
      throw new Error(`risk_command_invalid_execution_target:${options.executionTarget || 'missing'}`);
    }
    this.pool = options.pool;
    this.executionTarget = options.executionTarget;
    this.logger = options.logger ?? console;
  }

  async submitSignal(input: SubmitRiskSignalInput): Promise<RiskCommandAccepted> {
    return this.submit(
      {
        kind: 'applySignal',
        accountId: input.accountId,
        signal: {
          kind: input.kind as RiskSignalKind,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      },
      null,
      input.accountId,
      input.requestedBy,
    );
  }

  async submitRestrictedRecovery(input: SubmitRestrictedRecoveryInput): Promise<RiskCommandAccepted> {
    return this.submit(
      {
        kind: 'recoverRestricted',
        envKey: input.envKey,
        accountId: input.accountId,
        reason: input.reason,
      },
      input.envKey,
      input.accountId,
      input.requestedBy,
    );
  }

  async submitQuotaLevel(input: SubmitRiskQuotaLevelInput): Promise<RiskCommandAccepted> {
    return this.submit(
      { kind: 'setQuotaLevel', accountId: input.accountId, level: input.level as RiskQuotaLevel },
      null,
      input.accountId,
      input.requestedBy,
    );
  }

  /**
   * 提交人不进命令载荷（载荷形状由 outbox 契约固定、两侧共用），而是随结果账本一起落。
   * 提交时先占一行 `requested_by`——单写者稍后 upsert 结局时保留它，审计链不断。
   */
  private async submit(
    cmd: RiskCommand,
    envKey: string | null,
    accountId: string,
    requestedBy: string,
  ): Promise<RiskCommandAccepted> {
    const { id } = await emitRiskCommand(this.pool, this.executionTarget, cmd, this.logger);
    try {
      await this.pool.query(
        `INSERT INTO risk_command_outcome
           (command_id, execution_target, env_key, account_id, command_kind, state, requested_by, decided_at)
         VALUES ($1, $2, $3, $4, $5, 'submitted', $6, now())
         ON CONFLICT (command_id) DO NOTHING`,
        [id, this.executionTarget, envKey, accountId, cmd.kind, requestedBy],
      );
    } catch {
      // 占位行写不进不影响承重链路：命令已在 outbox 里、单写者照常应用。
      // 唯一代价是审计里少一个提交人；绝不因此把已入队的命令报成失败。
      this.logger.warn(`[risk-command] 提交人占位行写入失败 commandId=${id}（命令已入队，不影响应用）`);
    }
    return { commandId: String(id) };
  }

  async outcomeOf(commandId: string): Promise<RiskCommandOutcome> {
    const id = Number(commandId);
    if (!Number.isSafeInteger(id) || id <= 0) return { commandId, state: 'unknown' };

    const { rows } = await this.pool.query<OutcomeRow>(
      `SELECT command_id, state, status, quota_level, reason, decided_at
         FROM risk_command_outcome
        WHERE command_id = $1 AND execution_target = $2`,
      [id, this.executionTarget],
    );
    const row = rows[0];
    if (row && row.state === 'applied') {
      return {
        commandId,
        state: 'applied',
        decidedAt: row.decided_at.getTime(),
        status: row.status ?? '',
        quotaLevel: row.quota_level ?? '',
      };
    }
    if (row && row.state === 'failed') {
      return {
        commandId,
        state: 'failed',
        decidedAt: row.decided_at.getTime(),
        reason: row.reason ?? 'unspecified',
      };
    }

    // 占位行存在（state='submitted'）即证明这条命令确实被提交过 → processing。
    if (row) return { commandId, state: 'processing' };

    // 占位行没写成时的兜底：直接问 outbox 这条命令在不在。
    const { rows: cmdRows } = await this.pool.query<{ id: string | number }>(
      `SELECT id FROM event_outbox WHERE id = $1 AND topic = $2 AND execution_target = $3`,
      [id, RISK_COMMAND_TOPIC, this.executionTarget],
    );
    if (cmdRows.length > 0) return { commandId, state: 'processing' };

    // 两处都查不到：这条 id 从未被本 target 受理。诚实回 unknown，MUST NOT 当 processing。
    return { commandId, state: 'unknown' };
  }

  /**
   * restricted recovery 结局必须同时匹配 commandId + envKey + accountId + executionTarget。
   * command id 可枚举，任何一个维度不匹配都按不可见 `unknown` 处理，不泄露别的账号结局。
   */
  async restrictedRecoveryOutcomeOf(
    commandId: string,
    envKey: string,
    accountId: string,
  ): Promise<RestrictedRecoveryOutcome> {
    const id = Number(commandId);
    if (!Number.isSafeInteger(id) || id <= 0 || envKey.length === 0 || accountId.length === 0) {
      return { commandId, state: 'unknown' };
    }

    const row = await this.restrictedRecoveryRow(id, envKey, accountId);
    if (row?.state === 'applied' && row.resume_state === 'completed') {
      const risk = recoveryRiskFromRow(row);
      const resumedEdges = asFiniteNumber(row.resumed_edges);
      const resumeError =
        row.resume_failure === 'edge_resume_failed' || row.resume_failure === 'edge_resume_result_unknown'
          ? row.resume_failure
          : undefined;
      if (
        !risk ||
        row.recovery_changed === null ||
        resumedEdges === null ||
        (row.resume_failure !== null && resumeError === undefined)
      ) {
        return { commandId, state: 'failed', reason: 'recovery_outcome_incomplete' };
      }
      return {
        commandId,
        state: 'applied',
        risk,
        changed: row.recovery_changed,
        resumedEdges,
        ...(resumeError ? { resumeError } : {}),
      };
    }
    if (row?.state === 'refused') {
      const risk = recoveryRiskFromRow(row);
      if (!risk || row.recovery_refusal !== 'state_not_restricted') {
        return { commandId, state: 'failed', reason: 'recovery_outcome_incomplete' };
      }
      return { commandId, state: 'refused', reason: row.recovery_refusal, risk };
    }
    if (row?.state === 'failed') {
      return { commandId, state: 'failed', reason: publicRecoveryFailureReason(row.reason) };
    }
    if (
      row?.state === 'applied' &&
      row.resume_state !== 'pending' &&
      row.resume_state !== 'claimed' &&
      row.resume_state !== 'completed'
    ) {
      return { commandId, state: 'failed', reason: 'recovery_outcome_incomplete' };
    }
    if (row) return { commandId, state: 'processing' };

    // 同 command/target 已有 recovery 账本但 env/account 不匹配（含 0080 前 env_key=NULL 的旧行）
    // 一律不可见 unknown。不能再回落 outbox，否则旧行会被新 payload 的 envKey“补猜”为 processing。
    const { rows: scopedElsewhere } = await this.pool.query<{ command_id: string | number }>(
      `SELECT command_id
         FROM risk_command_outcome
        WHERE command_id = $1
          AND execution_target = $2
          AND command_kind = 'recoverRestricted'
        LIMIT 1`,
      [id, this.executionTarget],
    );
    if (scopedElsewhere.length > 0) return { commandId, state: 'unknown' };

    // 占位行写失败时仍可由 durable command 证明 processing；环境、账号与 kind 必须同时匹配。
    const { rows: cmdRows } = await this.pool.query<{ id: string | number }>(
      `SELECT id
         FROM event_outbox
        WHERE id = $1
          AND topic = $2
          AND execution_target = $3
          AND payload->>'envKey' = $4
          AND payload->>'accountId' = $5
          AND payload->>'kind' = 'recoverRestricted'`,
      [id, RISK_COMMAND_TOPIC, this.executionTarget, envKey, accountId],
    );
    return cmdRows.length > 0 ? { commandId, state: 'processing' } : { commandId, state: 'unknown' };
  }

  private async restrictedRecoveryRow(
    commandId: number,
    envKey: string,
    accountId: string,
  ): Promise<RestrictedRecoveryOutcomeRow | undefined> {
    const { rows } = await this.pool.query<RestrictedRecoveryOutcomeRow>(
      `SELECT command_id, execution_target, env_key, account_id, command_kind, state,
              status, quota_level, signal_count, last_signal_at, status_since, state_updated_at,
              recovery_changed, recovery_refusal, resumed_edges, resume_failure, resume_state,
              reason, decided_at
         FROM risk_command_outcome
        WHERE command_id = $1
          AND execution_target = $2
          AND env_key = $3
          AND account_id = $4
          AND command_kind = 'recoverRestricted'`,
      [commandId, this.executionTarget, envKey, accountId],
    );
    return rows[0];
  }

  async restrictedRecoveryStageOf(
    commandId: number,
    envKey: string,
    accountId: string,
  ): Promise<RestrictedRecoveryStage> {
    const row = await this.restrictedRecoveryRow(commandId, envKey, accountId);
    if (!row) return 'missing';
    if (row.state === 'submitted') return 'submitted';
    if (row.state === 'applying') return 'applying';
    if (row.state === 'refused') return 'refused';
    if (row.state === 'failed') return 'failed';
    if (row.state !== 'applied') return 'failed';
    if (row.resume_state === 'completed') return 'applied_resume_completed';
    if (row.resume_state === 'claimed') return 'applied_resume_claimed';
    if (row.resume_state === 'pending') return 'applied_resume_pending';
    return 'applied_resume_incomplete';
  }

  /** 单写者应用成功后落真态（`status` / `quotaLevel` 由调用方从 controller 回读，MUST NOT 推断）。 */
  async recordApplied(commandId: number, status: string, quotaLevel: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO risk_command_outcome
         (command_id, execution_target, account_id, command_kind, state, status, quota_level, decided_at)
       VALUES ($1, $2, '', '', 'applied', $3, $4, now())
       ON CONFLICT (command_id) DO UPDATE
         SET state = 'applied', status = EXCLUDED.status, quota_level = EXCLUDED.quota_level,
             reason = NULL, decided_at = now()`,
      [commandId, this.executionTarget, status, quotaLevel],
    );
  }

  /** 单写者应用失败后落具名原因。at-least-once 重投成功时会被上面的 upsert 覆盖成 applied。 */
  async recordFailed(commandId: number, reason: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO risk_command_outcome
         (command_id, execution_target, account_id, command_kind, state, reason, decided_at)
       VALUES ($1, $2, '', '', 'failed', $3, now())
       ON CONFLICT (command_id) DO UPDATE
         SET state = 'failed', reason = EXCLUDED.reason, status = NULL, quota_level = NULL, decided_at = now()`,
      [commandId, this.executionTarget, reason],
    );
  }

  async markRestrictedRecoveryApplying(
    commandId: number,
    envKey: string,
    accountId: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO risk_command_outcome
         (command_id, execution_target, env_key, account_id, command_kind, state, decided_at)
       VALUES ($1, $2, $3, $4, 'recoverRestricted', 'applying', now())
       ON CONFLICT (command_id) DO UPDATE
         SET state = 'applying', decided_at = now()
       WHERE risk_command_outcome.execution_target = EXCLUDED.execution_target
         AND risk_command_outcome.env_key = EXCLUDED.env_key
         AND risk_command_outcome.account_id = EXCLUDED.account_id
         AND risk_command_outcome.command_kind = EXCLUDED.command_kind
         AND risk_command_outcome.state = 'submitted'
       RETURNING command_id`,
      [commandId, this.executionTarget, envKey, accountId],
    );
    if (result.rows.length === 0) throw new Error('risk_command_outcome_scope_or_stage_mismatch');
  }

  async recordRestrictedRecoveryAppliedDomain(
    commandId: number,
    envKey: string,
    accountId: string,
    risk: RestrictedRecoveryRiskState,
    changed: boolean,
  ): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO risk_command_outcome
         (command_id, execution_target, env_key, account_id, command_kind, state,
          status, quota_level, signal_count, last_signal_at, status_since, state_updated_at,
          recovery_changed, recovery_refusal, resumed_edges, resume_failure, resume_state, reason, decided_at)
       VALUES ($1, $2, $3, $4, 'recoverRestricted', 'applied',
               $5, $6, $7, $8, $9, $10, $11, NULL, NULL, NULL, 'pending', NULL, now())
       ON CONFLICT (command_id) DO UPDATE
         SET state = 'applied',
             status = EXCLUDED.status, quota_level = EXCLUDED.quota_level,
             signal_count = EXCLUDED.signal_count, last_signal_at = EXCLUDED.last_signal_at,
             status_since = EXCLUDED.status_since, state_updated_at = EXCLUDED.state_updated_at,
             recovery_changed = EXCLUDED.recovery_changed, recovery_refusal = NULL,
             resumed_edges = NULL, resume_failure = NULL, resume_state = 'pending',
             reason = NULL, decided_at = now()
       WHERE risk_command_outcome.execution_target = EXCLUDED.execution_target
         AND risk_command_outcome.env_key = EXCLUDED.env_key
         AND risk_command_outcome.account_id = EXCLUDED.account_id
         AND risk_command_outcome.command_kind = EXCLUDED.command_kind
         AND risk_command_outcome.state = 'applying'
       RETURNING command_id`,
      [
        commandId,
        this.executionTarget,
        envKey,
        accountId,
        risk.status,
        risk.quotaLevel,
        risk.signalCount,
        risk.lastSignalAt,
        risk.statusSince,
        risk.updatedAt,
        changed,
      ],
    );
    if (result.rows.length === 0) throw new Error('risk_command_outcome_scope_or_stage_mismatch');
  }

  async claimRestrictedRecoveryResume(commandId: number, envKey: string, accountId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE risk_command_outcome
          SET resume_state = 'claimed', decided_at = now()
        WHERE command_id = $1
          AND execution_target = $2
          AND env_key = $3
          AND account_id = $4
          AND command_kind = 'recoverRestricted'
          AND state = 'applied'
          AND resume_state = 'pending'
       RETURNING command_id`,
      [commandId, this.executionTarget, envKey, accountId],
    );
    return result.rows.length > 0;
  }

  async recordRestrictedRecoveryResumeResult(
    commandId: number,
    envKey: string,
    accountId: string,
    resume: { resumedEdges: number; resumeError?: RestrictedRecoveryResumeFailure },
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE risk_command_outcome
          SET resume_state = 'completed',
              resumed_edges = $5,
              resume_failure = $6,
              decided_at = now()
        WHERE command_id = $1
          AND execution_target = $2
          AND env_key = $3
          AND account_id = $4
          AND command_kind = 'recoverRestricted'
          AND state = 'applied'
          AND resume_state = 'claimed'
       RETURNING command_id`,
      [commandId, this.executionTarget, envKey, accountId, resume.resumedEdges, resume.resumeError ?? null],
    );
    if (result.rows.length === 0) {
      const stage = await this.restrictedRecoveryStageOf(commandId, envKey, accountId);
      if (stage !== 'applied_resume_completed') {
        throw new Error('risk_command_outcome_scope_or_stage_mismatch');
      }
    }
  }

  async recordRestrictedRecoveryRefused(
    commandId: number,
    envKey: string,
    accountId: string,
    risk: RestrictedRecoveryRiskState,
    reason: 'state_not_restricted',
  ): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO risk_command_outcome
         (command_id, execution_target, env_key, account_id, command_kind, state,
          status, quota_level, signal_count, last_signal_at, status_since, state_updated_at,
          recovery_changed, recovery_refusal, resumed_edges, resume_failure, resume_state, reason, decided_at)
       VALUES ($1, $2, $3, $4, 'recoverRestricted', 'refused',
               $5, $6, $7, $8, $9, $10, FALSE, $11, NULL, NULL, NULL, NULL, now())
       ON CONFLICT (command_id) DO UPDATE
         SET state = 'refused',
             status = EXCLUDED.status, quota_level = EXCLUDED.quota_level,
             signal_count = EXCLUDED.signal_count, last_signal_at = EXCLUDED.last_signal_at,
             status_since = EXCLUDED.status_since, state_updated_at = EXCLUDED.state_updated_at,
             recovery_changed = FALSE, recovery_refusal = EXCLUDED.recovery_refusal,
             resumed_edges = NULL, resume_failure = NULL, resume_state = NULL,
             reason = NULL, decided_at = now()
       WHERE risk_command_outcome.execution_target = EXCLUDED.execution_target
         AND risk_command_outcome.env_key = EXCLUDED.env_key
         AND risk_command_outcome.account_id = EXCLUDED.account_id
         AND risk_command_outcome.command_kind = EXCLUDED.command_kind
         AND risk_command_outcome.state = 'applying'
       RETURNING command_id`,
      [
        commandId,
        this.executionTarget,
        envKey,
        accountId,
        risk.status,
        risk.quotaLevel,
        risk.signalCount,
        risk.lastSignalAt,
        risk.statusSince,
        risk.updatedAt,
        reason,
      ],
    );
    if (result.rows.length === 0) {
      const stage = await this.restrictedRecoveryStageOf(commandId, envKey, accountId);
      if (stage !== 'refused' && stage !== 'applied_resume_completed') {
        throw new Error('risk_command_outcome_scope_or_stage_mismatch');
      }
    }
  }

  async recordRestrictedRecoveryFailed(
    commandId: number,
    envKey: string,
    accountId: string,
    reason: RestrictedRecoveryFailureReason,
  ): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO risk_command_outcome
         (command_id, execution_target, env_key, account_id, command_kind, state, reason, decided_at)
       VALUES ($1, $2, $3, $4, 'recoverRestricted', 'failed', $5, now())
       ON CONFLICT (command_id) DO UPDATE
         SET state = 'failed', reason = EXCLUDED.reason,
             status = NULL, quota_level = NULL, signal_count = NULL, last_signal_at = NULL,
             status_since = NULL, state_updated_at = NULL, recovery_changed = NULL,
             recovery_refusal = NULL, resumed_edges = NULL, resume_failure = NULL,
             resume_state = NULL, decided_at = now()
       WHERE risk_command_outcome.execution_target = EXCLUDED.execution_target
         AND risk_command_outcome.env_key = EXCLUDED.env_key
         AND risk_command_outcome.account_id = EXCLUDED.account_id
         AND risk_command_outcome.command_kind = EXCLUDED.command_kind
         AND risk_command_outcome.state <> 'applied'
       RETURNING command_id`,
      [commandId, this.executionTarget, envKey, accountId, reason],
    );
    if (result.rows.length === 0) {
      const stage = await this.restrictedRecoveryStageOf(commandId, envKey, accountId);
      if (stage !== 'failed' && !stage.startsWith('applied_resume_')) {
        throw new Error('risk_command_outcome_scope_or_stage_mismatch');
      }
    }
  }
}

export interface RiskCommandController {
  applySignal(signal: RiskSignal): Promise<RiskState>;
  setQuotaLevel(level: RiskQuotaLevel): Promise<RiskState>;
  recoverRestricted(reason: string): Promise<{
    accepted: boolean;
    refusal?: 'state_not_restricted';
    state: RiskState;
    changed: boolean;
  }>;
  getState(): RiskState;
}

export interface RiskCommandApplyHandlerOptions {
  service: PgRiskCommandService;
  getController(accountId: string): Promise<RiskCommandController>;
  resumeEdgesForAccount(accountId: string): number | Promise<number>;
  logger?: Pick<Console, 'warn'>;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * automation 组合根可直接注入 RiskCommandConsumer 的领域应用器。
 * 本函数只依赖端口：不持有 registry / WebSocket server，也不选择部署目标。
 */
export function createRiskCommandApplyHandler(options: RiskCommandApplyHandlerOptions): RiskCommandApply {
  return async (cmd, commandId) => {
    const logger = options.logger ?? console;

    if (cmd.kind === 'recoverRestricted') {
      const finishResume = async (stage: RestrictedRecoveryStage): Promise<void> => {
        if (stage === 'applied_resume_completed') return;
        if (stage === 'applied_resume_claimed') {
          // claimed 已在 durable ledger：上次可能已真正 resume 但回执落账失败。重复调用虽对 Set.delete
          // 幂等，却会把第二次 0 冒充第一次真实数量；因此只补一条诚实的 unknown 结局，不再 resume。
          logger.warn(
            `[risk-command] Edge resume receipt missing commandId=${commandId}; recording stable unknown result`,
          );
          await options.service.recordRestrictedRecoveryResumeResult(
            commandId,
            cmd.envKey,
            cmd.accountId,
            { resumedEdges: 0, resumeError: 'edge_resume_result_unknown' },
          );
          return;
        }
        if (stage !== 'applied_resume_pending') {
          throw new Error(`risk_command_unexpected_resume_stage:${stage}`);
        }
        const claimed = await options.service.claimRestrictedRecoveryResume(
          commandId,
          cmd.envKey,
          cmd.accountId,
        );
        if (!claimed) {
          await finishResume(
            await options.service.restrictedRecoveryStageOf(commandId, cmd.envKey, cmd.accountId),
          );
          return;
        }

        let resume: { resumedEdges: number; resumeError?: RestrictedRecoveryResumeFailure };
        try {
          const resumedEdges = await options.resumeEdgesForAccount(cmd.accountId);
          if (!Number.isSafeInteger(resumedEdges) || resumedEdges < 0) {
            throw new Error(`invalid_resumed_edges:${String(resumedEdges)}`);
          }
          resume = { resumedEdges };
        } catch (err) {
          logger.warn(
            `[risk-command] Edge resume failed commandId=${commandId}: ${errorReason(err)}`,
          );
          resume = { resumedEdges: 0, resumeError: 'edge_resume_failed' };
        }
        await options.service.recordRestrictedRecoveryResumeResult(
          commandId,
          cmd.envKey,
          cmd.accountId,
          resume,
        );
      };

      let stage = await options.service.restrictedRecoveryStageOf(commandId, cmd.envKey, cmd.accountId);
      if (
        stage === 'refused' ||
        stage === 'failed' ||
        stage === 'applied_resume_incomplete' ||
        stage === 'applied_resume_completed'
      ) return;
      if (stage === 'applied_resume_pending' || stage === 'applied_resume_claimed') {
        await finishResume(stage);
        return;
      }
      if (stage === 'applying') {
        await options.service.recordRestrictedRecoveryFailed(
          commandId,
          cmd.envKey,
          cmd.accountId,
          'recovery_application_indeterminate',
        );
        return;
      }
      await options.service.markRestrictedRecoveryApplying(commandId, cmd.envKey, cmd.accountId);

      let controller: RiskCommandController;
      try {
        controller = await options.getController(cmd.accountId);
      } catch (err) {
        logger.warn(
          `[risk-command] recovery controller unavailable commandId=${commandId}: ${errorReason(err)}`,
        );
        await options.service.recordRestrictedRecoveryFailed(
          commandId,
          cmd.envKey,
          cmd.accountId,
          'recovery_application_failed',
        );
        return;
      }

      let result: Awaited<ReturnType<RiskCommandController['recoverRestricted']>>;
      try {
        result = await controller.recoverRestricted(cmd.reason);
      } catch (err) {
        logger.warn(
          `[risk-command] recovery application failed commandId=${commandId}: ${errorReason(err)}`,
        );
        await options.service.recordRestrictedRecoveryFailed(
          commandId,
          cmd.envKey,
          cmd.accountId,
          'recovery_application_failed',
        );
        return;
      }

      if (!result.accepted) {
        if (result.state.accountId !== cmd.accountId) {
          await options.service.recordRestrictedRecoveryFailed(
            commandId,
            cmd.envKey,
            cmd.accountId,
            'recovery_write_after_invalid',
          );
          return;
        }
        await options.service.recordRestrictedRecoveryRefused(
          commandId,
          cmd.envKey,
          cmd.accountId,
          result.state,
          'state_not_restricted',
        );
        return;
      }

      if (result.state.accountId !== cmd.accountId || result.state.status !== 'normal') {
        await options.service.recordRestrictedRecoveryFailed(
          commandId,
          cmd.envKey,
          cmd.accountId,
          'recovery_write_after_invalid',
        );
        return;
      }

      try {
        await options.service.recordRestrictedRecoveryAppliedDomain(
          commandId,
          cmd.envKey,
          cmd.accountId,
          result.state,
          result.changed,
        );
      } catch (err) {
        logger.warn(
          `[risk-command] recovery applied outcome write failed commandId=${commandId}: ${errorReason(err)}`,
        );
        stage = await options.service.restrictedRecoveryStageOf(commandId, cmd.envKey, cmd.accountId);
        if (!stage.startsWith('applied_resume_')) {
          await options.service.recordRestrictedRecoveryFailed(
            commandId,
            cmd.envKey,
            cmd.accountId,
            'recovery_result_recording_failed',
          );
          return;
        }
      }
      stage = await options.service.restrictedRecoveryStageOf(commandId, cmd.envKey, cmd.accountId);
      await finishResume(stage);
      return;
    }

    let controller: RiskCommandController;
    try {
      controller = await options.getController(cmd.accountId);
    } catch (err) {
      const reason = errorReason(err);
      await options.service.recordFailed(commandId, reason).catch(() => undefined);
      throw err;
    }

    try {
      if (cmd.kind === 'applySignal') await controller.applySignal(cmd.signal);
      else await controller.setQuotaLevel(cmd.level);
    } catch (err) {
      await options.service.recordFailed(commandId, errorReason(err)).catch(() => undefined);
      throw err;
    }
    const state = controller.getState();
    await options.service.recordApplied(commandId, state.status, state.quotaLevel);
  };
}
