/**
 * 运营指令的**幂等台账**（属主 automation；表 `operator_command_receipt`，migrations/0099）。
 *
 * 它回答一个问题：同一次运营意图（一条飞书消息 / 一次面板点击）被投递第二次时，**副作用要不要再发生一次**。
 * 答案永远是不要，且第二次必须拿回**首次那一次的结果原文**——不是现算一个看起来一样的。
 *
 * ── 为什么必须落库 ──────────────────────────────────────────────────────
 * 接收方是「本地注入」与「HTTP 路由」共用的**同一份实现**，而运营指令的副作用是真的
 * （落一条委托任务并可能自动入队 / 整条发帖编排 / 评论任务）。进程内的表重启后一片空白，
 * 于是重启前后的同一条消息会被当成两次意图执行两遍。
 *
 * **领域层既有的判重挡不住它**（这条实测推翻过一次「有唯一索引就够了」的想法）：`delegated_tasks`
 * 上那条唯一索引的去重键含**由当前时刻算出的截止时间**，同一条消息几分钟后重投，`now()` 变了
 * ⇒ 去重键变了 ⇒ 建出第二条任务。它挡得住「同一秒内两次点击」，挡不住「稍后重投」。
 *
 * ── 三态，以及那一格没有别的诚实解 ──────────────────────────────────────
 * `in_flight` / `applied` / `rejected`。**刻意没有第四态、也刻意没有「回滚」这个操作。**
 *
 * 抢到 `in_flight` 之后处理器抛了一个**非业务**错误（库挂了、意料之外的 TypeError）时，本台账
 * **不释放那一行**。代价必须说清楚：那把键从此永远回「结果未知」。这是有意的——
 *   - 回 `duplicate` 是在断言首次成功了（可能没有）；
 *   - 直接重跑可能双发（副作用可能已经发生）；
 *   - 而我们**确实不知道**那一次的结局。编一个结局比说不知道更贵。
 * 运营的出路不是重发同一条消息（那把键的答案永远是不知道，这是对的），而是**发一条新消息**
 * ——新消息新键，照常执行。
 *
 * 注意**解析失败不走这条路**：解析器给的是带具名 code 的业务错误，落 `rejected`。
 * 所以真正落到「未知」的只剩「意料之外」，那时候「不知道」是准确的描述而不是偷懒。
 *
 * ── scope 存入参那个，不存从键反解那个 ───────────────────────────────────
 * `command_id` 形如 `kind:scope:requestKey`，看着能反解出 scope。但**存的必须是入参里那个作用域**：
 * 同一把键被用在两个不同账号上是调用方的错，接收方要能当场判出 `collision` 而不是照着跑。
 * 判据形态逐字照 4a 的既有判例（`src/comm/edge-resume-command-receiver.ts` 比 `input.accountId`）。
 */
import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { ensureCapabilitySchema } from '../schema/schema-capability.js';
import {
  isOperatorCommandRejection,
  type OperatorCommandKind,
  type OperatorCommandRejection,
} from '../kernel/operator-command-port.js';
import type { DelegatedExecutionTarget } from './types.js';

const { Pool } = pg;

/** 台账迁移的版本 id。探不到表时由 `ensureCapabilitySchema` 带着它报错，好让人知道要跑哪一条。 */
export const OPERATOR_COMMAND_RECEIPT_SINCE_VERSION = '0099_operator_command_receipt';

export interface OperatorCommandLedgerEntry {
  commandId: string;
  kind: OperatorCommandKind;
  /** 入参给的作用域（账号）。 */
  scope: string;
}

export type OperatorCommandLedgerRow =
  | { state: 'in_flight'; scope: string }
  /** `receipt` 是首次回执的**载荷原文**（不含 outcome 字段——重放时由接收方套上 `duplicate`）。 */
  | { state: 'applied'; scope: string; receipt: unknown }
  | { state: 'rejected'; scope: string; rejection: OperatorCommandRejection };

export type OperatorCommandClaim =
  | { outcome: 'claimed' }
  | { outcome: 'existing'; row: OperatorCommandLedgerRow };

export interface OperatorCommandLedger {
  /**
   * 抢 `in_flight`。抢到回 `claimed`；没抢到回**既有行**（抢占本身就是判重，不需要额外的锁）。
   *
   * 没抢到时 MUST 回真实的既有行，MUST NOT 回一个「反正是重复」的笼统结论——
   * 三态在调用方那边分别对应完全不同的回答（原样回放 / 原样回放拒绝 / 结果未知）。
   */
  claim(entry: OperatorCommandLedgerEntry): Promise<OperatorCommandClaim>;
  /** 落定成功：存首次回执载荷原文。 */
  settleApplied(commandId: string, receipt: unknown): Promise<void>;
  /** 落定业务拒绝：三字段原样存（含处理器给的 `status`）。 */
  settleRejected(commandId: string, rejection: OperatorCommandRejection): Promise<void>;
}

/** 台账行读出来后形状不符（库里被人手改过 / 跨版本）时抛它，**绝不猜一个态**。 */
export class OperatorCommandLedgerShapeError extends Error {
  constructor(readonly commandId: string, detail: string) {
    super(`operator_command_receipt row for ${commandId} is unusable: ${detail}`);
    this.name = 'OperatorCommandLedgerShapeError';
  }
}

interface ReceiptRow {
  command_kind: string;
  scope: string;
  state: string;
  receipt: unknown;
}

function rowToLedgerRow(commandId: string, row: ReceiptRow): OperatorCommandLedgerRow {
  if (row.state === 'in_flight') return { state: 'in_flight', scope: row.scope };
  if (row.state === 'applied') {
    // `receipt` 为 NULL 而 state 是 applied ⇒ 库里的行自相矛盾。**MUST NOT 回一个空回执**——
    // 那会让调用方把「记录坏了」当成「首次的结果就是空」。
    if (row.receipt === null || row.receipt === undefined) {
      throw new OperatorCommandLedgerShapeError(commandId, 'state=applied but receipt is null');
    }
    return { state: 'applied', scope: row.scope, receipt: row.receipt };
  }
  if (row.state === 'rejected') {
    if (!isOperatorCommandRejection(row.receipt)) {
      throw new OperatorCommandLedgerShapeError(
        commandId,
        'state=rejected but receipt is not a three-field rejection',
      );
    }
    return { state: 'rejected', scope: row.scope, rejection: row.receipt };
  }
  throw new OperatorCommandLedgerShapeError(commandId, `unknown state=${row.state}`);
}

export interface PgOperatorCommandLedgerOptions {
  executionTarget: DelegatedExecutionTarget;
  pool?: pg.Pool;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export class PgOperatorCommandLedger implements OperatorCommandLedger {
  private readonly pool: pg.Pool;
  private readonly executionTarget: DelegatedExecutionTarget;

  constructor(options: PgOperatorCommandLedgerOptions) {
    this.executionTarget = options.executionTarget;
    this.pool = options.pool ?? new Pool({
      host: options.host ?? DEFAULT_PG_CONFIG.host,
      port: options.port ?? DEFAULT_PG_CONFIG.port,
      database: options.database ?? DEFAULT_PG_CONFIG.database,
      user: options.user ?? DEFAULT_PG_CONFIG.user,
      password: options.password ?? DEFAULT_PG_CONFIG.password,
    });
  }

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    //
    // **`ddl` 刻意是空的、要求全部走 `requiredObjects`**：运行时 DDL 棘轮（AC-SCHEMA-DDL-OWNER，
    // 只减不增）禁止为了新 schema 在 `src/` 下再写一段建表语句。表由 migrations/0099 建，
    // 这里只声明「探测需要哪些表 / 列」。照 src/config/approval-policy-store.ts 的既有做法。
    await ensureCapabilitySchema(this.pool, {
      capability: 'operator_command_receipt',
      sinceVersion: OPERATOR_COMMAND_RECEIPT_SINCE_VERSION,
      ddl: [],
      requiredObjects: {
        tables: {
          operator_command_receipt: [
            'execution_target',
            'command_id',
            'command_kind',
            'scope',
            'state',
            'receipt',
            'created_at',
            'decided_at',
          ],
        },
      },
    });
  }

  async claim(entry: OperatorCommandLedgerEntry): Promise<OperatorCommandClaim> {
    // 抢占式判重：`DO NOTHING RETURNING` 让「抢到」与「已存在」一次往返分得开
    // （形态照 src/interactions/interaction-store.ts 的既有判例）。
    const claimed = await this.pool.query<{ command_id: string }>(
      `INSERT INTO operator_command_receipt
         (execution_target, command_id, command_kind, scope, state, created_at)
       VALUES ($1, $2, $3, $4, 'in_flight', now())
       ON CONFLICT (execution_target, command_id) DO NOTHING
       RETURNING command_id`,
      [this.executionTarget, entry.commandId, entry.kind, entry.scope],
    );
    if ((claimed.rowCount ?? 0) > 0) return { outcome: 'claimed' };

    const { rows } = await this.pool.query<ReceiptRow>(
      `SELECT command_kind, scope, state, receipt
         FROM operator_command_receipt
        WHERE execution_target = $1 AND command_id = $2`,
      [this.executionTarget, entry.commandId],
    );
    const row = rows[0];
    if (!row) {
      // 抢不到却又读不到：行在这两条语句之间被删了（只有人手动干预会这样）。
      // **MUST NOT 静默重试成 claimed**——那会绕过判重。如实报形状问题。
      throw new OperatorCommandLedgerShapeError(entry.commandId, 'claim lost but no row present');
    }
    return { outcome: 'existing', row: rowToLedgerRow(entry.commandId, row) };
  }

  async settleApplied(commandId: string, receipt: unknown): Promise<void> {
    await this.settle(commandId, 'applied', receipt);
  }

  async settleRejected(commandId: string, rejection: OperatorCommandRejection): Promise<void> {
    await this.settle(commandId, 'rejected', rejection);
  }

  private async settle(commandId: string, state: 'applied' | 'rejected', receipt: unknown): Promise<void> {
    // 只允许从 in_flight 落定：已落定的行**绝不覆盖**，否则重放会把首次结果改写成第二次的
    // ——那正是「原样回放首次结果」这条要求的反面。
    await this.pool.query(
      `UPDATE operator_command_receipt
          SET state = $3, receipt = $4::jsonb, decided_at = now()
        WHERE execution_target = $1 AND command_id = $2 AND state = 'in_flight'`,
      [this.executionTarget, commandId, state, JSON.stringify(receipt)],
    );
  }
}

/**
 * 进程内台账。**只给测试用**，生产一律用 PG 那份（进程内的表重启后一片空白，见文件头）。
 *
 * **它刻意做成与真台账一样有损**：写入时走一次 JSON 往返。假件比真件保真度高，会让
 * 「回放的回执与首次逐字段相同」这类断言在真库上失败而在测试里全绿——那是最贵的一种假信心。
 */
export class InMemoryOperatorCommandLedger implements OperatorCommandLedger {
  private readonly rows = new Map<string, OperatorCommandLedgerRow>();

  async claim(entry: OperatorCommandLedgerEntry): Promise<OperatorCommandClaim> {
    const existing = this.rows.get(entry.commandId);
    if (existing) return { outcome: 'existing', row: existing };
    this.rows.set(entry.commandId, { state: 'in_flight', scope: entry.scope });
    return { outcome: 'claimed' };
  }

  async settleApplied(commandId: string, receipt: unknown): Promise<void> {
    const current = this.rows.get(commandId);
    if (current?.state !== 'in_flight') return;
    this.rows.set(commandId, {
      state: 'applied',
      scope: current.scope,
      receipt: JSON.parse(JSON.stringify(receipt)) as unknown,
    });
  }

  async settleRejected(commandId: string, rejection: OperatorCommandRejection): Promise<void> {
    const current = this.rows.get(commandId);
    if (current?.state !== 'in_flight') return;
    this.rows.set(commandId, {
      state: 'rejected',
      scope: current.scope,
      rejection: JSON.parse(JSON.stringify(rejection)) as OperatorCommandRejection,
    });
  }

  /** 测试用：把一行强行留在 `in_flight`，模拟「进程崩在那一格上」。 */
  forceInFlight(commandId: string, scope: string): void {
    this.rows.set(commandId, { state: 'in_flight', scope });
  }
}
