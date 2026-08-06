/**
 * 反回归（change collapse-facebook-global-policy-target-column，任务 4.5）。
 *
 * 收缩的目的不是「少一列」，是让「存在第二份 Facebook 全局策略」不可表示。库层面由单例主键守；
 * 代码层面要守的是另一半：**MUST NOT 再有任何以运行目标为键读写这三张主表的路径，
 * 也 MUST NOT 留一个恒为同一个值的替代常量继续传参** —— 那等于把分行维度改名留在代码里，
 * 而它下一次被重新用起来时，同样不会报错。
 *
 * 判据按**语句**给，不按文件给：审计表上的运行目标字段是刻意保留的追溯字段，
 * 按文件粗判会把它一起判成违规，于是这道闸只能被放宽或删掉。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));

/** 三张主表；正则用负向前瞻把同名前缀的审计表排除在外。 */
const COLLAPSED_TABLES = [
  /facebook_operation_global_policy(?!_audit)/,
  /facebook_group_comment_policy(?!_audit)/,
  /facebook_environment_slow_start_completion/,
];

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    const full = path.join(dir, entry);
    if ((await stat(full)).isDirectory()) out.push(...(await tsFiles(full)));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 抽出全部模板字符串（本仓的 SQL 一律写在反引号里）。 */
function templateLiterals(content: string): string[] {
  return [...content.matchAll(/`(?:[^`\\]|\\[\s\S])*`/g)].map((m) => m[0]);
}

describe('facebook 全局策略单行化的反回归', () => {
  it('三张主表的任何一条 SQL 里都不再出现 execution_target', async () => {
    const offenders: string[] = [];
    for (const file of await tsFiles(srcDir)) {
      const content = await readFile(file, 'utf8');
      for (const literal of templateLiterals(content)) {
        if (!COLLAPSED_TABLES.some((re) => re.test(literal))) continue;
        if (!/execution_target/.test(literal)) continue;
        offenders.push(`${path.relative(srcDir, file)}: ${literal.slice(0, 90).replace(/\s+/g, ' ')}…`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '这三张表上已经没有这一列了：留着的语句不是报错，而是一条谁都能写、代码却不读的旁路',
    );
  });

  it('作用域常量模块已删除，且没有人再引它', async () => {
    const files = await tsFiles(srcDir);
    assert.equal(
      files.filter((f) => f.endsWith('facebook-global-policy-scope.ts')).length,
      0,
      '分行键消失之后，一个恒为同一个值的行键常量没有对应的列可选，MUST NOT 继续留着传参',
    );
    const referencing: string[] = [];
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      if (/facebook-global-policy-scope|FACEBOOK_GLOBAL_POLICY_SCOPE/.test(content)) {
        referencing.push(path.relative(srcDir, file));
      }
    }
    assert.deepEqual(referencing, []);
  });

  it('两张审计表上的运行目标字段刻意留着：这道闸 MUST NOT 顺手把它也判成违规', async () => {
    const auditWrites: string[] = [];
    for (const file of await tsFiles(srcDir)) {
      const content = await readFile(file, 'utf8');
      for (const literal of templateLiterals(content)) {
        if (!/facebook_(operation_global|group_comment)_policy_audit/.test(literal)) continue;
        if (/execution_target/.test(literal)) auditWrites.push(path.relative(srcDir, file));
      }
    }
    assert.deepEqual(
      [...new Set(auditWrites)].sort(),
      ['config/facebook-group-comment-policy-store.ts', 'config/facebook-operation-policy-store.ts'],
      '主表旧行删掉之后，审计上的这个字段是「合并之前各目标各是什么」唯一的留存处；' +
        '它消失了不是「更干净」，是把历史抹掉了',
    );
  });
});
