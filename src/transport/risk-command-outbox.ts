/**
 * 风控命令 outbox 通道（change 2e-api-split，seam ③「风控单写命令」）。
 *
 * ## 为什么存在
 *
 * 拆进程后，api 侧仍会收到三类会改写账号风控**最终状态**的请求：
 *   - `applySignal`（施加风控信号，驱状态机迁移）
 *   - `setQuotaLevel`（改配额档位）
 *   - `recoverRestricted`（人工解除受限）
 * 但 CLAUDE §2 的铁律是**账号风控最终状态只由云端 `RiskController` 单写**。拆进程后
 * 「单写者」物理上落在 **automation 服务**——api 进程里没有、也不该有 `RiskController`。
 *
 * 本通道把这三类写变成**异步命令**：
 *   - **api 侧只 `emit`**（把命令落进事务型 outbox，永不直接调风控）；
 *   - **automation 侧唯一消费者 `apply`**（转调本进程的 `riskRegistry.getController(accountId)` 的三方法）。
 * 单写不变量因此在物理进程边界上成立：命令是数据、写是行为，行为只发生在 automation 一处。
 *
 * ## 本文件的边界（硬约束）
 *
 * **绝不 import `RiskController`、绝不直连 `src/risk/` 的任何运行时**。这里只做三件事：
 *   1. 定义命令（discriminated union）；
 *   2. `emitRiskCommand` —— 包 `emitOutboxEvent`，topic 固定 `risk.command`，payload = 命令；
 *   3. `RiskCommandConsumer` —— 用 `OutboxConsumer` 订 `risk.command`，把解码后的命令交给
 *      **组合根注入的 `apply` 回调**（automation 的组合根在回调里转调 `riskRegistry`）。
 *
 * 唯一对 `src/risk/` 的依赖是 **`import type`**（`RiskSignal` / `RiskQuotaLevel` 两个纯类型）——
 * 运行时被 TS 完全擦除、零耦合，只为让命令字段与风控三方法入参**同源不漂移**（自己重抄一份枚举
 * 才是漂移入口）。
 *
 * ## 投递语义（继承 `event-outbox.ts`）
 *
 * `OutboxConsumer` 是 **at-least-once**：handler 抛错即停在该条之前、下一轮重放；`apply` 必须幂等
 * （风控三方法本身对重复施加同一信号/档位是收敛的，见各方法注释）。解码失败按红线**抛错而非静默丢弃**
 * ——一条无法解码的风控命令若被吞掉，就是一次「本该改的账号状态没改、且无人知道」的静默假成功。
 * 抛错会让该条卡住重放（loud），由 automation 侧告警介入；正常路径不会触发，因为 emit 侧已校验命令形状。
 */

import type { RiskQuotaLevel, RiskSignal } from '../risk/types.js';
import {
  OutboxConsumer,
  emitOutboxEvent,
  type OutboxEvent,
  type OutboxHandler,
  type OutboxQueryable,
} from './event-outbox.js';

/** 风控命令统一走这个 outbox 主题。 */
export const RISK_COMMAND_TOPIC = 'risk.command';

/** 单写者消费者名（游标按 (consumer, target) 分行）。剪裁器据此判断「谁追平了才敢剪」。 */
export const RISK_COMMAND_CONSUMER = 'risk-command';

/**
 * `risk.command` 的保留期：已被单写者应用过的命令留 30 天做审计追溯，之后剪掉。
 * **刻意不设兜底强删上限**——风控命令是承重写，未被应用就删掉等于「本该改的账号状态没改、且无人知道」。
 * 消费者掉线时宁可让它堆着并如实告警。
 */
export const RISK_COMMAND_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 施加一条风控信号 → 转调 `RiskController.applySignal(signal)`。 */
export interface ApplySignalCommand {
  kind: 'applySignal';
  accountId: string;
  signal: RiskSignal;
}

/** 改配额档位 → 转调 `RiskController.setQuotaLevel(level)`。 */
export interface SetQuotaLevelCommand {
  kind: 'setQuotaLevel';
  accountId: string;
  level: RiskQuotaLevel;
}

/** 人工解除受限 → 转调 `RiskController.recoverRestricted(reason)`（reason 必填，用于审计）。 */
export interface RecoverRestrictedCommand {
  kind: 'recoverRestricted';
  accountId: string;
  reason: string;
}

export type RiskCommand = ApplySignalCommand | SetQuotaLevelCommand | RecoverRestrictedCommand;

export type RiskCommandKind = RiskCommand['kind'];

const RISK_COMMAND_KINDS: ReadonlySet<string> = new Set<RiskCommandKind>([
  'applySignal',
  'setQuotaLevel',
  'recoverRestricted',
]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 把（emit 前的、或 jsonb 往返回来的）未知值校验成一个合法 `RiskCommand`，否则抛错。
 *
 * emit 侧与 consume 侧共用同一把校验，保证「进得去的一定出得来、出不来的绝不进」。校验只做**形状**
 * （kind + 必填字段存在且类型对），不深挖 `signal.kind` 的合法枚举——那是风控层 `transition` 的职责，
 * 且本文件不得依赖风控运行时。
 */
export function decodeRiskCommand(value: unknown): RiskCommand {
  if (value == null || typeof value !== 'object') {
    throw new Error(`decodeRiskCommand: 命令必须是对象，收到 ${JSON.stringify(value)}`);
  }
  const cmd = value as Record<string, unknown>;
  const kind = cmd.kind;
  if (typeof kind !== 'string' || !RISK_COMMAND_KINDS.has(kind)) {
    throw new Error(`decodeRiskCommand: 未知 kind=${JSON.stringify(kind)}`);
  }
  if (!isNonEmptyString(cmd.accountId)) {
    throw new Error(`decodeRiskCommand: accountId 必须为非空字符串（kind=${kind}）`);
  }
  switch (kind) {
    case 'applySignal': {
      const signal = cmd.signal;
      if (signal == null || typeof signal !== 'object' || !isNonEmptyString((signal as Record<string, unknown>).kind)) {
        throw new Error('decodeRiskCommand: applySignal 缺少合法 signal.kind');
      }
      return { kind, accountId: cmd.accountId, signal: signal as RiskSignal };
    }
    case 'setQuotaLevel': {
      if (!isNonEmptyString(cmd.level)) {
        throw new Error('decodeRiskCommand: setQuotaLevel 缺少 level');
      }
      return { kind, accountId: cmd.accountId, level: cmd.level as RiskQuotaLevel };
    }
    case 'recoverRestricted': {
      if (!isNonEmptyString(cmd.reason)) {
        // recoverRestricted 本身也要求非空 reason（审计）；这里前置拦住，避免把注定被风控层拒的命令入队。
        throw new Error('decodeRiskCommand: recoverRestricted 缺少 reason');
      }
      return { kind, accountId: cmd.accountId, reason: cmd.reason };
    }
    default: {
      // 穷举兜底（RISK_COMMAND_KINDS 与联合类型同源，正常到不了这里）。
      const _exhaustive: never = kind as never;
      throw new Error(`decodeRiskCommand: 未处理 kind=${String(_exhaustive)}`);
    }
  }
}

// ── emit 侧（api）────────────────────────────────────────────────────────────

/**
 * api 侧把一条风控写变成 outbox 命令。**这是 api 触碰风控的唯一出口**——它只落数据、不改状态。
 *
 * 在**调用方事务内**执行（`client` 传该事务句柄），命令与业务写同生共死。emit 前先本地校验命令形状
 * （fail loud，别把畸形命令塞进队列去毒 consumer）。`executionTarget` 非法由 `emitOutboxEvent` 拦。
 */
export async function emitRiskCommand(
  client: OutboxQueryable,
  executionTarget: string,
  cmd: RiskCommand,
  logger: Pick<Console, 'warn'> = console,
): Promise<{ id: number }> {
  const validated = decodeRiskCommand(cmd); // 形状自检：畸形命令绝不入队
  return emitOutboxEvent(
    client,
    { topic: RISK_COMMAND_TOPIC, payload: validated, executionTarget },
    logger,
  );
}

// ── consume 侧（automation，单写者）──────────────────────────────────────────

/**
 * 单写者注入的落地回调：把一条风控命令真正 apply 到本进程的 `RiskController`。
 * 由 automation 组合根提供，内部按 `cmd.kind` 转调
 * `riskRegistry.getController(cmd.accountId).applySignal/setQuotaLevel/recoverRestricted`。
 * **MUST 幂等**（at-least-once 可能重投同一条）。
 */
export type RiskCommandApply = (cmd: RiskCommand) => Promise<void>;

export interface RiskCommandConsumerOptions {
  /** 归属目标；只消费本 target 的命令。MUST 为 'dev' | 'ol'。 */
  executionTarget: string;
  /** 复用组合根已有的 Pool。 */
  pool: OutboxQueryable;
  /** 单写者落地回调（automation 组合根注入）。 */
  apply: RiskCommandApply;
  /** 游标消费者名，默认 'risk-command'。 */
  consumer?: string;
  batchSize?: number;
  pollIntervalMs?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * 风控命令消费者：`OutboxConsumer` 的一层薄包装，只订 `risk.command` 主题，把解码后的命令交注入回调。
 *
 * **本类不知道 `RiskController` 存在**：apply 回调由 automation 组合根注入，风控单写点收口在那一处回调里。
 * 生命周期 `start()/stop()/wake()` 直接透传给内层 `OutboxConsumer`（承重轮询 + 可选 pg_notify 唤醒）。
 */
export class RiskCommandConsumer {
  private readonly inner: OutboxConsumer;

  constructor(options: RiskCommandConsumerOptions) {
    if (typeof options.apply !== 'function') {
      throw new Error('RiskCommandConsumer: apply 回调必填（单写落地点，缺了就没有消费者）');
    }
    const apply = options.apply;
    const handler: OutboxHandler = async (event: OutboxEvent) => {
      const cmd = decodeRiskCommand(event.payload);
      await apply(cmd);
    };
    this.inner = new OutboxConsumer({
      consumer: options.consumer ?? RISK_COMMAND_CONSUMER,
      executionTarget: options.executionTarget,
      pool: options.pool,
      handlers: new Map<string, OutboxHandler>([[RISK_COMMAND_TOPIC, handler]]),
      batchSize: options.batchSize,
      pollIntervalMs: options.pollIntervalMs,
      logger: options.logger,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
    });
  }

  /** 启动承重轮询（幂等）。 */
  start(): void {
    this.inner.start();
  }

  /** 停止消费。 */
  stop(): void {
    this.inner.stop();
  }

  /** pg_notify 加速器唤醒（收到通知时调）。 */
  wake(): void {
    this.inner.wake();
  }

  /** 直接驱动一轮（单测用，不依赖真定时器）。返回本轮处理条数。 */
  runOnce(): Promise<number> {
    return this.inner.runOnce();
  }
}

/**
 * 工厂便捷入口：构造 `RiskCommandConsumer` 并 `start()`。返回实例以便后续 `stop()`。
 * automation 组合根若只想「起一个消费者」可用它，等价于 `new RiskCommandConsumer(opts)` + `.start()`。
 */
export function startRiskCommandConsumer(options: RiskCommandConsumerOptions): RiskCommandConsumer {
  const consumer = new RiskCommandConsumer(options);
  consumer.start();
  return consumer;
}
