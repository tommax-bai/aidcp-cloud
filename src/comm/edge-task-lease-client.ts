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
    public readonly code: 'edge_offline' | 'acquire_timeout' | 'release_timeout' | 'edge_disconnected',
    message: string,
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

export interface EdgeTaskLeaseClientOptions {
  pusher: EdgeTaskLeasePusher;
  idGen?: () => string;
  clock?: () => number;
  acquireTimeoutMs?: number;
  releaseTimeoutMs?: number;
  defaultLeaseMs?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 45_000;
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
  private readonly acquiring = new Map<string, Pending<EdgeTaskAcquiredPayload>>();
  private readonly releasing = new Map<string, Pending<EdgeTaskReleasedPayload>>();
  private readonly active = new Map<string, EdgeTaskLease>();

  constructor(options: EdgeTaskLeaseClientOptions) {
    this.pusher = options.pusher;
    this.idGen = options.idGen ?? randomUUID;
    this.clock = options.clock ?? Date.now;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    this.releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
    this.defaultLeaseMs = options.defaultLeaseMs ?? DEFAULT_LEASE_MS;
    this.logger = options.logger ?? console;
  }

  acquire(request: EdgeTaskLeaseRequest): Promise<EdgeTaskLease> {
    const taskId = this.idGen();
    const payload: EdgeTaskAcquirePayload = {
      taskId,
      kind: request.kind,
      priority: request.priority,
      leaseMs: request.leaseMs ?? this.defaultLeaseMs,
    };
    return new Promise<EdgeTaskLease>((resolve, reject) => {
      const timeoutMs = request.acquireTimeoutMs ?? this.acquireTimeoutMs;
      const timer = setTimeout(() => {
        this.acquiring.delete(taskId);
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
    if (!pending || !edgeId || pending.edgeId !== edgeId) return;
    this.acquiring.delete(payload.taskId);
    clearTimeout(pending.timer);
    pending.resolve(payload);
    this.logger.log(
      `[edge-task] acquired taskId=${payload.taskId} edge=${edgeId} kind=${payload.kind} cancelledBrowse=${payload.cancelledBrowseCommands}`,
    );
  }

  onReleased(payload: EdgeTaskReleasedPayload, edgeId?: string): void {
    const pending = this.releasing.get(payload.taskId);
    if (pending && edgeId && pending.edgeId === edgeId) {
      this.releasing.delete(payload.taskId);
      clearTimeout(pending.timer);
      pending.resolve(payload);
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
  }
}
