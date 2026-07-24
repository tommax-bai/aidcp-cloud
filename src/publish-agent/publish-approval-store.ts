/**
 * PublishApprovalStore —— 人审授权的唯一持久写者（change publish-approval-signal-to-database）。
 *
 * 为什么存在：授权这一位过去躺在本机文件 `/tmp/aidcp-publish-approve-<requestId>.json` 上。写方（飞书回调 /
 * 后台审批 / 客户端内审批 / 委托任务 / 排期免审）与读方（发布下发器 / 评论审批闸）拆分后分属两个服务，
 * 一分进程文件系统就不再共享（systemd PrivateTmp、容器化、分机部署任一发生即触发），读方永远读不到
 * approved===true —— 失败方向是 **fail-closed 的静默停滞**：运营点了通过、稿件永远发不出去、安全断言全绿、
 * 界面仍显示「待审批」。本项目红线明令禁止这种形态。
 *
 * 不变量：
 * - **单写**：本表的唯一写者是本 Store；执行侧 MUST NOT 直接写它（经内部接口）。
 * - **first-writer-wins**：由「活跃行唯一」的部分唯一索引承担（替代文件系统 O_EXCL），
 *   首个写者得 `{written:true}`，后到者得 `{alreadyDecided:<首个决定>}`。
 * - **绝不返回 published**：授权受理 ≠ 平台已发布。
 * - **作废是状态迁移不是删除**：`dispatch_state='void'` + `void_reason`，历史轮次保留供审计；
 *   下一轮授权以 `revision+1` 插入（活跃部分索引随即让出）。
 * - **execution_target 由服务端注入**：MUST NOT 取自请求体；缺失或非法即写入失败（可区分错误）。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { parseDeploymentTarget, type DeploymentTarget } from '../deployment-target.js';

const { Pool } = pg;

export const PUBLISH_APPROVAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS publish_approval_decision (
  request_id              TEXT NOT NULL,
  revision                INT  NOT NULL CHECK (revision >= 1),
  subject_kind            TEXT NOT NULL CHECK (subject_kind IN ('publish','comment')),
  candidate_ref           TEXT NOT NULL,
  content_version         INT  NOT NULL DEFAULT 0,
  approved                BOOLEAN NOT NULL,
  decided_by              TEXT NOT NULL,
  decided_via             TEXT NOT NULL CHECK (
                            decided_via IN ('feishu','console','client','delegated_task','schedule_auto_approve')
                          ),
  decided_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  env_key                 TEXT,
  execution_target        TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  frozen_payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  dispatch_state          TEXT NOT NULL CHECK (
                            dispatch_state IN ('pending_dispatch','dispatching','consumed','void')
                          ),
  dispatch_blocked_reason TEXT,
  dispatch_state_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  void_reason             TEXT,
  PRIMARY KEY (request_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_approval_decision_active
  ON publish_approval_decision (request_id)
  WHERE dispatch_state <> 'void';
CREATE INDEX IF NOT EXISTS idx_publish_approval_decision_pending
  ON publish_approval_decision (execution_target, decided_at)
  WHERE dispatch_state = 'pending_dispatch';

CREATE TABLE IF NOT EXISTS publish_approval_outbox (
  id               BIGSERIAL PRIMARY KEY,
  command          TEXT NOT NULL DEFAULT 'PublishApproved',
  request_id       TEXT NOT NULL,
  revision         INT  NOT NULL,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at      TIMESTAMPTZ,
  UNIQUE (command, request_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_publish_approval_outbox_unconsumed
  ON publish_approval_outbox (execution_target, id)
  WHERE consumed_at IS NULL;
`;

export const APPROVAL_DECIDED_VIA = [
  'feishu',
  'console',
  'client',
  'delegated_task',
  'schedule_auto_approve',
] as const;
export type ApprovalDecidedVia = (typeof APPROVAL_DECIDED_VIA)[number];

export const APPROVAL_DISPATCH_STATES = ['pending_dispatch', 'dispatching', 'consumed', 'void'] as const;
export type ApprovalDispatchState = (typeof APPROVAL_DISPATCH_STATES)[number];

// 作废/阻塞原因枚举 + 哨兵错误抬入 kernel（change decouple-longtail-sweep）供发布下发编排跨边界共导；
// 本文件从 kernel 导入并等值再导出，令既有消费方与内部使用无感。
import {
  APPROVAL_VOID_REASONS,
  isApprovalVoidReason,
  APPROVAL_BLOCKED_REASONS,
  ApprovalUnreadableError,
  type ApprovalVoidReason,
  type ApprovalBlockedReason,
} from '../kernel/publish-approval-contract.js';
export {
  APPROVAL_VOID_REASONS,
  isApprovalVoidReason,
  APPROVAL_BLOCKED_REASONS,
  ApprovalUnreadableError,
  type ApprovalVoidReason,
  type ApprovalBlockedReason,
};

export interface ApprovalDecisionInput {
  requestId: string;
  subjectKind: 'publish' | 'comment';
  candidateRef: string;
  contentVersion: number;
  approved: boolean;
  /** 真实决策主体（飞书 open_id / 后台用户 / 客户端 accountId / 排期规则 id）。MUST NOT 常量占位。 */
  decidedBy: string;
  decidedVia: ApprovalDecidedVia;
  envKey?: string | null;
  frozenPayload: Record<string, unknown>;
  decidedAt?: number;
}

export interface ApprovalDecisionRow {
  requestId: string;
  revision: number;
  subjectKind: 'publish' | 'comment';
  candidateRef: string;
  contentVersion: number;
  approved: boolean;
  decidedBy: string;
  decidedVia: ApprovalDecidedVia;
  decidedAt: number;
  envKey: string | null;
  executionTarget: DeploymentTarget;
  frozenPayload: Record<string, unknown>;
  dispatchState: ApprovalDispatchState;
  dispatchBlockedReason: string | null;
  dispatchStateAt: number;
  voidReason: string | null;
}

/** 与旧 `ApprovalWriteResult` 同形：`{written}` 或 `{alreadyDecided}`。MUST NOT 出现 `published`。 */
export interface ApprovalWriteOutcome {
  written: boolean;
  alreadyDecided?: boolean;
  /** 首写成功时的轮次（供 Outbox 关联 / 调用方日志）。 */
  revision?: number;
}

export interface PublishApprovedCommand {
  requestId: string;
  revision: number;
  candidateRef: string;
  contentVersion: number;
  envKey: string | null;
  executionTarget: DeploymentTarget;
}

/** `execution_target` 缺失 / 非法：可区分错误，MUST NOT 以默认值补齐。 */
export class ApprovalExecutionTargetError extends Error {
  readonly code = 'execution_target_unavailable';
  constructor(message = 'execution_target_unavailable') {
    super(message);
    this.name = 'ApprovalExecutionTargetError';
  }
}


interface DecisionDbRow {
  request_id: string;
  revision: number;
  subject_kind: 'publish' | 'comment';
  candidate_ref: string;
  content_version: number;
  approved: boolean;
  decided_by: string;
  decided_via: ApprovalDecidedVia;
  decided_at: Date | string;
  env_key: string | null;
  execution_target: DeploymentTarget;
  frozen_payload: Record<string, unknown> | null;
  dispatch_state: ApprovalDispatchState;
  dispatch_blocked_reason: string | null;
  dispatch_state_at: Date | string;
  void_reason: string | null;
}

function toMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function mapRow(row: DecisionDbRow): ApprovalDecisionRow {
  return {
    requestId: row.request_id,
    revision: row.revision,
    subjectKind: row.subject_kind,
    candidateRef: row.candidate_ref,
    contentVersion: Number(row.content_version ?? 0),
    approved: row.approved === true,
    decidedBy: row.decided_by,
    decidedVia: row.decided_via,
    decidedAt: toMs(row.decided_at),
    envKey: row.env_key,
    executionTarget: row.execution_target,
    frozenPayload: row.frozen_payload ?? {},
    dispatchState: row.dispatch_state,
    dispatchBlockedReason: row.dispatch_blocked_reason,
    dispatchStateAt: toMs(row.dispatch_state_at),
    voidReason: row.void_reason,
  };
}

const DECISION_COLUMNS =
  'request_id, revision, subject_kind, candidate_ref, content_version, approved, decided_by, decided_via, ' +
  'decided_at, env_key, execution_target, frozen_payload, dispatch_state, dispatch_blocked_reason, ' +
  'dispatch_state_at, void_reason';

export interface PublishApprovalStoreOptions {
  /** 服务端注入的本机部署事实；缺失 / 非法即写入失败（可区分错误）。 */
  executionTarget: DeploymentTarget | null | undefined;
  pool?: pg.Pool;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

/**
 * 授权表的唯一写者与唯一直接读者。执行侧经 `publish-approval-api.ts` 的窄内部接口访问，
 * MUST NOT 直接注入本 Store（拆分后那会二次断裂）。
 */
export class PublishApprovalStore {
  private readonly pool: pg.Pool;
  private readonly executionTarget: DeploymentTarget | null;

  constructor(options: PublishApprovalStoreOptions) {
    this.executionTarget = parseDeploymentTarget(options.executionTarget);
    this.pool =
      options.pool ??
      new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
  }

  async init(): Promise<void> {
    await this.pool.query(PUBLISH_APPROVAL_SCHEMA_SQL);
  }

  /**
   * 唯一写出口。first-writer-wins：活跃行唯一索引冲突 → 读回既有决定返回 `{alreadyDecided}`。
   *
   * `approved=true` 落 `pending_dispatch`（= 已批准·待下发，独立可见状态）并同事务写 Outbox
   * `PublishApproved`；`approved=false` 无下发可言，直接落 `consumed`（仍是活跃行，故后到的批准
   * 会被判 `alreadyDecided:false`，与旧「文件已存在且 approved=false」逐条对应）。
   */
  async record(input: ApprovalDecisionInput): Promise<ApprovalWriteOutcome> {
    const target = this.executionTarget;
    if (!target) throw new ApprovalExecutionTargetError();
    const decidedAt = new Date(input.decidedAt ?? Date.now());
    const dispatchState: ApprovalDispatchState = input.approved ? 'pending_dispatch' : 'consumed';

    // 最多三轮：PK (request_id, revision) 与活跃部分索引都可能被并发写者先占。两者都代表「有人先到」，
    // 唯一的正确回应是读回活跃行；读不回（并发者随后作废了）才重算轮次重试。绝不静默返回假成功。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query<DecisionDbRow>(
          `INSERT INTO publish_approval_decision (
             request_id, revision, subject_kind, candidate_ref, content_version, approved,
             decided_by, decided_via, decided_at, env_key, execution_target, frozen_payload,
             dispatch_state, dispatch_state_at
           )
           SELECT $1,
                  COALESCE((SELECT MAX(revision) FROM publish_approval_decision WHERE request_id = $1), 0) + 1,
                  $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $8
           ON CONFLICT (request_id) WHERE dispatch_state <> 'void' DO NOTHING
           RETURNING ${DECISION_COLUMNS}`,
          [
            input.requestId,
            input.subjectKind,
            input.candidateRef,
            Math.trunc(Number.isFinite(input.contentVersion) ? input.contentVersion : 0),
            input.approved,
            input.decidedBy,
            input.decidedVia,
            decidedAt,
            input.envKey ?? null,
            target,
            JSON.stringify(input.frozenPayload ?? {}),
            dispatchState,
          ],
        );
        if (inserted.rowCount && inserted.rows[0]) {
          const row = mapRow(inserted.rows[0]);
          if (row.approved) {
            await client.query(
              `INSERT INTO publish_approval_outbox (command, request_id, revision, execution_target, payload)
               VALUES ('PublishApproved', $1, $2, $3, $4::jsonb)
               ON CONFLICT (command, request_id, revision) DO NOTHING`,
              [
                row.requestId,
                row.revision,
                row.executionTarget,
                JSON.stringify({
                  requestId: row.requestId,
                  revision: row.revision,
                  candidateRef: row.candidateRef,
                  contentVersion: row.contentVersion,
                  envKey: row.envKey,
                  executionTarget: row.executionTarget,
                } satisfies PublishApprovedCommand),
              ],
            );
          }
          await client.query('COMMIT');
          return { written: true, revision: row.revision };
        }
        await client.query('ROLLBACK');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        // 23505 = unique_violation：PK 轮次撞车（并发写者用了同一 revision）。与活跃索引冲突同义：有人先到。
        if ((err as { code?: string }).code !== '23505') throw err;
      } finally {
        client.release();
      }
      const active = await this.readActive(input.requestId);
      if (active) return { written: false, alreadyDecided: active.approved };
    }
    throw new Error('publish_approval_record_contention');
  }

  /** 活跃行（`dispatch_state <> 'void'`）。历史轮次 MUST NOT 混入判定。 */
  async readActive(requestId: string): Promise<ApprovalDecisionRow | null> {
    const res = await this.pool.query<DecisionDbRow>(
      `SELECT ${DECISION_COLUMNS} FROM publish_approval_decision
        WHERE request_id = $1 AND dispatch_state <> 'void'
        LIMIT 1`,
      [requestId],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  /** 审计读：含历史轮次，按轮次降序。仅供审计接口，MUST NOT 参与授权判定。 */
  async listRevisions(requestId: string): Promise<ApprovalDecisionRow[]> {
    const res = await this.pool.query<DecisionDbRow>(
      `SELECT ${DECISION_COLUMNS} FROM publish_approval_decision
        WHERE request_id = $1 ORDER BY revision DESC`,
      [requestId],
    );
    return res.rows.map(mapRow);
  }

  /**
   * 兜底扫描用：只返回本机 target 的活跃待下发行（DEV/OL 共库异步隔离，CLAUDE.md §2）。
   *
   * `subjectKind` MUST 由调用方按用途给定：**只有发帖有下发段**（PublishDispatcher 是
   * `markDispatching/markConsumed` 的唯一调用者，且只认 `publish-<n>`）。评论授权由评论人审闸就地消费、
   * 状态永远停在 `pending_dispatch`，若混进本窗口会把 LIMIT 名额永久占满，真正待下发的稿件反而被挤出窗口。
   */
  async listPendingDispatch(
    executionTarget: DeploymentTarget,
    limit = 200,
    subjectKind?: 'publish' | 'comment',
  ): Promise<ApprovalDecisionRow[]> {
    const res = await this.pool.query<DecisionDbRow>(
      `SELECT ${DECISION_COLUMNS} FROM publish_approval_decision
        WHERE dispatch_state = 'pending_dispatch' AND approved = true AND execution_target = $1
          AND ($3::text IS NULL OR subject_kind = $3::text)
        ORDER BY decided_at ASC
        LIMIT $2`,
      [executionTarget, Math.max(1, Math.trunc(limit)), subjectKind ?? null],
    );
    return res.rows.map(mapRow);
  }

  /**
   * 待下发告警候选：本机 target、无任何阻塞原因、且待下发已超阈值。
   * 「没有原因的长时间待下发」恰恰是执行侧静默失联的形态——有阻塞原因的是**已解释的等待**，不告警。
   *
   * 同 `listPendingDispatch`：`subjectKind` MUST 收窄到有下发段的主体。评论授权没有下发侧，
   * 混进来既是纯误报，又会把 LIMIT 窗口钉死在最老的一批上——那会让这道「静默停滞探测器」自我瘫痪。
   */
  async listStalePendingDispatch(
    executionTarget: DeploymentTarget,
    olderThanMs: number,
    limit = 50,
    subjectKind?: 'publish' | 'comment',
  ): Promise<ApprovalDecisionRow[]> {
    const res = await this.pool.query<DecisionDbRow>(
      `SELECT ${DECISION_COLUMNS} FROM publish_approval_decision
        WHERE dispatch_state = 'pending_dispatch'
          AND approved = true
          AND execution_target = $1
          AND dispatch_blocked_reason IS NULL
          AND decided_at <= now() - ($2::bigint * INTERVAL '1 millisecond')
          AND ($4::text IS NULL OR subject_kind = $4::text)
        ORDER BY decided_at ASC
        LIMIT $3`,
      [executionTarget, Math.max(0, Math.trunc(olderThanMs)), Math.max(1, Math.trunc(limit)), subjectKind ?? null],
    );
    return res.rows.map(mapRow);
  }

  /** 执行侧领取：`pending_dispatch → dispatching`。已被作废 / 已消费的行不迁移（返回 null）。 */
  async markDispatching(requestId: string, revision?: number): Promise<ApprovalDecisionRow | null> {
    const res = await this.pool.query<DecisionDbRow>(
      `UPDATE publish_approval_decision
          SET dispatch_state = 'dispatching', dispatch_state_at = now(), dispatch_blocked_reason = NULL
        WHERE request_id = $1 AND dispatch_state = 'pending_dispatch'
          AND ($2::int IS NULL OR revision = $2::int)
        RETURNING ${DECISION_COLUMNS}`,
      [requestId, revision ?? null],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  /** 下发序列已收敛（成功 / 终态失败）：`→ consumed`。授权已被用掉，不再是待下发。 */
  async markConsumed(requestId: string, revision?: number): Promise<ApprovalDecisionRow | null> {
    const res = await this.pool.query<DecisionDbRow>(
      `UPDATE publish_approval_decision
          SET dispatch_state = 'consumed', dispatch_state_at = now(), dispatch_blocked_reason = NULL
        WHERE request_id = $1 AND dispatch_state IN ('pending_dispatch','dispatching')
          AND ($2::int IS NULL OR revision = $2::int)
        RETURNING ${DECISION_COLUMNS}`,
      [requestId, revision ?? null],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  /**
   * 被抢占 / 等槽位等「保留授权」的路径：回到 `pending_dispatch` 并附阻塞原因，授权仍活跃。
   *
   * WHERE MUST 同时容纳 `pending_dispatch`：**并非每条退回路径都先经过 `dispatching`**。
   * 浏览器停泊唤不醒（`browser_wake_failed`）是在 acquire 阶段就 reject 的，业务回调根本没执行、
   * `markDispatching` 也就没跑过，行仍停在 `pending_dispatch`。若只认 `dispatching`，这条 UPDATE 命中 0 行、
   * `browser_slot_waiting` 被静默丢弃 —— 后台看不到真实原因，看门狗还会把「等槽位」误报成「下发侧失联」。
   */
  async releaseToPending(requestId: string, blockedReason?: ApprovalBlockedReason | null): Promise<void> {
    await this.pool.query(
      `UPDATE publish_approval_decision
          SET dispatch_state = 'pending_dispatch', dispatch_state_at = now(), dispatch_blocked_reason = $2
        WHERE request_id = $1 AND dispatch_state IN ('pending_dispatch','dispatching')`,
      [requestId, blockedReason ?? null],
    );
  }

  /**
   * 作废：**只做状态迁移，MUST NOT 删行**。活跃部分索引随即让出，下一轮授权以 revision+1 插入成功
   * （旧语义「删文件 = 可重新审批」逐条保留，并多出完整审计轨迹）。
   */
  async voidActive(requestId: string, reason: ApprovalVoidReason): Promise<ApprovalDecisionRow | null> {
    if (!isApprovalVoidReason(reason)) throw new Error(`invalid_void_reason:${String(reason)}`);
    const res = await this.pool.query<DecisionDbRow>(
      `UPDATE publish_approval_decision
          SET dispatch_state = 'void', void_reason = $2, dispatch_state_at = now(), dispatch_blocked_reason = NULL
        WHERE request_id = $1 AND dispatch_state <> 'void'
        RETURNING ${DECISION_COLUMNS}`,
      [requestId, reason],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  /** 阻塞原因写入 / 清空（`null` = 阻塞解除，MUST 清空，绝不遗留过期文案）。 */
  async setBlockedReason(requestId: string, reason: ApprovalBlockedReason | null): Promise<void> {
    await this.pool.query(
      `UPDATE publish_approval_decision
          SET dispatch_blocked_reason = $2, dispatch_state_at = now()
        WHERE request_id = $1 AND dispatch_state IN ('pending_dispatch','dispatching')
          AND dispatch_blocked_reason IS DISTINCT FROM $2`,
      [requestId, reason],
    );
  }

  /** 面板投影批量读：一批 requestId 的活跃行。 */
  async readActiveMany(requestIds: string[]): Promise<Map<string, ApprovalDecisionRow>> {
    const out = new Map<string, ApprovalDecisionRow>();
    if (requestIds.length === 0) return out;
    const res = await this.pool.query<DecisionDbRow>(
      `SELECT ${DECISION_COLUMNS} FROM publish_approval_decision
        WHERE request_id = ANY($1::text[]) AND dispatch_state <> 'void'`,
      [requestIds],
    );
    for (const row of res.rows) out.set(row.request_id, mapRow(row));
    return out;
  }

  /**
   * Inbox：原子认领一批未消费命令（`consumed_at` 由 UPDATE 一次写定 = 去重）。
   * 只认领本机 target 的命令。至少一次投递 + 幂等消费，重复投递 MUST NOT 造成重复发布。
   */
  async claimApprovedCommands(executionTarget: DeploymentTarget, limit = 20): Promise<PublishApprovedCommand[]> {
    const res = await this.pool.query<{ payload: PublishApprovedCommand }>(
      `UPDATE publish_approval_outbox
          SET consumed_at = now()
        WHERE id IN (
          SELECT id FROM publish_approval_outbox
           WHERE consumed_at IS NULL AND execution_target = $1
           ORDER BY id ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING payload`,
      [executionTarget, Math.max(1, Math.trunc(limit))],
    );
    return res.rows.map((row) => row.payload);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
