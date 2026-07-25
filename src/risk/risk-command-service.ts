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
  RiskCommandAccepted,
  RiskCommandOutcome,
  RiskCommandPort,
  SubmitRiskQuotaLevelInput,
  SubmitRiskSignalInput,
} from '../kernel/risk-command-types.js';
import type { RiskQuotaLevel, RiskSignalKind } from './types.js';
import { emitRiskCommand, RISK_COMMAND_TOPIC, type RiskCommand } from '../transport/risk-command-outbox.js';

export interface RiskCommandServiceOptions {
  pool: pg.Pool;
  /** 归属目标（'dev' | 'ol'）。缺失/非法由 emitOutboxEvent 拦；本服务 MUST NOT 从请求推导。 */
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

export class PgRiskCommandService implements RiskCommandPort {
  private readonly pool: pg.Pool;
  private readonly executionTarget: string;
  private readonly logger: Pick<Console, 'warn'>;

  constructor(options: RiskCommandServiceOptions) {
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
      input.accountId,
      input.requestedBy,
    );
  }

  async submitQuotaLevel(input: SubmitRiskQuotaLevelInput): Promise<RiskCommandAccepted> {
    return this.submit(
      { kind: 'setQuotaLevel', accountId: input.accountId, level: input.level as RiskQuotaLevel },
      input.accountId,
      input.requestedBy,
    );
  }

  /**
   * 提交人不进命令载荷（载荷形状由 outbox 契约固定、两侧共用），而是随结果账本一起落。
   * 提交时先占一行 `requested_by`——单写者稍后 upsert 结局时保留它，审计链不断。
   */
  private async submit(cmd: RiskCommand, accountId: string, requestedBy: string): Promise<RiskCommandAccepted> {
    const { id } = await emitRiskCommand(this.pool, this.executionTarget, cmd, this.logger);
    try {
      await this.pool.query(
        `INSERT INTO risk_command_outcome
           (command_id, execution_target, account_id, command_kind, state, requested_by, decided_at)
         VALUES ($1, $2, $3, $4, 'submitted', $5, now())
         ON CONFLICT (command_id) DO NOTHING`,
        [id, this.executionTarget, accountId, cmd.kind, requestedBy],
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
}
