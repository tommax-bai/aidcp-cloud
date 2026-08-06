// aidcp:test-owner=cloud
/**
 * 边界扫描器份际闸（change invert-split-fact-source · 任务 3；结构性合并推迟到 cutover）。
 *
 * `test/acceptance/helpers/boundary-scan.ts` 在 aidcp-cloud 与 aidcp-automation 各有一份：
 * 2026-08-05 实测两份已经漂开（composition→composition 判向相反），且没有任何机械手段会报。
 * 结构性合并（单一落点进共享包）被翻转前的机制卡住 —— 扫描器活在 test/ 而非 src/（transport
 * 点名只吃 cloud src/ 文件），仓根又按模块自身位置解析（REPO_ROOT 取 import.meta.url 上三层，
 * 装进包里会指到 node_modules 深处）；cutover（cloud src/ 删除、boundaries/ 冻结）才是指定
 * 唯一副本的自然时点。在那之前，本闸把「语义已并齐」钉住：两份 MUST 逐字一致。
 *
 * 本文件自身也是两仓各一份的镜像，因此把自己也纳入比对：改闸必须两边同批改。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { classifyEdge } from './helpers/boundary-scan.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** 两仓各持一份、内容 MUST 一致的文件（相对仓根）。 */
const PARITY_FILES = [
  'test/acceptance/helpers/boundary-scan.ts',
  'test/acceptance/boundary-scan-parity.test.ts',
];

const SELF_NAME = (
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { name: string }
).name;
/** cloud 对照 automation；任何派生侧副本一律对照事实源 cloud。 */
const SIBLING_NAME = SELF_NAME === 'aidcp-cloud' ? 'aidcp-automation' : 'aidcp-cloud';

/**
 * 兄弟 checkout 解析：主 checkout 在 `codes/<repo>`，worktree 在 `codes/<repo>.wt/<change>`，
 * 逐级向上找同级兄弟仓；判据是「份际文件真实在场」而非目录名存在（半个 clone 不算在场）。
 */
function findSiblingRoot(): string | null {
  for (const up of ['..', '../..', '../../..']) {
    const candidate = path.resolve(REPO_ROOT, up, SIBLING_NAME);
    if (PARITY_FILES.every((rel) => existsSync(path.join(candidate, rel)))) return candidate;
  }
  return null;
}

/** 归属标记行是两份之间唯一的合法差异（各标各的属主），其余一字不许漂。 */
function normalized(root: string, rel: string): string {
  return readFileSync(path.join(root, rel), 'utf8')
    .split('\n')
    .filter((line) => !line.includes('aidcp:test-owner='))
    .join('\n');
}

test('方向白名单语义钉死：组合根内部互引允许、反向导入组合根恒禁、kernel 不得反向依赖', () => {
  // 2026-08-05 那次漂移的裁定：以派生侧为准（组合根已拆成多文件，同层互引本就恒允许）。
  // 反向保护一条没松：业务层 / kernel → composition 仍是无豁免通道的 forbidden。
  assert.equal(classifyEdge('composition', 'composition'), 'allowed');
  for (const layer of ['kernel', 'api', 'content', 'automation'] as const) {
    assert.equal(classifyEdge('composition', layer), 'allowed');
    assert.equal(classifyEdge(layer, 'composition'), 'forbidden', `${layer} MUST NOT 反向导入组合根`);
  }
  for (const layer of ['api', 'content', 'automation'] as const) {
    assert.equal(classifyEdge('kernel', layer), 'forbidden', `kernel MUST NOT 反向依赖 ${layer}`);
    assert.equal(classifyEdge(layer, 'kernel'), 'allowed');
  }
  assert.equal(classifyEdge('api', 'content'), 'exemptable');
});

test('扫描器两份副本零漂移（对照兄弟 checkout）', (t) => {
  const sibling = findSiblingRoot();
  if (sibling === null) {
    // 三态诚实：兄弟 checkout 不在场＝「没能确认」，不是「确认到一致」。fleet 布局下两仓恒同级；
    // 走到这里只剩独立 clone 场景，此时对面仓里的同名闸会在有完整布局的机器上补上这一道。
    t.skip(`找不到同级的 ${SIBLING_NAME} checkout，本机确认不了份际`);
    return;
  }
  for (const rel of PARITY_FILES) {
    assert.equal(
      normalized(REPO_ROOT, rel),
      normalized(sibling, rel),
      `${rel} 与 ${SIBLING_NAME} 的副本已漂移。两份是同一实现的镜像（结构性合并等 cutover），`
        + '改任何一侧 MUST 在同一批把另一侧改成逐字一致（唯一豁免：归属标记行）',
    );
  }
});
