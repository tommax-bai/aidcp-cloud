/**
 * 运行时 DDL 允许清单的生成器 / 对照器（change cloud-schema-migration-executor 任务 4.1–4.2）。
 *
 *   npx tsx scripts/generate-ddl-allowlist.ts            干跑：打印三元组与逐文件条目，不落盘
 *   npx tsx scripts/generate-ddl-allowlist.ts --write    写 test/schema/runtime-ddl-allowlist.json
 *
 * **清单只减不增**：`--write` 只在「收口了一批存储、条目变少」之后跑。新增运行时 DDL 时
 * 正确动作是把 DDL 挪进 migrations/，而不是跑这个脚本把它登记进来。
 * 验收用例 AC-SCHEMA-DDL-OWNER（test/acceptance/schema-ddl-owner.test.ts）负责在 CI 里守住这条。
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { repoRoot, scanRuntimeDdl, stableKey } from '../src/schema/ddl-scan.js';

export function allowlistPath(root = repoRoot()): string {
  return path.join(root, 'test', 'schema', 'runtime-ddl-allowlist.json');
}

/** 已冻结的基线三元组 MUST 保持不变——它是「当初有多少」的历史事实，不随收口进度重算。 */
async function frozenBaseline(): Promise<unknown | undefined> {
  try {
    const raw = await readFile(allowlistPath(), 'utf8');
    return (JSON.parse(raw) as { baseline?: unknown }).baseline;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const report = await scanRuntimeDdl();

  const entries: Record<string, Record<string, number>> = {};
  for (const hit of report.hits) {
    const perFile = (entries[hit.file] ??= {});
    const key = stableKey(hit);
    perFile[key] = (perFile[key] ?? 0) + 1;
  }
  const sortedFiles = Object.keys(entries).sort();
  const sorted: Record<string, Record<string, number>> = {};
  for (const file of sortedFiles) {
    const keys = Object.keys(entries[file]).sort();
    sorted[file] = Object.fromEntries(keys.map((k) => [k, entries[file][k]]));
  }

  console.log('运行时 DDL 三元组（MUST 三个数同时给出，MUST NOT 只写一个）：');
  console.log(`  文本命中（含注释内）：${report.textHitCount}`);
  console.log(`  去注释后生效：      ${report.effectiveHitCount}   ← 收口范围以这一组为准`);
  console.log(`  分布文件数：        ${report.fileCount}`);
  // 历史基线（proposal/design 里的 76 / 58–60 / 34）只数 CREATE TABLE 一个动词，
  // 这里单列一行，才能与当前实测逐条对上而不是把两把尺子混着比。
  const createTableHits = report.hits.filter((h) => h.verb === 'create_table');
  const createTableFiles = new Set(createTableHits.map((h) => h.file));
  console.log(
    `  其中仅建表动词：去注释后生效 ${createTableHits.length}，分布 ${createTableFiles.size} 个文件`,
  );
  for (const file of sortedFiles) {
    const total = Object.values(sorted[file]).reduce((a, b) => a + b, 0);
    console.log(`  ${String(total).padStart(3)}  ${file}`);
  }

  if (!write) {
    console.log('（干跑；加 --write 落盘到 test/schema/runtime-ddl-allowlist.json）');
    return;
  }

  const baseline = (await frozenBaseline()) ?? {
    _comment: [
      '首次冻结时的三元组，按当前 master 实测（非 proposal/design 里的历史数字）。',
      '本块一旦落盘 MUST NOT 随收口进度重算——它记的是「当初有多少」。',
      'createTableOnly 单列，是为了与 proposal 的 76 / 58–60 / 34（只数建表动词）同尺子对照。',
    ],
    measuredOn: 'master @ publish-approval-signal-to-database (d9c550e) + 本 change 第一批',
    textHits: report.textHitCount,
    effectiveHits: report.effectiveHitCount,
    files: report.fileCount,
    createTableOnly: {
      textHits: 83,
      effectiveHits: createTableHits.length,
      files: createTableFiles.size,
      note: 'proposal 记 76 / 58–60 / 34；差额来自 config-mirror 与 publish-approval 两个并行 change 新增的两个存储',
    },
  };

  const payload = {
    _comment: [
      '运行时 DDL 允许清单（change cloud-schema-migration-executor 任务 4.1）。',
      '清单只减不增：新增运行时 DDL MUST 改为加在 migrations/，MUST NOT 加进本文件。',
      '每收口一批存储，跑 npx tsx scripts/generate-ddl-allowlist.ts --write 让条目变少。',
      'key = <verb>:<object>，刻意不含行号——行号会随无关编辑漂移，会把清单变成噪声源。',
    ],
    baseline,
    current: {
      textHits: report.textHitCount,
      effectiveHits: report.effectiveHitCount,
      files: report.fileCount,
    },
    entries: sorted,
  };
  await writeFile(allowlistPath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`已写入 ${allowlistPath()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
