/**
 * 记账 outbox 与漏斗（change risk-state-cross-process-integrity，tasks 5.9 / 6.4）。
 *
 * 内存桩按 outbox 表的**约束**建模：`(execution_target, dedupe_key)` 唯一、`risk_counters.outbox_id`
 * 唯一、apply 的两步在同一「事务」里全成或全不成。测的是漏斗语义（崩溃点补记、重复投递只记一次、
 * 同一行 apply 两次只增一行、超限进死信、入队失败 fail-closed）。
 *
 * **测不到的**（真机验收项）：`FOR UPDATE SKIP LOCKED` 在多 worker 下的真实互斥、真事务的原子性。
 * 桩里那两条是我自己写的，断言它们只是在断言我自己。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RiskAccounting } from '../src/risk/risk-accounting.js';
import { RiskCounterReconciler } from '../src/risk/risk-counter-reconciler.js';
import { RiskController } from '../src/risk/risk-controller.js';
import type {
  RiskCounterOutbox,
  RiskCounterOutboxBacklog,
  RiskCounterOutboxClaim,
  RiskCounterOutboxEnqueueInput,
} from '../src/risk/risk-counter-outbox-store.js';
import type { ActionQuota, RiskAction } from '../src/risk/types.js';
import { RISK_ACTIONS } from '../src/risk/types.js';

const silent = { log() {}, warn() {}, error() {} };

interface Row {
  id: number;
  accountId: string;
  action: RiskAction;
  occurredAt: number;
  dedupeKey: string;
  status: 'pending' | 'applied' | 'dead';
  attempts: number;
  claimToken: string | null;
  claimExpiresAt: number | null;
}

/** 库的持久部分：进程重启时保留。 */
class FakeDatabase {
  rows: Row[] = [];
  /** risk_counters：outbox_id 上有唯一索引。 */
  counters: { accountId: string; action: RiskAction; occurredAt: number; outboxId: number }[] = [];
  nextId = 1;
}

class FakeOutbox implements RiskCounterOutbox {
  now = 1_000;
  /** 置真 → 入队抛错（模拟数据库不可写）。 */
  enqueueFails = false;
  /** 置真 → apply 抛错（模拟落库失败，驱动重试与死信）。 */
  applyFails = false;

  constructor(private readonly db: FakeDatabase) {}

  async init(): Promise<void> {}

  async enqueue(input: RiskCounterOutboxEnqueueInput): Promise<{ id: number; inserted: boolean }> {
    if (this.enqueueFails) throw new Error('pg is not writable');
    const existing = this.db.rows.find((r) => r.dedupeKey === input.dedupeKey);
    if (existing) return { id: existing.id, inserted: false };
    const row: Row = {
      id: this.db.nextId++,
      accountId: input.accountId,
      action: input.action,
      occurredAt: input.occurredAt,
      dedupeKey: input.dedupeKey,
      status: 'pending',
      attempts: 0,
      claimToken: null,
      claimExpiresAt: null,
    };
    this.db.rows.push(row);
    return { id: row.id, inserted: true };
  }

  async claimBatch(opts: { workerId: string; leaseMs: number; limit: number }): Promise<RiskCounterOutboxClaim[]> {
    const token = `${opts.workerId}:${this.now}`;
    const picked = this.db.rows
      .filter((r) => r.status === 'pending' && (r.claimExpiresAt === null || r.claimExpiresAt <= this.now))
      .slice(0, opts.limit);
    for (const r of picked) {
      r.claimToken = token;
      r.claimExpiresAt = this.now + opts.leaseMs;
    }
    return picked.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      action: r.action,
      occurredAt: r.occurredAt,
      dedupeKey: r.dedupeKey,
      attempts: r.attempts,
      claimToken: token,
    }));
  }

  async applyClaimed(claims: RiskCounterOutboxClaim[]): Promise<RiskCounterOutboxClaim[]> {
    if (this.applyFails) throw new Error('counter insert failed');
    const applied: RiskCounterOutboxClaim[] = [];
    for (const claim of claims) {
      const row = this.db.rows.find((r) => r.id === claim.id);
      // 认领失效（租约被回收 / 已被别人应用）→ 整笔不生效。
      if (!row || row.status !== 'pending' || row.claimToken !== claim.claimToken) continue;
      // outbox_id 唯一索引：同一行第二次 apply 不产生第二行计数。
      if (!this.db.counters.some((c) => c.outboxId === row.id)) {
        this.db.counters.push({
          accountId: row.accountId,
          action: row.action,
          occurredAt: row.occurredAt,
          outboxId: row.id,
        });
      }
      row.status = 'applied';
      row.claimToken = null;
      row.claimExpiresAt = null;
      applied.push(claim);
    }
    return applied;
  }

  async failClaimed(claim: RiskCounterOutboxClaim, _error: string, maxAttempts: number): Promise<{ dead: boolean }> {
    const row = this.db.rows.find((r) => r.id === claim.id);
    if (!row) return { dead: false };
    row.attempts += 1;
    row.claimToken = null;
    row.claimExpiresAt = null;
    const dead = row.attempts >= maxAttempts;
    if (dead) row.status = 'dead';
    return { dead };
  }

  async recoverExpiredClaims(): Promise<number> {
    let n = 0;
    for (const r of this.db.rows) {
      if (r.status === 'pending' && r.claimToken !== null && (r.claimExpiresAt ?? 0) <= this.now) {
        r.claimToken = null;
        r.claimExpiresAt = null;
        n += 1;
      }
    }
    return n;
  }

  async backlogCounts(): Promise<RiskCounterOutboxBacklog> {
    return {
      pending: this.db.rows.filter((r) => r.status === 'pending').length,
      dead: this.db.rows.filter((r) => r.status === 'dead').length,
      staleClaims: 0,
    };
  }
}

function makeAccounting(outbox: FakeOutbox, opts: { maxAttempts?: number } = {}) {
  const controllers = new Map<string, RiskController>();
  const alerts: { type: string; accountId?: string }[] = [];
  const accounting: RiskAccounting = new RiskAccounting({
    outbox,
    resolveController: async (accountId: string): Promise<RiskController> => {
      let c = controllers.get(accountId);
      if (!c) {
        c = new RiskController({
          accountId,
          quotaLevel: 'normal',
          interactionBlockedProvider: (id: string): boolean => accounting.isBlocked(id),
        });
        controllers.set(accountId, c);
      }
      return c;
    },
    alertStore: {
      raise: async (input) => {
        alerts.push({ type: input.type, ...(input.accountId ? { accountId: input.accountId } : {}) });
        return { alertId: alerts.length };
      },
    },
    logger: silent,
    pollIntervalMs: 10_000,
    maxAttempts: opts.maxAttempts ?? 5,
    workerId: 'test',
  });
  return { accounting, controllers, alerts };
}

test('崩在入队与 apply 之间不丢账：重启后回收并补记，且只记一次', async () => {
  const db = new FakeDatabase();

  // 进程 A：入队成功，随后崩溃（认领了但没 apply）。
  {
    const outbox = new FakeOutbox(db);
    const { accounting } = makeAccounting(outbox);
    await accounting.enqueue({ accountId: 'acc-1', action: 'like', dedupeKey: 'env-1:like' });
    await outbox.claimBatch({ workerId: 'crashed', leaseMs: 30_000, limit: 10 });
    accounting.stop();
  }
  assert.equal(db.counters.length, 0, '崩溃点：事实已在 outbox，但还没进账本');

  // 进程 B：重启 → 回收租约过期的在途行 → apply。
  const outbox = new FakeOutbox(db);
  outbox.now = 1_000_000; // 租约已过期
  const { accounting, controllers } = makeAccounting(outbox);
  const { recovered } = await accounting.start();
  assert.equal(recovered, 1, '启动回收条数 MUST 可见（写进启动日志）');
  assert.equal(await accounting.applyNow(), 1);
  accounting.stop();

  assert.equal(db.counters.length, 1, '这次真实点赞 MUST 出现在计数里');
  assert.equal(controllers.get('acc-1')!.counts().day.like, 1, '且只被计入一次');
});

test('边缘重发同一信封：outbox 只留一行，计数只增一次', async () => {
  const db = new FakeDatabase();
  const outbox = new FakeOutbox(db);
  const { accounting, controllers } = makeAccounting(outbox);
  await accounting.start();

  await accounting.record({ accountId: 'acc-1', action: 'like', dedupeKey: 'env-9:like' });
  await accounting.record({ accountId: 'acc-1', action: 'like', dedupeKey: 'env-9:like' });
  accounting.stop();

  assert.equal(db.rows.length, 1);
  assert.equal(db.counters.length, 1);
  assert.equal(controllers.get('acc-1')!.counts().day.like, 1);
});

test('重复的 submitted-unknown comment dedupe key 只消耗一次评论用量', async () => {
  const db = new FakeDatabase();
  const outbox = new FakeOutbox(db);
  const { accounting, controllers } = makeAccounting(outbox);
  await accounting.start();

  await accounting.record({ accountId: 'acc-fb', action: 'comment', dedupeKey: 'ambiguous-1:comment' });
  await accounting.record({ accountId: 'acc-fb', action: 'comment', dedupeKey: 'ambiguous-1:comment' });
  accounting.stop();

  assert.equal(db.rows.length, 1);
  assert.equal(db.counters.filter((row) => row.action === 'comment').length, 1);
  assert.equal(controllers.get('acc-fb')?.counts().day.comment, 1);
});

test('同一 outbox 行 apply 两次：risk_counters 只增一行（exactly-once 由唯一约束担保）', async () => {
  const db = new FakeDatabase();
  const outbox = new FakeOutbox(db);
  const { accounting } = makeAccounting(outbox);
  await accounting.enqueue({ accountId: 'acc-1', action: 'comment', dedupeKey: 'env-2:comment' });

  const claim = (await outbox.claimBatch({ workerId: 'w', leaseMs: 30_000, limit: 1 }))[0];
  assert.deepEqual((await outbox.applyClaimed([claim])).length, 1);
  assert.deepEqual((await outbox.applyClaimed([claim])).length, 0, '第二次 apply MUST 不生效');
  assert.equal(db.counters.length, 1);
});

test('内存计数只在 apply 成功时递增（回执处理时 MUST NOT 先加一次）', async () => {
  const db = new FakeDatabase();
  const outbox = new FakeOutbox(db);
  const { accounting, controllers } = makeAccounting(outbox);

  await accounting.enqueue({ accountId: 'acc-1', action: 'like', dedupeKey: 'env-3:like' });
  const controller = await (async () => {
    await accounting.applyNow();
    return controllers.get('acc-1')!;
  })();
  assert.equal(controller.counts().day.like, 1);

  // 再入队但不 apply：内存计数不动。
  await accounting.enqueue({ accountId: 'acc-1', action: 'like', dedupeKey: 'env-4:like' });
  assert.equal(controller.counts().day.like, 1, '事实已落库，但内存只跟着 apply 走');
});

test('apply 连续失败到上限 → 进死信 + P1 告警，MUST NOT 静默丢弃', async () => {
  const db = new FakeDatabase();
  const outbox = new FakeOutbox(db);
  const { accounting, alerts } = makeAccounting(outbox, { maxAttempts: 2 });
  await accounting.enqueue({ accountId: 'acc-1', action: 'follow', dedupeKey: 'env-5:follow' });

  outbox.applyFails = true;
  await accounting.applyNow();
  assert.equal(db.rows[0].status, 'pending', '第一次失败还能重试');
  await accounting.applyNow();

  assert.equal(db.rows[0].status, 'dead');
  assert.equal(db.counters.length, 0);
  assert.ok(alerts.some((a) => a.type === 'risk_accounting_dead_letter'));
  assert.equal((await accounting.backlog()).dead, 1, '死信量 MUST 可读');
});

test('入队失败 → 告警 + 该账号 fail-closed（互动准入一律拒绝，浏览仍放行）', async () => {
  const db = new FakeDatabase();
  const outbox = new FakeOutbox(db);
  const { accounting, controllers, alerts } = makeAccounting(outbox);

  // 先物化 controller，好断言闸对它生效。
  await accounting.enqueue({ accountId: 'acc-1', action: 'view', dedupeKey: 'env-6:view' });
  await accounting.applyNow();
  const controller = controllers.get('acc-1')!;
  assert.equal(controller.canDo('like'), true);

  outbox.enqueueFails = true;
  await assert.rejects(
    () => accounting.enqueue({ accountId: 'acc-1', action: 'like', dedupeKey: 'env-7:like' }),
    /pg is not writable/,
    '入队失败 MUST 抛给调用方，调用方据此不推进闭环',
  );
  assert.ok(alerts.some((a) => a.type === 'risk_accounting_enqueue_failed'));
  assert.equal(accounting.isBlocked('acc-1'), true);
  assert.equal(controller.canDo('like'), false, '记不上账就 MUST NOT 再制造要记的账');
  assert.equal(controller.explain('like').reason, 'accounting:blocked');
  assert.equal(controller.canDo('view'), true, '浏览仍放行——否则连「现在什么情况」都看不到');

  // 下一次成功入队即自动解除。
  outbox.enqueueFails = false;
  await accounting.enqueue({ accountId: 'acc-1', action: 'like', dedupeKey: 'env-8:like' });
  assert.equal(accounting.isBlocked('acc-1'), false);
  assert.equal(controller.canDo('like'), true);
  accounting.stop();
});

// ── 对账 ──────────────────────────────────────────────────────────────────────

test('库里被外部插入一行 → 对账检出偏差、告警、以库为准重建', async () => {
  const counters: { action: RiskAction; occurredAt: number; count: number }[] = [];
  const store = {
    loadCounters: async () => counters.map((c) => ({ ...c })),
    loadState: async () => null,
    appendCounter: async () => undefined,
    saveState: async () => undefined,
  };
  const controller = await RiskController.create({
    accountId: 'acc-1',
    store: store as never,
    clock: () => 5_000,
  });
  const registry = {
    materializedAccountIds: () => ['acc-1'],
    peek: () => Promise.resolve(controller),
  };

  const drifts: { action: RiskAction; memory: number; database: number }[] = [];
  const totals = (): ActionQuota =>
    Object.fromEntries(RISK_ACTIONS.map((a) => [a, a === 'like' ? 3 : 0])) as ActionQuota;

  // 内存只知道 1 次（本进程记的那一笔），库里其实有 3 次（外部写入 2 笔）。
  controller.recordFact('like', 4_000);
  counters.push({ action: 'like', occurredAt: 4_000, count: 1 });
  counters.push({ action: 'like', occurredAt: 4_100, count: 1 });
  counters.push({ action: 'like', occurredAt: 4_200, count: 1 });

  const reconciler = new RiskCounterReconciler({
    registry: registry as never,
    totalsSince: async () => totals(),
    clock: () => 5_000,
    logger: silent,
    onDrift: (d) => {
      drifts.push({ action: d.action, memory: d.memory, database: d.database });
    },
  });

  const found = await reconciler.runOnce();
  assert.equal(found.drifts.length, 1);
  assert.deepEqual(drifts, [{ action: 'like', memory: 1, database: 3 }]);
  assert.equal(controller.counts().day.like, 3, '重建后内存值 MUST 等于库值');

  // 再跑一次：已一致 ⇒ 零偏差。
  assert.deepEqual((await reconciler.runOnce()).drifts, []);
});

test('偏差 1 也算偏差：MUST NOT 因差值小而判为一致', async () => {
  const controller = await RiskController.create({
    accountId: 'acc-1',
    store: {
      loadCounters: async () => [],
      loadState: async () => null,
      appendCounter: async () => undefined,
      saveState: async () => undefined,
    } as never,
    clock: () => 5_000,
  });
  controller.recordFact('like', 4_000);
  const reconciler = new RiskCounterReconciler({
    registry: { materializedAccountIds: () => ['acc-1'], peek: () => Promise.resolve(controller) } as never,
    totalsSince: async () =>
      Object.fromEntries(RISK_ACTIONS.map((a) => [a, a === 'like' ? 2 : 0])) as ActionQuota,
    clock: () => 5_000,
    logger: silent,
  });
  const found = await reconciler.runOnce();
  assert.equal(found.drifts.length, 1);
  assert.deepEqual(
    { memory: found.drifts[0].memory, database: found.drifts[0].database },
    { memory: 1, database: 2 },
  );
});

// ── 对账范围按归属收敛（change scope-risk-reconcile-to-owned-accounts）─────────────

/**
 * 建一个「内存少于库」的账号：内存 1 次 like，库里 3 次。对账若把它算进来，必然报偏差。
 * 桩 store 的 `loadCounters` 与 `totalsSince` 口径一致（都是库里那 3 行），
 * 这样「以库为准重建」才是真的在断言重建结果、而不是在断言一个空桩。
 */
async function driftingController(accountId: string) {
  const dbRows: { action: RiskAction; occurredAt: number; count: number }[] = [];
  const controller = await RiskController.create({
    accountId,
    store: {
      loadCounters: async () => dbRows.map((r) => ({ ...r })),
      loadState: async () => null,
      appendCounter: async () => undefined,
      saveState: async () => undefined,
    } as never,
    clock: () => 5_000,
  });
  // 本进程只记了 1 笔；库里另有 2 笔外部写入 ⇒ 内存 1 / 库 3。
  controller.recordFact('like', 4_000);
  for (const occurredAt of [4_000, 4_100, 4_200]) dbRows.push({ action: 'like', occurredAt, count: 1 });
  return controller;
}

const likeTotals = (n: number): ActionQuota =>
  Object.fromEntries(RISK_ACTIONS.map((a) => [a, a === 'like' ? n : 0])) as ActionQuota;

test('归属在另一个 target 的账号：有偏差也 MUST NOT 告警、MUST NOT 重建', async () => {
  const controller = await driftingController('acc-foreign');
  const drifts: string[] = [];
  const reconciler = new RiskCounterReconciler({
    registry: {
      materializedAccountIds: () => ['acc-foreign'],
      peek: () => Promise.resolve(controller),
    } as never,
    totalsSince: async () => likeTotals(3),
    executionTarget: 'dev',
    ownerTargetFor: async () => ({ outcome: 'owned', target: 'ol' }),
    clock: () => 5_000,
    logger: silent,
    onDrift: (d) => {
      drifts.push(d.accountId);
    },
  });

  const round = await reconciler.runOnce();
  assert.deepEqual(round.drifts, [], '共用账本 + 只跟本进程走的内存 ⇒ 他 target 账号本就不可能相等');
  assert.deepEqual(drifts, [], 'MUST NOT 就他 target 的账号告警');
  assert.equal(round.skippedForeign, 1);
  assert.equal(round.reconciled, 0);
  assert.equal(controller.counts().day.like, 1, '跳过的账号 MUST NOT 被重建');
});

test('归属为本 target 的账号：照旧检出偏差并以库为准重建', async () => {
  const controller = await driftingController('acc-own');
  const reconciler = new RiskCounterReconciler({
    registry: {
      materializedAccountIds: () => ['acc-own'],
      peek: () => Promise.resolve(controller),
    } as never,
    totalsSince: async () => likeTotals(3),
    executionTarget: 'dev',
    ownerTargetFor: async () => ({ outcome: 'owned', target: 'dev' }),
    clock: () => 5_000,
    logger: silent,
  });

  const round = await reconciler.runOnce();
  assert.equal(round.drifts.length, 1, '归属过滤 MUST NOT 削弱本 target 账号上的零容忍判据');
  assert.equal(round.reconciled, 1);
  assert.equal(round.skippedForeign, 0);
  assert.equal(controller.counts().day.like, 3, '仍 MUST 以库为准重建');
});

test('归属未知（无归属行 / 账号不存在 / 读失败）MUST 跳过并计数，MUST NOT 冒充本 target', async () => {
  const controllers = new Map(
    await Promise.all(
      ['acc-unowned', 'acc-missing', 'acc-throws'].map(
        async (id) => [id, await driftingController(id)] as const,
      ),
    ),
  );
  const reconciler = new RiskCounterReconciler({
    registry: {
      materializedAccountIds: () => [...controllers.keys()],
      peek: (id: string) => Promise.resolve(controllers.get(id)!),
    } as never,
    totalsSince: async () => likeTotals(3),
    executionTarget: 'dev',
    ownerTargetFor: async (accountId: string) => {
      if (accountId === 'acc-unowned') return { outcome: 'unowned' as const };
      if (accountId === 'acc-missing') return { outcome: 'account_not_found' as const };
      throw new Error('ownership read exploded');
    },
    clock: () => 5_000,
    logger: silent,
  });

  const round = await reconciler.runOnce();
  assert.deepEqual(round.drifts, []);
  assert.equal(round.skippedUnknown, 3, '「未知」不等于「是我的」；读失败也 MUST 计入而不是中断整轮');
  assert.equal(round.reconciled, 0);
  for (const [id, controller] of controllers) {
    assert.equal(controller.counts().day.like, 1, `${id} 跳过后 MUST NOT 被重建`);
  }
});

test('一轮全部跳过 MUST 响亮记录——过滤器把对账做成死代码与「一切正常」必须可区分', async () => {
  const controller = await driftingController('acc-foreign');
  const warnings: string[] = [];
  const reconciler = new RiskCounterReconciler({
    registry: {
      materializedAccountIds: () => ['acc-foreign'],
      peek: () => Promise.resolve(controller),
    } as never,
    totalsSince: async () => likeTotals(3),
    executionTarget: 'dev',
    ownerTargetFor: async () => ({ outcome: 'owned', target: 'ol' }),
    clock: () => 5_000,
    logger: { log: () => undefined, warn: (m: string) => warnings.push(m), error: () => undefined },
  });

  const round = await reconciler.runOnce();
  assert.equal(round.materialized, 1);
  assert.equal(round.reconciled, 0);
  assert.ok(
    warnings.some((w) => w.includes('本轮无账号参与对账') && w.includes('已物化=1')),
    '已物化>0 而实际对账=0 MUST 响亮记录，否则「过滤条件写错」与「健康」在观测上同形',
  );
});

test('归属读口缺席 ⇒ 不过滤、全量对账（逐字回到改动前行为）', async () => {
  const controller = await driftingController('acc-1');
  const reconciler = new RiskCounterReconciler({
    registry: {
      materializedAccountIds: () => ['acc-1'],
      peek: () => Promise.resolve(controller),
    } as never,
    totalsSince: async () => likeTotals(3),
    // executionTarget / ownerTargetFor 都不注入：归属强制未生效的形态。
    clock: () => 5_000,
    logger: silent,
  });

  const round = await reconciler.runOnce();
  assert.equal(round.drifts.length, 1, '归属强制已关时对账器 MUST NOT 单方面把自己关成静默');
  assert.equal(round.reconciled, 1);
});
