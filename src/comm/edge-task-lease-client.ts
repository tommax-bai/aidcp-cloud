import { randomUUID } from 'node:crypto';
import {
  makeEnvelope,
  type EdgeTaskAcquirePayload,
  type EdgeTaskAcquiredPayload,
  type EdgeTaskKind,
  type EdgeTaskPriority,
  type EdgeTaskReleasePayload,
  type EdgeTaskReleasedPayload,
  type Envelope,
} from './protocol.js';
import type { PreemptionReason } from './preemption.js';

export interface EdgeTaskLeasePusher {
  pushToEdges(envelope: Envelope, edgeId?: string): number;
}

export interface EdgeTaskLease {
  taskId: string;
  edgeId: string;
  kind: EdgeTaskKind;
  priority: EdgeTaskPriority;
}

export interface EdgeTaskLeaseRequest {
  edgeId: string;
  kind: EdgeTaskKind;
  priority: EdgeTaskPriority;
  leaseMs?: number;
  acquireTimeoutMs?: number;
}

export class EdgeTaskLeaseError extends Error {
  constructor(
    public readonly code:
      | 'edge_offline'
      | 'edge_unhealthy'
      /** 浏览器停泊且未能在唤醒死线内起来。**可恢复**（下一次可能就叫得醒），与 edge_unhealthy 区分。 */
      | 'browser_wake_failed'
      | 'acquire_timeout'
      | 'release_timeout'
      | 'edge_disconnected'
      /** 7.5：抢占撞上持有者不可逆提交窗口——**可恢复**，windowRemainingMs 带剩余预算供精确重排（不空转轮询）。 */
      | 'window_busy'
      /** 7.5：写者收到取消仍不停手＝控制面故障——**不可恢复**，通向人工重启浏览器客户端（§10.4），绝不自动重试。 */
      | 'yield_timeout',
    message: string,
    /**
     * `window_busy` 专用：持有者剩余提交窗口预算（毫秒）。**保留字段，当前无消费者**——window_busy 的 acquire
     * 失败今天走各调用方既有的「按计划下一轮重触发 / 有界退避」（非空转），尚未实装「按此值精确重排」。
     * 精确重排消费者列入 change 延后清单（7.5 尾巴），落地时在此值上挂 setTimeout 重排 acquire。
     */
    public readonly windowRemainingMs?: number,
  ) {
    super(message);
    this.name = 'EdgeTaskLeaseError';
  }
}

interface Pending<T> {
  edgeId: string;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CancelledAcquire {
  edgeId: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface EdgeTaskLeaseClientOptions {
  pusher: EdgeTaskLeasePusher;
  idGen?: () => string;
  clock?: () => number;
  acquireTimeoutMs?: number;
  releaseTimeoutMs?: number;
  defaultLeaseMs?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
  /**
   * 7.5 活跃租约中断：收到**活跃**租约（正在 withLease 跑）的抢占释放（preempted_by_task / yield_timeout）时回调，
   * 让持有方就地中断在飞命令——发布经 command-sequencer.preemptTask reject 在途 publish.command（交序列器归类、
   * **绝不 unwind withLease**）；巡视经 role-dispatcher 收敛。无该回调则退化为今天的「仅 active.delete」（work 靠命令回执/超时兜底收敛）。
   */
  onActiveLeasePreempted?: (taskId: string, edgeId: string, reason: PreemptionReason) => void;
}

/**
 * 受理超时（change browser-slot-scheduling）：必须**容得下一次浏览器唤醒**。
 *
 * 边缘现在会为停泊账号原地重开浏览器：冷启 30–90s + 串行启动队列的排队时间，死线 180s。45 秒的旧默认
 * 值会在边缘**正在正常唤醒**的过程中先超时——任务被判失败，而浏览器一分钟后才起来、无人认领。
 *
 * 200s = 边缘 180s 唤醒死线 + 余量。超时并不是发现故障的主要手段：边缘掉线由连接层立刻发现，控制面
 * 故障（cdp_unhealthy）与唤醒失败（browser_wake_failed）都是**即时回执**，这条超时只兜「边缘完全失声」。
 */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 200_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 10_000;
const DEFAULT_LEASE_MS = 5 * 60_000;

/** cloud 侧 taskId 关联器；业务回调只有在 edge 明确 acquired/quiesced 后才会执行。 */
export class EdgeTaskLeaseClient {
  private readonly pusher: EdgeTaskLeasePusher;
  private readonly idGen: () => string;
  private readonly clock: () => number;
  private readonly acquireTimeoutMs: number;
  private readonly releaseTimeoutMs: number;
  private readonly defaultLeaseMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn'>;
  private readonly onActiveLeasePreempted?: (taskId: string, edgeId: string, reason: PreemptionReason) => void;
  private readonly acquiring = new Map<string, Pending<EdgeTaskAcquiredPayload>>();
  private readonly releasing = new Map<string, Pending<EdgeTaskReleasedPayload>>();
  private readonly active = new Map<string, EdgeTaskLease>();
  private readonly cancelledAcquires = new Map<string, CancelledAcquire>();

  constructor(options: EdgeTaskLeaseClientOptions) {
    this.pusher = options.pusher;
    this.idGen = options.idGen ?? randomUUID;
    this.clock = options.clock ?? Date.now;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    this.releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
    this.defaultLeaseMs = options.defaultLeaseMs ?? DEFAULT_LEASE_MS;
    this.logger = options.logger ?? console;
    this.onActiveLeasePreempted = options.onActiveLeasePreempted;
  }

  acquire(request: EdgeTaskLeaseRequest): Promise<EdgeTaskLease> {
    const taskId = this.idGen();
    const timeoutMs = request.acquireTimeoutMs ?? this.acquireTimeoutMs;
    const payload: EdgeTaskAcquirePayload = {
      taskId,
      kind: request.kind,
      priority: request.priority,
      leaseMs: request.leaseMs ?? this.defaultLeaseMs,
      acquireTimeoutMs: timeoutMs,
    };
    return new Promise<EdgeTaskLease>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.acquiring.get(taskId);
        if (!pending) return;
        this.acquiring.delete(taskId);
        this.cancelAcquire(taskId, pending.edgeId, payload.leaseMs);
        reject(new EdgeTaskLeaseError('acquire_timeout', `edge task acquire timeout taskId=${taskId} edge=${request.edgeId}`));
      }, timeoutMs);
      timer.unref?.();
      this.acquiring.set(taskId, {
        edgeId: request.edgeId,
        timer,
        resolve: () => {
          const lease: EdgeTaskLease = { taskId, edgeId: request.edgeId, kind: request.kind, priority: request.priority };
          this.active.set(taskId, lease);
          resolve(lease);
        },
        reject,
      });
      const sent = this.pusher.pushToEdges(
        makeEnvelope('edge.task.acquire', `task-acquire-${taskId}`, this.clock(), payload),
        request.edgeId,
      );
      if (sent <= 0) {
        clearTimeout(timer);
        this.acquiring.delete(taskId);
        reject(new EdgeTaskLeaseError('edge_offline', `edge task acquire delivered to 0 edges edge=${request.edgeId}`));
      }
    });
  }

  async release(lease: EdgeTaskLease, outcome: EdgeTaskReleasePayload['outcome'] = 'completed'): Promise<void> {
    if (!this.active.has(lease.taskId)) return;
    const payload: EdgeTaskReleasePayload = { taskId: lease.taskId, outcome };
    await new Promise<EdgeTaskReleasedPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.releasing.delete(lease.taskId);
        this.active.delete(lease.taskId);
        reject(new EdgeTaskLeaseError('release_timeout', `edge task release timeout taskId=${lease.taskId} edge=${lease.edgeId}`));
      }, this.releaseTimeoutMs);
      timer.unref?.();
      this.releasing.set(lease.taskId, { edgeId: lease.edgeId, timer, resolve, reject });
      const sent = this.pusher.pushToEdges(
        makeEnvelope('edge.task.release', `task-release-${lease.taskId}`, this.clock(), payload),
        lease.edgeId,
      );
      if (sent <= 0) {
        clearTimeout(timer);
        this.releasing.delete(lease.taskId);
        this.active.delete(lease.taskId);
        reject(new EdgeTaskLeaseError('edge_offline', `edge task release delivered to 0 edges edge=${lease.edgeId}`));
      }
    });
  }

  async withLease<T>(request: EdgeTaskLeaseRequest, work: (lease: EdgeTaskLease) => Promise<T>): Promise<T> {
    const lease = await this.acquire(request);
    let outcome: EdgeTaskReleasePayload['outcome'] = 'completed';
    try {
      return await work(lease);
    } catch (err) {
      outcome = 'failed';
      throw err;
    } finally {
      try {
        await this.release(lease, outcome);
      } catch (err) {
        // 释放异常可观测，但不得把已成功提交的平台动作翻成业务失败；edge 有租约时限自愈。
        this.logger.warn(`[edge-task] release did not confirm taskId=${lease.taskId}: ${(err as Error).message}`);
      }
    }
  }

  onAcquired(payload: EdgeTaskAcquiredPayload, edgeId?: string): void {
    const pending = this.acquiring.get(payload.taskId);
    if (!pending) {
      const cancelled = this.cancelledAcquires.get(payload.taskId);
      if (cancelled && edgeId && cancelled.edgeId === edgeId) {
        this.logger.warn(`[edge-task] late acquired; cancelling stale taskId=${payload.taskId} edge=${edgeId}`);
        this.pushRelease(payload.taskId, edgeId);
      }
      return;
    }
    if (!edgeId || pending.edgeId !== edgeId) return;
    this.acquiring.delete(payload.taskId);
    clearTimeout(pending.timer);
    pending.resolve(payload);
    this.logger.log(
      `[edge-task] acquired taskId=${payload.taskId} edge=${edgeId} kind=${payload.kind} cancelledBrowse=${payload.cancelledBrowseCommands}`,
    );
  }

  onReleased(payload: EdgeTaskReleasedPayload, edgeId?: string): void {
    const acquiring = this.acquiring.get(payload.taskId);
    if (acquiring && edgeId && acquiring.edgeId === edgeId && payload.reason === 'cdp_unhealthy') {
      this.acquiring.delete(payload.taskId);
      clearTimeout(acquiring.timer);
      acquiring.reject(new EdgeTaskLeaseError(
        'edge_unhealthy',
        `edge task rejected because browser control is unavailable taskId=${payload.taskId} edge=${edgeId}`,
      ));
    }
    // 浏览器停泊且唤不醒（change browser-slot-scheduling）：与 edge_unhealthy 明确区分——前者是**可恢复**的
    // （浏览器是边缘自己收起来的，下一分钟可能就叫得醒），后者是控制面故障。排期调度器据此归还小时格并重试；
    // 混为一谈会让运维去查一个根本没坏的连接。
    if (acquiring && edgeId && acquiring.edgeId === edgeId && payload.reason === 'browser_wake_failed') {
      this.acquiring.delete(payload.taskId);
      clearTimeout(acquiring.timer);
      acquiring.reject(new EdgeTaskLeaseError(
        'browser_wake_failed',
        `edge task rejected because the parked browser could not be woken taskId=${payload.taskId} edge=${edgeId}`,
      ));
    }
    // 7.5 抢占撞上持有者的不可逆提交窗口：challenger 的 acquire 被拒——**可恢复**，带剩余预算供精确重排（不空转轮询）。
    if (acquiring && edgeId && acquiring.edgeId === edgeId && payload.reason === 'window_busy') {
      this.acquiring.delete(payload.taskId);
      clearTimeout(acquiring.timer);
      acquiring.reject(new EdgeTaskLeaseError(
        'window_busy',
        `edge task acquire refused: holder inside commit window taskId=${payload.taskId} edge=${edgeId}`,
        payload.windowRemainingMs,
      ));
    }
    // 7.5 写者收到取消仍不停手＝控制面故障：challenger 的 acquire 被拒——**不可恢复**，通向人工重启客户端（§10.4）、绝不自动重试。
    if (acquiring && edgeId && acquiring.edgeId === edgeId && payload.reason === 'yield_timeout') {
      this.acquiring.delete(payload.taskId);
      clearTimeout(acquiring.timer);
      acquiring.reject(new EdgeTaskLeaseError(
        'yield_timeout',
        `edge task acquire refused: held writer would not yield (control-plane fault) taskId=${payload.taskId} edge=${edgeId}`,
      ));
    }
    // 7.5 活跃租约中断：一个**正在跑**的租约（在 active、非本方发起 release、非 acquiring）被边缘以抢占原因释放——
    // 通知持有方就地中断在飞命令（发布 → command-sequencer.preemptTask；巡视 → role-dispatcher），**绝不 unwind withLease**。
    // 在 active.delete 之前触发：此时该任务仍可辨识为「活跃被抢」。
    if (
      edgeId &&
      this.active.get(payload.taskId)?.edgeId === edgeId &&
      !this.releasing.has(payload.taskId) &&
      (payload.reason === 'preempted_by_task' || payload.reason === 'yield_timeout')
    ) {
      this.onActiveLeasePreempted?.(payload.taskId, edgeId, payload.reason);
    }
    const pending = this.releasing.get(payload.taskId);
    if (pending && edgeId && pending.edgeId === edgeId) {
      this.releasing.delete(payload.taskId);
      clearTimeout(pending.timer);
      pending.resolve(payload);
    }
    const cancelled = this.cancelledAcquires.get(payload.taskId);
    if (cancelled && edgeId && cancelled.edgeId === edgeId) {
      clearTimeout(cancelled.timer);
      this.cancelledAcquires.delete(payload.taskId);
    }
    this.active.delete(payload.taskId);
    this.logger.log(`[edge-task] released taskId=${payload.taskId} edge=${edgeId ?? '-'} reason=${payload.reason}`);
  }

  invalidateEdge(edgeId: string): void {
    const error = new EdgeTaskLeaseError('edge_disconnected', `edge disconnected while task lease pending edge=${edgeId}`);
    for (const [taskId, pending] of this.acquiring) {
      if (pending.edgeId !== edgeId) continue;
      clearTimeout(pending.timer);
      this.acquiring.delete(taskId);
      pending.reject(error);
    }
    for (const [taskId, pending] of this.releasing) {
      if (pending.edgeId !== edgeId) continue;
      clearTimeout(pending.timer);
      this.releasing.delete(taskId);
      pending.reject(error);
    }
    for (const [taskId, lease] of this.active) {
      if (lease.edgeId === edgeId) this.active.delete(taskId);
    }
    for (const [taskId, cancelled] of this.cancelledAcquires) {
      if (cancelled.edgeId !== edgeId) continue;
      clearTimeout(cancelled.timer);
      this.cancelledAcquires.delete(taskId);
    }
  }

  private cancelAcquire(taskId: string, edgeId: string, leaseMs: number): void {
    const existing = this.cancelledAcquires.get(taskId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.cancelledAcquires.delete(taskId);
    }, Math.max(this.defaultLeaseMs, leaseMs));
    timer.unref?.();
    this.cancelledAcquires.set(taskId, { edgeId, timer });
    this.pushRelease(taskId, edgeId);
  }

  private pushRelease(taskId: string, edgeId: string): void {
    const sent = this.pusher.pushToEdges(
      makeEnvelope('edge.task.release', `task-release-${taskId}`, this.clock(), { taskId, outcome: 'failed' }),
      edgeId,
    );
    if (sent <= 0) this.logger.warn(`[edge-task] stale task release delivered to 0 edges taskId=${taskId} edge=${edgeId}`);
  }
}
