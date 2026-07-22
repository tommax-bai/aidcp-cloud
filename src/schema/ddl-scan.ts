/**
 * 运行时 DDL 扫描器（change cloud-schema-migration-executor 任务 4.1）。
 *
 * 目的：机械回答「`src/` 下还有哪些地方在建表 / 改表 / 建索引」，作为 DDL 单一所有者的过渡期闸门。
 *
 * 两条必须守住的口径：
 *  1. **先剥注释再判定**。SQL 行注释、块注释与 TS 行注释里的 DDL 一律不算运行时建表点。
 *     不剥注释会把注释掉的 DDL 当成真实建表点，给收口范围凭空加出十几条假目标
 *     （与 change cloud-service-boundary-gates 任务 4.2 同规则）。
 *  2. **计数按三元组给出**：文本命中（未剥注释）/ 去注释后生效 / 分布文件数。只给一个数会误导范围。
 *
 * 本文件刻意不写出连着的 DDL 关键字字面量（模式由 `\s+` 拼接），因此扫描自身时不会自命中。
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DdlVerb = 'create_table' | 'alter_table' | 'create_index';

export interface DdlHit {
  /** 仓库相对路径，如 `src/config/model-config-store.ts` */
  file: string;
  /** 1-based 行号（仅供人读；允许清单的键不含行号，见 stableKey） */
  line: number;
  verb: DdlVerb;
  /** 语句作用的对象名（表名 / 索引名）；解析不出时为 `?` */
  object: string;
}

interface VerbPattern {
  verb: DdlVerb;
  re: RegExp;
  /** 捕获组里哪个是对象名 */
  group: number;
}

function verbPatterns(): VerbPattern[] {
  return [
    {
      verb: 'create_table',
      re: /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w.]*)/gi,
      group: 1,
    },
    {
      verb: 'alter_table',
      re: /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([a-zA-Z_][\w.]*)/gi,
      group: 1,
    },
    {
      verb: 'create_index',
      re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w.]*)/gi,
      group: 1,
    },
  ];
}

/**
 * 剥注释：块注释与行注释都替换成等量空白，保持字节偏移不变（行号才不会漂）。
 * `//` 前面紧跟 `:` 的不当作注释（`https://…` 一类 URL 字面量），否则会把整行剩余内容误删。
 */
export function stripComments(source: string): string {
  const blanked = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return blanked
    .split('\n')
    .map((line) => {
      let cut = -1;
      for (let i = 0; i < line.length - 1; i += 1) {
        const two = line.slice(i, i + 2);
        if (two === '--') {
          cut = i;
          break;
        }
        if (two === '//' && line[i - 1] !== ':') {
          cut = i;
          break;
        }
      }
      if (cut < 0) return line;
      return line.slice(0, cut) + ' '.repeat(line.length - cut);
    })
    .join('\n');
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/** 单文件扫描；`stripFirst=false` 时统计的是「文本命中」（含注释里的）。 */
export function scanSource(file: string, source: string, stripFirst = true): DdlHit[] {
  const text = stripFirst ? stripComments(source) : source;
  const hits: DdlHit[] = [];
  for (const { verb, re, group } of verbPatterns()) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({ file, line: lineOf(text, m.index), verb, object: m[group] ?? '?' });
    }
  }
  hits.sort((a, b) => a.line - b.line || a.verb.localeCompare(b.verb));
  return hits;
}

/** 允许清单的稳定键：不含行号（行号会随无关编辑漂移，清单会变成噪声源）。 */
export function stableKey(hit: DdlHit): string {
  return `${hit.verb}:${hit.object}`;
}

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

async function listTsFiles(dir: string, rootLen: number, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      await listTsFiles(full, rootLen, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full.slice(rootLen + 1));
    }
  }
}

export interface DdlScanReport {
  /** 去注释后生效的命中（收口范围以此为准） */
  hits: DdlHit[];
  /** 未剥注释的文本命中数（仅用于三元组报数，MUST NOT 用它立收口范围） */
  textHitCount: number;
  /** 去注释后生效的命中数 */
  effectiveHitCount: number;
  /** 去注释后仍有命中的源文件数 */
  fileCount: number;
}

/** 扫描 `src/**\/*.ts`；扫描器自身被排除（它写的是模式，不是 DDL）。 */
export async function scanRuntimeDdl(root = repoRoot()): Promise<DdlScanReport> {
  const srcDir = path.join(root, 'src');
  const files: string[] = [];
  await listTsFiles(srcDir, root.length, files);
  files.sort();

  const selfRelative = path.join('src', 'schema', 'ddl-scan.ts');
  const hits: DdlHit[] = [];
  let textHitCount = 0;
  const fileSet = new Set<string>();

  for (const file of files) {
    if (file === selfRelative) continue;
    const source = await readFile(path.join(root, file), 'utf8');
    textHitCount += scanSource(file, source, false).length;
    const effective = scanSource(file, source, true);
    if (effective.length > 0) fileSet.add(file);
    hits.push(...effective);
  }

  return {
    hits,
    textHitCount,
    effectiveHitCount: hits.length,
    fileCount: fileSet.size,
  };
}
