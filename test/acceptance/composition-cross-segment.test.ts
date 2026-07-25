import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * AC-SPLIT-CROSSSEG：组装根里的**跨段前向引用**必须响亮，不得静默短路。
 *
 * 背景（Block④ 三仓提取 · 批次 0b）：基础段 / 内容段在装配期构造回调，回调体里读一个由
 * **自动化段**赋值的句柄。单体里自动化段恒跑、回调只在请求期触发，永远读得到；三等分后
 * api / content 进程根本不跑自动化段，同一行就变成读 `undefined`。
 *
 * 若这一读写成裸 `ctx.X?.doSomething()`，缺席就被 `?.` 静默吞掉、调用方照样拿到「成功」——
 * 本仓头号红线「静默假成功」，而且**没有任何机械手段看得见**：类型系统对 `?.` 短路无话可说，
 * 日志里一个字都不留。这条闸就是那个机械手段。
 *
 * 判据：段边界、赋值段、读点全部**从源码现算**，不硬编码字段清单 —— 新加一个同形状的前向引用会
 * 自动被纳入判定，而不是等人想起来更新清单。
 */

const SEGMENTS = [
  { name: 'segA', marker: 'async function segAApiFoundation(' },
  { name: 'segB', marker: 'async function segBContent(' },
  { name: 'segC', marker: 'async function segCAutomation(' },
  { name: 'segD', marker: 'async function segDApiServing(' },
] as const;

/**
 * 允许保留裸解引用的例外，**每条都必须写清为什么它不是「被丢弃的动作」**。
 * 这张表是白名单不是垃圾桶：新增一条等于主张「这里缺席无后果」，要能当面讲通。
 */
const BARE_DEREF_EXEMPTIONS = new Map<string, string>([
  [
    'scheduledPublishReconciler',
    '停一个本进程没起过的东西：没跑自动化段 ⇒ 对账器根本不存在 ⇒ 「没停」不是被丢弃的动作、' +
      '也没有后果需要别人承接。此处记 error 只会在每次 api / content 进程正常退出时喊一次狼。',
  ],
  [
    'publishScheduler',
    '已有显式 `if (!ctx.publishScheduler) throw new Error(\'publish_unready\')` 前置守卫：' +
      '缺席时调用方拿到的是**失败**而不是假成功，解引用行永远走不到。',
  ],
]);

async function readServerSource(): Promise<string> {
  return readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');
}

/** 段边界＝四个段函数的起始行；末段直到文件尾。 */
function segmentRanges(lines: string[]): { name: string; start: number; end: number }[] {
  const starts = SEGMENTS.map(({ name, marker }) => {
    const start = lines.findIndex((l) => l.includes(marker));
    assert.ok(start >= 0, `段函数标志缺失：${marker}（段边界改名了？先修本闸再改代码）`);
    return { name, start };
  });
  return starts.map((s, i) => ({
    name: s.name,
    start: s.start,
    end: i + 1 < starts.length ? starts[i + 1]!.start - 1 : lines.length - 1,
  }));
}

function segmentOf(ranges: ReturnType<typeof segmentRanges>, line: number): string | undefined {
  return ranges.find((r) => line >= r.start && line <= r.end)?.name;
}

test('AC-SPLIT-CROSSSEG: 基础段/内容段对后段字段的前向引用不得裸解引用（静默短路）', async () => {
  const lines = (await readServerSource()).split('\n');
  const ranges = segmentRanges(lines);
  const order = new Map<string, number>(SEGMENTS.map((s, i) => [s.name as string, i]));

  // 每个 ctx 字段的首个赋值点所在段。
  const assignedIn = new Map<string, string>();
  lines.forEach((line, i) => {
    const m = /^\s*ctx\.([A-Za-z0-9_]+)\s*=(?!=)/.exec(line);
    if (!m) return;
    const seg = segmentOf(ranges, i);
    if (seg && !assignedIn.has(m[1]!)) assignedIn.set(m[1]!, seg);
  });
  assert.ok(assignedIn.size > 50, `ctx 赋值点解析异常（只认出 ${assignedIn.size} 个），先修本闸`);

  const violations: string[] = [];
  lines.forEach((line, i) => {
    const readerSeg = segmentOf(ranges, i);
    if (readerSeg !== 'segA' && readerSeg !== 'segB') return;
    for (const m of line.matchAll(/ctx\.([A-Za-z0-9_]+)(\??\.|\?\.\()/g)) {
      const field = m[1]!;
      // 赋值目标行本身不算读点。
      if (new RegExp(`^\\s*ctx\\.${field}\\s*=(?!=)`).test(line)) continue;
      const ownerSeg = assignedIn.get(field);
      if (!ownerSeg) continue;
      if (order.get(ownerSeg)! <= order.get(readerSeg)!) continue; // 后向引用：本段跑到这里时已赋值
      if (BARE_DEREF_EXEMPTIONS.has(field)) continue;
      violations.push(`${readerSeg} 第 ${i + 1} 行裸解引用 ctx.${field}（由 ${ownerSeg} 赋值）: ${line.trim()}`);
    }
  });

  assert.deepEqual(
    violations,
    [],
    '跨段前向引用必须经 crossSegment(...) 取用（缺席时如实记 cross_segment_drop），' +
      '不得写成 `ctx.X?.doSomething()` —— 那会在 api / content 进程里静默吞掉动作、' +
      '让调用方拿到假成功。确属「缺席无后果」的，加进 BARE_DEREF_EXEMPTIONS 并写明理由。\n' +
      violations.join('\n'),
  );
});

test('AC-SPLIT-CROSSSEG: crossSegment 闸本身存在且缺席分支是响亮的', async () => {
  const source = await readServerSource();
  assert.match(source, /function crossSegment</, 'crossSegment 闸不得被删除');
  const body = source.slice(source.indexOf('function crossSegment<'));
  const impl = body.slice(0, body.indexOf('\n}\n') + 3);
  assert.match(impl, /console\.error\(/, '缺席分支必须记 error —— 静默返回 undefined 等于什么都没做');
  assert.match(impl, /cross_segment_drop/, '缺席日志必须带可 grep 的 cross_segment_drop 前缀');
  // 有实现时必须原样返回：本闸只管缺席那一支，绝不改变单体行为。
  assert.match(impl, /if \(handle !== undefined && handle !== null\) return handle;/);
});
