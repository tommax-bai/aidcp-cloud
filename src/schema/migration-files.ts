/**
 * 迁移目录读取（change cloud-schema-migration-executor）。
 *
 * 只做「读文件 + 算校验和 + 排序」，不连库。执行器、启动期契约门与脱库测试共用同一入口，
 * 避免出现第二份「哪些文件算迁移」的口径。
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareVersions, versionOf, type MigrationFile } from './migration-plan.js';

/** 账本表 DDL 所在的迁移文件；执行器在读账本之前先原样执行它（幂等 bootstrap）。 */
export const LEDGER_MIGRATION_NAME = '0064_schema_migrations_ledger.sql';

/** 迁移目录绝对路径（相对本文件解析，随仓库移动仍成立）。 */
export function migrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
}

export function checksumOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 按复合序返回全部迁移文件。 */
export async function loadMigrationFiles(dir = migrationsDir()): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const names = entries.filter((n) => n.toLowerCase().endsWith('.sql'));
  const files: MigrationFile[] = [];
  for (const name of names) {
    const content = await readFile(path.join(dir, name), 'utf8');
    files.push({ name, content, checksum: checksumOf(content) });
  }
  files.sort((a, b) => compareVersions(versionOf(a.name), versionOf(b.name)));
  return files;
}

/** 目录里的最大版本 id（复合序），空目录返回 undefined。 */
export function maxVersionOf(files: MigrationFile[]): string | undefined {
  let max: string | undefined;
  for (const f of files) {
    const v = versionOf(f.name);
    if (max === undefined || compareVersions(v, max) > 0) max = v;
  }
  return max;
}
