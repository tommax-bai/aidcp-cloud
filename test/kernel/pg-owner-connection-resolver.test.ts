import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PG_CONFIG } from '../../src/kernel/pg-config.js';
import {
  PG_OWNERS,
  pgOwnerUrlEnvVar,
  resolveOwnerPgConfig,
  resolveAllOwnerPgConfigs,
} from '../../src/kernel/pg-owner-connection-resolver.js';

/** DEFAULT_PG_CONFIG 派生的共享单库形状（与 resolveEnvPgConfig() 对空 env 的结果逐字一致）。 */
const SHARED_DEFAULT = { ...DEFAULT_PG_CONFIG };

describe('pg-owner-connection-resolver（Block③ L2：owner → PoolConfig，未接线脚手架）', () => {
  it('默认（空 env）：三属主解析出彼此逐字相同、且等于 DEFAULT_PG_CONFIG 派生形状', () => {
    const all = resolveAllOwnerPgConfigs({});
    assert.deepEqual(all.content, SHARED_DEFAULT);
    assert.deepEqual(all.automation, SHARED_DEFAULT);
    assert.deepEqual(all.api, SHARED_DEFAULT);
    // 三者互等（同一单库，三个别名）
    assert.deepEqual(all.content, all.automation);
    assert.deepEqual(all.automation, all.api);
  });

  it('配了 AIDCP_PG_CONTENT_URL → content 走该 URL，automation/api 仍回落共享', () => {
    const env = { AIDCP_PG_CONTENT_URL: 'postgres://c/aidcp_content' };
    assert.deepEqual(resolveOwnerPgConfig('content', env), {
      connectionString: 'postgres://c/aidcp_content',
    });
    assert.deepEqual(resolveOwnerPgConfig('automation', env), SHARED_DEFAULT);
    assert.deepEqual(resolveOwnerPgConfig('api', env), SHARED_DEFAULT);
  });

  it('全空白 owner URL 视为未设 → 回落共享', () => {
    const env = { AIDCP_PG_CONTENT_URL: '   ' };
    assert.deepEqual(resolveOwnerPgConfig('content', env), SHARED_DEFAULT);
  });

  it('只配 DATABASE_URL（无 owner URL）→ 三属主全走该连接串', () => {
    const env = { DATABASE_URL: 'postgres://shared/aidcp' };
    const all = resolveAllOwnerPgConfigs(env);
    assert.deepEqual(all.content, { connectionString: 'postgres://shared/aidcp' });
    assert.deepEqual(all.automation, { connectionString: 'postgres://shared/aidcp' });
    assert.deepEqual(all.api, { connectionString: 'postgres://shared/aidcp' });
  });

  it('PGHOST/PGPORT/... 兜底（无 DATABASE_URL / owner URL）；非数字 PGPORT 回落默认端口', () => {
    const env = {
      PGHOST: 'db.example',
      PGPORT: '6543',
      PGDATABASE: 'mydb',
      PGUSER: 'me',
      PGPASSWORD: 'pw',
    };
    assert.deepEqual(resolveOwnerPgConfig('content', env), {
      host: 'db.example',
      port: 6543,
      database: 'mydb',
      user: 'me',
      password: 'pw',
    });
    // 非数字端口 → 回落 DEFAULT_PG_CONFIG.port，其余仍取 env
    const badPort = resolveOwnerPgConfig('content', { ...env, PGPORT: 'not-a-number' });
    assert.equal(badPort.port, DEFAULT_PG_CONFIG.port);
    assert.equal(badPort.host, 'db.example');
  });

  it('env 名与属主枚举稳定', () => {
    assert.equal(pgOwnerUrlEnvVar('content'), 'AIDCP_PG_CONTENT_URL');
    assert.equal(pgOwnerUrlEnvVar('automation'), 'AIDCP_PG_AUTOMATION_URL');
    assert.equal(pgOwnerUrlEnvVar('api'), 'AIDCP_PG_API_URL');
    assert.deepEqual([...PG_OWNERS], ['content', 'automation', 'api']);
  });
});
