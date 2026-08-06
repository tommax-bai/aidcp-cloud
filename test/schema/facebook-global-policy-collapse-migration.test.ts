/**
 * 收缩迁移 `0114` 的 SQL 合同测试（change collapse-facebook-global-policy-target-column，任务 4.1–4.4）。
 * 零数据库依赖：这里守的是**文件本身不许退化**；行为层面的证据（真库上试插第二行被拒）
 * 由部署后的验收项给出，两者 MUST 都做，MUST NOT 用其中一个冒充另一个。
 */

import { readFile, readdir } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const migrationUrl = new URL(
  '../../migrations/0114_facebook_global_policy_collapse_target.sql',
  import.meta.url,
);
const migrationsDir = new URL('../../migrations/', import.meta.url);

const read = () => readFile(migrationUrl, 'utf8');

/** 只保留 SQL 语句本体：本迁移注释密度高，不剥注释会把「注释里提到审计表」判成 DDL。 */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('facebook global policy collapse migration', () => {
  it('两张策略表用单例约束替代分行键：第二行在库层面插不进去', async () => {
    const sql = stripComments(await read());
    for (const table of ['facebook_operation_global_policy', 'facebook_group_comment_policy']) {
      assert.match(
        sql,
        new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN IF NOT EXISTS singleton boolean NOT NULL DEFAULT true;`),
        `${table} 必须先有单例列`,
      );
      assert.match(
        sql,
        new RegExp(`ALTER TABLE ${table}\\s+ADD PRIMARY KEY \\(singleton\\);`),
        `${table} 删列之后会没有主键；MUST NOT 就这么放着——没有唯一性约束的配置表，` +
          '第二行插进去不报错，而读路径拿到的是「某一行」',
      );
      assert.match(
        sql,
        new RegExp(`ADD CONSTRAINT ${table}_singleton_check CHECK \\(singleton\\);`),
        `${table} 的取值集合必须只有一个元素，否则单例主键拦不住第二行`,
      );
      assert.match(
        sql,
        new RegExp(`ALTER TABLE ${table}\\s+DROP COLUMN execution_target;`),
        `${table} 必须真的删掉分行维度——只留一个合法值等于把它改名留下`,
      );
    }
  });

  it('约束名都在 63 字节以内（0110 曾因自动名 65 字节被截断、DROP 不命中且不报错）', async () => {
    const sql = stripComments(await read());
    const names = [...sql.matchAll(/ADD CONSTRAINT ([a-z0-9_]+)/g)].map((m) => m[1]);
    assert.ok(names.length >= 2, '至少两条具名约束');
    for (const name of names) {
      assert.ok(
        Buffer.byteLength(name, 'utf8') <= 63,
        `约束名 ${name} 有 ${Buffer.byteLength(name, 'utf8')} 字节，超过 PG 标识符上限会被静默截断`,
      );
    }
  });

  it('完成事实表主键收敛到 (env_key)，且删旧行排在改主键之前', async () => {
    const sql = stripComments(await read());
    assert.match(
      sql,
      /ALTER TABLE facebook_environment_slow_start_completion\s+ADD PRIMARY KEY \(env_key\);/,
    );
    const deleteAt = sql.indexOf('DELETE FROM facebook_environment_slow_start_completion');
    const pkAt = sql.indexOf('ADD PRIMARY KEY (env_key)');
    assert.ok(deleteAt > 0 && pkAt > 0);
    assert.ok(
      deleteAt < pkAt,
      '同一 env_key 在 dev 与 ol 各有一行时 (env_key) 这个主键还不成立，顺序不可颠倒',
    );
  });

  it('三条数据前置逐条断言，且删行排在断言之后（MUST NOT 只删通过检查的那部分）', async () => {
    const sql = stripComments(await read());
    const guard = sql.indexOf('$$');
    const firstDelete = sql.indexOf('DELETE FROM');
    assert.ok(guard > 0 && firstDelete > guard, '前置断言必须整体排在任何删除之前');

    // 每条前置都必须是**会让整条迁移失败**的断言，而不是打印一行了事。
    const raises = [...sql.matchAll(/RAISE EXCEPTION/g)];
    assert.ok(raises.length >= 4, `期望至少 4 条 RAISE EXCEPTION（三条 design 前置 + 策略表孤儿旧行），实得 ${raises.length}`);

    assert.match(sql, /EXCEPT[\s\S]*?execution_target = 'all'/, '前置①：合并行未覆盖的 env_key');
    assert.match(sql, /GROUP BY env_key HAVING count\(\*\) > 1/, '前置②：合并行内 env_key 重复');
    assert.match(sql, /a\.completed_at > o\.completed_at/, '前置③：合并完成时刻晚于旧行');
  });

  it('审计表零改动：迁移里不得出现任何针对两张 *_audit 的 DDL', async () => {
    const sql = stripComments(await read());
    for (const audit of [
      'facebook_operation_global_policy_audit',
      'facebook_group_comment_policy_audit',
    ]) {
      assert.doesNotMatch(
        sql,
        new RegExp(`(ALTER TABLE|DROP TABLE|CREATE INDEX|DROP INDEX)[^;]*${audit}`),
        `${audit} 上的 execution_target / CHECK / UNIQUE 全部保留：` +
          '合并之前各目标的 revision 是各自独立的序列，历史行跨目标重复，收紧唯一性会在现有数据上直接失败；' +
          '而主表旧行删掉之后，这个字段是「合并之前各目标各是什么」唯一的留存处',
      );
    }
  });

  it('被删掉的、更早声明过的对象都写进了 aidcp:retires（否则 verify 永远挂着假缺失）', async () => {
    const sql = await read();
    const retired = new Set(
      [...sql.matchAll(/^--\s*aidcp:retires=(.+)$/gm)]
        .flatMap((m) => m[1].split(','))
        .map((t) => t.trim())
        .filter(Boolean),
    );
    assert.deepEqual(
      [...retired].sort(),
      [
        'constraint:facebook_env_slow_start_completion_scope_check',
        'constraint:facebook_group_comment_policy_execution_target_check',
        'constraint:facebook_operation_global_policy_execution_target_check',
        'index:idx_facebook_environment_slow_start_completion_target',
      ],
      '这四个对象由 0103 / 0110 声明过、被本条删掉；漏登记不会报错，' +
        '只会让 migrate verify 从此报缺失，而缺失清单是 baseline 唯一的准入闸',
    );
  });

  it('每条 aidcp:retires MUST 命中一条更早的真实声明（写错名字不会报错，只会白减一个）', async () => {
    const names = (await readdir(new URL('.', migrationsDir))).filter((n) => n.endsWith('.sql'));
    const declared = new Set<string>();
    const retires: { token: string; version: string }[] = [];
    for (const name of names.sort()) {
      const content = await readFile(new URL(name, migrationsDir), 'utf8');
      for (const line of content.matchAll(/^--\s*aidcp:objects=(.+)$/gm)) {
        for (const token of line[1].split(',')) if (token.trim()) declared.add(token.trim());
      }
      for (const line of content.matchAll(/^--\s*aidcp:retires=(.+)$/gm)) {
        for (const token of line[1].split(',')) {
          if (token.trim()) retires.push({ token: token.trim(), version: name });
        }
      }
    }
    const orphans = retires.filter((r) => !declared.has(r.token));
    assert.deepEqual(orphans, [], '写错一个名字，被删对象仍留在期望集里、verify 继续报它缺失');
  });
});
