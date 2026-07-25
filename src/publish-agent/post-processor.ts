/**
 * 去 AI 味后处理器（发帖侧薄壳）。
 *
 * 流程：
 * 1. 扫描生成正文，检测禁用词列表（BANNED_PHRASES）+ 过量感叹号；
 * 2. 命中 >= rewriteThreshold（默认 2）个禁用项时，调用 generator.rewrite 重写一次；
 * 3. 重写后仍命中 >= rewriteThreshold，则标记需人工审核（needsReview=true）。
 *
 * aiScore：AI 味浓度评分（0-1），按命中禁用项数量归一（命中越多越高）。
 *
 * change cloud-coupling-p3-7：词表、纯检测、评分归一与那一轮编排已迁入 kernel 的
 * `ai-flavor-detection.ts` —— 评论侧要的是同一套判据，此前它为了复用直连了本文件（content 属主）。
 * 本类保留在此、只做「构造期选项 → 一次调用」的薄封装：**逻辑没有第二份**，
 * 也不必把一个行为类塞进 kernel（本层现有导出类全是错误类型，且既有判例明写路由客户端类留 content）。
 */

import {
  aiScoreFromHits,
  detectBannedPhrases,
  exclamationMaxForTone,
  runAiFlavorPass,
} from '../kernel/ai-flavor-detection.js';
import type { PostProcessResult } from './types.js';

// 对既有导入方等值再导出（发帖侧多处按名取用，调用点一行不改）。
export { aiScoreFromHits, detectBannedPhrases, exclamationMaxForTone };

export interface PostProcessorOptions {
  /** 命中多少个禁用项触发重写，默认 2 */
  rewriteThreshold?: number;
  /** 重写器：给定正文 + 命中词（+ 归账账号，见 process），返回新正文；不传则不重写 */
  rewrite?: (content: string, flagged: string[], accountId?: string) => Promise<string>;
  /**
   * 额外的体裁专用禁用词（change humanize-interaction-prompts）：在发帖侧通用词表之外叠加。
   * 评论去 AI 味用它接入评论体裁客套句集；缺省为空——发帖侧行为完全不变。
   */
  extraPhrases?: string[];
}

/** 去 AI 味后处理器。 */
export class PostProcessor {
  private readonly rewriteThreshold: number;
  private readonly rewriteFn?: (content: string, flagged: string[], accountId?: string) => Promise<string>;
  private readonly extraPhrases: string[];

  constructor(options: PostProcessorOptions = {}) {
    this.rewriteThreshold = Math.max(1, options.rewriteThreshold ?? 2);
    this.rewriteFn = options.rewrite;
    this.extraPhrases = options.extraPhrases ?? [];
  }

  /**
   * 处理一段正文：检测 → （必要时）重写 → 复检。
   * accountId（change parallel-rewrite-drafts 显式归账）：透传给重写器供模型调用按当轮账号记账；
   * 缺省保持旧行为（评论侧调用方各有自己的归账通道，不受影响）。
   * @returns PostProcessResult；命中超阈且重写后仍超阈时 aiScore 较高，
   *          调用方据此决定 status='needs_review'。
   */
  async process(content: string, exclamationMax = 1, accountId?: string): Promise<PostProcessResult> {
    return runAiFlavorPass(
      content,
      exclamationMax,
      {
        rewriteThreshold: this.rewriteThreshold,
        ...(this.rewriteFn ? { rewrite: this.rewriteFn } : {}),
        extraPhrases: this.extraPhrases,
      },
      accountId,
    );
  }

  /** 当前重写阈值。 */
  getRewriteThreshold(): number {
    return this.rewriteThreshold;
  }
}
