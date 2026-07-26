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
/**
 * 本仓的 `migrations/` 目录。
 *
 * **基准是「本模块文件往上两级」，而这在共享包里会变**（定稿 §4.7.1 把本族并入 `aidcp-transport`）：
 * 单体里 `src/schema/` 往上两级是仓根，指向对的地方；作为依赖被装进 `node_modules/<pkg>/dist/schema/`
 * 之后，同一句话指向的是包自己的目录 —— 那里**没有** `migrations/`。
 *
 * 消费方 MUST 显式把自己的迁移目录传进 `loadMigrationFiles(dir)`，别依赖这个默认值。
 * 默认值只为单体与本仓脚本保留。**下面那道空目录守卫就是给漏传的人准备的**：
 * 读到零条迁移绝不能当成「这个库没有迁移」——契约门会据此说「通过」，
 * 而它存在的全部意义正是拦住那种无声的错。
 */
export function migrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
}

export function checksumOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 按复合序返回全部迁移文件。 */
export async function loadMigrationFiles(dir = migrationsDir()): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    // 目录压根不存在 —— 最典型的成因是本模块作为依赖被装进 node_modules 后仍用了默认基准。
    // 抛，别回空数组：空数组会一路走到契约门说「通过」。
    throw new Error(
      `migrations_dir_unreadable dir=${dir}: ${(error as Error).message}。` +
        '若本模块是作为共享包被装载的，消费方 MUST 显式传入自己的 migrations 目录。',
    );
  }
  const names = entries.filter((n) => n.toLowerCase().endsWith('.sql'));
  if (names.length === 0) {
    // 目录在、但一个 .sql 都没有。同样不是一种正常态：本系统的每个属主库都有迁移。
    throw new Error(
      `migrations_dir_empty dir=${dir}。读到零条迁移 MUST NOT 被当成「这个库没有迁移」——` +
        'schema 契约门会据此判「通过」，而拦住这种无声错误正是它存在的理由。',
    );
  }
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
