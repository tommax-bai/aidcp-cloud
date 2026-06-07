/**
 * 去 AI 味后处理器。
 *
 * 流程：
 * 1. 扫描生成正文，检测禁用词列表（BANNED_PHRASES）+ 过量感叹号；
 * 2. 命中 >= rewriteThreshold（默认 2）个禁用项时，调用 generator.rewrite 重写一次；
 * 3. 重写后仍命中 >= rewriteThreshold，则标记需人工审核（needsReview=true）。
 *
 * aiScore：AI 味浓度评分（0-1），按命中禁用项数量归一（命中越多越高）。
 */

import { BANNED_PHRASES } from './prompts.js';
import type { PostProcessResult } from './types.js';

/** 感叹号检测：最多允许 1 个（全角/半角都算）。 */
const EXCLAMATION_RE = /[!！]/g;

/** AI 味评分归一的分母（命中达到该数量即视为满分 1.0）。 */
const AI_SCORE_CAP = 4;

export interface PostProcessorOptions {
  /** 命中多少个禁用项触发重写，默认 2 */
  rewriteThreshold?: number;
  /** 重写器：给定正文 + 命中词，返回新正文；不传则不重写 */
  rewrite?: (content: string, flagged: string[]) => Promise<string>;
}

/**
 * 扫描正文，返回命中的禁用词/句式（含"过量感叹号"作为一个虚拟命中项）。
 * 纯函数，便于单测。
 */
export function detectBannedPhrases(content: string): string[] {
  const hits: string[] = [];
  for (const p of BANNED_PHRASES) {
    if (content.includes(p)) hits.push(p);
  }
  const exclaims = content.match(EXCLAMATION_RE);
  if (exclaims && exclaims.length > 1) {
    hits.push('过量感叹号');
  }
  return hits;
}

/** 把命中数量归一为 0-1 的 AI 味评分。 */
export function aiScoreFromHits(hitCount: number): number {
  if (hitCount <= 0) return 0;
  return Math.min(1, hitCount / AI_SCORE_CAP);
}

/** 去 AI 味后处理器。 */
export class PostProcessor {
  private readonly rewriteThreshold: number;
  private readonly rewriteFn?: (content: string, flagged: string[]) => Promise<string>;

  constructor(options: PostProcessorOptions = {}) {
    this.rewriteThreshold = Math.max(1, options.rewriteThreshold ?? 2);
    this.rewriteFn = options.rewrite;
  }

  /**
   * 处理一段正文：检测 → （必要时）重写 → 复检。
   * @returns PostProcessResult；命中超阈且重写后仍超阈时 aiScore 较高，
   *          调用方据此决定 status='needs_review'。
   */
  async process(content: string): Promise<PostProcessResult> {
    const firstHits = detectBannedPhrases(content);

    // 未达重写阈值：直接返回。
    if (firstHits.length < this.rewriteThreshold || !this.rewriteFn) {
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
      rewritten = await this.rewriteFn(content, firstHits);
    } catch {
      // 重写失败：退回原文，按首轮命中返回（交由上层标记审核）。
      return {
        content,
        aiScore: aiScoreFromHits(firstHits.length),
        rewritten: false,
        flaggedPhrases: firstHits,
      };
    }

    const secondHits = detectBannedPhrases(rewritten);
    return {
      content: rewritten,
      aiScore: aiScoreFromHits(secondHits.length),
      rewritten: true,
      flaggedPhrases: secondHits,
    };
  }

  /** 当前重写阈值。 */
  getRewriteThreshold(): number {
    return this.rewriteThreshold;
  }
}
