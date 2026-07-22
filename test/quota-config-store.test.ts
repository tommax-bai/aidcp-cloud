import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { QuotaConfigStore, QUOTA_CONFIG_SCHEMA_SQL } from '../src/config/quota-config-store.js';
import { COOLDOWN_ACTIONS } from '../src/risk/action-cooldown.js';
import { HOUR_BURST_CAP, MINUTE_BURST_CAP, deriveWindowQuotas } from '../src/risk/quotas.js';
import { RISK_QUOTA_LEVELS } from '../src/risk/types.js';
import { fakeSchemaProbe } from './fixtures/schema-probe.js';

/** 假 pool 的 schema 探测应答：存储 init() 现在只探测、不建表（change cloud-schema-migration-executor 第 5 节）。 */
const schemaProbe = fakeSchemaProbe(QUOTA_CONFIG_SCHEMA_SQL);

/** 内存假 pool：路由 quota_config 的建表 / SELECT / upsert(RETURNING)；可注入写失败 + 脏行。 */
function fakePool(seed: Array<{ tier: string; action: string; daily: number; per_minute: number; per_hour: number }> = []) {
  const rows = new Map<string, { tier: string; action: string; daily: number; per_minute: number; per_hour: number; updated_at: string; updated_by: string }>();
  for (const s of seed) rows.set(`${s.tier} ${s.action}`, { ...s, updated_at: '2026-06-24T00:00:00.000Z', updated_by: 'seed' });
  let failWrite = false;
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const __probe = schemaProbe(sql);
      if (__probe) return __probe;
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('INSERT INTO quota_config')) {
        if (failWrite) throw new Error('db down');
        const [tier, action, daily, per_minute, per_hour, updated_by] = params as [string, string, number, number, number, string];
        const row = { tier, action, daily, per_minute, per_hour, updated_at: '2026-06-24T01:00:00.000Z', updated_by };
        rows.set(`${tier} ${action}`, row);
        return { rows: [row] };
      }
      if (sql.includes('FROM quota_config')) return { rows: [...rows.values()] };
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as pg.Pool, setFailWrite: (v: boolean) => { failWrite = v; } };
}

test('零回归：表为空 → windowQuotasFor 与 deriveWindowQuotas 逐位一致（全档位）', async () => {
  const { pool } = fakePool();
  const store = new QuotaConfigStore({ pool });
  await store.init();
  for (const level of RISK_QUOTA_LEVELS) {
    assert.deepEqual(store.windowQuotasFor(level), deriveWindowQuotas(level), `档位 ${level} 应逐位一致`);
  }
});

test('命中库值 → 该 (tier,action) 三窗口用库值；其余动作仍回落派生默认', async () => {
  // per_minute 取 cap 内的值（4 = MINUTE_BURST_CAP.like），专测「库值优先」本身；夹 cap 另有专测。
  const { pool } = fakePool([{ tier: 'normal', action: 'like', daily: 999, per_minute: 4, per_hour: 88 }]);
  const store = new QuotaConfigStore({ pool });
  await store.init();
  const w = store.windowQuotasFor('normal');
  assert.equal(w.day.like, 999);
  assert.equal(w.minute.like, 4);
  assert.equal(w.hour.like, 88);
  // 未覆盖的 collect 仍是派生默认
  assert.equal(w.day.collect, deriveWindowQuotas('normal').day.collect);
});

// change cooldown-as-backstop-not-quota §8：把「兜底(动作冷却)必须比主闸松」从文档纪律变成算术。
// 派生路径本就夹 MINUTE_BURST_CAP（quotas.ts），覆盖路径此前不夹 ⇒ 面板填大值可让冷却反超主闸、
// 「配额旋钮被焊死」的病无声复发。夹在 windowQuotasFor 单点 ⇒ canDo 与面板 catalog 同口径。
test('perMinute 覆盖超 MINUTE_BURST_CAP → 夹到 cap（兜底不变量变成算术）', async () => {
  const { pool } = fakePool([
    { tier: 'normal', action: 'like', daily: 50, per_minute: 6, per_hour: 20 }, // cap 4
    { tier: 'normal', action: 'follow', daily: 15, per_minute: 5, per_hour: 8 }, // cap 1
  ]);
  const store = new QuotaConfigStore({ pool });
  await store.init();
  const w = store.windowQuotasFor('normal');
  assert.equal(w.minute.like, MINUTE_BURST_CAP.like, 'like perMinute=6 应被夹到 cap 4');
  assert.equal(w.minute.follow, MINUTE_BURST_CAP.follow, 'follow perMinute=5 应被夹到 cap 1');
  // 夹只作用于 minute：同一行的 day / hour 原样用库值
  assert.equal(w.day.like, 50);
  assert.equal(w.hour.like, 20);
});

test('perMinute 覆盖在 cap 内 → 原样生效（夹只降不升，绝不替运营改小/改大）', async () => {
  const { pool } = fakePool([{ tier: 'normal', action: 'like', daily: 50, per_minute: 3, per_hour: 20 }]);
  const store = new QuotaConfigStore({ pool });
  await store.init();
  const w = store.windowQuotasFor('normal');
  assert.ok(3 < MINUTE_BURST_CAP.like, '前提：3 应在 like 的分钟 cap(4) 内');
  assert.equal(w.minute.like, 3);
});

// 🔴 红线二回归：夹只作用于受冷却约束的动作。
// dm_reply 的 MINUTE_BURST_CAP 是 0——那是「旧浏览曲线没有 dm_reply 语义」的占位、不是真爆发上限。
// 若把夹broaden到 RISK_ACTIONS 全集，运营在面板显式配的额度会被永久压成 0（配额 0 ⇒ canDo 恒拒），
// 且会从上游架空 risk-controller 专为 dm_reply 开的慢启动 clamp 豁免（「不能把运营明确配置的非零额度再次夹成 0」）
// ⇒ 视频号入站回复静默停摆，正是本 change 要根除的「旋钮被焊死」病、只是换了个动作。
test('红线：dm_reply 的 perMinute 覆盖绝不被夹（cap=0 是占位，不是上限）', async () => {
  const { pool } = fakePool([{ tier: 'normal', action: 'dm_reply', daily: 200, per_minute: 5, per_hour: 60 }]);
  const store = new QuotaConfigStore({ pool });
  await store.init();
  const w = store.windowQuotasFor('normal');
  assert.equal(MINUTE_BURST_CAP.dm_reply, 0, '前提：dm_reply 的分钟 cap 确为 0（占位），否则此测试不成立');
  assert.equal(w.minute.dm_reply, 5, '运营显式配置的 dm_reply 分钟额度 MUST 原样生效，MUST NOT 被夹成 0');
  assert.equal(w.day.dm_reply, 200);
  assert.equal(w.hour.dm_reply, 60);
});

test('夹的作用域＝COOLDOWN_ACTIONS：非冷却动作的 perMinute 超 cap 也原样生效', async () => {
  const { pool } = fakePool([
    { tier: 'normal', action: 'view', daily: 300, per_minute: 20, per_hour: 80 }, // cap 8，但 view 无冷却
    { tier: 'normal', action: 'join_group', daily: 20, per_minute: 4, per_hour: 3 }, // cap 1，但 join_group 无冷却
  ]);
  const store = new QuotaConfigStore({ pool });
  await store.init();
  const w = store.windowQuotasFor('normal');
  assert.ok(!COOLDOWN_ACTIONS.includes('view' as never), '前提：view 不受冷却约束');
  assert.equal(w.minute.view, 20, 'view 无冷却 ⇒ 无不变量可守 ⇒ MUST NOT 夹');
  assert.equal(w.minute.join_group, 4, 'join_group 无冷却 ⇒ MUST NOT 夹');
});

// 🔴 红线回归：只夹 perMinute。dev 库的浏览行 per_hour=80 > HOUR_BURST_CAP.view=60 **正在生效**，
// 夹 hour 会当场把浏览量从 80 砍到 60；daily 同理。这是本 change 最容易被「对称性」诱发的回归。
test('红线：perHour / daily 覆盖绝不被夹（即使超各自 BURST_CAP）', async () => {
  const { pool } = fakePool([{ tier: 'normal', action: 'view', daily: 300, per_minute: 4, per_hour: 80 }]);
  const store = new QuotaConfigStore({ pool });
  await store.init();
  const w = store.windowQuotasFor('normal');
  assert.ok(80 > HOUR_BURST_CAP.view, '前提：80 应确实超过 view 的小时 cap(60)，否则此测试不成立');
  assert.equal(w.hour.view, 80, 'perHour 超 cap 也 MUST 原样生效（浏览行 80 正在生效）');
  assert.equal(w.day.view, 300, 'daily 超派生默认也 MUST 原样生效');
});

test('脏行（非法 tier/action 或负值）→ 忽略，回落派生默认（绝不 brick）', async () => {
  const { pool } = fakePool([
    { tier: 'bogus_tier', action: 'like', daily: 5, per_minute: 5, per_hour: 5 },
    { tier: 'normal', action: 'like', daily: -3, per_minute: 4, per_hour: 10 },
  ]);
  const store = new QuotaConfigStore({ pool });
  await store.init();
  const w = store.windowQuotasFor('normal');
  // 负 daily 非法 → 回落派生默认；per_minute/per_hour 合法 → 用库值
  assert.equal(w.day.like, deriveWindowQuotas('normal').day.like);
  assert.equal(w.minute.like, 4);
  assert.equal(w.hour.like, 10);
});

test('set 后 windowQuotasFor 即时热加载（无需重启）+ 回真态含审计', async () => {
  const { pool } = fakePool();
  const store = new QuotaConfigStore({ pool });
  await store.init();
  const row = await store.set('aggressive', 'follow', { daily: 40, perMinute: 1, perHour: 12 }, 'alice');
  assert.equal(row.updatedBy, 'alice');
  const w = store.windowQuotasFor('aggressive');
  assert.equal(w.day.follow, 40);
  assert.equal(w.minute.follow, 1);
  assert.equal(w.hour.follow, 12);
});

// 写路径不夹（库里原样留运营填的值），只在取值口夹 ⇒ 回滚只需去掉那一行夹、已落库的行从不被改写。
test('夹发生在取值口而非写路径：库内原样留覆盖值，生效值被夹', async () => {
  const { pool } = fakePool();
  const store = new QuotaConfigStore({ pool });
  await store.init();
  const row = await store.set('normal', 'like', { perMinute: 9 }, 'alice');
  assert.equal(row.perMinute, 9, '写回真态＝库里存的原值（不替运营改写）');
  assert.equal(store.getRow('normal', 'like')?.perMinute, 9);
  assert.equal(store.windowQuotasFor('normal').minute.like, MINUTE_BURST_CAP.like, '生效值被夹到 cap');
});

test('部分窗口写：未传窗口保持原值（有原值）或回落派生默认（无原值）', async () => {
  const { pool } = fakePool([{ tier: 'normal', action: 'like', daily: 50, per_minute: 4, per_hour: 20 }]);
  const store = new QuotaConfigStore({ pool });
  await store.init();
  await store.set('normal', 'like', { daily: 60 }, 'a'); // 只改 daily
  const w = store.windowQuotasFor('normal');
  assert.equal(w.day.like, 60);
  assert.equal(w.minute.like, 4); // 保持原值
  assert.equal(w.hour.like, 20);
});

test('写库失败 → 内存镜像不变（绝不镜像/库不一致）', async () => {
  const { pool, setFailWrite } = fakePool([{ tier: 'normal', action: 'like', daily: 50, per_minute: 4, per_hour: 20 }]);
  const store = new QuotaConfigStore({ pool });
  await store.init();
  setFailWrite(true);
  await assert.rejects(store.set('normal', 'like', { daily: 999 }, 'a'));
  assert.equal(store.windowQuotasFor('normal').day.like, 50);
});
