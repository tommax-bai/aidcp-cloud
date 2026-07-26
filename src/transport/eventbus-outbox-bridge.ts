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
 * - **replay 侧（automation 组合根起）**：`PanelEventReplay` 用 `OutboxConsumer` 订
 *   `'panel.event'`，把每条解码为带稳定 delivery id 的投递合同，交给**注入的异步 sink**
 *   （= api 内部 HTTP ingress）；只有收到 api 的受理回执后才推进 cursor。
 *
 * ## 红线
 *
 * - **payload 必须可 JSON 化**：EventBus 载荷可能带循环引用 / BigInt / 函数等非可序列化字段。
 *   tee 侧先 `toJsonSafe` 净化（整体可序列化就整体过；否则浅拷贝、逐字段丢弃不可序列化的），
 *   绝不让一条脏载荷把 emit 抛崩、连累整条总线。
 * - **单条有上限**：净化之后还要过大小闸（与推送端同源的 `PANEL_FRAME_MAX_BYTES`）。「整批卡片到达」
 *   可带 20 张卡、「详情到达」带正文 + 评论，单条常在 KB 量级、可到几十 KB；不限大小就是每天往**共库的
 *   生产 PostgreSQL** 里灌 GB 级观测行。超限 MUST 降级为带 `truncated` 标记的摘要，**MUST NOT 静默丢弃**
 *   ——回放端要看得出「这条原本有内容、只是太大被截了、原始体积多少」。注：推送端本来也会把超限帧截成
 *   同形状摘要，所以这道闸并不会让面板少看到任何它本来看得到的东西，只是把大 blob 挡在库外。
 * - **本文件不 import panel-ws / EventBus 具体实现**：只对接最小接口（`EventBusLike.onAny`）与
 *   注入的 sink。EventBus 的连线、panel-ws 的 push 都由各自组合根传入。
 * - **只有「面板确实在另一个进程」的模式才桥**：判定收口在 `src/gateway/service-mode.ts` 的
 *   `panelEventTransportForMode`。monolith / core 下 panel-ws 与产生端同进程、EventBus 直连，
 *   此时起 tee 等于**无消费者地满速率写生产库**（core 的回放门禁只在 api 模式开，永远不会有人读这些行）。
 *   这里刻意**不**照抄推送端「本进程有无已认证订阅者就短路」那道闸：拆进程后消费方的订阅者对
 *   automation 进程不可见，照抄会变成静默漏投。
 */

import {
  PANEL_FRAME_MAX_BYTES,
  panelPayloadByteLength,
  panelPayloadTruncated,
} from '../kernel/panel-frame-limits.js';
import {
  PANEL_EVENT_DELIVERY_CONTRACT_VERSION,
  makePanelEventDeliveryId,
  type PanelEventDelivery,
} from '../kernel/panel-event-delivery-port.js';
import {
  OutboxConsumer,
  emitOutboxEvent,
  type OutboxConsumerStats,
  type OutboxEvent,
  type OutboxHandler,
  type OutboxQueryable,
} from './event-outbox.js';

/** 跨段回放用的固定 outbox 主题；tee 与 replay 两侧共用，避免字面量漂移。 */
export const PANEL_EVENT_OUTBOX_TOPIC = 'panel.event';

/** 默认消费者名（游标按 (consumer, target) 分行）。 */
export const PANEL_EVENT_REPLAY_CONSUMER = 'panel-event-replay';

/**
 * `panel.event` 的保留期：已被回放消费者追平的行，超过 6 小时即剪。
 * 这是**纯观测流**，回放只服务「面板此刻看到的实时流」，没有任何补数/审计诉求；留 6 小时
 * 只是给「消费者短暂离线后追赶」留足余量。
 */
export const PANEL_EVENT_RETENTION_MS = 6 * 60 * 60 * 1000;

/**
 * `panel.event` 的兜底上限：即使消费进度没跟上（或消费者压根没上线），超过 3 天的行也剪掉并**如实告警**。
 * 观测流丢一条 3 天前的历史帧，代价远小于让共库的生产 PostgreSQL 无界增长；且拒绝剪裁若无兜底，
 * 「api 进程从没起过」这种部署形态会把这张表撑到磁盘满。承重命令类主题 MUST NOT 设这个兜底。
 */
export const PANEL_EVENT_UNCONSUMED_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * EventBus 的最小订阅接口——只用 `onAny`。刻意不 import 具体 `EventBus` 类，
 * 让本桥与总线实现解耦（tee 侧由组合根传入真实例）。
 */
export interface EventBusLike {
  onAny(handler: (event: string, data: unknown) => void): () => void;
}

/**
 * 回放落点：把带稳定 deliveryId 的事件投给 api ingress。允许同步本地 sink，也允许异步 HTTP sink；
 * replay handler 一律 await，拒绝时 outbox cursor 必须停在本条之前。
 */
export type PanelEventSink = (delivery: PanelEventDelivery) => void | Promise<void>;

/** 跨段传输的信封形状：一条 outbox 事件的 payload。 */
export interface PanelEventEnvelope {
  event: string;
  data: unknown;
  /**
   * 事件在产生端发生的时刻，**epoch ms**（`Date` 过不了 HTTP / jsonb 往返，一律用数字）。
   * 老行（本字段加入之前写的）没有它 ⇒ 解码时回落到 outbox 行的 `created_at`。
   */
  ts?: number;
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

/**
 * tee 侧编码：把一条总线事件包成 JSON 安全 + **大小达标**的信封。
 *
 * 超限时 data 降级为摘要（`{truncated:true, reason:'payload_too_large', bytes}`，与推送端同一形状），
 * `event` / `ts` 照留 —— 回放端仍能看到「这条事件发生过、原始体积多少」，绝不静默丢弃整条。
 */
export function encodePanelEventPayload(
  event: string,
  data: unknown,
  ts: number,
  maxBytes: number = PANEL_FRAME_MAX_BYTES,
): PanelEventEnvelope {
  const safe = toJsonSafe(data);
  const envelope: PanelEventEnvelope = { event, data: safe, ts };
  const bytes = panelPayloadByteLength(JSON.stringify(envelope));
  if (bytes <= maxBytes) return envelope;
  return { event, data: panelPayloadTruncated(bytes), ts };
}

/** jsonb / pg 驱动可能给出 Date、数字或 ISO 串；一律归一为 epoch ms，认不出就是 undefined（不猜）。 */
function toEpochMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

/** replay 侧解码：从 outbox payload 还原信封；形状不符返回 null（由调用方 warn + 跳过）。 */
export function decodePanelEventPayload(payload: unknown): PanelEventEnvelope | null {
  if (payload !== null && typeof payload === 'object' && typeof (payload as PanelEventEnvelope).event === 'string') {
    const raw = payload as PanelEventEnvelope;
    const ts = toEpochMs(raw.ts);
    return ts === undefined ? { event: raw.event, data: raw.data } : { event: raw.event, data: raw.data, ts };
  }
  return null;
}

export interface BridgeEventBusToOutboxOptions {
  eventBus: EventBusLike;
  /** 复用组合根已有的 Pool（tee 侧写 outbox）。 */
  pool: OutboxQueryable;
  /** 归属目标；MUST 为 'dev' | 'ol'（非法由 emitOutboxEvent 抛，此处只透传）。 */
  executionTarget: string;
  /** 单条信封上限（字节）；默认与推送端同源的 `PANEL_FRAME_MAX_BYTES`。 */
  maxBytes?: number;
  /** 事件发生时刻的时钟（测试可注入）；默认 `Date.now`。 */
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
}

/**
 * tee 侧接线（automation 组合根调用）：对 EventBus 挂 `onAny`，把每条事件 best-effort 写进 outbox。
 * 返回 unsubscribe——拆卸时调用即摘除订阅。
 *
 * **调用方须先过模式闸**（`panelEventTransportForMode(mode).tee`）：只有面板真的在另一个进程时才该接线。
 *
 * onAny 回调是同步 fire-and-forget；`emitOutboxEvent` 的写库是异步的，此处不等待、只在其 reject 时 warn。
 * EventBus 自身已把 wildcard handler 包在 try/catch 里，本桥再加一层 catch 确保写库失败绝不冒泡回总线。
 */
export function bridgeEventBusToOutbox(options: BridgeEventBusToOutboxOptions): () => void {
  const logger = options.logger ?? console;
  const now = options.now ?? (() => Date.now());
  const maxBytes = options.maxBytes ?? PANEL_FRAME_MAX_BYTES;
  return options.eventBus.onAny((event, data) => {
    let payload: PanelEventEnvelope;
    try {
      payload = encodePanelEventPayload(event, data, now(), maxBytes);
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
  /** 复用 automation 组合根已有的 owner Pool（replay 侧读 outbox）。 */
  pool: OutboxQueryable;
  /** 归属目标；只回放本 target 的行。MUST 为 'dev' | 'ol'（非法由 OutboxConsumer 构造抛）。 */
  executionTarget: string;
  /** 注入的落点：解码后的事件逐条推给 api ingress。 */
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
 * replay 侧（automation 组合根起）：用 `OutboxConsumer` 订 `'panel.event'`，逐条解码 → await 注入 sink。
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
      // 原始时刻：信封里的 ts 优先；老行没有它就回落到 outbox 行的 created_at（≈ 产生时刻，
      // 差一次事务提交）。两者都取不到才交 undefined，由下游诚实回落到当下——绝不编一个假时间。
      const originTs = decoded.ts ?? toEpochMs(event.createdAt);
      // HTTP 成功只表示 api 本地 fanout 已接受；reject 必须原样冒泡，让 OutboxConsumer 停在本条之前重放。
      await sink({
        contractVersion: PANEL_EVENT_DELIVERY_CONTRACT_VERSION,
        executionTarget: event.executionTarget,
        deliveryId: makePanelEventDeliveryId(event.executionTarget, event.id),
        event: decoded.event,
        data: decoded.data,
        ...(originTs === undefined ? {} : { originTs }),
      });
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

  /** 加速器唤醒（收到 pg_notify 时调用），让空闲轮询提前触发一次。带 topic 时只在相关时才醒。 */
  wake(topic?: string): void {
    this.consumer.wake(topic);
  }

  /** 本回放器是否关心该主题（通知过滤用）。 */
  handlesTopic(topic: string): boolean {
    return this.consumer.handlesTopic(topic);
  }

  /** 健康度快照（同步）。 */
  stats(): OutboxConsumerStats {
    return this.consumer.stats();
  }

  /** 队列占用（连库计数）。 */
  backlogByTopic(): Promise<Record<string, number>> {
    return this.consumer.backlogByTopic();
  }

  /** 手动驱动一轮（单测用，不依赖真定时器）；返回本轮回放条数。 */
  async runOnce(): Promise<number> {
    return this.consumer.runOnce();
  }
}
