/**
 * outbox 通道健康巡检日志（change outbox-listen-and-topic-cursor）。
 *
 * ## 为什么要有它
 *
 * 「可观测」若只落成几个没人调用的 accessor，就会复现本 change 起因的同一个毛病——`wake()` 在原语里
 * 躺了整整一个 change 没有生产调用者。本文件是这些快照的**唯一在生产里被调用的消费点**：按低频
 * 打一行「通知通道 + 各消费者 + 队列占用」的汇总，并在非正常态（通知通道断开 / 有主题被毒消息堵住 /
 * 队列积压超阈值）当场抬高日志等级。
 *
 * 它是**观测**，不参与任何投递判定：巡检本身失败只 warn，绝不连累消费。
 */

import type { OutboxConsumerStats } from './event-outbox.js';
import type { OutboxNotifyHealth } from './outbox-notify-listener.js';

/** 被巡检的一个消费者（`OutboxConsumer` 及其薄包装都满足）。 */
export interface OutboxHealthSource {
  /** 日志里的显示名。 */
  name: string;
  stats(): OutboxConsumerStats;
  backlogByTopic(): Promise<Record<string, number>>;
}

export interface OutboxHealthLogOptions {
  consumers: OutboxHealthSource[];
  /** 通知通道（可缺省：没接通知时只巡检消费者）。 */
  listener?: { health(): OutboxNotifyHealth };
  /** 巡检间隔（毫秒），默认 5 分钟。 */
  intervalMs?: number;
  /** 单主题积压超过该条数即抬成 warn，默认 1000。 */
  backlogWarnThreshold?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface OutboxHealthReport {
  line: string;
  /** true = 有非正常态（通道断开 / 主题被堵 / 积压超阈值）。 */
  degraded: boolean;
}

/** 汇总一次健康度（连库读队列占用）。不抛错：读失败如实写进报告文本，不静默成「一切正常」。 */
export async function buildOutboxHealthReport(
  options: Pick<OutboxHealthLogOptions, 'consumers' | 'listener' | 'backlogWarnThreshold'>,
): Promise<OutboxHealthReport> {
  const threshold = options.backlogWarnThreshold ?? 1_000;
  const parts: string[] = [];
  let degraded = false;

  if (options.listener) {
    const h = options.listener.health();
    if (!h.connected) degraded = true;
    parts.push(
      `通知通道 ${h.connected ? 'connected' : 'DOWN'} channel=${h.channel} 收到=${h.notifications}` +
        ` 重连=${h.reconnects} 连续失败=${h.consecutiveFailures}` +
        (h.connected ? '' : ` 上次错误=${h.lastError ?? '(无)'}`),
    );
  } else {
    parts.push('通知通道 未接（纯轮询）');
  }

  for (const source of options.consumers) {
    const s = source.stats();
    let backlogText: string;
    try {
      const backlog = await source.backlogByTopic();
      const entries = Object.entries(backlog);
      if (entries.some(([, n]) => n >= threshold)) degraded = true;
      backlogText = entries.length === 0 ? '(无主题)' : entries.map(([t, n]) => `${t}=${n}`).join(',');
    } catch (err: unknown) {
      degraded = true;
      backlogText = `读取失败(${err instanceof Error ? err.message : String(err)})`;
    }
    if (s.blocked.length > 0) degraded = true;
    parts.push(
      `${source.name}[${s.executionTarget}] 轮次=${s.ticks} 唤醒=${s.wakes}(忽略 ${s.wakesIgnored})` +
        ` 已投递=${s.handledTotal} 积压={${backlogText}}` +
        (s.blocked.length > 0
          ? ` 堵塞主题=${s.blocked.map((b) => `${b.topic}@id${b.eventId}×${b.attempts}`).join(',')}`
          : '') +
        (s.lastError ? ` 上次错误=${s.lastError}` : ''),
    );
  }

  return { line: `[event-outbox] 健康巡检 —— ${parts.join(' | ')}`, degraded };
}

/**
 * 起一个低频健康巡检定时器。返回 `stop()` 与 `reportOnce()`（后者供单测 / 手工触发）。
 * 巡检本身抛错只 warn，绝不冒泡到组合根。
 */
export function startOutboxHealthLog(options: OutboxHealthLogOptions): {
  stop(): void;
  reportOnce(): Promise<OutboxHealthReport>;
} {
  const logger = options.logger ?? console;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  const intervalMs = options.intervalMs ?? 300_000;
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const reportOnce = async (): Promise<OutboxHealthReport> => {
    const report = await buildOutboxHealthReport(options);
    if (report.degraded) logger.warn(report.line);
    else logger.log(report.line);
    return report;
  };

  const loop = (): void => {
    if (!running) return;
    timer = setTimer(() => {
      timer = null;
      void reportOnce()
        .catch((err: unknown) => {
          logger.warn(
            `[event-outbox] 健康巡检失败（纯观测，不影响投递）: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        })
        .finally(() => loop());
    }, intervalMs);
  };
  loop();

  return {
    stop(): void {
      running = false;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
    reportOnce,
  };
}
