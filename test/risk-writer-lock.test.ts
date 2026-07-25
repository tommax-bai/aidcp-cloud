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
import {
  AutomationWriterLock,
  resolveWriterLockConnection,
  writerLockClientConfig,
  type WriterLockConnection,
} from '../src/risk/writer-lock.js';

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

// ── 锁连的是哪个库（Block③ 物理拆库 L3）───────────────────────────────────────────────
//
// advisory lock 的作用域是「一个数据库」。锁留在旧共享库、写落到新 automation 库时，两个进程
// 各自「抢到同一把锁」却互不排斥 = 静默双写 risk_state。下面三条断言守的就是这一点；纯配置
// 解析层面（不建连、不连真库），故本文件仍是离线用例。

const AUTOMATION_URL = 'postgres://writer@pg-automation.internal:5432/aidcp_automation';

test('设了 AIDCP_PG_AUTOMATION_URL：写者锁连的是 automation 属主库（且绝不叠回落字段）', () => {
  const connection = resolveWriterLockConnection({
    AIDCP_PG_AUTOMATION_URL: AUTOMATION_URL,
    // 共享库的 PG* 同时在场也不该被采纳：翻转后它们指的是**另一个库**。
    PGHOST: 'shared.local',
    PGPORT: '5432',
    PGDATABASE: 'aidcp',
    PGUSER: 'shared',
  } as NodeJS.ProcessEnv);
  assert.equal(connection.connectionString, AUTOMATION_URL);

  const client = writerLockClientConfig(connection);
  assert.equal(client.connectionString, AUTOMATION_URL);
  // 关键反回归：连接串在场时五个字段 MUST 全部缺席。任何一个被回落值填上，node-postgres
  // 都可能拿它覆盖连接串里的库名 —— 锁就取到了错的库上，而且会**成功**。
  for (const field of ['host', 'port', 'database', 'user', 'password'] as const) {
    assert.equal(client[field], undefined, `连接串在场时 MUST NOT 回落 ${field}`);
  }
});

test('未设 AIDCP_PG_AUTOMATION_URL：逐字回落到既有 PG* 读法（今天生产状态，行为不变）', () => {
  const connection = resolveWriterLockConnection({
    PGHOST: 'shared.local',
    PGPORT: '5433',
    PGDATABASE: 'aidcp',
    PGUSER: 'shared',
  } as NodeJS.ProcessEnv);
  assert.equal(connection.connectionString, undefined);
  assert.deepEqual(connection, {
    host: 'shared.local',
    port: 5433,
    database: 'aidcp',
    user: 'shared',
    password: undefined,
  });

  const client = writerLockClientConfig(connection);
  assert.equal(client.connectionString, undefined);
  assert.equal(client.host, 'shared.local');
  assert.equal(client.port, 5433);
  assert.equal(client.keepAlive, true);
});

test('AIDCP_PG_AUTOMATION_URL 空白视为未设（绝不把空串当连接串连出去）', () => {
  const connection = resolveWriterLockConnection({
    AIDCP_PG_AUTOMATION_URL: '   ',
    PGHOST: 'shared.local',
  } as NodeJS.ProcessEnv);
  assert.equal(connection.connectionString, undefined);
  assert.equal(connection.host, 'shared.local');
});
