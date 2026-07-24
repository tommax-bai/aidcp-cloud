/**
 * 数据库事件 outbox 传输原语（change block2-outbox-transport，Block② 拆进程的异步事件承重地基）。
 *
 * 用途：将来风控事件、跨服务通知走这条通道。本文件只导出**原语**——emit（事务型写入）与
 * OutboxConsumer（有界轮询消费）；**不接 server.ts、不接 EventBus / 风控**（那是 2c 双写/切换的事）。
 *
 * ## 承重通道与加速器的分工（照 src/config/mirror-version-store.ts 的既有范式）
 *
 * 唯一承重的投递通道是**轮询**：陈旧上限 ≤ 轮询周期 + 一次查询耗时，与通知是否送达无关。
 * `pg_notify` 只是**可选加速器**——fire-and-forget，连接断开期间发出的通知永久丢失、无补偿。
 * 因此消费方 MUST NOT 因为接了通知就放宽轮询周期；通知只是「早一点醒一次」。
 *
 * ## 语义保证
 *
 * - **事务型 outbox**：`emitOutboxEvent` 收调用方的 client/事务句柄，INSERT 在**调用方事务内**完成；
 *   事件与业务写入同生共死（业务回滚 → 事件不存在，绝不出现「事件发了、业务没落」的裂缝）。
 * - **at-least-once**：消费方逐条 `await handler`，成功一条才把游标推到该条 id；handler 抛错即停在
 *   该条之前、游标不越过它，下一轮从游标之后重放。幂等由 handler 负责（同一事件可能被投递多次）。
 * - **提交乱序安全水位**：`id`（BIGSERIAL）在 INSERT 时分配、**先于 COMMIT**，故 id 顺序 ≠ 提交可见顺序。
 *   若只按 `id > 游标` 拉取，会出现「并发事务 A 拿到较小 id 但尚未提交、事务 B 拿到较大 id 已提交」→
 *   消费方看不到 A 的行、却消费了 B 并把游标推过 B → A 随后提交时其较小 id 已 < 游标、**永远投不出去**
 *   （静默吞事件、违背 at-least-once）。为此消费方只拉取**「插入事务已早于当前所有在途事务」**的行
 *   （`xmin < txid_snapshot_xmin(txid_current_snapshot())`）：任何仍在途、可能提交出更小 id 的事务，
 *   都会把与它并发的、id 更大的已提交行**压住不投**，直到它落定；游标因此绝不会越过一个「日后还会
 *   冒出更小 id」的位置。未落定的行下一轮再拉，陈旧上限仍是 ≤ 轮询周期 + 一次事务停留。
 *   （注：`xmin` 为 32 位、`txid_*` 为带 epoch 的 64 位；单一 epoch 内比较成立，事务号绕回后此闸退化为
 *   旧的纯 `id` 水位——不会更糟、只是丢失该额外保护，属真机/绕回期验收范畴。）
 * - **游标崩溃不回退**：游标推进用 `GREATEST(existing, new)` 的幂等 upsert，进程崩溃/并发都不会让
 *   已消费的进度倒退。
 * - **execution_target 隔离**：emit 与 consume 都必须带合法 target；消费只读本 target 的行
 *   （dev 不消费 ol、反之）。target 缺失/非法 → emit 抛错、consumer 构造抛错（绝不静默降级）。
 *
 * 建表只活在 migrations/0074_event_outbox.sql（存储不自建表，遵守迁移执行器纪律）。
 */

import type pg from 'pg';

/** `pg_notify` 频道名（可选加速器）。 */
export const EVENT_OUTBOX_NOTIFY_CHANNEL = 'event_outbox';

export type ExecutionTarget = 'dev' | 'ol';

const VALID_TARGETS: ReadonlySet<string> = new Set<ExecutionTarget>(['dev', 'ol']);

export function isExecutionTarget(value: unknown): value is ExecutionTarget {
  return typeof value === 'string' && VALID_TARGETS.has(value);
}

/**
 * `pg.Pool` 与 `pg.PoolClient` 的公共子集——emit 收其一即可，从而支持「事务型 outbox」：
 * 调用方在自己已开启的事务上把这个 client 传进来，事件就落进同一个事务。
 */
export interface OutboxQueryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface EmitOutboxEventInput {
  /** 事件主题（消费方按主题分派 handler）。 */
  topic: string;
  /** JSON 可序列化的负载。undefined 视为 JSON null。 */
  payload: unknown;
  /** 归属目标；MUST 为 'dev' | 'ol'。 */
  executionTarget: string;
}

type EmitLogger = Pick<Console, 'warn'>;

/**
 * 在**调用方事务内**写入一条 outbox 事件，返回自增 id。
 *
 * INSERT 之后顺手发一条 `pg_notify`（可选加速器）：它是**事务作用域**的——PostgreSQL 会把它压到
 * 提交时才真正投递，若调用方事务回滚则通知随之丢弃（正是我们要的：不为未提交的事件发幻影通知）。
 * 通知发送失败只 warn、不改变返回值；轮询是承重通道，一定兜得住。
 *
 * MUST 在调用方的业务事务里调用本函数（传入该事务的 client），才能拿到「事件与业务写入同生共死」。
 */
export async function emitOutboxEvent(
  client: OutboxQueryable,
  input: EmitOutboxEventInput,
  logger: EmitLogger = console,
): Promise<{ id: number }> {
  if (!isExecutionTarget(input.executionTarget)) {
    throw new Error(
      `emitOutboxEvent: 非法 executionTarget=${JSON.stringify(input.executionTarget)}（只接受 'dev' | 'ol'）`,
    );
  }
  if (typeof input.topic !== 'string' || input.topic.length === 0) {
    throw new Error('emitOutboxEvent: topic 不能为空');
  }

  const payloadJson = JSON.stringify(input.payload === undefined ? null : input.payload);
  const { rows } = await client.query<{ id: string | number }>(
    `INSERT INTO event_outbox (topic, payload, execution_target)
     VALUES ($1, $2::jsonb, $3)
     RETURNING id`,
    [input.topic, payloadJson, input.executionTarget],
  );
  const id = Number(rows[0].id);

  try {
    await client.query(`SELECT pg_notify($1, $2)`, [EVENT_OUTBOX_NOTIFY_CHANNEL, input.topic]);
  } catch (err: unknown) {
    logger.warn(
      `[event-outbox] pg_notify 失败（非承重通道，轮询照常兜底）topic=${input.topic}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { id };
}

export interface OutboxEvent {
  id: number;
  topic: string;
  payload: unknown;
  executionTarget: ExecutionTarget;
  createdAt: Date;
}

/** 单个主题的处理器；MUST 幂等（同一事件可能被投递多次）。 */
export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

interface OutboxRow {
  id: string | number;
  topic: string;
  payload: unknown;
  execution_target: string;
  created_at: Date;
}

interface CursorRow {
  last_id: string | number;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface OutboxConsumerOptions {
  /** 消费者名（游标按 (consumer, target) 分行；不同消费者各自收齐全量）。 */
  consumer: string;
  /** 归属目标；只消费本 target 的行。MUST 为 'dev' | 'ol'。 */
  executionTarget: string;
  /** 复用组合根已有的 Pool。 */
  pool: OutboxQueryable;
  /** 主题 → 处理器。未注册的主题对本消费者视为无关，直接跳过并推进游标（多消费者扇出语义）。 */
  handlers: Map<string, OutboxHandler>;
  /** 每批最多拉取条数，默认 100。 */
  batchSize?: number;
  /** 有界轮询兜底间隔（毫秒），默认 2000。承重通道，MUST NOT 因接了通知就放大。 */
  pollIntervalMs?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
  /** 注入定时器（测试用）；默认 setTimeout / clearTimeout。 */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/**
 * outbox 消费者：有界轮询 + 可选通知唤醒。
 *
 * 生命周期：`start()` 读游标、跑一轮、排下一次轮询；`wake()` 让当前空闲的轮询提前触发一次
 * （由持有 LISTEN 长连接的一方在收到 NOTIFY 时调用——LISTEN 连接的接线属 server 组合根，不在本原语内）；
 * `stop()` 停表、可释放。
 */
export class OutboxConsumer {
  private readonly consumer: string;
  private readonly executionTarget: ExecutionTarget;
  private readonly pool: OutboxQueryable;
  private readonly handlers: Map<string, OutboxHandler>;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn'>;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  private running = false;
  private draining = false;
  private wakePending = false;
  private timer: TimerHandle | null = null;

  constructor(options: OutboxConsumerOptions) {
    if (!isExecutionTarget(options.executionTarget)) {
      throw new Error(
        `OutboxConsumer: 非法 executionTarget=${JSON.stringify(
          options.executionTarget,
        )}（只接受 'dev' | 'ol'）—— target 缺失/非法不启动`,
      );
    }
    if (typeof options.consumer !== 'string' || options.consumer.length === 0) {
      throw new Error('OutboxConsumer: consumer 名不能为空');
    }
    // batchSize 必须为正整数：0 / 负数会让 `LIMIT $3` 恒返 0 行、drainedFull 恒真 → drain 循环空转
    // 死打数据库（每轮两次查询、无定时器让位）。构造期一次性拦住这个误配置脚枪。
    if (options.batchSize !== undefined && (!Number.isInteger(options.batchSize) || options.batchSize <= 0)) {
      throw new Error(
        `OutboxConsumer: batchSize 必须为正整数，收到 ${JSON.stringify(options.batchSize)}`,
      );
    }
    // pollIntervalMs 必须为非负有限数：负数 / NaN 会让兜底轮询定时器行为未定义。
    if (
      options.pollIntervalMs !== undefined &&
      (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs < 0)
    ) {
      throw new Error(
        `OutboxConsumer: pollIntervalMs 必须为非负有限数，收到 ${JSON.stringify(options.pollIntervalMs)}`,
      );
    }
    this.consumer = options.consumer;
    this.executionTarget = options.executionTarget;
    this.pool = options.pool;
    this.handlers = options.handlers;
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.logger = options.logger ?? console;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  /** 启动：立即跑一轮，之后按轮询间隔兜底。幂等（重复调用无副作用）。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  /** 停止：不再排新轮询、清掉挂起的定时器。已在跑的一轮会自然收敛。 */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /**
   * 加速器唤醒：让空闲中的轮询提前触发一次。收到 pg_notify 时调用。
   * 若正在排空则记一个「待唤醒」标志，本轮结束后立即再跑一轮（不丢通知）。
   */
  wake(): void {
    if (!this.running) return;
    if (this.draining) {
      this.wakePending = true;
      return;
    }
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    void this.tick();
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, this.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.draining) return;
    this.draining = true;
    try {
      // 一次醒来把能拉到的都排空：拉满一批说明还有，继续；不满一批说明追平了。
      let drainedFull = true;
      while (this.running && drainedFull) {
        const processed = await this.runOnce();
        drainedFull = processed === this.batchSize;
      }
    } catch (err: unknown) {
      this.logger.warn(
        `[event-outbox] 消费轮询失败（下一轮重试）consumer=${this.consumer} target=${this.executionTarget}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.draining = false;
    }
    if (this.wakePending) {
      this.wakePending = false;
      if (this.running) void this.tick();
      return;
    }
    this.scheduleNext();
  }

  /**
   * 拉一批 → 逐条分派 → 推进游标，返回本批处理条数。
   *
   * at-least-once 的核心：只把游标推到「连续成功的最后一条」的 id。某条 handler 抛错即停在它之前，
   * 游标不越过它，下一轮从游标之后重放。公开以便单测直接驱动（不依赖真定时器）。
   */
  async runOnce(): Promise<number> {
    const lastId = await this.readCursor();
    // 安全水位（见文件头「提交乱序安全水位」）：只拉「插入事务已早于当前所有在途事务」的行，
    // 即 xmin < 当前快照 xmin。这样任何仍在途、可能日后提交出更小 id 的并发事务，都会把与它
    // 并发的、id 更大的已提交行压住不投，游标绝不越过一个「日后还会冒出更小 id」的位置。
    // 被压住的行不算追平：runOnce 返回实际投递条数，drain 循环据此停手、下一轮再拉。
    const { rows } = await this.pool.query<OutboxRow>(
      `SELECT id, topic, payload, execution_target, created_at
         FROM event_outbox
        WHERE execution_target = $1 AND id > $2
          AND xmin::text::bigint < txid_snapshot_xmin(txid_current_snapshot())
        ORDER BY id ASC
        LIMIT $3`,
      [this.executionTarget, lastId, this.batchSize],
    );
    if (rows.length === 0) return 0;

    let progressedTo = lastId;
    let handled = 0;
    for (const row of rows) {
      const event: OutboxEvent = {
        id: Number(row.id),
        topic: row.topic,
        payload: row.payload,
        executionTarget: row.execution_target as ExecutionTarget,
        createdAt: row.created_at,
      };
      const handler = this.handlers.get(event.topic);
      if (handler) {
        try {
          await handler(event);
        } catch (err: unknown) {
          // 停在这条之前：游标不越过失败条，先把此前连续成功的进度落库，下一轮重放本条。
          this.logger.warn(
            `[event-outbox] handler 抛错，停在 id=${event.id} 之前（下一轮重放）topic=${event.topic}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          break;
        }
      }
      // handler 成功，或本消费者对该主题无关（跳过）——两种情况都可安全推进游标越过本条。
      progressedTo = event.id;
      handled += 1;
    }

    if (progressedTo > lastId) await this.advanceCursor(progressedTo);
    return handled;
  }

  private async readCursor(): Promise<number> {
    const { rows } = await this.pool.query<CursorRow>(
      `SELECT last_id FROM event_outbox_cursor WHERE consumer = $1 AND execution_target = $2`,
      [this.consumer, this.executionTarget],
    );
    if (rows.length === 0) return 0;
    const value = Number(rows[0].last_id);
    return Number.isFinite(value) ? value : 0;
  }

  /**
   * 游标推进：幂等 upsert + `GREATEST` 守——崩溃/并发都不会让已消费进度倒退（CAS 语义）。
   */
  private async advanceCursor(lastId: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO event_outbox_cursor (consumer, execution_target, last_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (consumer, execution_target)
       DO UPDATE SET last_id = GREATEST(event_outbox_cursor.last_id, EXCLUDED.last_id),
                     updated_at = now()`,
      [this.consumer, this.executionTarget, lastId],
    );
  }
}
