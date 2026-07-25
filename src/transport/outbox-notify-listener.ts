/**
 * outbox 通知唤醒的 `LISTEN` 长连接（change outbox-listen-and-topic-cursor）。
 *
 * ## 它补上的缺口
 *
 * `OutboxConsumer.wake()` 早就在原语里，但**生产代码零调用者**——没有任何一方持有 `LISTEN` 会话，
 * 于是 `emitOutboxEvent` 每次发的 `pg_notify` 都发给了空气，投递延迟恒等于一个完整轮询周期。
 * 本文件把接收端接起来：`LISTEN` 到通知就唤醒对应消费者，投递延迟降到毫秒级。
 *
 * ## 三条纪律（不是可选项）
 *
 * 1. **专用连接**。`pg.Pool` 不能用于 `LISTEN`：池会把连接回收给别的查询、也会按空闲策略销毁它，
 *    订阅随之无声消失。故本类持有一个**独占的 `pg.Client`**（由组合根按属主连接配置注入工厂），
 *    只用来 `LISTEN`、绝不跑业务查询、不占共享池的额度。
 * 2. **有界重连**。断开必重连，退避按指数增长但**有上限**（默认 1s 起、30s 封顶、±20% 抖动），
 *    绝不形成重连风暴；同时**永不放弃**——放弃等于把加速器悄悄关掉，那正是红线里的静默降级。
 *    连续失败次数、上次错误、上次连上的时刻都进 `health()`，并在跨过告警阈值时抬高日志等级。
 * 3. **绝不因为接了通知就放宽轮询**。承重通道永远是 `OutboxConsumer` 的有界轮询（见
 *    `event-outbox.ts` 文件头的 MUST NOT）。本类只负责「早一点醒一次」；它整个挂掉，投递也只是
 *    退回轮询周期，绝不丢事件。
 *
 * ## 载荷
 *
 * `NOTIFY` 的载荷有 8000 字节硬上限，且在事务内发送、随事务提交才投递。本通道的载荷**只带 topic**
 * （唤醒信号，非数据通道），空载荷视为「主题未知」→ 全量唤醒一次。
 */

/**
 * `pg.Client` 的最小子集——本类只需要「连、订阅、收通知、断开」。刻意不 import `pg`：
 * 连接对象由组合根按属主连接配置构造并注入，本文件因此可用纯内存假客户端单测。
 */
export interface NotifyClientLike {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (arg: any) => void): unknown;
  removeAllListeners(): unknown;
  end(): Promise<void>;
}

/** 一条通知：与 `pg` 的 `notification` 事件同形。 */
export interface OutboxNotification {
  channel: string;
  payload?: string;
}

export interface OutboxNotifyListenerOptions {
  /**
   * 专用连接工厂。**每次重连都会调一次**（`pg.Client` 断开后不可复用），组合根实现为
   * `() => new pg.Client(resolveOwnerPgConfig('automation'))`。
   */
  createClient: () => NotifyClientLike;
  /**
   * 收到通知时的回调，参数是载荷里的 topic（空载荷 → `undefined`，表示主题未知）。
   * 回调抛错只 warn、不拆连接（一个消费者的唤醒失败不该拖垮整条通道）。
   */
  onNotify: (topic: string | undefined) => void;
  /** 频道名，默认 `event_outbox`。MUST 是合法标识符（`LISTEN` 不接受参数占位符）。 */
  channel?: string;
  /** 首次重连退避（毫秒），默认 1000。 */
  reconnectBaseMs?: number;
  /** 重连退避上限（毫秒），默认 30000。**这就是「有界」**：退避封顶、不无限增长也不无限加速。 */
  reconnectMaxMs?: number;
  /** 连续失败多少次后把日志从 warn 抬到 error（默认 5）。 */
  alertAfterFailures?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
  /** 抖动系数生成器（测试用），返回 [0,1)。默认 Math.random。 */
  random?: () => number;
}

/** 通知通道健康度快照。 */
export interface OutboxNotifyHealth {
  channel: string;
  /** 当前是否已 `LISTEN` 成功（false = 加速器不在，投递退回纯轮询）。 */
  connected: boolean;
  /** 是否已 `start()` 且未 `stop()`。 */
  running: boolean;
  /** 连续失败次数（连上即清零）。 */
  consecutiveFailures: number;
  /** 累计重连次数。 */
  reconnects: number;
  /** 累计收到的通知条数。 */
  notifications: number;
  lastConnectedAt: number | null;
  lastNotifyAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  /** 下一次重连的排期时刻（未排期为 null）。 */
  nextRetryAt: number | null;
}

/** `LISTEN <ident>` 不接受参数占位符，频道名只能拼进 SQL —— 故必须先证明它是个安全标识符。 */
const SAFE_CHANNEL = /^[a-z_][a-z0-9_]*$/i;

export class OutboxNotifyListener {
  private readonly createClient: () => NotifyClientLike;
  private readonly onNotify: (topic: string | undefined) => void;
  private readonly channel: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly alertAfterFailures: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly now: () => number;
  private readonly random: () => number;

  private running = false;
  private connected = false;
  private client: NotifyClientLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private reconnects = 0;
  private notifications = 0;
  private lastConnectedAt: number | null = null;
  private lastNotifyAt: number | null = null;
  private lastError: string | null = null;
  private lastErrorAt: number | null = null;
  private nextRetryAt: number | null = null;
  /**
   * 连接世代号。一次失败可能同时从两条路走到失败处置（`connect()` 的 reject + 客户端 `error` 事件），
   * 不去重就会把一次故障记成两次、退避直接跳级。世代号让**每次尝试只结算一次**。
   */
  private generation = 0;

  constructor(options: OutboxNotifyListenerOptions) {
    const channel = options.channel ?? 'event_outbox';
    if (!SAFE_CHANNEL.test(channel)) {
      throw new Error(
        `OutboxNotifyListener: 频道名 ${JSON.stringify(channel)} 不是合法标识符（LISTEN 无法参数化，拒绝拼接）`,
      );
    }
    if (typeof options.createClient !== 'function') {
      throw new Error('OutboxNotifyListener: createClient 必填（LISTEN MUST 用专用连接，不得占用共享池）');
    }
    if (typeof options.onNotify !== 'function') {
      throw new Error('OutboxNotifyListener: onNotify 必填（没有落点的监听等于没接）');
    }
    const base = options.reconnectBaseMs ?? 1_000;
    const max = options.reconnectMaxMs ?? 30_000;
    if (!Number.isFinite(base) || base < 0 || !Number.isFinite(max) || max < base) {
      throw new Error(
        `OutboxNotifyListener: 重连退避非法（base=${String(options.reconnectBaseMs)} max=${String(options.reconnectMaxMs)}），要求 0 ≤ base ≤ max 且均为有限数`,
      );
    }
    this.createClient = options.createClient;
    this.onNotify = options.onNotify;
    this.channel = channel;
    this.reconnectBaseMs = base;
    this.reconnectMaxMs = max;
    this.alertAfterFailures = options.alertAfterFailures ?? 5;
    this.logger = options.logger ?? console;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? (() => Math.random());
  }

  /** 健康度快照（同步、不连库）。 */
  health(): OutboxNotifyHealth {
    return {
      channel: this.channel,
      connected: this.connected,
      running: this.running,
      consecutiveFailures: this.consecutiveFailures,
      reconnects: this.reconnects,
      notifications: this.notifications,
      lastConnectedAt: this.lastConnectedAt,
      lastNotifyAt: this.lastNotifyAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      nextRetryAt: this.nextRetryAt,
    };
  }

  /**
   * 启动：建专用连接并 `LISTEN`。幂等（重复调用无副作用）。
   * 返回的 Promise 在**首次连接尝试**结束后 resolve（成功或失败都 resolve——失败已排好重连，
   * 且承重轮询不依赖本通道，故 MUST NOT 让它拖住组合根启动）。
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.connectOnce();
  }

  /** 停止：不再重连、断开专用连接。 */
  async stop(): Promise<void> {
    this.running = false;
    this.nextRetryAt = null;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (!client) return;
    try {
      client.removeAllListeners();
    } catch {
      /* 摘监听失败不影响关连接 */
    }
    try {
      await client.end();
    } catch {
      /* 关连接失败无处可退，忽略；重连会建新的 */
    }
  }

  private async connectOnce(): Promise<void> {
    if (!this.running) return;
    const gen = ++this.generation;
    let client: NotifyClientLike;
    try {
      client = this.createClient();
    } catch (err: unknown) {
      this.onFailure(err, gen);
      return;
    }
    this.client = client;
    client.on('error', (err: unknown) => this.onDisconnect(err, gen));
    client.on('end', () => this.onDisconnect(new Error('LISTEN 连接被对端关闭'), gen));
    client.on('notification', (msg: OutboxNotification) => this.onNotification(msg));
    try {
      await client.connect();
      await client.query(`LISTEN ${this.channel}`);
    } catch (err: unknown) {
      await this.teardown();
      this.onFailure(err, gen);
      return;
    }
    if (!this.running) {
      // start 与 stop 竞态：连上时已被停掉 —— 立刻拆掉，别留一条没人管的长连接。
      await this.teardown();
      return;
    }
    this.connected = true;
    this.consecutiveFailures = 0;
    this.lastConnectedAt = this.now();
    this.nextRetryAt = null;
    this.logger.log(
      `[event-outbox] 通知通道已就绪：LISTEN ${this.channel}（专用连接；承重仍是有界轮询）` +
        (this.reconnects > 0 ? ` reconnects=${this.reconnects}` : ''),
    );
  }

  private onNotification(msg: OutboxNotification): void {
    if (!this.running) return;
    if (msg?.channel !== this.channel) return;
    this.notifications += 1;
    this.lastNotifyAt = this.now();
    const topic = typeof msg.payload === 'string' && msg.payload.length > 0 ? msg.payload : undefined;
    try {
      this.onNotify(topic);
    } catch (err: unknown) {
      this.logger.warn(
        `[event-outbox] 通知落点抛错（不拆连接，轮询照常兜底）topic=${topic ?? '(未知)'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private onDisconnect(err: unknown, gen: number): void {
    if (!this.running) return;
    if (gen !== this.generation) return; // 上一世代的迟到事件，已结算过
    if (!this.connected && this.client === null) return;
    this.connected = false;
    void this.teardown().then(() => this.onFailure(err, gen));
  }

  /** 失败记账 + 有界退避重连排期。**永不放弃**：放弃 = 悄悄关掉加速器（静默降级，红线）。 */
  private onFailure(err: unknown, gen: number): void {
    if (gen !== this.generation) return; // 同一次尝试只结算一次（reject + error 事件可能同时到）
    this.generation += 1;
    this.consecutiveFailures += 1;
    this.lastError = err instanceof Error ? err.message : String(err);
    this.lastErrorAt = this.now();
    if (!this.running) return;
    const exponent = Math.min(this.consecutiveFailures - 1, 30);
    const backoff = Math.min(this.reconnectBaseMs * 2 ** exponent, this.reconnectMaxMs);
    const delay = Math.round(backoff * (0.8 + this.random() * 0.4)); // ±20% 抖动，避免多进程同频重连
    this.nextRetryAt = this.now() + delay;
    const line =
      `[event-outbox] 通知通道断开（投递退回有界轮询，不丢事件）channel=${this.channel} ` +
      `连续失败=${this.consecutiveFailures} ${delay}ms 后重连: ${this.lastError}`;
    if (this.consecutiveFailures >= this.alertAfterFailures) this.logger.error(line);
    else this.logger.warn(line);
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.reconnects += 1;
      void this.connectOnce();
    }, delay);
  }
}

/** 便捷入口：构造并 `start()`。返回实例以便 `health()` / `stop()`。 */
export async function startOutboxNotifyListener(
  options: OutboxNotifyListenerOptions,
): Promise<OutboxNotifyListener> {
  const listener = new OutboxNotifyListener(options);
  await listener.start();
  return listener;
}
