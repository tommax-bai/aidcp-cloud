/**
 * 模块边界静态断言（change config-mirror-cross-process-invalidation task 1.3）。
 *
 * **为什么要有这条测试**：定稿方案 §11.4 要求一把 `quota_config` / `pacing_floor_config` /
 * `session_config_global` / `resume_config_global` 四张表判给自动化服务，判据是一条**既成事实**——
 * 风控层对配置层的源码引用为 0，而配置层引用风控层的常量与校验共 13 处，依赖方向已单向倒置。
 * 这条事实一旦被人随手加一行 import 打破，归属论证当场失效，而且没有任何机械手段会提醒。
 *
 * 用读源码做静态断言（不引入 lint 依赖）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 抽出一个文件里的全部 import 说明符（含 `import type`）。 */
function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

test('1.3 src/risk/** MUST NOT import src/config/**（四类限频配置归属自动化的依据）', () => {
  const offenders: string[] = [];
  for (const file of tsFilesUnder(path.join(SRC, 'risk'))) {
    for (const spec of importSpecifiers(file)) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      if (resolved.startsWith(path.join(SRC, 'config') + path.sep)) {
        offenders.push(`${path.relative(SRC, file)} → ${spec}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '风控层一旦 import 配置层，「依赖方向已单向倒置」这条归属依据即失效；' +
      '需要跨层事实请走 src/config-mirror-freshness.ts 这类中立模块',
  );
});

test('1.3 反向依赖仍然成立：src/config/** 确实引用 src/risk/**（归属论证的另一半）', () => {
  let hits = 0;
  for (const file of tsFilesUnder(path.join(SRC, 'config'))) {
    for (const spec of importSpecifiers(file)) {
      if (spec.includes('../risk/')) hits += 1;
    }
  }
  assert.ok(hits >= 10, `配置层→风控层的引用应在 10 处以上，实测 ${hits}`);
});
