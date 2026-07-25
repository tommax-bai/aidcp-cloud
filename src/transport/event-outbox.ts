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
 * - **游标按主题分维（change outbox-listen-and-topic-cursor）**：游标键是 `(consumer, target, topic)`，
 *   落在 `event_outbox_topic_cursor`（migrations/0075）。一条毒消息只堵**它自己那条主题**，其余主题照常
 *   推进——这正是 broker 的「逐条 ack + 待处理表」所提供的收益，零新组件拿到。
 *   ⚠️ 幂等不是可以假设的：本仓实测 `risk.command` 的 `applySignal` **不幂等**（`light` 信号重投会把
 *   normal→warned→restricted 一路推上去，`signalCount` 单调累加，见 src/risk/risk-state-machine.ts:27,56）。
 *   故迁移的存量回填 MUST 取「不重放也不跳过」的精确续接，MUST NOT 靠「重放总是安全的」搪塞。
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
 * - **保留期**：outbox 是队列不是账本。`pruneEventOutbox` / `OutboxRetentionPruner` 按**主题**剪裁
 *   （见文末），没有它这张表只进不出、在 dev/ol 共用的**生产** PostgreSQL 上无界增长。
 *
 * 建表只活在 migrations/0074_event_outbox.sql（存储不自建表，遵守迁移执行器纪律）。
 */

import type pg from 'pg';

/** `pg_notify` 频道名（可选加速器）。 */
export const EVENT_OUTBOX_NOTIFY_CHANNEL = 'event_outbox';

/**
 * `NOTIFY` 载荷的字节上限（PostgreSQL 硬限 8000 字节，超限直接报错）。
 *
 * 本通道的载荷**只当唤醒信号**用——最多带一个 topic 名，业务数据一律走 `event_outbox` 行本身。
 * 留出余量后取 7900：topic 正常是十几字节，这道闸只为挡住「有人把业务字段塞进 topic」的将来。
 * 超限时降级为空载荷（消费方按「未知主题」全量唤醒一次），MUST NOT 让加速器把承重的 INSERT 拖崩。
 */
export const NOTIFY_PAYLOAD_MAX_BYTES = 7900;

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

  // 载荷只带 topic（唤醒信号，非数据通道）。超 8000 字节上限则退化为空载荷、由消费方全量唤醒。
  const notifyPayload =
    Buffer.byteLength(input.topic, 'utf8') <= NOTIFY_PAYLOAD_MAX_BYTES ? input.topic : '';
  try {
    await client.query(`SELECT pg_notify($1, $2)`, [EVENT_OUTBOX_NOTIFY_CHANNEL, notifyPayload]);
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
  /** 消费者名（游标按 (consumer, target, topic) 分行；不同消费者各自收齐全量）。 */
  consumer: string;
  /** 归属目标；只消费本 target 的行。MUST 为 'dev' | 'ol'。 */
  executionTarget: string;
  /** 复用组合根已有的 Pool。 */
  pool: OutboxQueryable;
  /**
   * 主题 → 处理器。**只有注册过的主题会被拉取**：游标按主题分维之后，未注册主题既不查也不进游标
   * （从前是「拉出来、跳过、把聚合游标推过去」；新语义下它对本消费者根本不存在）。
   */
  handlers: Map<string, OutboxHandler>;
  /** 每批最多拉取条数，默认 100。**按主题计**（每个主题各自最多拉这么多）。 */
  batchSize?: number;
  /** 有界轮询兜底间隔（毫秒），默认 2000。承重通道，MUST NOT 因接了通知就放大。 */
  pollIntervalMs?: number;
  /**
   * 通知唤醒的最小间隔（毫秒），默认 50。
   *
   * `panel.event` 是全量总线 firehose——每条编排事件都会发一次 `NOTIFY`。若每条通知都立刻触发一轮
   * 查询，空闲期的查询频率就等于总线事件频率。这道闸把**通知驱动**的查询频率压到 ≤ 1/该间隔，
   * 唤醒延迟仍是毫秒级。它只压通知路径，**MUST NOT** 用来放大 `pollIntervalMs`（承重通道）。
   */
  wakeDebounceMs?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
  /** 注入定时器（测试用）；默认 setTimeout / clearTimeout。 */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** 注入时钟（测试用）；默认 Date.now。 */
  now?: () => number;
}

/** 一条被毒消息堵住的主题（只堵它自己，其余主题照常推进）。 */
export interface OutboxBlockedTopic {
  topic: string;
  /** 卡住的那条事件 id。 */
  eventId: number;
  /** 首次卡住的时刻（毫秒时间戳）。 */
  since: number;
  /** 连续失败次数。 */
  attempts: number;
  lastError: string;
}

/** 消费者健康度快照（可观测：给运维 / 面板看「通道是否在动、被什么堵住」）。 */
export interface OutboxConsumerStats {
  consumer: string;
  executionTarget: ExecutionTarget;
  topics: string[];
  running: boolean;
  pollIntervalMs: number;
  /** 已跑过的轮次数（含通知唤醒触发的）。 */
  ticks: number;
  /** 收到并采纳的唤醒次数。 */
  wakes: number;
  /** 收到但与本消费者无关（主题未注册）而丢弃的唤醒次数。 */
  wakesIgnored: number;
  /** 累计成功投递条数。 */
  handledTotal: number;
  lastTickAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  /** 各主题最近一次读到 / 推进到的游标位置。 */
  cursors: Record<string, number>;
  /** 被毒消息堵住的主题（空数组 = 全部畅通）。 */
  blocked: OutboxBlockedTopic[];
}

/**
 * outbox 消费者：有界轮询 + 通知唤醒，游标按 `(consumer, target, topic)` 分维。
 *
 * 生命周期：`start()` 逐主题读游标、跑一轮、排下一次轮询；`wake(topic?)` 让当前空闲的轮询提前触发一次
 * （由 `OutboxNotifyListener` 收到 `NOTIFY` 时调用，带上通知载荷里的 topic）；`stop()` 停表、可释放。
 *
 * **主题隔离**：每个已注册主题各读各的游标、各拉各的一批。某主题的 handler 抛错只会把**那条主题**
 * 停在失败条之前，其余主题本轮照常推进——单条毒消息不再堵队头。被堵主题进 `stats().blocked`。
 */
export class OutboxConsumer {
  private readonly consumer: string;
  private readonly executionTarget: ExecutionTarget;
  private readonly pool: OutboxQueryable;
  private readonly handlers: Map<string, OutboxHandler>;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly wakeDebounceMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn'>;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly now: () => number;

  private running = false;
  private draining = false;
  private wakePending = false;
  private timer: TimerHandle | null = null;
  /** 唤醒去抖用：上一次 tick 起跑的时刻。 */
  private lastTickStartedAt = 0;
  /** 本进程已同步到遗留聚合游标的水位（只增，避免每轮重复写同一个值）。 */
  private legacySyncedTo = 0;
  private readonly cursorByTopic = new Map<string, number>();
  private readonly blockedByTopic = new Map<string, OutboxBlockedTopic>();
  private ticks = 0;
  private wakes = 0;
  private wakesIgnored = 0;
  private handledTotal = 0;
  private lastTickAt: number | null = null;
  private lastErrorAt: number | null = null;
  private lastError: string | null = null;

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
    // wakeDebounceMs 同样必须为非负有限数（负数 / NaN 会让唤醒定时器行为未定义）。
    if (
      options.wakeDebounceMs !== undefined &&
      (!Number.isFinite(options.wakeDebounceMs) || options.wakeDebounceMs < 0)
    ) {
      throw new Error(
        `OutboxConsumer: wakeDebounceMs 必须为非负有限数，收到 ${JSON.stringify(options.wakeDebounceMs)}`,
      );
    }
    this.consumer = options.consumer;
    this.executionTarget = options.executionTarget;
    this.pool = options.pool;
    this.handlers = options.handlers;
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.wakeDebounceMs = options.wakeDebounceMs ?? 50;
    this.logger = options.logger ?? console;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.now = options.now ?? (() => Date.now());
  }

  /** 本消费者是否关心该主题（通知唤醒的过滤依据：别让别人的主题把本消费者吵醒）。 */
  handlesTopic(topic: string): boolean {
    return this.handlers.has(topic);
  }

  /** 健康度快照（同步、不连库）。 */
  stats(): OutboxConsumerStats {
    return {
      consumer: this.consumer,
      executionTarget: this.executionTarget,
      topics: [...this.handlers.keys()],
      running: this.running,
      pollIntervalMs: this.pollIntervalMs,
      ticks: this.ticks,
      wakes: this.wakes,
      wakesIgnored: this.wakesIgnored,
      handledTotal: this.handledTotal,
      lastTickAt: this.lastTickAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      cursors: Object.fromEntries(this.cursorByTopic),
      blocked: [...this.blockedByTopic.values()],
    };
  }

  /**
   * 队列占用：各主题「游标之后还压着多少条」。连库计数，供健康巡检 / 面板取用。
   *
   * 用的是本进程最近一次读到的游标位置（`stats().cursors`），未跑过的主题按 0 算——它是**观测量**，
   * 不参与任何投递判定，故不为它再跑一次游标查询。
   */
  async backlogByTopic(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const topic of this.handlers.keys()) {
      const after = this.cursorByTopic.get(topic) ?? 0;
      const { rows } = await this.pool.query<{ pending: string | number }>(
        `SELECT count(*)::bigint AS pending
           FROM event_outbox
          WHERE execution_target = $1 AND topic = $2 AND id > $3`,
        [this.executionTarget, topic, after],
      );
      const n = Number(rows[0]?.pending ?? 0);
      out[topic] = Number.isFinite(n) ? n : 0;
    }
    return out;
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
   * 加速器唤醒：让空闲中的轮询提前触发一次。由 LISTEN 长连接收到 `NOTIFY` 时调用。
   *
   * - `topic` 给了且本消费者没注册它 → 与我无关，丢弃（`panel.event` firehose 不该吵醒风控命令消费者）。
   *   `topic` 缺省 / 空串（载荷超限降级）→ 无从判断，照常唤醒一次（多跑一次查询，不会漏投）。
   * - 正在排空 → 记「待唤醒」标志，本轮结束后立即再跑一轮（不丢通知）。
   * - 距上轮起跑不足去抖窗口 → 排一个短定时器，把通知驱动的查询频率压住（见 `wakeDebounceMs`）。
   */
  wake(topic?: string): void {
    if (!this.running) return;
    if (topic !== undefined && topic !== '' && !this.handlers.has(topic)) {
      this.wakesIgnored += 1;
      return;
    }
    this.wakes += 1;
    if (this.draining) {
      this.wakePending = true;
      return;
    }
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const since = this.now() - this.lastTickStartedAt;
    const delay = since >= this.wakeDebounceMs ? 0 : this.wakeDebounceMs - since;
    if (delay <= 0) {
      void this.tick();
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  private scheduleNext(): void {
    if (!this.running) return;
    // 承重通道：兜底轮询间隔与「有没有接通知」无关，MUST NOT 因接了通知而放大（见文件头）。
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, this.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.draining) return;
    this.draining = true;
    this.ticks += 1;
    this.lastTickStartedAt = this.now();
    this.lastTickAt = this.lastTickStartedAt;
    try {
      // 一次醒来把能拉到的都排空：任一主题拉满一批说明它还有，继续；都不满说明追平了。
      let drainedFull = true;
      while (this.running && drainedFull) {
        const round = await this.runRound();
        drainedFull = round.sawFullBatch;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.lastErrorAt = this.now();
      this.logger.warn(
        `[event-outbox] 消费轮询失败（下一轮重试）consumer=${this.consumer} target=${this.executionTarget}: ${message}`,
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
   * 逐主题跑一轮：拉一批 → 逐条分派 → 推进该主题游标，返回本轮总投递条数。
   * 公开以便单测直接驱动（不依赖真定时器）。
   */
  async runOnce(): Promise<number> {
    return (await this.runRound()).handled;
  }

  /**
   * 一轮 = 对**每个已注册主题**各跑一次。主题之间互不影响：
   * - 某主题 handler 抛错只堵它自己（游标停在失败条之前），其余主题本轮照常推进；
   * - 某主题**查询本身**失败（库错）不吞、也不阻断后面的主题：记下来、继续跑，全部跑完再抛出去，
   *   由 `tick()` 统一 warn + 下一轮重试。绝不静默降级成「看起来在跑」。
   */
  private async runRound(): Promise<{ handled: number; sawFullBatch: boolean }> {
    let handled = 0;
    let sawFullBatch = false;
    const failures: string[] = [];
    const cursors = new Map<string, number>();
    for (const topic of this.handlers.keys()) {
      try {
        const result = await this.runTopicOnce(topic);
        handled += result.handled;
        cursors.set(topic, result.cursor);
        // 「拉满一批」按实际投递条数判，而非返回行数：被毒消息卡住的主题投递数必然 < batchSize，
        // 因此绝不会把 drain 循环拖成对同一条失败消息的死转。
        if (result.handled === this.batchSize) sawFullBatch = true;
      } catch (err: unknown) {
        failures.push(`${topic}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.handledTotal += handled;
    // 有主题查询失败时不动遗留聚合游标：它是「所有主题都已越过」的下界，样本不全就不能推进。
    if (failures.length === 0) await this.syncLegacyAggregateCursor(cursors);
    if (failures.length > 0) {
      throw new Error(`event_outbox 主题消费失败 ${failures.length} 条 —— ${failures.join('；')}`);
    }
    return { handled, sawFullBatch };
  }

  /** 单个主题的一轮：读该主题游标 → 拉一批 → 逐条分派 → 推进该主题游标。 */
  private async runTopicOnce(topic: string): Promise<{ handled: number; cursor: number }> {
    const handler = this.handlers.get(topic);
    if (!handler) return { handled: 0, cursor: this.cursorByTopic.get(topic) ?? 0 };

    const lastId = await this.readCursor(topic);
    this.cursorByTopic.set(topic, lastId);
    // 安全水位（见文件头「提交乱序安全水位」）：只拉「插入事务已早于当前所有在途事务」的行，
    // 即 xmin < 当前快照 xmin。这样任何仍在途、可能日后提交出更小 id 的并发事务，都会把与它
    // 并发的、id 更大的已提交行压住不投，游标绝不越过一个「日后还会冒出更小 id」的位置。
    // 被压住的行不算追平：本方法返回实际投递条数，drain 循环据此停手、下一轮再拉。
    const { rows } = await this.pool.query<OutboxRow>(
      `SELECT id, topic, payload, execution_target, created_at
         FROM event_outbox
        WHERE execution_target = $1 AND topic = $2 AND id > $3
          AND xmin::text::bigint < txid_snapshot_xmin(txid_current_snapshot())
        ORDER BY id ASC
        LIMIT $4`,
      [this.executionTarget, topic, lastId, this.batchSize],
    );
    if (rows.length === 0) {
      this.blockedByTopic.delete(topic);
      return { handled: 0, cursor: lastId };
    }

    let progressedTo = lastId;
    let handled = 0;
    let blocked = false;
    for (const row of rows) {
      const event: OutboxEvent = {
        id: Number(row.id),
        topic: row.topic,
        payload: row.payload,
        executionTarget: row.execution_target as ExecutionTarget,
        createdAt: row.created_at,
      };
      try {
        await handler(event);
      } catch (err: unknown) {
        // 停在这条之前：本主题游标不越过失败条，先把此前连续成功的进度落库，下一轮重放本条。
        // 其余主题不受牵连——毒消息只堵它自己那条主题。
        const message = err instanceof Error ? err.message : String(err);
        const prior = this.blockedByTopic.get(topic);
        const record: OutboxBlockedTopic = {
          topic,
          eventId: event.id,
          since: prior && prior.eventId === event.id ? prior.since : this.now(),
          attempts: prior && prior.eventId === event.id ? prior.attempts + 1 : 1,
          lastError: message,
        };
        this.blockedByTopic.set(topic, record);
        blocked = true;
        this.logger.warn(
          `[event-outbox] handler 抛错，主题 ${topic} 停在 id=${event.id} 之前（下一轮重放，只堵本主题）` +
            ` consumer=${this.consumer} attempts=${record.attempts}: ${message}`,
        );
        break;
      }
      progressedTo = event.id;
      handled += 1;
    }
    if (!blocked) this.blockedByTopic.delete(topic);

    if (progressedTo > lastId) {
      await this.advanceCursor(topic, progressedTo);
      this.cursorByTopic.set(topic, progressedTo);
    }
    return { handled, cursor: progressedTo };
  }

  /**
   * 读某主题的游标位置。
   *
   * **两级回落，顺序不可颠倒**（change outbox-listen-and-topic-cursor 的存量安全核心）：
   *   1. `event_outbox_topic_cursor` 的 `(consumer, target, topic)` 行 —— 分维之后的真实进度；
   *   2. 没有该行时回落到遗留的 `event_outbox_cursor` 的 `(consumer, target)` 聚合行 —— 它的语义是
   *      「id ≤ last_id 的**全部**主题都已消费」，因此对任意主题都是一个**既不漏投也不重放**的精确起点；
   *   3. 两者都没有 → 0（全新消费者，与今天行为一致）。
   *
   * 回落到 0 而不是回落到聚合行，会把该消费者已经消费过的全部历史**原样重放一遍**；本仓的
   * `risk.command` 消费方实测不幂等（见文件头），那是一次真实的状态损坏，不是「幂等所以无所谓」。
   */
  private async readCursor(topic: string): Promise<number> {
    const { rows } = await this.pool.query<CursorRow>(
      `SELECT COALESCE(
                (SELECT last_id FROM event_outbox_topic_cursor
                  WHERE consumer = $1 AND execution_target = $2 AND topic = $3),
                (SELECT last_id FROM event_outbox_cursor
                  WHERE consumer = $1 AND execution_target = $2),
                0
              ) AS last_id`,
      [this.consumer, this.executionTarget, topic],
    );
    if (rows.length === 0) return 0;
    const value = Number(rows[0].last_id);
    return Number.isFinite(value) ? value : 0;
  }

  /**
   * 主题游标推进：幂等 upsert + `GREATEST` 守——崩溃/并发都不会让已消费进度倒退（CAS 语义）。
   */
  private async advanceCursor(topic: string, lastId: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO event_outbox_topic_cursor (consumer, execution_target, topic, last_id, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (consumer, execution_target, topic)
       DO UPDATE SET last_id = GREATEST(event_outbox_topic_cursor.last_id, EXCLUDED.last_id),
                     updated_at = now()`,
      [this.consumer, this.executionTarget, topic, lastId],
    );
  }

  /**
   * 把遗留的 `(consumer, target)` 聚合游标同步到「各主题游标的**最小值**」。
   *
   * 为什么还要写它：回滚到分维之前的旧代码时，旧代码只认这一行。取 **min** 而不是 max ——
   *   - min ⇒ 旧代码可能**重放**边界上的少量事件（安全方向，且窗口只有主题间的落差）；
   *   - max ⇒ 旧代码会**跳过**尚未消费的那条主题的事件（静默漏投，红线）。
   * `GREATEST` 守保证它只增不减；min 恒 ≥ 回填时的聚合值（回填就是拿聚合值播种每个主题），故不会卡死。
   */
  private async syncLegacyAggregateCursor(cursors: Map<string, number>): Promise<void> {
    if (cursors.size === 0) return;
    let min = Number.POSITIVE_INFINITY;
    for (const value of cursors.values()) min = Math.min(min, value);
    if (!Number.isFinite(min) || min <= this.legacySyncedTo) return;
    await this.pool.query(
      `INSERT INTO event_outbox_cursor (consumer, execution_target, last_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (consumer, execution_target)
       DO UPDATE SET last_id = GREATEST(event_outbox_cursor.last_id, EXCLUDED.last_id),
                     updated_at = now()`,
      [this.consumer, this.executionTarget, min],
    );
    this.legacySyncedTo = min;
  }
}

/* ─────────────────────────────── 保留期 / 剪裁 ─────────────────────────────── */

/**
 * 一个主题的保留策略。
 *
 * **`consumers` 为空数组不是「忘了填」，是一个正式结论**：本部署形态下这个主题确实没有任何消费者
 * （典型：`core` 模式的面板事件——面板与产生端同进程直连，回放根本不启动）。此时按年龄剪裁即可，
 * **且不产生任何告警**：没有消费者是这个模式的正常形态，不是故障。
 *
 * 反过来，「所有声明的消费者都必须有进度行才允许剪裁」这条守卫，只有在消费者**真的存在**时才成立；
 * 无条件套用会让没有消费者的模式永久拒绝剪裁 + 永久告警，把一道安全闸变成噪声源加磁盘炸弹。
 */
export interface OutboxTopicRetention {
  /** 主题名。 */
  topic: string;
  /** 已被全部必需消费者追平的行，超过这个年龄即剪。 */
  retentionMs: number;
  /** 必须先有消费进度才允许剪过的消费者名；空 = 本形态下该主题无消费者（纯按年龄剪、不告警）。 */
  consumers: readonly string[];
  /**
   * 兜底上限（可选）：即使消费进度没跟上、甚至消费者从未上线，超过这个年龄的行也剪掉，并**如实告警**
   * （日志写明剪了多少条未确认消费的行）。只给**纯观测类**主题设；承重命令类主题 MUST NOT 设——
   * 那等于把「本该被应用的写命令」悄悄扔掉。
   */
  unconsumedRetentionMs?: number;
}

/** 一个主题一轮剪裁的结果。所有「没剪成」的情形都在这里如实表达，绝不伪装成正常。 */
export interface OutboxTopicPruneResult {
  topic: string;
  /** 消费进度线以内、按 `retentionMs` 删掉的行数。 */
  deleted: number;
  /** 按 `unconsumedRetentionMs` 兜底强删的行数（这些行未被确认消费过）；>0 MUST 告警。 */
  forced: number;
  /** 剪裁上界（全部必需消费者的最小进度）；null = 无必需消费者或本轮被挡住。 */
  floorId: number | null;
  /** 缺进度行、导致本轮不敢剪，且**确有到龄行堆着**——如实报出是哪些消费者；否则 null。 */
  blockedBy: string[] | null;
}

export interface PruneEventOutboxOptions {
  /** 归属目标；只剪本 target 的行。MUST 为 'dev' | 'ol'。 */
  executionTarget: string;
  /** 逐主题的保留策略。**未登记的主题一行都不会被剪**（宁可留着，也不猜别人的语义）。 */
  topics: readonly OutboxTopicRetention[];
  /** 单主题单轮删除上限，默认 2000（有界：绝不一条语句锁住整张表）。 */
  batchLimit?: number;
  /** 当前时刻（注入便于测试），默认 `Date.now()`。 */
  now?: () => number;
}

/** 单主题单轮删除上限的默认值。 */
export const DEFAULT_OUTBOX_PRUNE_BATCH = 2000;
/** 兜底轮询间隔的默认值：10 分钟一轮（剪裁不是热路径）。 */
export const DEFAULT_OUTBOX_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

interface CursorConsumerRow {
  consumer: string;
  last_id: string | number;
}

/**
 * 按主题剪裁 `event_outbox`（一轮，有界）。返回逐主题结果，**调用方负责告警**。
 *
 * 剪裁上界的两条规则：
 *   1. 主题声明了消费者 → 只剪「全部消费者都已越过」的 id（`min(last_id)`）。任一消费者连游标行都
 *      还没有 ⇒ 它可能一条都没消费过，本轮**一条都不剪**（`blockedBy`），除非有兜底上限。
 *   2. 主题没有消费者 → 没有「等谁追平」这回事，纯按年龄剪。
 *
 * 诚实闸：规则 1 挡住时，只有**确实存在到龄行**才报 `blockedBy`。没有到龄行就什么都不报——
 * 「没东西可剪」不是故障，为它每轮打一条告警只会把真问题淹掉。
 */
export async function pruneEventOutbox(
  pool: OutboxQueryable,
  options: PruneEventOutboxOptions,
): Promise<OutboxTopicPruneResult[]> {
  if (!isExecutionTarget(options.executionTarget)) {
    throw new Error(
      `pruneEventOutbox: 非法 executionTarget=${JSON.stringify(options.executionTarget)}（只接受 'dev' | 'ol'）`,
    );
  }
  const target = options.executionTarget;
  const batchLimit = options.batchLimit ?? DEFAULT_OUTBOX_PRUNE_BATCH;
  const nowMs = (options.now ?? (() => Date.now()))();
  const results: OutboxTopicPruneResult[] = [];

  for (const spec of options.topics) {
    if (!Number.isFinite(spec.retentionMs) || spec.retentionMs < 0) {
      throw new Error(
        `pruneEventOutbox: topic=${spec.topic} 的 retentionMs 必须为非负有限数，收到 ${JSON.stringify(spec.retentionMs)}`,
      );
    }
    let floorId: number | null = null;
    let blockedBy: string[] | null = null;

    if (spec.consumers.length > 0) {
      const { rows } = await pool.query<CursorConsumerRow>(
        `SELECT consumer, last_id FROM event_outbox_cursor
          WHERE execution_target = $1 AND consumer = ANY($2::text[])`,
        [target, [...spec.consumers]],
      );
      const progress = new Map<string, number>();
      for (const row of rows) progress.set(row.consumer, Number(row.last_id));
      const missing = spec.consumers.filter((name) => !progress.has(name));
      if (missing.length > 0) blockedBy = [...missing];
      else floorId = Math.min(...spec.consumers.map((name) => progress.get(name) ?? 0));
    }

    const cutoff = new Date(nowMs - spec.retentionMs);
    let deleted = 0;
    if (blockedBy === null) {
      const res = await pool.query(
        `DELETE FROM event_outbox
          WHERE id IN (
            SELECT id FROM event_outbox
             WHERE execution_target = $1 AND topic = $2 AND created_at < $3
               AND ($4::bigint IS NULL OR id <= $4::bigint)
             ORDER BY id ASC
             LIMIT $5
          )`,
        [target, spec.topic, cutoff, floorId, batchLimit],
      );
      deleted = res.rowCount ?? 0;
    } else {
      // 诚实闸：确认真有到龄行堆着才报；没有就静默（这不是故障）。
      const { rows } = await pool.query<{ id: string | number }>(
        `SELECT id FROM event_outbox
          WHERE execution_target = $1 AND topic = $2 AND created_at < $3
          LIMIT 1`,
        [target, spec.topic, cutoff],
      );
      if (rows.length === 0) blockedBy = null;
    }

    let forced = 0;
    if (spec.unconsumedRetentionMs !== undefined) {
      const hardCutoff = new Date(nowMs - spec.unconsumedRetentionMs);
      const res = await pool.query(
        `DELETE FROM event_outbox
          WHERE id IN (
            SELECT id FROM event_outbox
             WHERE execution_target = $1 AND topic = $2 AND created_at < $3
             ORDER BY id ASC
             LIMIT $4
          )`,
        [target, spec.topic, hardCutoff, batchLimit],
      );
      forced = res.rowCount ?? 0;
    }

    results.push({ topic: spec.topic, deleted, forced, floorId, blockedBy });
  }
  return results;
}

export interface OutboxRetentionPrunerOptions extends PruneEventOutboxOptions {
  pool: OutboxQueryable;
  /** 兜底轮询间隔（毫秒），默认 10 分钟。 */
  intervalMs?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/**
 * 定时剪裁器：把 `pruneEventOutbox` 挂到一个有界定时器上，并把「没剪成」如实说出来。
 *
 * 告警纪律（防噪声）：
 *   - 被消费进度挡住 → **只在状态跃迁时**各打一条（进入受阻 / 恢复），不每轮重复刷屏；
 *   - 兜底强删 → 每次都 warn（真的丢了未确认消费的行，必须次次可见）；
 *   - 一切正常 → 只在真删到行时打一条 info。
 */
export class OutboxRetentionPruner {
  private readonly pool: OutboxQueryable;
  private readonly options: PruneEventOutboxOptions;
  private readonly intervalMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn'>;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly blockedTopics = new Set<string>();

  private running = false;
  private ticking = false;
  private timer: TimerHandle | null = null;

  constructor(options: OutboxRetentionPrunerOptions) {
    if (!isExecutionTarget(options.executionTarget)) {
      throw new Error(
        `OutboxRetentionPruner: 非法 executionTarget=${JSON.stringify(
          options.executionTarget,
        )}（只接受 'dev' | 'ol'）—— target 缺失/非法不启动`,
      );
    }
    if (
      options.intervalMs !== undefined &&
      (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0)
    ) {
      throw new Error(
        `OutboxRetentionPruner: intervalMs 必须为正有限数，收到 ${JSON.stringify(options.intervalMs)}`,
      );
    }
    this.pool = options.pool;
    this.options = {
      executionTarget: options.executionTarget,
      topics: options.topics,
      batchLimit: options.batchLimit,
      now: options.now,
    };
    this.intervalMs = options.intervalMs ?? DEFAULT_OUTBOX_PRUNE_INTERVAL_MS;
    this.logger = options.logger ?? console;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  /** 启动：立即剪一轮，之后按间隔兜底。幂等。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  /** 停止：不再排新轮次。 */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** 手动驱动一轮（单测用，不依赖真定时器）；返回逐主题结果。 */
  async runOnce(): Promise<OutboxTopicPruneResult[]> {
    const results = await pruneEventOutbox(this.pool, this.options);
    for (const r of results) {
      if (r.forced > 0) {
        this.logger.warn(
          `[event-outbox] 兜底剪裁：topic=${r.topic} 强删 ${r.forced} 行**未确认被消费**的过期事件` +
            `（超过 unconsumedRetentionMs；宁可丢历史观测帧也不让生产库无界增长）`,
        );
      }
      if (r.blockedBy !== null) {
        if (!this.blockedTopics.has(r.topic)) {
          this.blockedTopics.add(r.topic);
          this.logger.warn(
            `[event-outbox] 拒绝剪裁：topic=${r.topic} 有到龄行，但消费者 ${r.blockedBy.join(
              ',',
            )} 尚无消费进度行 —— 不敢剪（剪了就是静默吞事件）。消费进程是否在跑？`,
          );
        }
      } else if (this.blockedTopics.delete(r.topic)) {
        this.logger.log(`[event-outbox] 剪裁已恢复：topic=${r.topic} 的消费进度已就位`);
      }
      if (r.deleted > 0) {
        this.logger.log(
          `[event-outbox] 剪裁 topic=${r.topic} 删除 ${r.deleted} 行（上界 id=${r.floorId ?? '按年龄'}）`,
        );
      }
    }
    return results;
  }

  private async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      await this.runOnce();
    } catch (err: unknown) {
      this.logger.warn(
        `[event-outbox] 剪裁轮次失败（下一轮重试）: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.ticking = false;
    }
    if (!this.running) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, this.intervalMs);
  }
}
