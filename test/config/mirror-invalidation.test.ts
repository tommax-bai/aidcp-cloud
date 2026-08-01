/**
 * 跨进程配置镜像失效通道（change config-mirror-cross-process-invalidation）单测。
 *
 * 桩 PG（内存假 pool，支持事务 connect）+ 注入时钟，不打真实 PostgreSQL。
 * 覆盖的不变量按 tasks.md §7 逐条编号标注。
 */

import { test } from 'node:test';
import { ensureCapabilitySchema } from '../../src/schema/schema-capability.js';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  MirrorVersionStore,
  writeWithMirrorBump,
} from '../../src/config/mirror-version-store.js';
import {
  ConfigMirrorBumpRelay,
  OutboxMirrorVersionBumper,
} from '../../src/config/mirror-bump-outbox.js';
import {
  PgConfigMirrorBumpSink,
  UnavailableConfigMirrorBumpSink,
} from '../../src/config/mirror-bump-sink.js';
import type { ConfigMirrorBumpSink } from '../../src/kernel/config-mirror-bump-types.js';
import { ConfigMirrorRefresher, resolveMirrorPollMs } from '../../src/config/mirror-refresher.js';
import { CONFIG_MIRRORS, CONFIG_MIRROR_KEYS } from '../../src/config/mirror-registry.js';
import {
  installConfigMirrorFreshnessSource,
  mirrorStateOf,
} from '../../src/config-mirror-freshness.js';
import { QUOTA_CONFIG_SCHEMA_SQL, QuotaConfigStore } from '../../src/config/quota-config-store.js';
import { PERSONA_CONFIG_SCHEMA_SQL, PersonaStore } from '../../src/config/persona-store.js';
import { fakeSchemaProbe } from '../fixtures/schema-probe.js';
import { deriveWindowQuotas } from '../../src/risk/quotas.js';
import { staleGateMirrors, shouldHaltNewPlatformActions } from '../../src/config/mirror-stop-work.js';
import { createQuotaConfigPanel } from '../../src/config/quota-config-facade.js';
import { RISK_ACTIONS, RISK_QUOTA_LEVELS } from '../../src/risk/types.js';

/**
 * 假 pool 的 schema 探测应答：两个存储的 init() 现在只探测、不建表
 * （change cloud-schema-migration-executor 第 5 节）。
 */
const schemaProbe = fakeSchemaProbe(QUOTA_CONFIG_SCHEMA_SQL, PERSONA_CONFIG_SCHEMA_SQL);

/** 内存假 PG：版本表 + quota_config + persona_config + 拒绝记账表；支持 connect() 事务。 */
function fakePg() {
  const versions = new Map<string, number>();
  const quotas = new Map<string, Record<string, unknown>>();
  const personas = new Map<string, Record<string, unknown>>();
  const refusals: Array<{ mirrorKey: string; target: string; count: number }> = [];
  // change block3-l3-config-mirror-bump-decouple：automation 侧走 outbox + 中继 + api 侧 inbox 去重。
  const outbox: Array<{ id: number; topic: string; payload: unknown; execution_target: string; created_at: Date }> = [];
  const cursors = new Map<string, number>();
  const topicCursors = new Map<string, number>();
  const inbox = new Set<string>();
  let outboxSeq = 0;
  let versionReadFails = false;
  let writeFails = false;

  const run = async (sql: string, params?: unknown[]) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/.test(sql)) return { rows: [] };
    const probe = schemaProbe(sql);
    if (probe) return probe;
    if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX') || sql.includes('ALTER TABLE')) return { rows: [] };
    if (sql.includes('INSERT INTO event_outbox ')) {
      const [topic, payloadJson, target] = params as [string, string, string];
      outboxSeq += 1;
      outbox.push({
        id: outboxSeq,
        topic,
        payload: JSON.parse(payloadJson) as unknown,
        execution_target: target,
        created_at: new Date(),
      });
      return { rows: [{ id: outboxSeq }] };
    }
    // change outbox-listen-and-topic-cursor：消费游标按 (consumer, target, topic) 分维之后，读游标是
    // 「主题行 → 遗留聚合行 → 0」的两级回落，拉取按主题各拉一批。下面四支照实现的 SQL 形状分派；
    // 顺序 MUST 在遗留分支之前——两级回落那条 SELECT 里同时提到两张游标表，先匹配到谁就按谁走。
    if (sql.startsWith('SELECT COALESCE(')) {
      const [consumer, target, topic] = params as [string, string, string];
      const scoped = topicCursors.get(`${consumer}|${target}|${topic}`);
      const legacy = cursors.get(`${consumer}|${target}`);
      return { rows: [{ last_id: scoped ?? legacy ?? 0 }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT count(*)::bigint AS pending')) {
      const [target, topic, after] = params as [string, string, number];
      const pending = outbox.filter(
        (e) => e.execution_target === target && e.topic === topic && e.id > Number(after),
      ).length;
      return { rows: [{ pending }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id, topic, payload')) {
      const [target, topic, afterId, limit] = params as [string, string, number, number];
      const rows = outbox
        .filter((e) => e.execution_target === target && e.topic === topic && e.id > Number(afterId))
        .sort((a, b) => a.id - b.id)
        .slice(0, Number(limit));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('INSERT INTO event_outbox_topic_cursor')) {
      const [consumer, target, topic, lastId] = params as [string, string, string, number];
      const key = `${consumer}|${target}|${topic}`;
      topicCursors.set(key, Math.max(topicCursors.get(key) ?? 0, Number(lastId)));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM event_outbox_cursor')) {
      const key = `${String((params ?? [])[0])}|${String((params ?? [])[1])}`;
      const last = cursors.get(key);
      return { rows: last === undefined ? [] : [{ last_id: last }] };
    }
    if (sql.includes('INSERT INTO event_outbox_cursor')) {
      const [consumer, target, lastId] = params as [string, string, number];
      const key = `${consumer}|${target}`;
      cursors.set(key, Math.max(cursors.get(key) ?? 0, Number(lastId)));
      return { rows: [] };
    }
    if (sql.includes('FROM event_outbox')) {
      const [target, lastId, limit] = params as [string, number, number];
      const rows = outbox
        .filter((e) => e.execution_target === target && e.id > Number(lastId))
        .slice(0, Number(limit));
      return { rows };
    }
    if (sql.includes('INSERT INTO config_mirror_bump_inbox')) {
      const dedupKey = String((params ?? [])[0]);
      if (inbox.has(dedupKey)) return { rows: [], rowCount: 0 };
      inbox.add(dedupKey);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO config_mirror_version')) {
      const key = String((params ?? [])[0]);
      versions.set(key, (versions.get(key) ?? 0) + 1);
      return { rows: [] };
    }
    if (sql.includes('FROM config_mirror_version')) {
      if (versionReadFails) throw new Error('pg down');
      return { rows: [...versions].map(([mirror_key, version]) => ({ mirror_key, version })) };
    }
    if (sql.includes('INSERT INTO config_mirror_stale_refusal')) {
      refusals.push({
        mirrorKey: String((params ?? [])[0]),
        target: String((params ?? [])[2]),
        count: Number((params ?? [])[3] ?? 1),
      });
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO quota_config')) {
      if (writeFails) throw new Error('db down');
      const [tier, action, daily, per_minute, per_hour, updated_by] = params as [string, string, number, number, number, string];
      const row = { tier, action, daily, per_minute, per_hour, updated_at: '2026-07-22T00:00:00.000Z', updated_by };
      quotas.set(`${tier}|${action}`, row);
      return { rows: [row] };
    }
    if (sql.includes('FROM quota_config')) return { rows: [...quotas.values()] };
    if (sql.includes('INSERT INTO persona_config')) {
      const [accountId, persona, updatedBy] = params as [string, string, string];
      const row = { account_id: accountId, persona, updated_at: null, updated_by: updatedBy };
      personas.set(accountId, row);
      return { rows: [row] };
    }
    if (sql.includes('DELETE FROM persona_config')) {
      personas.delete(String((params ?? [])[0]));
      return { rows: [] };
    }
    if (sql.includes('FROM persona_config')) return { rows: [...personas.values()] };
    if (sql.includes('SELECT pg_notify')) return { rows: [] };
    return { rows: [] };
  };

  const pool = {
    query: run,
    connect: async () => ({ query: run, release: () => {} }),
  };
  return {
    pool: pool as unknown as pg.Pool,
    versions,
    quotas,
    personas,
    refusals,
    outbox,
    cursors,
    topicCursors,
    inbox,
    setVersionReadFails: (v: boolean) => { versionReadFails = v; },
    setWriteFails: (v: boolean) => { writeFails = v; },
  };
}

/**
 * automation 属主的配置（本文件里是 `quota_config`）自 change block3-l3-config-mirror-bump-decouple 起
 * **不再**在自己的写事务里直接推 api 的版本表：同事务写本域 outbox 行 → 进程内中继 → api 侧 inbox 去重 + 推版本。
 * 本 helper 把这条链在假 PG 上接起来，供各用例复用。
 */
function wireAutomationBumpChannel(
  db: ReturnType<typeof fakePg>,
  opts: { sink?: ConfigMirrorBumpSink } = {},
) {
  const versionStore = new MirrorVersionStore({ pool: db.pool, notifyEnabled: false });
  const sink = opts.sink ?? new PgConfigMirrorBumpSink({ pool: db.pool, versionStore });
  const relay = new ConfigMirrorBumpRelay({
    pool: db.pool,
    sink,
    executionTarget: 'dev',
    logger: { log: () => {}, warn: () => {} },
  });
  const bumper = new OutboxMirrorVersionBumper({
    allowedMirrorKeys: new Set(
      CONFIG_MIRROR_KEYS.filter((key) => CONFIG_MIRRORS[key].owner === 'automation'),
    ),
    executionTarget: 'dev',
    logger: { log: () => {}, warn: () => {} },
  });
  return { versionStore, sink, relay, bumper };
}

/** 每个用例跑完都卸载事实源，避免污染别的用例（模块级单例）。 */
function withFreshnessCleanup(fn: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } finally {
      installConfigMirrorFreshnessSource(null);
    }
  };
}

// ── §1 注册表：闭集合与档位 ───────────────────────────────────────────────────

test('1.1 注册表穷举登记 16 处镜像；闸门镜像必有陈旧上限、参数镜像必为 null', () => {
  assert.equal(CONFIG_MIRROR_KEYS.length, 16);
  for (const key of CONFIG_MIRROR_KEYS) {
    const d = CONFIG_MIRRORS[key];
    assert.equal(d.mirrorKey, key, '键与 mirrorKey 字段必须一致');
    if (d.tier === 'gate') {
      assert.equal(typeof d.staleMs, 'number');
      assert.ok((d.staleMs as number) > 0, `闸门镜像 ${key} 必须声明正的陈旧上限`);
    } else {
      assert.equal(d.staleMs, null, `参数镜像 ${key} 的 staleMs 必须显式为 null`);
    }
  }
});

test('7.8 穷举防漂移：未登记的 mirrorKey 在类型层就取不到（typecheck 守）', () => {
  // @ts-expect-error 未登记的 mirrorKey 必须编译失败——这行若不再报错，说明闭集合被打开了。
  const missing = CONFIG_MIRRORS['brand_new_unregistered_mirror'];
  assert.equal(missing, undefined);
});

// ── §2 版本推进 ──────────────────────────────────────────────────────────────

test('2.2/2.3 写配置与失效信号入队同事务；写库失败则信号不入队、版本不进、镜像不刷', async () => {
  const db = fakePg();
  const { relay, bumper } = wireAutomationBumpChannel(db);
  const store = new QuotaConfigStore({ pool: db.pool, mirrorVersionBumper: bumper });
  await store.init();

  await store.set('normal', 'like', { daily: 42 }, 'tester');
  assert.equal(db.outbox.length, 1, '写成功 → 本域 outbox 落一条失效信号（与配置写同一笔提交）');
  assert.equal(db.versions.get('quota_config'), undefined, '此刻版本还没进：跨库那一步已改成异步中继');
  assert.equal(store.windowQuotasFor('normal').day.like, 42, '本进程镜像仍然是写透的（同步）');

  assert.equal(await relay.runOnce(), 1, '中继投递一条');
  assert.equal(db.versions.get('quota_config'), 1, '投递后版本 +1');

  db.setWriteFails(true);
  await assert.rejects(() => store.set('normal', 'like', { daily: 99 }, 'tester'));
  assert.equal(db.outbox.length, 1, '写库失败 MUST NOT 入队失效信号（同一笔事务回滚）');
  assert.equal(store.windowQuotasFor('normal').day.like, 42, '写库失败 MUST NOT 刷新镜像');
  await relay.runOnce();
  assert.equal(db.versions.get('quota_config'), 1, '写库失败 MUST NOT 推进版本');
});

test('2.2 版本由库侧自增、与主机时钟无关（时钟回拨不影响单调）', async () => {
  const db = fakePg();
  const versionStore = new MirrorVersionStore({ pool: db.pool, notifyEnabled: false });
  await versionStore.bumpInTx(db.pool, 'persona_config');
  await versionStore.bumpInTx(db.pool, 'persona_config');
  const all = await versionStore.readAll();
  assert.equal(all.get('persona_config'), 2);
});

test('2.5 pg_notify 只是加速器：关掉它不影响版本推进', async () => {
  const db = fakePg();
  const versionStore = new MirrorVersionStore({ pool: db.pool, notifyEnabled: false });
  await writeWithMirrorBump(db.pool, versionStore, 'model_config', (q) => q.query('SELECT 1'));
  assert.equal(db.versions.get('model_config'), 1);
});

// ── §3 刷新器与有界陈旧度 ────────────────────────────────────────────────────

test('3.1 轮询周期超硬上界 MUST 拒绝启动并诚实报错，绝不静默截断', () => {
  assert.equal(resolveMirrorPollMs(undefined), 5000);
  assert.equal(resolveMirrorPollMs('8000'), 8000);
  assert.throws(() => resolveMirrorPollMs('60000'), /硬上界/);
  assert.throws(() => resolveMirrorPollMs('abc'), /非法/);
});

test('7.1 写侧改配置 → 读侧在「中继一轮 + 轮询周期」内读到新值，无需重启', withFreshnessCleanup(async () => {
  const db = fakePg();
  const { versionStore, relay, bumper } = wireAutomationBumpChannel(db);
  // 写侧进程（如 dev）与读侧进程（如 ol）共库，各自持一份镜像。
  const writer = new QuotaConfigStore({ pool: db.pool, mirrorVersionBumper: bumper });
  const reader = new QuotaConfigStore({ pool: db.pool });
  await writer.init();
  await reader.init();

  let now = 1_000_000;
  const refresher = new ConfigMirrorRefresher({
    pool: db.pool,
    versionStore,
    pollMs: 5000,
    enabled: true,
    clock: () => now,
    logger: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    reloaders: { quota_config: () => reader.refreshFromAuthority() },
  });
  await refresher.start();

  await writer.set('normal', 'like', { daily: 7 }, 'dev-panel');
  assert.notEqual(reader.windowQuotasFor('normal').day.like, 7, '未比对前读侧仍是旧值（这正是今天的缺陷）');

  // 新增的一段：跨库那一步现在由中继承担（常态由提交后 wake() 立刻触发，这里显式驱动一轮）。
  await relay.runOnce();
  now += 5000;
  await refresher.runOnce();
  assert.equal(reader.windowQuotasFor('normal').day.like, 7, '中继一轮 + 比对一轮内读侧必须读到新值');
  refresher.stop();
}));

test('3.3/7.2 计时基准是「成功比对」而非「成功 reload」：长期无变更的镜像不得被误判陈旧', withFreshnessCleanup(async () => {
  const db = fakePg();
  const versionStore = new MirrorVersionStore({ pool: db.pool, notifyEnabled: false });
  let now = 1_000_000;
  const refresher = new ConfigMirrorRefresher({
    pool: db.pool,
    versionStore,
    pollMs: 5000,
    enabled: true,
    clock: () => now,
    logger: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  await refresher.start();

  // 十分钟没有任何写入，但每轮比对都成功 → 必须始终 fresh。
  for (let i = 0; i < 120; i += 1) {
    now += 5000;
    await refresher.runOnce();
  }
  assert.equal(mirrorStateOf('persona_config'), 'fresh');
  assert.equal(staleGateMirrors().length, 0);
  refresher.stop();
}));

test('7.2 版本查询连续失败超过陈旧上限 → 闸门镜像转 stale、落具名告警、命令泵停手', withFreshnessCleanup(async () => {
  const db = fakePg();
  const versionStore = new MirrorVersionStore({ pool: db.pool, notifyEnabled: false });
  const alerts: Array<{ mirrorKey: string; severity: string }> = [];
  let now = 1_000_000;
  const refresher = new ConfigMirrorRefresher({
    pool: db.pool,
    versionStore,
    pollMs: 5000,
    enabled: true,
    executionTarget: 'dev',
    clock: () => now,
    logger: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    onStaleAlert: (a) => alerts.push({ mirrorKey: a.mirrorKey, severity: a.severity }),
  });
  await refresher.start();
  assert.equal(shouldHaltNewPlatformActions(), false, '基线：新鲜时不停手');

  db.setVersionReadFails(true);
  // 陈旧上限默认 60s = 12 轮；跑 15 轮确保越界。
  for (let i = 0; i < 15; i += 1) {
    now += 5000;
    await refresher.runOnce();
  }
  assert.ok(staleGateMirrors().length > 0, '闸门镜像必须转 stale');
  assert.equal(mirrorStateOf('persona_config'), 'stale');
  assert.equal(mirrorStateOf('model_config'), 'fresh', '参数镜像陈旧不停手，状态口恒 fresh');
  assert.ok(alerts.some((a) => a.severity === 'stale'), '必须落 config_mirror_stale 具名告警');
  assert.ok(alerts.some((a) => a.severity === 'warning'), '进入 stale 前必须先预警一次');

  const halt = shouldHaltNewPlatformActions('unit-test');
  assert.equal(halt, true, '闸门镜像陈旧 → 不放行新的真实平台动作');
  assert.ok(db.refusals.length > 0, '每次因陈旧的拒绝 MUST 计数并持久化');
  assert.equal(db.refusals[0].target, 'dev', '记账须带 executionTarget');

  // 单轮失败 MUST 保留上次已知版本、MUST NOT 清空镜像。
  const health = refresher.health();
  const persona = health.entries.find((e) => e.mirrorKey === 'persona_config')!;
  assert.equal(persona.state, 'stale');
  assert.ok(typeof health.asOf === 'number', '健康投影必须标注数据时刻');
  refresher.stop();
}));

test('3.5 整体开关关闭 → 不安装事实源，全部闸门按今日现状（fresh）运行', withFreshnessCleanup(async () => {
  const db = fakePg();
  const refresher = new ConfigMirrorRefresher({
    pool: db.pool,
    enabled: false,
    logger: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  await refresher.start();
  assert.equal(mirrorStateOf('persona_config'), 'fresh');
  assert.equal(shouldHaltNewPlatformActions(), false);
}));

// ── §4 三态与 never-brick 边界 ───────────────────────────────────────────────

test('7.3 未知不得压成否：人设副本陈旧 → bindingFor 返回 unknown，绝不返回 unbound', withFreshnessCleanup(async () => {
  const db = fakePg();
  const store = new PersonaStore({ schemaEnsurer: ensureCapabilitySchema, pool: db.pool });
  await store.init();
  // 副本里本来就没有这个账号：权威可读时 = 未绑。
  assert.equal(store.bindingFor('acc-1'), 'unbound');

  installConfigMirrorFreshnessSource({
    stateOf: (key) => (key === 'persona_config' ? 'stale' : 'fresh'),
    noteStaleRefusal: () => {},
  });
  assert.equal(store.bindingFor('acc-1'), 'unknown', '副本陈旧时「查不到」MUST NOT 等于「未绑」');
}));

test('7.5 never-brick 边界：权威已答但缺行 → 回落写死默认；副本陈旧 → 停手而非回落', withFreshnessCleanup(async () => {
  const db = fakePg();
  const store = new QuotaConfigStore({ pool: db.pool });
  await store.init();
  // ① 权威已答、表为空 → 逐位回落 deriveWindowQuotas（零回归）。
  assert.deepEqual(store.windowQuotasFor('normal'), deriveWindowQuotas('normal'));

  // ② 副本陈旧 → 上层闸停手；never-brick 的回落**不覆盖**「权威未答」。
  installConfigMirrorFreshnessSource({
    stateOf: () => 'stale',
    noteStaleRefusal: () => {},
  });
  assert.equal(shouldHaltNewPlatformActions(), true);
}));

test('7.6 归属重排零回归：改 quota_config 后下一次取值即按新值（无需重启）', async () => {
  const db = fakePg();
  const store = new QuotaConfigStore({ pool: db.pool });
  await store.init();
  const before = store.windowQuotasFor('normal').day.like;
  await store.set('normal', 'like', { daily: before + 5 }, 'panel');
  assert.equal(store.windowQuotasFor('normal').day.like, before + 5, 'canDo 的取值口必须每次现读');
});

test('7.7 半填竞态：重载进行中并发读 → 要么完整旧集合、要么完整新集合', async () => {
  const db = fakePg();
  const store = new QuotaConfigStore({ pool: db.pool });
  await store.init();
  await store.set('normal', 'like', { daily: 11 }, 'seed');
  await store.set('normal', 'collect', { daily: 22 }, 'seed');

  const reload = store.refreshFromAuthority();
  // 重载在途时同步现读：绝不能出现「like 有值而 collect 掉回默认」这种中途态。
  const mid = store.windowQuotasFor('normal');
  assert.equal(mid.day.like, 11);
  assert.equal(mid.day.collect, 22);
  await reload;
  const after = store.windowQuotasFor('normal');
  assert.equal(after.day.like, 11);
  assert.equal(after.day.collect, 22);
});

// ── §5 归属重排与面板透传 ────────────────────────────────────────────────────

test('5.2 面板回显的限额数字与同一时刻生效的数字逐格相等（展示与生效同源）', async () => {
  const db = fakePg();
  const store = new QuotaConfigStore({ pool: db.pool });
  await store.init();
  await store.set('normal', 'like', { daily: 33, perMinute: 2, perHour: 9 }, 'panel');

  const panel = createQuotaConfigPanel({ store });
  const catalog = await panel.getCatalog();
  for (const tier of RISK_QUOTA_LEVELS) {
    // 生效值：RiskController 的 QuotaProvider 取值口（canDo 每次现读的那一个）。
    const effective = store.windowQuotasFor(tier);
    for (const action of RISK_ACTIONS) {
      const row = catalog.quotas.find((q) => q.tier === tier && q.action === action)!;
      assert.equal(row.daily, effective.day[action], `${tier}/${action} daily 必须逐格相等`);
      assert.equal(row.perMinute, effective.minute[action], `${tier}/${action} perMinute 必须逐格相等`);
      assert.equal(row.perHour, effective.hour[action], `${tier}/${action} perHour 必须逐格相等`);
    }
  }
});

// ── 审计修复回归（2026-07-22 defects #3 / #5 / #8）─────────────────────────────────────────

test('4.1 重载持续失败 → 副本「已知落后」MUST 转 stale 并停手（绝不因为比对成功就算新鲜）', withFreshnessCleanup(async () => {
  const db = fakePg();
  let now = 5_000_000;
  const alerts: Array<{ mirrorKey: string; severity: string; tier: string; reloadFailing: boolean }> = [];
  let reloadCalls = 0;
  const refresher = new ConfigMirrorRefresher({
    pool: db.pool,
    versionStore: new MirrorVersionStore({ pool: db.pool }),
    pollMs: 5000,
    enabled: true,
    executionTarget: 'dev',
    clock: () => now,
    logger: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    onStaleAlert: (a) => alerts.push({ mirrorKey: a.mirrorKey, severity: a.severity, tier: a.tier, reloadFailing: a.reloadFailing }),
    reloaders: {
      persona_config: async () => { reloadCalls += 1; throw new Error('reload boom'); },
    },
  });
  await refresher.start();
  assert.equal(mirrorStateOf('persona_config'), 'fresh', '基线：刚起来是新鲜的');

  // 版本表**读得动**（比对每轮都成功），但重载每次都炸 —— 我们明确知道副本落后了。
  for (let i = 0; i < 15; i += 1) {
    now += 5000;
    await writeWithMirrorBump(db.pool, new MirrorVersionStore({ pool: db.pool }), 'persona_config', async (q) =>
      q.query('INSERT INTO persona_config (account_id, persona, updated_by) VALUES ($1,$2,$3)', ['a', 'p', 'u']));
    await refresher.runOnce();
  }
  assert.ok(reloadCalls >= 10, '每轮都应重试重载（版本没被记成已装载）');
  assert.equal(
    mirrorStateOf('persona_config'),
    'stale',
    '「比对得动但装不进来」= 已知落后，MUST 判 stale —— 否则一个明知落后的闸门副本照常放行平台动作',
  );
  assert.equal(shouldHaltNewPlatformActions('unit-test'), true, '已知落后的闸门镜像 MUST 停手');
  assert.ok(alerts.some((a) => a.severity === 'stale' && a.reloadFailing), '告警必须说清是「已知落后」而非「读不到」');

  const persona = refresher.health().entries.find((e) => e.mirrorKey === 'persona_config')!;
  assert.equal(persona.state, 'stale', '健康投影 MUST 如实回 stale');
  assert.ok(persona.reloadFailingSince !== null, '投影须给出「从何时起已知落后」');
  assert.equal(persona.version, null, '副本从未成功装载过任何版本 → version 保持 null（绝不记成已装载）');
  refresher.stop();
}));

test('4.10 参数镜像：超过观测阈值 MUST 发具名告警并在投影上如实 stale，但 MUST NOT 停手', withFreshnessCleanup(async () => {
  const db = fakePg();
  let now = 6_000_000;
  const alerts: Array<{ mirrorKey: string; severity: string; tier: string }> = [];
  const refresher = new ConfigMirrorRefresher({
    pool: db.pool,
    versionStore: new MirrorVersionStore({ pool: db.pool }),
    pollMs: 5000,
    enabled: true,
    executionTarget: 'dev',
    clock: () => now,
    logger: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    onStaleAlert: (a) => alerts.push({ mirrorKey: a.mirrorKey, severity: a.severity, tier: a.tier }),
  });
  await refresher.start();
  db.setVersionReadFails(true);
  // 观测阈值 5 分钟：跑够 6 分钟。
  for (let i = 0; i < 80; i += 1) {
    now += 5000;
    await refresher.runOnce();
  }
  assert.equal(mirrorStateOf('model_config'), 'fresh', '参数镜像 MUST NOT 停手——取值口恒 fresh');
  assert.ok(
    alerts.some((a) => a.mirrorKey === 'model_config' && a.tier === 'parameter' && a.severity === 'stale'),
    '参数镜像陈旧 MUST 发具名告警（「继续用最后已知良值」不等于「无需知道」）',
  );
  const model = refresher.health().entries.find((e) => e.mirrorKey === 'model_config')!;
  assert.equal(model.state, 'stale', '健康投影 MUST 如实回 stale');
  assert.equal(model.haltsOnStale, false, '但投影 MUST 同时说清它不停手');
  assert.equal(model.staleMs, null, '停手阈值仍为 null');
  refresher.stop();
}));

test('6.2 拒绝记账按时间窗聚合：热路径连打千次也只落有限几条写，且一次都不少计', withFreshnessCleanup(async () => {
  const db = fakePg();
  let now = 7_000_000;
  const refresher = new ConfigMirrorRefresher({
    pool: db.pool,
    versionStore: new MirrorVersionStore({ pool: db.pool }),
    pollMs: 5000,
    enabled: true,
    executionTarget: 'dev',
    clock: () => now,
    logger: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  await refresher.start();
  db.refusals.length = 0;

  // 一次故障期间，出口闸 / 配额层 / note.arrived 会把它打成千次量级。
  for (let i = 0; i < 1000; i += 1) refresher.noteStaleRefusal('persona_config', `ctx-${i}`);
  assert.ok(db.refusals.length <= 2, `热路径 MUST NOT 每次调用一条 PG 写（实际 ${db.refusals.length} 条）`);

  now += 60_000; // 跨过聚合窗口
  refresher.stop(); // 停机 flush 把尾巴写掉
  const total = db.refusals
    .filter((r) => r.mirrorKey === 'persona_config')
    .reduce((sum, r) => sum + r.count, 0);
  assert.equal(total, 1000, '聚合 MUST NOT 少计——每一次拒绝都要落进累加值');
  assert.ok(db.refusals.every((r) => r.target === 'dev'), '记账须带 executionTarget');
}));

// ── change block3-l3-config-mirror-bump-decouple：跨库事务拆解后的四条不变量 ────────────────

test('B1 属主闸：非 api 属主的 mirrorKey MUST NOT 在写事务里直接推 api 版本表（穷举全表）', async () => {
  const db = fakePg();
  const versionStore = new MirrorVersionStore({ pool: db.pool, notifyEnabled: false });
  for (const key of CONFIG_MIRROR_KEYS) {
    const owner = CONFIG_MIRRORS[key].owner;
    if (owner === 'api') {
      await versionStore.bumpInTx(db.pool, key); // 同库同事务，照常
      assert.equal(db.versions.get(key), 1, `${key} 属 api，同事务推进应当成功`);
      await assert.rejects(
        () => versionStore.applyRelayedBumpInTx(db.pool, key),
        /MUST 走同事务的 bumpInTx/,
        `${key} 属 api，绕一圈中继说明接线错了`,
      );
      continue;
    }
    // 这条断言就是「门禁天然失明」的补位：SQL 扫描看不见方法调用，运行时断言看得见。
    await assert.rejects(
      () => versionStore.bumpInTx(db.pool, key),
      /跨库两阶段提交/,
      `${key} 属 ${owner}，MUST NOT 在自己的写事务里推 api 的版本表`,
    );
    assert.equal(db.versions.get(key), undefined, '被拒的 key 绝不能留下半笔写入');
  }
});

test('B2 入队闸：api 属主的 mirrorKey MUST NOT 绕道 automation 的 outbox', async () => {
  const db = fakePg();
  const { bumper } = wireAutomationBumpChannel(db);
  await assert.rejects(
    () => bumper.bumpInTx(db.pool, 'persona_config'),
    /MUST NOT 走本域 outbox 中继/,
  );
  assert.equal(db.outbox.length, 0, '被拒的 key 绝不能留下 outbox 行');
});

test('B3 幂等：同一条失效信号投递两次只推一次版本（inbox 去重）', async () => {
  const db = fakePg();
  const { sink } = wireAutomationBumpChannel(db);
  const first = await sink.applyBump({ mirrorKey: 'quota_config', dedupKey: 'event_outbox:dev:1' });
  const second = await sink.applyBump({ mirrorKey: 'quota_config', dedupKey: 'event_outbox:dev:1' });
  assert.deepEqual(first, { applied: true });
  assert.deepEqual(second, { applied: false }, '重放 MUST 是 no-op，MUST NOT 报错');
  assert.equal(db.versions.get('quota_config'), 1, '版本只推进一次');
});

test('B4 丢投兜底：投递失败 MUST 保留信号与游标、恢复后补投，绝不静默丢弃', async () => {
  const db = fakePg();
  const versionStore = new MirrorVersionStore({ pool: db.pool, notifyEnabled: false });
  const realSink = new PgConfigMirrorBumpSink({ pool: db.pool, versionStore });
  let down = true;
  const flakySink: ConfigMirrorBumpSink = {
    applyBump: (req) => (down ? Promise.reject(new Error('api 不可达')) : realSink.applyBump(req)),
  };
  const { relay, bumper } = wireAutomationBumpChannel(db, { sink: flakySink });
  const store = new QuotaConfigStore({ pool: db.pool, mirrorVersionBumper: bumper });
  await store.init();

  await store.set('normal', 'like', { daily: 5 }, 'tester');
  assert.equal(await relay.runOnce(), 0, '投递失败 → 本轮零条推进');
  assert.equal(db.versions.get('quota_config'), undefined, '版本不进');
  assert.deepEqual([...db.cursors.values()], [], '遗留聚合游标 MUST NOT 越过投递失败的那条');
  assert.deepEqual([...db.topicCursors.values()], [], '主题游标 MUST NOT 越过投递失败的那条');
  assert.equal(db.outbox.length, 1, '信号仍在 outbox 里等补投');

  down = false;
  assert.equal(await relay.runOnce(), 1, '通道恢复后自动补投');
  assert.equal(db.versions.get('quota_config'), 1, '补投后版本才推进');

  // 通道彻底不可用（automation 模式未配 api 地址）同样是「堆积 + 抛错」，绝不是静默成功。
  const dead = new UnavailableConfigMirrorBumpSink('未配 AIDCP_API_URL');
  await assert.rejects(
    () => dead.applyBump({ mirrorKey: 'quota_config', dedupKey: 'x' }),
    /config_mirror_bump_sink_unavailable/,
  );
});
