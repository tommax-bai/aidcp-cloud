import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { resolveChatIdForAccount } from '../src/feishu/chat-target.js';
import { GroupRouteStore } from '../src/cache/group-route-store.js';
import { CommandRouter, type CommandActions } from '../src/feishu/commands.js';

/**
 * change feishu-per-team-notification-routing：
 * - resolveChatIdForAccount 的账号→团队群路由 + 诚实兜底（红线：未绑定/读异常绝不静默丢，落默认群）；
 * - GroupRouteStore 输入校验 + 清除语义（红线：单写者、空键拒、空 chat_id = 清除）；
 * - CommandRouter 作用域闸（红线：非管理群拒账号命令、help 放行、未注入=零回归放行）。
 */

// ── resolveChatIdForAccount ─────────────────────────────────────────────
type Warns = string[];
function deps(opts: {
  groupLabel?: string | null;
  groupLabelThrows?: boolean;
  route?: string | null;
  routeThrows?: boolean;
  fallbackChatId?: string;
}) {
  const warns: Warns = [];
  const d = {
    accountStore: {
      getGroupLabel: async (_id: string) => {
        if (opts.groupLabelThrows) throw new Error('pg down');
        return opts.groupLabel ?? null;
      },
    },
    groupRouteStore: {
      getRoute: async (_k: string) => {
        if (opts.routeThrows) throw new Error('pg down');
        return opts.route ?? null;
      },
    },
    botChatStore: { getDefaultChat: async () => null }, // 默认群链回落 fallbackChatId
    fallbackChatId: opts.fallbackChatId ?? 'oc_default',
    logger: { warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')) },
  };
  return { d, warns };
}

test('已绑定账号 → 路由到团队群', async () => {
  const { d } = deps({ groupLabel: 'teamA', route: 'oc_team_a' });
  assert.equal(await resolveChatIdForAccount('acc-1', d), 'oc_team_a');
});

test('未分组账号（无 group_label）→ 落默认群，绝不丢', async () => {
  const { d } = deps({ groupLabel: null });
  assert.equal(await resolveChatIdForAccount('acc-2', d), 'oc_default');
});

test('空表 / 无路由映射 → 落默认群（空表=今天行为）', async () => {
  const { d } = deps({ groupLabel: 'teamA', route: null });
  assert.equal(await resolveChatIdForAccount('acc-3', d), 'oc_default');
});

test('有非空 group_label 却未命中路由 → config-gap 日志 + 落默认群', async () => {
  const { d, warns } = deps({ groupLabel: 'TeamA ', route: null });
  assert.equal(await resolveChatIdForAccount('acc-3', d), 'oc_default');
  assert.ok(warns.some((w) => w.includes('config-gap') && w.includes('acc-3')), 'config-gap 未记录');
});

test('红线：getGroupLabel 抛异常 → 落默认群、绝不外抛（异常路径不静默作废）', async () => {
  const { d } = deps({ groupLabelThrows: true });
  assert.equal(await resolveChatIdForAccount('acc-4', d), 'oc_default');
});

test('红线：getRoute 抛异常 → 落默认群、绝不外抛', async () => {
  const { d } = deps({ groupLabel: 'teamA', routeThrows: true });
  assert.equal(await resolveChatIdForAccount('acc-5', d), 'oc_default');
});

test('无 accountId（无归属告警）→ 直接默认群', async () => {
  const { d } = deps({ groupLabel: 'teamA', route: 'oc_team_a' });
  assert.equal(await resolveChatIdForAccount(undefined, d), 'oc_default');
});

// change feishu-route-account-cards-by-team：账号业务结果卡也经此解析器投递，
// 故「依赖缺失」的降级面必须钉死——启动时路由 / 账号存储 init 失败留 undefined，绝不能崩投递闭包、绝不静默丢卡。
test('红线：groupRouteStore 未注入（启动 init 失败）→ 全体账号落默认群，等价空表', async () => {
  const warns: string[] = [];
  const chatId = await resolveChatIdForAccount('acc-6', {
    accountStore: { getGroupLabel: async () => 'teamA' },
    groupRouteStore: undefined,
    botChatStore: { getDefaultChat: async () => null },
    fallbackChatId: 'oc_default',
    logger: { warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')) },
  });
  assert.equal(chatId, 'oc_default');
  assert.ok(warns.some((w) => w.includes('config-gap')), '缺路由存储时仍应留 config-gap 线索');
});

test('红线：accountStore 未注入 → 落默认群，绝不抛入投递闭包', async () => {
  const chatId = await resolveChatIdForAccount('acc-7', {
    accountStore: undefined,
    groupRouteStore: { getRoute: async () => 'oc_team_a' },
    botChatStore: { getDefaultChat: async () => null },
    fallbackChatId: 'oc_default',
    logger: console,
  });
  assert.equal(chatId, 'oc_default');
});

// ── GroupRouteStore（注入桩池，无需真实 PG）─────────────────────────────
interface Rec { sql: string; params: unknown[] }
function fakePool(opts: { returning?: Record<string, unknown>[]; getRows?: Record<string, unknown>[]; getError?: { code: string } } = {}) {
  const calls: Rec[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes('SELECT chat_id FROM group_route')) {
        if (opts.getError) throw opts.getError;
        return { rows: opts.getRows ?? [], rowCount: (opts.getRows ?? []).length };
      }
      if (sql.includes('INSERT INTO group_route')) return { rows: opts.returning ?? [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

test('setRoute：空 group_label → invalid_key（绝不落空键脏行）', async () => {
  const { pool, calls } = fakePool();
  const r = await new GroupRouteStore({ pool }).setRoute('   ', 'oc_x', 'u');
  assert.deepEqual(r, { ok: false, reason: 'invalid_key' });
  assert.equal(calls.length, 0, '无效键不应打库');
});

test('setRoute：空 chat_id → 清除该路由（DELETE），返回 route=null', async () => {
  const { pool, calls } = fakePool();
  const r = await new GroupRouteStore({ pool }).setRoute('teamA', '', 'u');
  assert.deepEqual(r, { ok: true, route: null });
  assert.ok(calls.some((c) => c.sql.includes('DELETE FROM group_route')), '应走 DELETE 清除');
});

test('setRoute：正常 upsert → 回读 RETURNING 真值', async () => {
  const { pool } = fakePool({ returning: [{ group_label: 'teamA', chat_id: 'oc_x', updated_by: 'u', updated_at: new Date(0) }] });
  const r = await new GroupRouteStore({ pool }).setRoute('teamA', 'oc_x', 'u');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.route?.chatId, 'oc_x');
});

test('getRoute：命中返回 chat_id；缺表(42P01) → null（首启竞态安全）', async () => {
  const hit = fakePool({ getRows: [{ chat_id: 'oc_x' }] });
  assert.equal(await new GroupRouteStore({ pool: hit.pool }).getRoute('teamA'), 'oc_x');
  const missing = fakePool({ getError: { code: '42P01' } });
  assert.equal(await new GroupRouteStore({ pool: missing.pool }).getRoute('teamA'), null);
});

// ── CommandRouter 作用域闸 ──────────────────────────────────────────────
function stubActions(): { actions: CommandActions; calls: string[] } {
  const calls: string[] = [];
  const actions: CommandActions = {
    status: (id) => { calls.push(`status:${id}`); return 'ok'; },
    pause: (id) => { calls.push(`pause:${id}`); },
    resume: (id) => { calls.push(`resume:${id}`); },
  };
  return { actions, calls };
}

test('作用域闸：非管理群下账号命令 → 诚实拒、不执行', async () => {
  const { actions, calls } = stubActions();
  const router = new CommandRouter(actions, undefined, undefined, (chatId) => chatId === 'oc_admin');
  const r = await router.handle('/status acc-1', { chatId: 'oc_external' });
  assert.equal(r.ok, false);
  assert.match(r.title, /本群无权/);
  assert.equal(calls.length, 0, '非管理群绝不执行账号命令');
});

test('作用域闸：管理群下命令 → 正常执行', async () => {
  const { actions, calls } = stubActions();
  const router = new CommandRouter(actions, undefined, undefined, (chatId) => chatId === 'oc_admin');
  const r = await router.handle('/status acc-1', { chatId: 'oc_admin' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['status:acc-1']);
});

test('作用域闸：help 在任何群放行（不被拦）', async () => {
  const { actions } = stubActions();
  const router = new CommandRouter(actions, undefined, undefined, () => false);
  const r = await router.handle('你好', { chatId: 'oc_external' });
  assert.match(r.title, /需要帮助/);
});

test('作用域闸：未注入（旧装配 / 测试）→ 放行全部（零回归）', async () => {
  const { actions, calls } = stubActions();
  const router = new CommandRouter(actions);
  const r = await router.handle('/status acc-1', { chatId: 'oc_whatever' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['status:acc-1']);
});
