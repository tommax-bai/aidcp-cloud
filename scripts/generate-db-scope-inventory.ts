/**
 * 库级作用域清单的生成器 / 对照器（change cloud-schema-migration-executor 任务 10.1）。
 *
 *   npx tsx scripts/generate-db-scope-inventory.ts            干跑：打印实测清单与逐条位置
 *   npx tsx scripts/generate-db-scope-inventory.ts --write     写 test/schema/database-scope-inventory.json
 *
 * 落盘的 JSON 是控制仓 `aidcp/docs/database-scope-inventory.md` 的**机器可读副本**。
 * 新增一处 advisory lock / 跨域外键 / 硬编码 schema 名而不更新清单，
 * 验收用例 AC-SCHEMA-DB-SCOPE 会当场失败并要求先去文档登记 —— 只写文档不加测试等于没做。
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { repoRoot } from '../src/schema/ddl-scan.js';
import { scanDbScope, toInventory } from '../src/schema/db-scope-scan.js';

export function inventoryPath(root = repoRoot()): string {
  return path.join(root, 'test', 'schema', 'database-scope-inventory.json');
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const report = await scanDbScope();

  console.log(`advisory lock 调用点：${report.advisoryLocks.length}`);
  for (const s of report.advisoryLocks) console.log(`  ${s.file}:${s.line}  ${s.fn}`);
  console.log(`源码里的外键：${report.foreignKeys.length}`);
  for (const s of report.foreignKeys) console.log(`  ${s.file}:${s.line}  → ${s.target}`);
  console.log(`硬编码 schema 名：${report.schemaLiterals.length}`);
  for (const s of report.schemaLiterals) console.log(`  ${s.file}:${s.line}  ${s.qualified}`);
  console.log('迁移目录里的外键目标：');
  for (const [table, n] of Object.entries(report.migrationForeignKeyTargets).sort()) {
    console.log(`  ${String(n).padStart(3)}  ${table}`);
  }

  if (!write) {
    console.log('（干跑；加 --write 落盘到 test/schema/database-scope-inventory.json）');
    return;
  }

  const payload = {
    _comment: [
      '库级作用域机制清单的机器可读副本（change cloud-schema-migration-executor 任务 10.1）。',
      '人读版本在控制仓 aidcp/docs/database-scope-inventory.md，两者 MUST 同步。',
      'advisory lock 与外键都是【数据库级】作用域：搬进不同 schema 后依然有效，只有拆成不同数据库才失效，',
      '而且失效方式是静默的——锁不再互斥、外键不再存在，业务照跑、数据慢慢分叉。',
      '键刻意不含行号：行号随无关编辑漂移，带行号的清单每次改代码都要重刷，很快就没人认真看了。',
    ],
    ...toInventory(report),
  };
  await writeFile(inventoryPath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`已写入 ${inventoryPath()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
