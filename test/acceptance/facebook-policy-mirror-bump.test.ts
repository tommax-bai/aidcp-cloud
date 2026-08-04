/**
 * AC-FOPMIRROR-01 改 Facebook 运营策略的每一笔事务，MUST 在同事务里推镜像版本。
 *
 * **这不是「配置晚点生效」那一档的问题**（2026-08-04 dev 实测代价）：
 * 同步读 `facebook_operation_policy` 流的游标只看这一个镜像版本，载荷却是从
 * `facebook_operation_policy` 与 `facebook_primary_browse_surface_policy` 两张表算出来的。
 * 少推一次版本 ⇒ 同一个游标发出两种载荷摘要 ⇒ 消费方按设计整条拒收，
 * 而游标不会自己再动，于是拒收是**永久**的；启动期那次 apply 又是 fail-closed 的，
 * 结果是「某个客户端建了个新 Facebook 环境」→「半小时后单体重启起不来」，
 * 中间没有任何一条日志把这两件事连起来。
 *
 * 判据按**事务**而不是按文件：写语句与 `COMMIT` 之间必须出现一次推版本。
 * 按文件判会被「同一个文件里另有一处推了版本」蒙混过去。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 载荷读这两张表 ⇒ 写这两张表就必须推版本。 */
const PAYLOAD_TABLES = [
  'facebook_operation_policy',
  'facebook_primary_browse_surface_policy',
] as const;

const WRITERS = [
  'src/client-auth/client-user-store.ts',
  'src/config/facebook-operation-policy-store.ts',
] as const;

const BUMP = /bumpInTx\(\s*client,\s*'facebook_operation_policy'\s*\)/;

/** 写语句（排除 `_audit` 后缀那些流水表：它们不进载荷）。 */
function writeStatements(source: string): { index: number; table: string }[] {
  const found: { index: number; table: string }[] = [];
  for (const table of PAYLOAD_TABLES) {
    const re = new RegExp(`(?:INSERT\\s+INTO|UPDATE)\\s+${table}(?![_a-z])`, 'g');
    for (const match of source.matchAll(re)) {
      found.push({ index: match.index ?? 0, table });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

test('AC-FOPMIRROR-01 写 Facebook 运营策略的事务里必须推镜像版本', () => {
  const offenders: string[] = [];
  for (const file of WRITERS) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const statement of writeStatements(source)) {
      const commit = source.indexOf("client.query('COMMIT')", statement.index);
      // 没有 COMMIT 说明这一段不是自己开事务的（由调用方包），此时看到文件尾为止。
      const end = commit === -1 ? source.length : commit;
      const window = source.slice(statement.index, end);
      if (!BUMP.test(window)) {
        const line = source.slice(0, statement.index).split('\n').length;
        offenders.push(`${file}:${line} 写 ${statement.table} 后到 COMMIT 之间没有推版本`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下写口会让同步读那条流永久卡死：\n${offenders.join('\n')}`,
  );
});
