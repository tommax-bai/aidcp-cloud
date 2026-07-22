/**
 * 自动化写者锁（change risk-state-cross-process-integrity，design D2）。
 *
 * 「承载风控写的进程对每个 executionTarget 单实例」这条不变量，靠文档纪律抓不住——纪律写了三年，
 * 仍然出过 canonical checkout 被切到发布分支停 24 小时的事故。这里给它一把机械锁：
 *
 *   SELECT pg_try_advisory_lock(hashtext('aidcp_automation_writer'), hashtext($target))
 *
 * 三条硬性质：
 * 1. **锁挂在一条专用长连接上，MUST NOT 走 pool**——pool 连接会被回收归还，会话级 advisory lock
 *    随之释放，锁就成了摆设。
 * 2. **抢不到即拒绝启用风控写路径**（有界等待后告警 + 非零码退出），MUST NOT 降级为无锁照写。
 *    滚动 / 蓝绿部署的第二个实例会在启动阶段响亮失败，而不是安静地开始双写。
 * 3. **连接断开即视为写权丢失**：立刻停止下发新的互动命令并告警，MUST NOT 静默继续写 risk_state。
 *    （连接断开时 PostgreSQL 自动释放该会话持有的 advisory lock，故这不是「可能丢」而是「已经丢」。）
 *
 * 已知边界：老进程被 kill -9 且 TCP 尚未被回收时，新进程可能要等到 keepalive 超时才抢得到。
 * 那是「拒绝启动」而不是「静默双写」，方向正确；强制释放步骤见 docs/deployment-environments.md。
 */
import pg from 'pg';
import type { DeploymentTarget } from '../deployment-target.js';

const { Client } = pg;

/** advisory lock 的第一段键（第二段是 hashtext(executionTarget)）。 */
export const AUTOMATION_WRITER_LOCK_NAME = 'aidcp_automation_writer';

/** 锁连接的最小接口：便于用内存桩模拟「两个实例抢同一把锁」，不依赖真 PG。 */
export interface WriterLockConnection {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  on(event: 'error' | 'end', listener: (err?: Error) => void): void;
  end(): Promise<void>;
}

export type WriterLockAcquireResult =
  | { ok: true }
  | { ok: false; reason: 'held_by_other' | 'connect_failed'; detail: string };

export interface WriterLockOptions {
  executionTarget: DeploymentTarget;
  /** 建立专用长连接。缺省用 pg.Client + 标准 PG env。 */
  connect?: () => Promise<WriterLockConnection>;
  /** 有界等待上限（毫秒）。默认 60s，AIDCP_RISK_WRITER_LOCK_WAIT_MS 可配。 */
  waitMs?: number;
  /** 重试间隔（毫秒）。默认 2s。 */
  retryIntervalMs?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

function defaultConnect(): Promise<WriterLockConnection> {
  // 专用 Client（非 Pool）：会话生命周期 = 进程生命周期，锁不会被连接回收顺手释放。
  const client = new Client({
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    // 让内核较早发现对端已死，缩短 kill -9 后的接管窗口。
    keepAlive: true,
  });
  return client.connect().then(() => client as unknown as WriterLockConnection);
}

export class AutomationWriterLock {
  private readonly executionTarget: DeploymentTarget;
  private readonly connect: () => Promise<WriterLockConnection>;
  private readonly waitMs: number;
  private readonly retryIntervalMs: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger?: Pick<Console, 'log' | 'warn' | 'error'>;

  private connection: WriterLockConnection | null = null;
  private held = false;
  private lostReason: string | null = null;
  private readonly lostListeners = new Set<(reason: string) => void>();

  constructor(options: WriterLockOptions) {
    this.executionTarget = options.executionTarget;
    this.connect = options.connect ?? defaultConnect;
    this.waitMs = Math.max(0, options.waitMs ?? 60_000);
    this.retryIntervalMs = Math.max(50, options.retryIntervalMs ?? 2_000);
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger;
  }

  target(): DeploymentTarget {
    return this.executionTarget;
  }

  /** 当前是否仍持有写权。连接断开后立即变 false（不等下一次查询才发现）。 */
  isHeld(): boolean {
    return this.held;
  }

  /** 写权丢失的原因（尚未丢失 → null）。 */
  lostAt(): string | null {
    return this.lostReason;
  }

  /** 订阅写权丢失。返回退订函数。 */
  onLost(listener: (reason: string) => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  /**
   * 有界重试抢锁。返回 ok:false 时调用方 MUST fail-closed（告警 + 非零码退出），
   * MUST NOT 把它当作「稍后再说」继续启用风控写路径。
   */
  async acquire(): Promise<WriterLockAcquireResult> {
    if (this.held) return { ok: true };
    const deadline = this.clock() + this.waitMs;
    let lastDetail = '';
    for (;;) {
      try {
        if (!this.connection) this.connection = await this.openConnection();
        const { rows } = await this.connection.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked`,
          [AUTOMATION_WRITER_LOCK_NAME, this.executionTarget],
        );
        if (rows[0]?.locked === true) {
          this.held = true;
          this.lostReason = null;
          return { ok: true };
        }
        lastDetail = `另一个实例正持有 ${this.executionTarget} 的自动化写者锁`;
      } catch (err) {
        // 连接失败也照有界重试：PG 刚起来 / 网络抖动时不该直接判死。
        lastDetail = `写者锁连接失败: ${err instanceof Error ? err.message : String(err)}`;
        await this.dropConnection();
      }
      if (this.clock() >= deadline) {
        await this.dropConnection();
        const reason: 'held_by_other' | 'connect_failed' = lastDetail.startsWith('写者锁连接失败')
          ? 'connect_failed'
          : 'held_by_other';
        return { ok: false, reason, detail: lastDetail };
      }
      this.logger?.warn?.(`[risk-writer-lock] ${lastDetail}，${this.retryIntervalMs}ms 后重试`);
      await this.sleep(this.retryIntervalMs);
    }
  }

  private async openConnection(): Promise<WriterLockConnection> {
    const conn = await this.connect();
    const markLost = (why: string) => (err?: Error) => {
      if (!this.held && this.lostReason) return;
      const detail = err ? `${why}: ${err.message}` : why;
      this.held = false;
      this.lostReason = detail;
      this.connection = null;
      for (const listener of this.lostListeners) {
        try {
          listener(detail);
        } catch (listenerErr) {
          this.logger?.error?.(`[risk-writer-lock] onLost 回调抛错: ${(listenerErr as Error).message}`);
        }
      }
    };
    conn.on('error', markLost('写者锁连接报错'));
    conn.on('end', markLost('写者锁连接已断开'));
    return conn;
  }

  private async dropConnection(): Promise<void> {
    const conn = this.connection;
    this.connection = null;
    if (!conn) return;
    try {
      await conn.end();
    } catch {
      // 关闭失败不影响判定：锁要么已随连接释放，要么由服务端超时回收。
    }
  }

  /** 主动释放（正常停机路径）。释放后同 target 的新实例可立即接管。 */
  async release(): Promise<void> {
    if (this.connection && this.held) {
      try {
        await this.connection.query(`SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`, [
          AUTOMATION_WRITER_LOCK_NAME,
          this.executionTarget,
        ]);
      } catch {
        // 连接已死 → 锁本就已被服务端释放，无需补偿。
      }
    }
    this.held = false;
    await this.dropConnection();
  }
}
