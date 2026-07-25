/**
 * automation 侧的配置镜像失效信号：**事务型入队 + 进程内中继**
 * （change block3-l3-config-mirror-bump-decouple）。
 *
 * ## 它替掉了什么
 *
 * 四个属 automation 的限频配置 store（`quota_config` / `pacing_floor_config` /
 * `session_config_global` / `resume_config_global`）原本在自己的写事务里、**同一条物理连接上**
 * 直接递增属 api 的 `config_mirror_version`。单库时看不出问题；两库一分，这一笔就断成两笔独立
 * 提交，且**没有任何错误、没有任何日志**——配置已改而版本没进，别的进程的镜像永远停在旧值。
 *
 * 现在的形态：
 *   1. **入队**（本文件的 {@link OutboxMirrorVersionBumper}）：在**automation 自己的库**里，
 *      与配置写入同一笔事务写一条 `event_outbox` 行。业务写回滚 ⇒ 信号不存在；业务写提交 ⇒
 *      信号一定在。原子性完好，且完全不碰别人的库。
 *   2. **中继**（本文件的 {@link ConfigMirrorBumpRelay}）：生产方进程内的有界轮询消费者，
 *      把 outbox 行投给 {@link ConfigMirrorBumpSink}（api 侧，进程内或内部 HTTP）。
 *   3. **落地**（`src/config/mirror-bump-sink.ts`）：api 在**自己的库**里 inbox 去重 + 推版本，
 *      一笔事务。
 *
 * ## 语义变化：多了一个「配置已改、版本还没涨」的窗口
 *
 * 上界 = 中继投递耗时 + 消费方刷新器的轮询周期。
 *   - 常态：写事务提交后 `notifyAfterCommit` 立刻唤醒中继（{@link ConfigMirrorBumpRelay.wake}），
 *     投递在毫秒级完成 ⇒ 窗口 ≈ 刷新器轮询周期（默认 5s），与本 change 之前**同量级**。
 *   - 中继被跳过/进程刚重启/投递失败：兜底轮询 {@link CONFIG_MIRROR_BUMP_RELAY_POLL_MS}（默认 2s）
 *     ⇒ 窗口上界 = 2s + 一次投递 + 5s ≈ **8s 量级**。
 *   - 消费方（api）不可达：outbox 行留在库里、游标不前进，**信号不丢**；恢复后按序补投。
 *     期间刷新器的比对照常成功（版本没变即视为没变化），故属 automation 的四项都是**参数镜像**
 *     （`tier: 'parameter'`，见 `src/config/mirror-registry.ts` 头注），陈旧只告警、不停手。
 *
 * 失败方向一律偏「重投」而非「丢投」：投递失败 → 游标不动 → 下一轮重放；重放由消费方 inbox 去重
 * 吸收（同一 `dedupKey` 只推一次版本）。**绝不静默丢投**。
 */

import type pg from 'pg';
import {
  CONFIG_MIRROR_BUMP_TOPIC,
  type ConfigMirrorBumpSink,
  type ConfigMirrorKey,
  type MirrorQueryable,
  type MirrorVersionBumper,
} from '../kernel/config-mirror-bump-types.js';
import { OutboxConsumer, emitOutboxEvent, type OutboxEvent } from '../transport/event-outbox.js';

/**
 * 中继的兜底轮询周期（毫秒）。承重通道是**它**，不是提交后的唤醒——唤醒只是加速器，
 * 进程重启、`notifyAfterCommit` 被跳过、投递当场失败，都靠这条轮询把信号补上。
 */
export const CONFIG_MIRROR_BUMP_RELAY_POLL_MS = 2_000;

/** outbox 消费者名（游标按 `(consumer, execution_target)` 分行）。 */
export const CONFIG_MIRROR_BUMP_CONSUMER = 'config-mirror-bump';

/** outbox 事件负载。只带 mirrorKey——失效信号是纯粹的「这项配置变了，去重读」，不搬配置内容。 */
interface ConfigMirrorBumpPayload {
  mirrorKey: string;
}

export interface OutboxMirrorVersionBumperOptions {
  /**
   * 允许经本通道入队的 mirrorKey 闭集合。由组合根按属主表算出
   * （`CONFIG_MIRRORS[k].owner === bumpDomain` 的那些），**本文件不 import 属 api 的注册表**。
   * 不在集合里的 key 一律抛错：把「api 属主的配置绕道 automation 的 outbox」这种反向错接线
   * 在第一次写入时就打出来，绝不静默改道。
   */
  allowedMirrorKeys: ReadonlySet<string>;
  /** 归属目标；MUST 为 'dev' | 'ol'（`emitOutboxEvent` 自己再校验一次）。 */
  executionTarget: string;
  /** 提交后的加速器出口：通常接 {@link ConfigMirrorBumpRelay.wake}。缺省即只靠兜底轮询。 */
  onCommitted?: (mirrorKey: ConfigMirrorKey) => void;
  logger?: Pick<Console, 'log' | 'warn'>;
}

/**
 * automation 侧的 {@link MirrorVersionBumper} 实现：在调用方事务内写一条 outbox 行。
 *
 * 它满足与 api 侧实现**完全相同**的契约（「业务写失败 ⇒ 失效信号不存在」），
 * 差别只在信号落在谁的库里。
 */
export class OutboxMirrorVersionBumper implements MirrorVersionBumper {
  readonly bumpDomain = 'automation' as const;

  private readonly allowedMirrorKeys: ReadonlySet<string>;
  private readonly executionTarget: string;
  private readonly onCommitted?: (mirrorKey: ConfigMirrorKey) => void;
  private readonly logger: Pick<Console, 'log' | 'warn'>;

  constructor(options: OutboxMirrorVersionBumperOptions) {
    this.allowedMirrorKeys = options.allowedMirrorKeys;
    this.executionTarget = options.executionTarget;
    this.onCommitted = options.onCommitted;
    this.logger = options.logger ?? console;
  }

  /**
   * 在调用方**已开启的事务**内写 outbox 行。MUST NOT 自开事务、MUST NOT 提交——
   * 它必须与配置写入同生共死。
   */
  async bumpInTx(client: MirrorQueryable, mirrorKey: ConfigMirrorKey): Promise<void> {
    if (!this.allowedMirrorKeys.has(mirrorKey)) {
      throw new Error(
        `[config-mirror] mirror=${mirrorKey} 不属 ${this.bumpDomain}，MUST NOT 走本域 outbox 中继：` +
          `与版本表同库的配置应当同事务直接推进版本（MirrorVersionStore.bumpInTx）。`,
      );
    }
    const payload: ConfigMirrorBumpPayload = { mirrorKey };
    await emitOutboxEvent(
      client,
      { topic: CONFIG_MIRROR_BUMP_TOPIC, payload, executionTarget: this.executionTarget },
      this.logger,
    );
  }

  /** 加速器：提交后立刻唤醒中继。吞错——它不承重，兜底轮询一定收得回来。 */
  notifyAfterCommit(mirrorKey: ConfigMirrorKey): void {
    try {
      this.onCommitted?.(mirrorKey);
    } catch (err: unknown) {
      this.logger.warn(
        `[config-mirror] 中继唤醒失败（非承重通道，兜底轮询照常补投）mirror=${mirrorKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export interface ConfigMirrorBumpRelayOptions {
  /** MUST 是 **automation 属主池**（outbox 行在 automation 的库里）。 */
  pool: pg.Pool;
  /** 投递目的地：api 侧的落地端口（进程内本地实现或内部 HTTP 客户端）。 */
  sink: ConfigMirrorBumpSink;
  executionTarget: string;
  /** 兜底轮询周期；默认 {@link CONFIG_MIRROR_BUMP_RELAY_POLL_MS}。 */
  pollIntervalMs?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
}

/**
 * 生产方进程内中继：把 automation 库里的失效信号推给 api。
 *
 * at-least-once：投递抛错即停在该条之前、游标不越过它，下一轮重放（`OutboxConsumer` 的既有语义）。
 * 幂等由消费方的 inbox 去重承担，`dedupKey` 取 outbox 行的持久 id —— 重放多少次都只推一次版本。
 *
 * **poison pill 是有意不跳过的**：负载非法（理论上只可能来自手工改库或跨版本回滚）会把队列卡住并
 * 每轮 warn 一次，而不是跳过它继续。跳过 = 一条失效信号被静默吞掉，正是本 change 要消灭的形态；
 * 卡住则响、可查、可人工修。负载由本文件唯一生产，正常路径不可能构造出非法值。
 */
export class ConfigMirrorBumpRelay {
  private readonly consumer: OutboxConsumer;
  private readonly executionTarget: string;
  private readonly logger: Pick<Console, 'log' | 'warn'>;

  constructor(options: ConfigMirrorBumpRelayOptions) {
    this.executionTarget = options.executionTarget;
    this.logger = options.logger ?? console;
    const handlers = new Map([
      [CONFIG_MIRROR_BUMP_TOPIC, (event: OutboxEvent) => this.deliver(options.sink, event)],
    ]);
    this.consumer = new OutboxConsumer({
      consumer: CONFIG_MIRROR_BUMP_CONSUMER,
      executionTarget: options.executionTarget,
      pool: options.pool,
      handlers,
      pollIntervalMs: options.pollIntervalMs ?? CONFIG_MIRROR_BUMP_RELAY_POLL_MS,
      logger: this.logger,
    });
  }

  /** 起中继（立刻跑一轮，之后按兜底周期）。幂等。 */
  start(): void {
    this.consumer.start();
    this.logger.log(
      `[config-mirror] 失效信号中继已启动：topic=${CONFIG_MIRROR_BUMP_TOPIC} ` +
        `兜底轮询=${CONFIG_MIRROR_BUMP_RELAY_POLL_MS}ms target=${this.executionTarget}`,
    );
  }

  stop(): void {
    this.consumer.stop();
  }

  /** 加速器：写事务提交后调，让空闲中的轮询提前跑一轮。 */
  wake(): void {
    this.consumer.wake();
  }

  /** 直接驱动一轮（单测用；不依赖真定时器）。返回本轮投递条数。 */
  runOnce(): Promise<number> {
    return this.consumer.runOnce();
  }

  private async deliver(sink: ConfigMirrorBumpSink, event: OutboxEvent): Promise<void> {
    const mirrorKey = readMirrorKey(event.payload);
    if (mirrorKey === null) {
      throw new Error(
        `[config-mirror] outbox 事件负载非法（队列停在此处、下一轮重放，绝不跳过丢信号）id=${event.id} ` +
          `payload=${JSON.stringify(event.payload)}`,
      );
    }
    const dedupKey = `event_outbox:${event.executionTarget}:${event.id}`;
    const { applied } = await sink.applyBump({ mirrorKey, dedupKey });
    this.logger.log(
      `[config-mirror] 失效信号已投递 mirror=${mirrorKey} dedup=${dedupKey} ` +
        `${applied ? '版本已推进' : '重放（早已应用，未重复推进）'}`,
    );
  }
}

function readMirrorKey(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = (payload as { mirrorKey?: unknown }).mirrorKey;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
