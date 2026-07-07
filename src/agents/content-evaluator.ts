/**
 * ContentEvaluator — 内容价值评估角色（LLM）。
 *
 * 职责：在列表页（feed/search）评估当前可见卡片是否值得点击查看。
 * 由 RoleDispatcher 在收到 page.cards.arrived 事件后主动触发 evaluate()。
 * 已访问卡片自动过滤，找到有价值卡片则 emit content.valuable，
 * 当前屏全部不值得则 emit content.no_valuable。
 *
 * 触发方式：RoleDispatcher 主动调用 setVisibleCards() + evaluate()
 * 产出事件：content.valuable、content.no_valuable
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import { tieredInterests } from './persona-format.js';
import type { RoleName } from '../event-bus/types.js';

/**
 * 受控好奇心豁免概率（change humanize-interaction-prompts）：小概率在某一轮选卡里追加
 * 「也可以纯粹因为标题有趣点开兴趣之外的内容」的许可，模拟真人偶发的好奇/看热闹。
 * 掷骰在代码层（random 可注入单测），未命中轮次 prompt 与从严口径逐字一致；命中轮仍是真实评估过的卡、
 * 诚实 skip 与品牌安全禁区不受豁免影响。
 */
export const CURIOSITY_EXEMPTION_PROBABILITY = 0.12;

export interface VisibleCard {
  index: number;
  title: string;
  author?: string;
  likeCount: number;
  collectCount: number;
  coverDesc?: string;
  noteId?: string;
  isVideo?: boolean;
}

export class ContentEvaluator extends BaseRole {
  readonly roleName: RoleName = 'content_evaluator';
  private readonly ctx: SessionContext;
  private readonly random: () => number;
  private unsubscribers: (() => void)[] = [];

  /** 当前屏可见卡片（由外部注入或通过事件 payload 提供） */
  private _visibleCards: VisibleCard[] = [];

  /** 评估在途标记：避免一批 page.cards 触发多个并发评估 → 多条 open_note */
  private _evaluating = false;

  constructor(options: RoleOptions, ctx: SessionContext, random: () => number = Math.random) {
    super(options);
    this.ctx = ctx;
    this.random = random;
    if (!options.llm) throw new Error('ContentEvaluator 需要 LlmClient');
  }

  /** 设置当前可见卡片（由上层在触发评估前注入） */
  setVisibleCards(cards: VisibleCard[]): void {
    this._visibleCards = cards;
  }

  subscribe(): void {
    // 评估由 RoleDispatcher 主动触发，无需自行订阅事件
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 核心评估 ─────────────────────────────────────────────

  async evaluate(pageType: 'feed' | 'search'): Promise<void> {
    if (this._evaluating) return; // 已有评估在途，丢弃本次触发，避免并发产生多条 open_note
    this._evaluating = true;
    try {
      await this._evaluate(pageType);
    } finally {
      this._evaluating = false;
    }
  }

  private async _evaluate(pageType: 'feed' | 'search'): Promise<void> {
    // 过滤已访问的卡片
    const candidates = this._visibleCards.filter(
      (c) => !c.noteId || !this.ctx.isVisited(c.noteId),
    );

    if (candidates.length === 0) {
      this.emit('content.no_valuable', {
        pageType,
        reason: 'all_cards_visited',
        ts: Date.now(),
      });
      return;
    }

    // 受控好奇心豁免（change humanize-interaction-prompts）：掷骰在代码层，命中才在 prompt 追加好奇许可。
    const curious = this.random() < CURIOSITY_EXEMPTION_PROBABILITY;

    // 构建 prompt 并调用 LLM
    const prompt = this.buildPrompt(candidates, pageType, curious);
    let raw: string;
    try {
      raw = await this.decide(prompt);
    } catch {
      this.emit('content.no_valuable', {
        pageType,
        reason: 'llm_error',
        ts: Date.now(),
      });
      return;
    }

    // 解析 LLM 输出
    const result = this.parseOutput(raw);
    if (!result) {
      this.emit('content.no_valuable', {
        pageType,
        reason: 'parse_failed',
        ts: Date.now(),
      });
      return;
    }

    if (result.verdict === 'valuable') {
      // 域内校验：LLM 回的序号必须落在本屏候选内；越界按 skip 如实处理，
      // 绝不静默换成别的卡片（否则会打开一篇从未被评估过的笔记）。
      const card = candidates[result.index];
      if (!card) {
        this.emit('content.no_valuable', {
          pageType,
          reason: 'index_out_of_range',
          ts: Date.now(),
        });
      } else {
        this.emit('content.valuable', {
          index: card.index,
          noteId: card.noteId,
          title: card.title,
          reason: result.reason,
          confidence: result.confidence,
          sourcePageType: pageType,
          ts: Date.now(),
        });
      }
    } else {
      this.emit('content.no_valuable', {
        pageType,
        reason: result.reason,
        ts: Date.now(),
      });
    }

    // 评估完成后标记本批候选"近期已评估"（仅用于后续重访的熟悉度折扣，候选过滤不变→二次评估照常）。
    // 置于 emit 之后：EventBus.emit 同步触发，open_note 的 familiar 判定读到的是本轮标记【之前】的状态，
    // 故"首次评估并打开"仍按全量 thinkMs，只有"返回后再次遇到"才享 1/3 折扣。
    for (const c of candidates) {
      if (c.noteId) this.ctx.markEvaluated(c.noteId);
    }
  }

  // ─── Prompt 构建 ───────────────────────────────────────────

  /** 只读预览（change role-prompt-visibility）：用最小示例数据 + 真实人设渲染真实 prompt，仅供后台查看；不改 buildPrompt 逻辑。 */
  previewPrompt(): string {
    return this.buildPrompt([{ index: 0, title: '<示例卡片标题>', author: '<示例作者>', likeCount: 0, collectCount: 0, isVideo: false }], 'feed');
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）：与 buildPrompt 同源拼接，仅供查看器定位标注；不改 buildPrompt。 */
  personaSegments(): string[] {
    const { identity, interests } = this.soul;
    return [`你是「${identity.name}」，${identity.role}。\n背景：${identity.background}\n兴趣领域：${tieredInterests(interests)}`];
  }

  private buildPrompt(cards: VisibleCard[], pageType: string, curious = false): string {
    const { identity, interests } = this.soul;
    const interestsStr = tieredInterests(interests);

    const cardList = cards
      .map((c, i) => {
        const videoTag = c.isVideo ? ' [视频]' : '';
        return `[${i}] "${c.title}"${videoTag} by ${c.author ?? '未知'} 👍${c.likeCount} ⭐${c.collectCount}${c.coverDesc ? ` (${c.coverDesc})` : ''}`;
      })
      .join('\n');

    // 好奇心许可（change humanize-interaction-prompts）：仅在命中豁免的这一轮出现；不改诚实 skip 与品牌安全。
    const curiosityLine = curious
      ? '\n（这一屏你心情不错，也可以纯粹因为某个标题有意思就点开一篇兴趣之外的内容——但仍要是真觉得有意思，不硬凑；品牌安全底线照样适用。）'
      : '';

    return `你是「${identity.name}」，${identity.role}。
背景：${identity.background}
兴趣领域：${interestsStr}

你正在小红书${pageType === 'feed' ? '推荐页' : '搜索结果页'}刷着，从下面这些卡片里挑一张你最想点开的。

可见卡片：
${cardList}

你怎么挑：
1. 先看标题跟你的兴趣对不对味——这是最主要的
2. 点赞/收藏数看看就好，不必非得高互动
3. 标 [视频] 的你自己定要不要看（视频也可能有料）
4. 已经看过的都过滤掉了，这些都是没看过的
5. 挑一张你真正最想深入看的
6. 要是这一屏没有一张真对你胃口，就直接 skip——别为跟你无关的内容硬编相关理由（诚实 skip 好过硬凑；你的兴趣以上面列的为准，不预设任何默认题材）
7. 品牌安全底线（不管你兴趣如何都适用）：政治敏感、色情低俗、赌博、违法或明显不良导向的一律不选${curiosityLine}

只输出JSON（不要输出其他内容）：
有价值：{"verdict":"valuable","index":N,"reason":"简短原因"}
全部跳过：{"verdict":"skip","reason":"简短原因"}`;
  }

  // ─── 输出解析 ───────────────────────────────────────────────

  private parseOutput(raw: string): EvalResult | null {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;

    let obj: unknown;
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }

    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;

    if (o.verdict === 'valuable') {
      // index 必须是非负整数；缺失/非法即判解析失败，不得默认 0（默认 0 = 静默选第一张卡）。
      if (typeof o.index !== 'number' || !Number.isInteger(o.index) || o.index < 0) return null;
      const reason = typeof o.reason === 'string' ? o.reason : 'valuable';
      const confidence = typeof o.confidence === 'number' ? o.confidence : 0.7;
      return { verdict: 'valuable', index: o.index, reason, confidence };
    } else if (o.verdict === 'skip') {
      const reason = typeof o.reason === 'string' ? o.reason : 'no_match';
      return { verdict: 'skip', reason, confidence: 0 };
    }

    return null;
  }
}

// ─── 内部类型 ─────────────────────────────────────────────────

interface EvalResultValuable {
  verdict: 'valuable';
  index: number;
  reason: string;
  confidence: number;
}

interface EvalResultSkip {
  verdict: 'skip';
  reason: string;
  confidence: number;
}

type EvalResult = EvalResultValuable | EvalResultSkip;
