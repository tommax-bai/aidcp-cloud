/**
 * 记账漏斗的四个缺口（change risk-state-cross-process-integrity 实施后审计坐实）。
 *
 * 这四条守的都是同一件事：**「真实发生过」与「账本上有」之间不许有静默的缝**。
 * 每条都对应一个改动前既有测试覆盖不到的形状——2940 条全绿时它们全都在漏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { DefaultMessageHandler, type AnchorStore } from '@automation/comm/handler.js';
import { makeEnvelope, type NoteDetailPayload } from '@automation/comm/protocol.js';
import type { EdgeSession } from '@automation/comm/ws-server.js';
import { EventBus } from '@automation/event-bus/index.js';
import { SimplePlanner } from '@automation/planner/index.js';
import type { LlmClient } from '@content/llm/qwen.js';
import { RiskAccounting } from '@automation/risk/risk-accounting.js';
import { RiskController } from '@automation/risk/risk-controller.js';
import { PgRiskCounterOutboxStore } from '@automation/risk/risk-counter-outbox-store.js';
import type {
  RiskCounterOutbox,
  RiskCounterOutboxBacklog,
  RiskCounterOutboxClaim,
  RiskCounterOutboxEnqueueInput,
} from '@automation/risk/risk-counter-outbox-store.js';
import type { RiskAction, RiskStore } from '@automation/risk/types.js';

const silent = { log() {}, warn() {}, error() {} };

const cache = {
  get: async () => null,
  recordHit: async () => {},
  recordFailure: async () => {},
  stage: async () => {},
  confirmStaged: async () => ({ promoted: false, successes: 0, needed: 1 }),
  dropStaged: async () => {},
} as unknown as AnchorStore;
const llm: LlmClient = { complete: async () => '0' };

// ── 缺口 1：view 从未进过漏斗（blocker）────────────────────────────────────────
//
// 记账整体从「interaction.occurred 订阅者里 record()」迁到 outbox 之后，入队点只接了 search 与
// 六个带回执的互动动作。view 是唯一没有 action.completed 回执的动作，于是它既不落库也不进内存：
// 浏览配额的日/时/分三个窗口全部失效、首发引导进度恒 0、面板浏览数恒 0，且对账检不出（内存 0 == 库 0）。

interface EnqueuedFact {
  accountId: string;
  action: RiskAction;
  dedupeKey: string;
}

function handlerWithAccounting() {
  const enqueued: EnqueuedFact[] = [];
  let applyNowCalls = 0;
  const bus = new EventBus();
  const emitted: { action: string; noteId?: string }[] = [];
  bus.on('interaction.occurred', (evt) => {
    emitted.push({ action: evt.action, ...(evt.noteId ? { noteId: evt.noteId } : {}) });
  });
  const handler = new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm,
    cache,
    eventBus: bus,
    clock: () => 1_000,
    riskAccounting: {
      enqueue: async (input) => {
        enqueued.push({ accountId: input.accountId, action: input.action, dedupeKey: input.dedupeKey });
      },
      record: async () => {
        applyNowCalls += 1;
        return { allowed: true };
      },
    },
  });
  return { handler, enqueued, emitted, applyNowCalls: () => applyNowCalls };
}

test('note.detail 的一次浏览 MUST 与其它动作走同一条 outbox 漏斗（否则浏览配额彻底失效）', async () => {
  const { handler, enqueued, emitted } = handlerWithAccounting();
  const session = {
    sessionId: 's',
    edgeId: 'edge-view',
    accountId: 'acc-view',
    platform: 'xiaohongshu',
  } as unknown as EdgeSession;
  const detail = {
    noteId: 'note-1',
    title: 't',
    content: 'b',
    likeCount: 0,
    collectCount: 0,
  } as unknown as NoteDetailPayload;

  await handler.handle(makeEnvelope('note.detail', 'env-1', 1_000, detail), session);

  assert.deepEqual(
    enqueued,
    [{
      accountId: 'acc-view',
      action: 'view',
      dedupeKey: 'edge-risk:acc-view:edge-view:1000:env-1:view:note-1',
    }],
    'view MUST 入 outbox；只 emit 不入队 = 浏览量无上界',
  );
  assert.deepEqual(emitted, [{ action: 'view', noteId: 'note-1' }]);
});

test('Cloud 去重键绑定账号、环境和原始信封时间/ID，同时保持原信封重放稳定', async () => {
  const { handler, enqueued } = handlerWithAccounting();
  const payload = { action: 'like', ok: true } as const;
  const session = (accountId: string, edgeId: string): EdgeSession => ({
    sessionId: `${accountId}:${edgeId}`,
    accountId,
    edgeId,
  });

  await handler.handle(makeEnvelope('action.completed', 'edge-1', 1_001, payload), session('acc-a', 'env-a'));
  await handler.handle(makeEnvelope('action.completed', 'edge-1', 1_001, payload), session('acc-a', 'env-a'));
  await handler.handle(makeEnvelope('action.completed', 'edge-1', 1_001, payload), session('acc-b', 'env-a'));
  await handler.handle(makeEnvelope('action.completed', 'edge-1', 1_001, payload), session('acc-a', 'env-b'));
  await handler.handle(makeEnvelope('action.completed', 'edge-1', 2_001, payload), session('acc-a', 'env-a'));

  const keys = enqueued.map((fact) => fact.dedupeKey);
  assert.equal(keys[0], 'edge-risk:acc-a:env-a:1001:edge-1:like');
  assert.equal(keys[1], keys[0], '同一原始信封重放 MUST 保持相同去重键');
  assert.notEqual(keys[2], keys[0], '不同账号 MUST 不碰撞');
  assert.notEqual(keys[3], keys[0], '不同环境 MUST 不碰撞');
  assert.notEqual(keys[4], keys[0], '进程重启复用顺序 ID 时，不同原始时间戳 MUST 不碰撞');
  assert.equal(new Set(keys).size, 4);
});

test('入队后 apply → risk_counters 多一行 view + 内存 view 计数 +1（端到端一条）', async () => {
  const db = new FakeDatabase();
  const outbox = new FakeOutbox(db);
  const controller = new RiskController({ accountId: 'acc-view', quotaLevel: 'normal' });
  const accounting = new RiskAccounting({
    outbox,
    resolveController: async () => controller,
    logger: silent,
    pollIntervalMs: 10_000,
    workerId: 'test',
  });

  assert.equal(controller.counts().day.view, 0);
  await accounting.enqueue({ accountId: 'acc-view', action: 'view', dedupeKey: 'env-1:view:note-1' });
  await accounting.applyNow();

  assert.equal(db.counters.filter((c) => c.action === 'view').length, 1, '库里 MUST 多一行 view');
  assert.equal(controller.counts().day.view, 1, '内存 view 计数 MUST 递增，否则配额闸读到的恒是 0');
  accounting.stop();
});

// ── 缺口 2：降级路径宣称「行为逐位一致」实则一行都不落库 ─────────────────────────

test('漏斗未启用时的降级 record() MUST 同时写内存与 risk_counters（否则重启即白送一整天配额）', async () => {
  const appended: { accountId: string; action: RiskAction }[] = [];
  const store: RiskStore = {
    loadCounters: async () => [],
    appendCounter: async (accountId: string, action: RiskAction) => {
      appended.push({ accountId, action });
    },
    loadState: async () => null,
    saveState: async () => undefined,
  } as unknown as RiskStore;
  const controller = new RiskController({ accountId: 'acc-1', store, quotaLevel: 'normal' });

  const allowed = await controller.record('like');

  assert.equal(allowed, true, '返回值仍答「在不在策略内」');
  assert.equal(controller.counts().day.like, 1, '内存计数照增');
  assert.deepEqual(appended, [{ accountId: 'acc-1', action: 'like' }], '库里也 MUST 有这一笔');
});

// ── 缺口 3：applyNow 并发折叠让「入队后立即 apply」整个落空 ──────────────────────

test('飞行中入队的行不会被推迟到下一轮兜底轮询（并发折叠 MUST 排队而非复用）', async () => {
  const db = new FakeDatabase();
  const outbox = new FakeOutbox(db);
  const controllers = new Map<string, RiskController>();
  const accounting = new RiskAccounting({
    outbox,
    resolveController: async (accountId) => {
      let c = controllers.get(accountId);
      if (!c) {
        c = new RiskController({ accountId, quotaLevel: 'normal' });
        controllers.set(accountId, c);
      }
      return c;
    },
    logger: silent,
    pollIntervalMs: 10_000,
    workerId: 'test',
  });

  // 账号 A 的 apply 起飞：**认领已经做完**（快照里只有 A），随后卡在落账那一步。
  // 这正是缺陷的形状——飞行中的那一次早已错过 B，复用它等于 B 这一轮根本不会被认领。
  await accounting.enqueue({ accountId: 'acc-a', action: 'like', dedupeKey: 'env-a:like' });
  outbox.holdApply();
  const inFlight = accounting.applyNow();
  await outbox.claimed();

  // 飞行途中账号 B 的事实入队并立即请求 apply。
  await accounting.enqueue({ accountId: 'acc-b', action: 'like', dedupeKey: 'env-b:like' });
  const second = accounting.applyNow();

  outbox.releaseApply();
  await inFlight;
  await second;

  assert.equal(
    controllers.get('acc-b')?.counts().day.like,
    1,
    'B 的内存计数 MUST 在第二次 applyNow 返回时已经递增，MUST NOT 等 5s 兜底轮询',
  );
  accounting.stop();
});

// ── 缺口 4：failClaimed 会把已 applied 的行改回 pending / 标死信并发假 P1 ──────────

test('failClaimed 只动 pending 行：已 applied 的行不被回写、不报死信（不发假 P1）', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rowCount: 0 }; // 该行已不是 pending（apply 已 COMMIT）→ 一行没改到
    },
  } as unknown as pg.Pool;
  const store = new PgRiskCounterOutboxStore({ executionTarget: 'dev', pool });
  const row: RiskCounterOutboxClaim = {
    id: 7,
    accountId: 'acc-1',
    action: 'like',
    occurredAt: 1_000,
    dedupeKey: 'env-1:like',
    attempts: 4,
    claimToken: 'w:1',
  };

  const { dead } = await store.failClaimed(row, 'resolveController failed', 5);

  assert.match(calls[0].sql, /AND status = 'pending'/, "WHERE MUST 带 status='pending' 守卫");
  assert.equal(dead, false, '没改到行就 MUST NOT 报死信——那条 P1 会声称一笔已入账的动作没进账本');
});

// ── 共用内存桩（形状同 risk-counter-outbox.test.ts，额外支持「卡住认领」）──────────

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

class FakeDatabase {
  rows: Row[] = [];
  counters: { accountId: string; action: RiskAction; occurredAt: number; outboxId: number }[] = [];
  nextId = 1;
}

class FakeOutbox implements RiskCounterOutbox {
  now = 1_000;
  /** 落账闸：置上后 applyClaimed 挂起，直到 releaseApply()。 */
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  /** 「认领已发生」的信号：用于让测试精确停在「已认领、未落账」这一刻。 */
  private claimedSignal: Promise<void>;
  private claimedResolve!: () => void;

  constructor(private readonly db: FakeDatabase) {
    this.claimedSignal = new Promise((resolve) => {
      this.claimedResolve = resolve;
    });
  }

  /** 等到 claimBatch 至少跑过一次。 */
  claimed(): Promise<void> {
    return this.claimedSignal;
  }

  holdApply(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve;
    });
  }

  releaseApply(): void {
    this.open?.();
    this.gate = null;
    this.open = null;
  }

  async init(): Promise<void> {}

  async enqueue(input: RiskCounterOutboxEnqueueInput): Promise<{ id: number; inserted: boolean }> {
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
    this.claimedResolve();
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
    if (this.gate) await this.gate;
    const applied: RiskCounterOutboxClaim[] = [];
    for (const claim of claims) {
      const row = this.db.rows.find((r) => r.id === claim.id);
      if (!row || row.status !== 'pending' || row.claimToken !== claim.claimToken) continue;
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
    if (!row || row.status !== 'pending') return { dead: false };
    row.attempts += 1;
    row.claimToken = null;
    row.claimExpiresAt = null;
    const dead = row.attempts >= maxAttempts;
    if (dead) row.status = 'dead';
    return { dead };
  }

  async recoverExpiredClaims(): Promise<number> {
    return 0;
  }

  async backlogCounts(): Promise<RiskCounterOutboxBacklog> {
    return {
      pending: this.db.rows.filter((r) => r.status === 'pending').length,
      dead: this.db.rows.filter((r) => r.status === 'dead').length,
      staleClaims: 0,
    };
  }
}
