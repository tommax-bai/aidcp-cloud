/**
 * 自动化写者锁（change risk-state-cross-process-integrity，task 2.5）。
 *
 * 用一个按连接建模 advisory lock 的内存桩：同一把键在同一时刻只能被一条连接持有，连接断开即释放。
 * 这是 PostgreSQL 会话级 advisory lock 的语义，也正是本锁的全部依赖面。
 *
 * **测不到的那一半**：真实 pg.Client 的连接语义（keepAlive、kill -9 后 TCP 未回收时的接管延迟）
 * 只能真机验收，见 change 的真机项。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationWriterLock, type WriterLockConnection } from '../src/risk/writer-lock.js';

/** 内存 PostgreSQL：一张 advisory lock 表，键 → 持有它的连接。 */
class FakePg {
  private readonly held = new Map<string, FakeConnection>();

  connect(): FakeConnection {
    return new FakeConnection(this);
  }

  tryLock(key: string, conn: FakeConnection): boolean {
    const owner = this.held.get(key);
    if (owner && owner !== conn) return false;
    this.held.set(key, conn);
    return true;
  }

  unlockAll(conn: FakeConnection): void {
    for (const [key, owner] of [...this.held]) if (owner === conn) this.held.delete(key);
  }

  unlock(key: string, conn: FakeConnection): void {
    if (this.held.get(key) === conn) this.held.delete(key);
  }
}

class FakeConnection implements WriterLockConnection {
  private readonly listeners = new Map<string, ((err?: Error) => void)[]>();

  constructor(private readonly pg: FakePg) {}

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const key = `${String(params[0])}:${String(params[1])}`;
    if (sql.includes('pg_try_advisory_lock')) {
      return { rows: [{ locked: this.pg.tryLock(key, this) }] as unknown as T[] };
    }
    if (sql.includes('pg_advisory_unlock')) {
      this.pg.unlock(key, this);
      return { rows: [] };
    }
    return { rows: [] };
  }

  on(event: 'error' | 'end', listener: (err?: Error) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  async end(): Promise<void> {
    this.pg.unlockAll(this);
    for (const listener of this.listeners.get('end') ?? []) listener();
  }

  /** 模拟连接被服务端/网络切断（锁随会话释放）。 */
  drop(err: Error): void {
    this.pg.unlockAll(this);
    for (const listener of this.listeners.get('error') ?? []) listener(err);
  }
}

function makeLock(pg: FakePg, target: 'dev' | 'ol', track?: { conn?: FakeConnection }) {
  return new AutomationWriterLock({
    executionTarget: target,
    waitMs: 30,
    retryIntervalMs: 5,
    sleep: async () => undefined,
    connect: async () => {
      const conn = pg.connect();
      if (track) track.conn = conn;
      return conn;
    },
  });
}

test('同一 target 的第二个实例抢锁必失败（滚动部署会响亮失败而不是静默双写）', async () => {
  const pg = new FakePg();
  const first = makeLock(pg, 'dev');
  const second = makeLock(pg, 'dev');

  assert.deepEqual(await first.acquire(), { ok: true });
  assert.equal(first.isHeld(), true);

  const result = await second.acquire();
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'held_by_other');
  assert.match(result.ok === false ? result.detail : '', /另一个实例正持有 dev/);
  assert.equal(second.isHeld(), false, '抢不到就 MUST NOT 自认为持有——那等于无锁照写');
});

test('不同 target 各自持锁互不影响（dev 与 ol 是两把锁）', async () => {
  const pg = new FakePg();
  const dev = makeLock(pg, 'dev');
  const ol = makeLock(pg, 'ol');
  assert.deepEqual(await dev.acquire(), { ok: true });
  assert.deepEqual(await ol.acquire(), { ok: true });
});

test('释放后可被重新抢到（stop→start 天然接管）', async () => {
  const pg = new FakePg();
  const first = makeLock(pg, 'dev');
  const second = makeLock(pg, 'dev');
  await first.acquire();
  await first.release();
  assert.equal(first.isHeld(), false);
  assert.deepEqual(await second.acquire(), { ok: true });
});

test('持锁连接断开 = 写权已丢失：isHeld 立即转 false 并通知订阅者', async () => {
  const pg = new FakePg();
  const track: { conn?: FakeConnection } = {};
  const lock = makeLock(pg, 'dev', track);
  await lock.acquire();

  const lost: string[] = [];
  lock.onLost((reason) => lost.push(reason));
  track.conn!.drop(new Error('connection terminated'));

  assert.equal(lock.isHeld(), false, '锁随会话释放，MUST NOT 继续自认为有写权');
  assert.equal(lost.length, 1);
  assert.match(lost[0], /写者锁连接报错/);

  // 写权已经让出去了：另一个实例现在就能抢到。
  const other = makeLock(pg, 'dev');
  assert.deepEqual(await other.acquire(), { ok: true });
});
