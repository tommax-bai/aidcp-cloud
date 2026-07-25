/**
 * 去 AI 味的**检测与一轮收敛**（kernel）：词表 + 纯检测 + 评分归一 + 一次「检测→重写→复检」的编排。
 *
 * 为什么落这里：发帖侧与评论侧要的是**同一套判据**，此前评论侧为了复用它直连了发帖侧（content）的实现文件。
 * 词表尤其不能各留一份——发帖 prompt 与后处理检测共用同一份，正是「生成约束与检测口径一致」这条不变量的载体，
 * 分成两份就会悄悄漂。
 *
 * **有意不把 `PostProcessor` 类搬进来**：本层现有的 6 个导出类全部是错误类型，且既有判例的文件头逐字写着
 * 「路由客户端类留 content」。与其去改那条判例，不如把类里真正被共用的那部分——一个**无状态的纯编排**——
 * 提成函数：类留在原处当薄壳、只负责把构造期选项转成一次调用，两侧共用同一份逻辑，**没有任何行为被复制**。
 *
 * 准入：无 SQL / 无 HTTP / 无 fetch / 无供应商标识符 / 无模块级可变容器单例 / 不反向依赖业务层。
 * 重写器由调用方以函数注入，本层不认识任何模型客户端。
 */
import type { PostProcessResult } from './publish-pipeline-types.js';

/**
 * 禁用词/句式列表（negative list）。
 * 后处理与 prompt 共用同一份，保证生成约束与检测口径一致。
 */
export const BANNED_PHRASES: string[] = [
  '首先',
  '其次',
  '最后',
  '总结来说',
  '值得一提的是',
  // 「不得不说」已移出（change category-adaptive-images-and-judgment）：真人极常见口语开头，
  // 计入后处理硬检测/扣分属校准偏差；保留真正的 AI 结构套话（首先/其次/综上所述/众所周知…）。
  '众所周知',
  '让我们一起来看看',
  '让我们一起',
  '接下来我将',
  '接下来我会',
  '总的来说',
  '综上所述',
  '各有优劣',
  '各有千秋',
];

/** 感叹号检测正则（全角/半角都算）；上限由 exclamationMax 决定（默认 1）。 */
const EXCLAMATION_RE = /[!！]/g;

/** AI 味评分归一的分母（命中达到该数量即视为满分 1.0）。 */
const AI_SCORE_CAP = 4;

/**
 * 感叹号上限按内容语气分档（change category-adaptive-images-and-judgment）。
 * 活泼/叙事（casual/narrative）等生活·情感调性放宽到 3，专业/克制（professional/technical）保持 1。
 * 生成侧 buildCreatorPrompt 与本检测口径为同一套——放宽后生活类正文不再被判「过量感叹号」推向 rewrite/人审。
 */
export function exclamationMaxForTone(tone: string | undefined): number {
  return tone === 'casual' || tone === 'narrative' ? 3 : 1;
}

/**
 * 扫描正文，返回命中的禁用词/句式（含"过量感叹号"作为一个虚拟命中项）。
 * 纯函数，便于单测。extraPhrases 为调用方按体裁叠加的额外词表（默认空，发帖侧不受影响）。
 */
export function detectBannedPhrases(content: string, exclamationMax = 1, extraPhrases: string[] = []): string[] {
  const hits: string[] = [];
  for (const p of BANNED_PHRASES) {
    if (content.includes(p)) hits.push(p);
  }
  for (const p of extraPhrases) {
    if (p && content.includes(p) && !hits.includes(p)) hits.push(p);
  }
  const exclaims = content.match(EXCLAMATION_RE);
  if (exclaims && exclaims.length > exclamationMax) {
    hits.push('过量感叹号');
  }
  return hits;
}

/** 把命中数量归一为 0-1 的 AI 味评分。 */
export function aiScoreFromHits(hitCount: number): number {
  if (hitCount <= 0) return 0;
  return Math.min(1, hitCount / AI_SCORE_CAP);
}

/** 一轮去 AI 味的输入旋钮。重写器缺省即「只检测不重写」。 */
export interface AiFlavorPassOptions {
  /** 命中多少个禁用项触发重写；调用方 MUST 传已归一（≥1）的值。 */
  rewriteThreshold: number;
  /** 重写器：给定正文 + 命中词（+ 归账账号），返回新正文；不传则不重写。 */
  rewrite?: (content: string, flagged: string[], accountId?: string) => Promise<string>;
  /** 额外的体裁专用禁用词，叠加在通用词表之外；缺省为空。 */
  extraPhrases?: string[];
}

/**
 * 一轮「检测 → （必要时）重写一次 → 复检」。**重写只做一次，不循环**——重写后仍超阈是交给上层判人审的信号，
 * 不是继续重试的理由。
 *
 * 重写器抛错时**退回原文并按首轮命中返回**，`rewritten` 保持 false：这是刻意的诚实口径——
 * 没改成就不能报「已重写」，否则上层会以为文本已经收敛过一轮。
 */
export async function runAiFlavorPass(
  content: string,
  exclamationMax: number,
  options: AiFlavorPassOptions,
  accountId?: string,
): Promise<PostProcessResult> {
  const extraPhrases = options.extraPhrases ?? [];
  const firstHits = detectBannedPhrases(content, exclamationMax, extraPhrases);

  // 未达重写阈值：直接返回。
  if (firstHits.length < options.rewriteThreshold || !options.rewrite) {
    return {
      content,
      aiScore: aiScoreFromHits(firstHits.length),
      rewritten: false,
      flaggedPhrases: firstHits,
    };
  }

  // 达阈：重写一次。
  let rewritten: string;
  try {
    rewritten = await options.rewrite(content, firstHits, accountId);
  } catch {
    // 重写失败：退回原文，按首轮命中返回（交由上层标记审核）。
    return {
      content,
      aiScore: aiScoreFromHits(firstHits.length),
      rewritten: false,
      flaggedPhrases: firstHits,
    };
  }

  const secondHits = detectBannedPhrases(rewritten, exclamationMax, extraPhrases);
  return {
    content: rewritten,
    aiScore: aiScoreFromHits(secondHits.length),
    rewritten: true,
    flaggedPhrases: secondHits,
  };
}
