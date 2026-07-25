/**
 * 真库集成测试连接守卫的用例（change dbsplit-test-gates 任务 A4）。
 *
 * 守的是一个真实且致命的形态：dev 与 ol 连同一台物理 PostgreSQL，那台就是生产库；
 * 而集成测试会 `TRUNCATE` 客户身份 / 环境归属 / 离场台账。故守卫的每一条**都要有喂危险输入的用例**——
 * 一条只在文档里存在的守卫等于不存在。
 *
 * 连接串一律用占位符（`user:password@`），本文件不出现任何真实口令。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PG_CONFIG } from '../../src/kernel/pg-config.js';
import {
  INTERACTION_URL_ENV,
  PG_CHANNEL_ENV,
  PgTestGuardError,
  REQUIRED_DATABASE_PREFIX,
  resolveIntegrationDatabase,
} from './pg-test-database-guard.js';

/** 干净的通道内环境：显式连接串 + 缺省连接都指向专用测试库。 */
const safeEnv = (url: string, extra: Record<string, string | undefined> = {}) => ({
  [PG_CHANNEL_ENV]: '1',
  [INTERACTION_URL_ENV]: url,
  DATABASE_URL: 'postgres://user:password@127.0.0.1:5432/aidcp_test_local',
  ...extra,
});

const refuses = (env: Record<string, string | undefined>, expect: RegExp): void => {
  assert.throws(() => resolveIntegrationDatabase(INTERACTION_URL_ENV, env), (error: unknown) => {
    assert.ok(error instanceof PgTestGuardError, `MUST 抛 PgTestGuardError，实际：${String(error)}`);
    assert.match(error.message, expect);
    return true;
  });
};

describe('真库集成测试连接守卫', () => {
  it('拒绝已知生产 host / 本机生产库 / 非 aidcp_test 前缀的库，且一律抛错而不是 skip', () => {
    refuses(safeEnv('postgres://user:password@121.89.85.150:5432/aidcp_test_x'), /生产 host 121\.89\.85\.150/);
    refuses(safeEnv('postgres://user:password@123.56.253.183:5432/aidcp_test_x'), /生产 host 123\.56\.253\.183/);
    // dev 机上的生产库正是走 127.0.0.1 的同名库，这条与「连生产」不可区分。
    refuses(safeEnv(`postgres://user:password@127.0.0.1:5432/${DEFAULT_PG_CONFIG.database}`), /本机的 .* 库/);
    refuses(safeEnv('postgres://user:password@localhost:5432/scratch'), /MUST 以 aidcp_test 开头/);
    refuses(safeEnv('postgres://user:password@127.0.0.1:5432/'), /没有写库名/);
    refuses(safeEnv('not-a-url'), /不是可解析的连接串/);
  });

  it('内置默认（DEFAULT_PG_CONFIG）本身就是危险目标，故缺省连接也必须过同一道守卫', () => {
    // 核实前提：kernel 的内置默认落在本机 `aidcp`，不带测试前缀。它变了这条断言就该红。
    assert.ok(
      !DEFAULT_PG_CONFIG.database.startsWith(REQUIRED_DATABASE_PREFIX),
      'kernel 内置默认库名一旦带上测试前缀，本守卫的「缺省连接」这一条就失去意义，MUST 重新审视',
    );
    // 通道内、显式连接串安全，但 DATABASE_URL/PG* 全缺省 ⇒ 未注入 pool 的 store 会兜底到本机生产库。
    refuses(
      { [PG_CHANNEL_ENV]: '1', [INTERACTION_URL_ENV]: 'postgres://user:password@127.0.0.1:5432/aidcp_test_local' },
      /缺省连接/,
    );
  });

  it('通道未开 = 不连库地 skip；通道开着却没给连接串 = 抛错（绝不静默跳过）', () => {
    const off = resolveIntegrationDatabase(INTERACTION_URL_ENV, { [INTERACTION_URL_ENV]: 'postgres://user:password@121.89.85.150:5432/aidcp' });
    assert.equal(off.enabled, false, '没有测试通道标志时 MUST NOT 连库——常规 npm test 因此绝不会碰真库');
    refuses({ [PG_CHANNEL_ENV]: '1' }, /却没有 AIDCP_INTERACTION_TEST_DATABASE_URL/);
  });

  it('三条守卫都过时放行，并原样交出连接串', () => {
    const url = 'postgres://user:password@127.0.0.1:5432/aidcp_test_local';
    const resolved = resolveIntegrationDatabase(INTERACTION_URL_ENV, safeEnv(url));
    assert.deepEqual(resolved, { enabled: true, connectionString: url });
  });
});
