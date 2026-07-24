/**
 * EventBus → outbox firehose 桥（change 2e-api-split，拆 api ↔ automation 后的跨段观测接缝）。
 *
 * ## 背景：这条接缝原本是进程内直连
 *
 * 单体形态下，automation 的全量事件流（浏览闭环 / 通知巡视 / 风控等一切 `EventBus.emit`）由
 * 面板 WS（`src/panel/panel-ws.ts` 的 `onAny` firehose）直接就地订阅、归一化广播给浏览器。
 * 拆进程后 automation 与 api（承载 panel-ws）不再共享同一个 EventBus 实例——这条**单向**
 * （segC automation → segD api 的 panel-ws）事件流必须经 outbox 承重通道桥过去回放。
 *
 * ## 分工（本文件只做两端的编解码 + 注入，不接具体实现）
 *
 * - **tee 侧（automation 组合根调用）**：`bridgeEventBusToOutbox` 对 EventBus 挂 `onAny`，把每条
 *   `{event, data}` 编码成一条 `topic='panel.event'` 的 outbox 事件。**best-effort**——emit 失败只 warn，
 *   绝不拖垮总线（onAny 是编排热路径，一条观测事件写库失败不该反噬业务）。
 * - **replay 侧（api 组合根起）**：`PanelEventReplay` 用 `OutboxConsumer` 订 `'panel.event'`，把每条
 *   解码回 `{event, data}` 交给**注入的 sink**（= panel-ws 的 push）。
 *
 * ## 红线
 *
 * - **payload 必须可 JSON 化**：EventBus 载荷可能带循环引用 / BigInt / 函数等非可序列化字段。
 *   tee 侧先 `toJsonSafe` 净化（整体可序列化就整体过；否则浅拷贝、逐字段丢弃不可序列化的），
 *   绝不让一条脏载荷把 emit 抛崩、连累整条总线。
 * - **本文件不 import panel-ws / EventBus 具体实现**：只对接最小接口（`EventBusLike.onAny`）与
 *   注入的 sink。EventBus 的连线、panel-ws 的 push 都由各自组合根传入。
 * - **monolith 默认不桥**：单体仍是 EventBus 进程内直连 panel-ws，不调用本桥；只有拆进程后
 *   automation 侧才起 tee、api 侧才起 replay。
 */

import {
  OutboxConsumer,
  emitOutboxEvent,
  type OutboxEvent,
  type OutboxHandler,
  type OutboxQueryable,
} from './event-outbox.js';

/** 跨段回放用的固定 outbox 主题；tee 与 replay 两侧共用，避免字面量漂移。 */
export const PANEL_EVENT_OUTBOX_TOPIC = 'panel.event';

/** 默认消费者名（游标按 (consumer, target) 分行）。 */
export const PANEL_EVENT_REPLAY_CONSUMER = 'panel-event-replay';

/**
 * EventBus 的最小订阅接口——只用 `onAny`。刻意不 import 具体 `EventBus` 类，
 * 让本桥与总线实现解耦（tee 侧由组合根传入真实例）。
 */
export interface EventBusLike {
  onAny(handler: (event: string, data: unknown) => void): () => void;
}

/** 回放落点：把解码后的 `{event, data}` 推给下游（= panel-ws 的 push）。由 api 组合根注入。 */
export type PanelEventSink = (event: string, data: unknown) => void;

/** 跨段传输的信封形状：一条 outbox 事件的 payload。 */
export interface PanelEventEnvelope {
  event: string;
  data: unknown;
}

/**
 * 把任意值净化为 JSON 可序列化的等价物。
 * - 整体能 round-trip → 直接返回 round-trip 后的副本（顺手剥掉 undefined / 函数）。
 * - 否则（循环引用 / BigInt 等）→ 对象则浅拷贝、逐字段丢弃不可序列化的；非对象回落为 null。
 * 目的：绝不让一条脏载荷把 tee 侧 emit 抛崩、反噬总线。
 */
export function toJsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        try {
          out[key] = JSON.parse(JSON.stringify(val ?? null));
        } catch {
          // 单个字段不可序列化 → 丢弃它，保住其余可序列化字段
        }
      }
      return out;
    }
    return null;
  }
}

/** tee 侧编码：把一条总线事件包成 JSON 安全的信封。 */
export function encodePanelEventPayload(event: string, data: unknown): PanelEventEnvelope {
  return { event, data: toJsonSafe(data) };
}

/** replay 侧解码：从 outbox payload 还原信封；形状不符返回 null（由调用方 warn + 跳过）。 */
export function decodePanelEventPayload(payload: unknown): PanelEventEnvelope | null {
  if (payload !== null && typeof payload === 'object' && typeof (payload as PanelEventEnvelope).event === 'string') {
    return { event: (payload as PanelEventEnvelope).event, data: (payload as PanelEventEnvelope).data };
  }
  return null;
}

export interface BridgeEventBusToOutboxOptions {
  eventBus: EventBusLike;
  /** 复用组合根已有的 Pool（tee 侧写 outbox）。 */
  pool: OutboxQueryable;
  /** 归属目标；MUST 为 'dev' | 'ol'（非法由 emitOutboxEvent 抛，此处只透传）。 */
  executionTarget: string;
  logger?: Pick<Console, 'warn'>;
}

/**
 * tee 侧接线（automation 组合根调用）：对 EventBus 挂 `onAny`，把每条事件 best-effort 写进 outbox。
 * 返回 unsubscribe——拆卸时调用即摘除订阅。
 *
 * onAny 回调是同步 fire-and-forget；`emitOutboxEvent` 的写库是异步的，此处不等待、只在其 reject 时 warn。
 * EventBus 自身已把 wildcard handler 包在 try/catch 里，本桥再加一层 catch 确保写库失败绝不冒泡回总线。
 */
export function bridgeEventBusToOutbox(options: BridgeEventBusToOutboxOptions): () => void {
  const logger = options.logger ?? console;
  return options.eventBus.onAny((event, data) => {
    let payload: PanelEventEnvelope;
    try {
      payload = encodePanelEventPayload(event, data);
    } catch (err: unknown) {
      logger.warn(
        `[eventbus-outbox-bridge] 编码事件失败，丢弃（best-effort，不拖垮总线）event=${event}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    void emitOutboxEvent(
      options.pool,
      { topic: PANEL_EVENT_OUTBOX_TOPIC, payload, executionTarget: options.executionTarget },
      logger,
    ).catch((err: unknown) => {
      logger.warn(
        `[eventbus-outbox-bridge] 写 outbox 失败，丢弃该观测事件（best-effort）event=${event}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface PanelEventReplayOptions {
  /** 复用 api 组合根已有的 Pool（replay 侧读 outbox）。 */
  pool: OutboxQueryable;
  /** 归属目标；只回放本 target 的行。MUST 为 'dev' | 'ol'（非法由 OutboxConsumer 构造抛）。 */
  executionTarget: string;
  /** 注入的落点：解码后的事件推给它（= panel-ws 的 push）。 */
  sink: PanelEventSink;
  /** 消费者名，默认 'panel-event-replay'。 */
  consumer?: string;
  batchSize?: number;
  pollIntervalMs?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/**
 * replay 侧（api 组合根起）：用 `OutboxConsumer` 订 `'panel.event'`，逐条解码 → 交给注入 sink。
 * 只是给 OutboxConsumer 装一个专用 handler 的薄壳，生命周期（start/stop/wake/runOnce）全透传。
 */
export class PanelEventReplay {
  private readonly consumer: OutboxConsumer;

  constructor(options: PanelEventReplayOptions) {
    const logger = options.logger ?? console;
    const sink = options.sink;

    const handler: OutboxHandler = async (event: OutboxEvent): Promise<void> => {
      const decoded = decodePanelEventPayload(event.payload);
      if (decoded === null) {
        logger.warn(
          `[eventbus-outbox-bridge] 回放解码失败，跳过 id=${event.id}（payload 形状不符 {event,data}）`,
        );
        return;
      }
      // sink（panel-ws push）自身兜住异常；此处不再吞，让 handler 语义与 OutboxConsumer 的
      // at-least-once 对齐（sink 抛则停在本条之前、下一轮重放）。
      sink(decoded.event, decoded.data);
    };

    this.consumer = new OutboxConsumer({
      consumer: options.consumer ?? PANEL_EVENT_REPLAY_CONSUMER,
      executionTarget: options.executionTarget,
      pool: options.pool,
      handlers: new Map<string, OutboxHandler>([[PANEL_EVENT_OUTBOX_TOPIC, handler]]),
      batchSize: options.batchSize,
      pollIntervalMs: options.pollIntervalMs,
      logger,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
    });
  }

  /** 启动有界轮询回放。 */
  start(): void {
    this.consumer.start();
  }

  /** 停止回放。 */
  stop(): void {
    this.consumer.stop();
  }

  /** 加速器唤醒（收到 pg_notify 时调用），让空闲轮询提前触发一次。 */
  wake(): void {
    this.consumer.wake();
  }

  /** 手动驱动一轮（单测用，不依赖真定时器）；返回本轮回放条数。 */
  async runOnce(): Promise<number> {
    return this.consumer.runOnce();
  }
}
