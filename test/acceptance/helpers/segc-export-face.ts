// aidcp:test-owner=cloud
/**
 * 自动化段导出面的派生器（change split-cloud-automation-production-runtime，批 A）。
 *
 * ## 它为什么存在
 *
 * `aidcp-automation` 里有一份判据清单（`src/automation-segc-export-disposition.ts`），
 * 逐条判自动化段导出的每个句柄「自动化进程里有没有去处」。那份清单是批 B…H 的尺子，
 * **而它是手抄的** —— 本仓的组装根一改，它静静地就不对了，派生仓里没有任何东西看得见。
 *
 * 这个派生器 + 同名验收用例是那份清单**唯一的机械信号**，且刻意留在本仓：
 * 判据的来源（自动化段的导出面）只在本仓存在。
 *
 * ## 它证明什么、不证明什么
 *
 * **证明**：自动化段导出的句柄集合与钉死的名单逐字相同。增一个、减一个、改个名，当场红。
 *
 * **不证明**：那 41 条各自的裁定对不对。裁定是人读出来的，只有人能改。
 * 本用例红的时候要做的是**去重判那条句柄的去处**，不是把名单改一改让它变绿。
 *
 * 单独跑：`npx tsx test/acceptance/helpers/segc-export-face.ts`
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVER_PATH = fileURLToPath(new URL('../../../src/server.ts', import.meta.url));

/** 段函数的起始签名。按符号名定位，**不按行号** —— 行号每一路都漂过。 */
const SEGMENT_SIGNATURE = 'async function segCAutomation(';

/**
 * 解析自动化段导出给共享上下文的字段名全集。
 *
 * 段边界的判法：从段签名那一行起，到**第一个顶格 `}`** 为止。顶格右花括号在本文件里
 * 只可能是顶层声明的收尾，段内任何嵌套都至少缩进两格。
 */
export function deriveSegCExportFace(source = readFileSync(SERVER_PATH, 'utf8')): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith(SEGMENT_SIGNATURE));
  if (start < 0) {
    throw new Error(
      `segc_export_face: 找不到段签名 ${SEGMENT_SIGNATURE} —— 段被改名或被拆走了，先确认它去哪了`,
    );
  }
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === '}') {
      end = i;
      break;
    }
  }
  if (end < 0) {
    throw new Error('segc_export_face: 段没有顶格收尾，解析边界失效');
  }
  const assignment = /^\s{0,4}ctx\.([A-Za-z0-9_]+)\s*=/;
  const handles = new Set<string>();
  for (let i = start + 1; i < end; i += 1) {
    const match = assignment.exec(lines[i]!);
    if (match) handles.add(match[1]!);
  }
  return [...handles].sort();
}

if (process.argv[1] && process.argv[1].endsWith('segc-export-face.ts')) {
  const face = deriveSegCExportFace();
  console.log(`segCAutomation 导出面 ${face.length} 条：`);
  for (const handle of face) console.log(`  ${handle}`);
}
