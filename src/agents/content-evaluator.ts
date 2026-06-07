/**
 * ContentEvaluator — 内容价值评估角色（LLM）。
 *
 * 职责：在列表页（feed/search）评估当前可见卡片是否值得点击查看。
 * 采用渐进消耗机制：已访问卡片标记无价值，找到有价值卡片则 emit content.valuable，
 * 当前屏全部耗尽则 emit content.no_valuable。
 *
 * 消费事件：feed.entered、feed.scrolled、search.scrolled
 * 产出事件：content.valuable、content.no_valuable
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName, FeedEnteredPayload, FeedScrolledPayload, SearchScrolledPayload } from '../event-bus/types.js';

export interface VisibleCard {
  index: number;
  title: string;
  author?: string;
  likeCount: number;
  collectCount: number;
  coverDesc?: string;
  noteId?: string;
}

export class ContentEvaluator extends BaseRole {
  readonly roleName: RoleName = 'content_evaluator';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  /** 当前屏可见卡片（由外部注入或通过事件 payload 提供） */
  private _visibleCards: VisibleCard[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
    if (!options.llm) throw new Error('ContentEvaluator 需要 LlmClient');
  }

  /** 设置当前可见卡片（由上层在触发评估前注入） */
  setVisibleCards(cards: VisibleCard[]): void {
    this._visibleCards = cards;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('feed.entered', (p) => this.handleFeedEntered(p)),
      this.eventBus.on('feed.scrolled', (p) => this.handleFeedScrolled(p)),
      this.eventBus.on('search.scrolled', (p) => this.handleSearchScrolled(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private handleFeedEntered(_payload: FeedEnteredPayload): void {
    void this.evaluate('feed');
  }

  private handleFeedScrolled(_payload: FeedScrolledPayload): void {
    void this.evaluate('feed');
  }

  private handleSearchScrolled(_payload: SearchScrolledPayload): void {
    void this.evaluate('search');
  }

  // ─── 核心评估 ─────────────────────────────────────────────

  async evaluate(pageType: 'feed' | 'search'): Promise<void> {
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

    // 构建 prompt 并调用 LLM
    const prompt = this.buildPrompt(candidates, pageType);
    let raw: string;
    try {
      raw = await this.llm!.complete(prompt);
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
      const card = candidates[result.index] ?? candidates[0];
      this.emit('content.valuable', {
        index: card.index,
        title: card.title,
        reason: result.reason,
        confidence: result.confidence,
        sourcePageType: pageType,
        ts: Date.now(),
      });
    } else {
      this.emit('content.no_valuable', {
        pageType,
        reason: result.reason,
        ts: Date.now(),
      });
    }
  }

  // ─── Prompt 构建 ───────────────────────────────────────────

  private buildPrompt(cards: VisibleCard[], pageType: string): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');

    const cardList = cards
      .map((c, i) => `[${i}] "${c.title}" by ${c.author ?? '未知'} 👍${c.likeCount} ⭐${c.collectCount}${c.coverDesc ? ` (${c.coverDesc})` : ''}`)
      .join('\n');

    return `你是「${identity.name}」，${identity.role}。兴趣：${interestsStr}。
当前在小红书列表页（${pageType}），从以下可见卡片中选择一个最值得打开的内容。

可见卡片：
${cardList}

筛选策略：
- 优先选择与你兴趣相关的标题
- 互动数据太差的（点赞=0 且无收藏）考虑跳过
- 已经看过的不会出现在列表中

只输出JSON（不要输出其他内容）：
有价值：{"verdict":"valuable","index":N,"reason":"简短原因","confidence":0.8}
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
      const index = typeof o.index === 'number' ? o.index : 0;
      const reason = typeof o.reason === 'string' ? o.reason : 'valuable';
      const confidence = typeof o.confidence === 'number' ? o.confidence : 0.7;
      return { verdict: 'valuable', index, reason, confidence };
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
