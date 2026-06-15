/**
 * SearchEvaluator — 搜索决策评估角色（LLM）。
 *
 * 职责：决定当前是否需要搜索、搜索什么关键词。
 * 通过 LLM 评估概念池关键词，避免重复搜索相同关键词。
 *
 * 消费事件：search.needed
 * 产出事件：search.approved、search.skipped
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { SessionContext } from './session-context.js';
import type { RoleName, SearchNeededPayload } from '../event-bus/types.js';

export interface SearchEvaluatorOptions extends RoleOptions {
  sessionContext: SessionContext;
  getSearchedKeywords: () => string[];
}

export class SearchEvaluator extends BaseRole {
  readonly roleName: RoleName = 'search_evaluator';
  private readonly getSearchedKeywords: () => string[];
  private unsubscribers: (() => void)[] = [];

  constructor(options: SearchEvaluatorOptions) {
    super(options);
    this.getSearchedKeywords = options.getSearchedKeywords;
    if (!options.llm) throw new Error('SearchEvaluator 需要 LlmClient');
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('search.needed', (p) => this.handleSearchNeeded(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private handleSearchNeeded(payload: SearchNeededPayload): void {
    void this.evaluate(payload);
  }

  // ─── 核心评估 ─────────────────────────────────────────────

  async evaluate(payload: SearchNeededPayload): Promise<void> {
    const prompt = this.buildPrompt(payload);
    let raw: string;
    try {
      raw = await this.decide(prompt);
    } catch {
      // LLM 异常时跳过搜索
      this.emit('search.skipped', {
        currentPageType: payload.currentPageType,
        reason: 'llm_error',
        ts: Date.now(),
      });
      return;
    }

    const result = this.parseOutput(raw);
    if (!result) {
      this.emit('search.skipped', {
        currentPageType: payload.currentPageType,
        reason: 'parse_failed',
        ts: Date.now(),
      });
      return;
    }

    if (result.verdict === 'search') {
      this.emit('search.approved', {
        keyword: result.keyword,
        reason: result.reason,
        ts: Date.now(),
      });
    } else {
      this.emit('search.skipped', {
        currentPageType: payload.currentPageType,
        reason: result.reason,
        ts: Date.now(),
      });
    }
  }

  // ─── Prompt 构建 ───────────────────────────────────────────

  private buildPrompt(payload: SearchNeededPayload): string {
    const { identity, interests } = this.soul;
    const seedKeywords = interests.seed_keywords;
    const allInterests = [...interests.primary, ...interests.secondary];
    const searched = this.getSearchedKeywords();

    const availableKeywords = seedKeywords.filter((kw) => !searched.includes(kw));

    return `你是「${identity.name}」，${identity.role}。
当前浏览场景：已在${payload.currentPageType === 'search' ? '搜索结果' : '首页'}连续滚动 ${payload.consecutiveScrolls} 次无收获。

兴趣领域：${allInterests.join('、')}
概念池可用关键词：${availableKeywords.length > 0 ? availableKeywords.join('、') : '（已全部搜索过）'}
已搜索过的关键词：${searched.length > 0 ? searched.join('、') : '（无）'}

请决定是否需要搜索新关键词：
- 如果概念池有未搜索的关键词，优先从中选择
- 如果所有关键词都搜索过，可以跳过搜索
- 考虑当前无果次数，判断搜索是否有意义

只输出JSON（不要输出其他内容）：
需要搜索：{"verdict":"search","keyword":"选中的关键词","reason":"简短原因"}
跳过搜索：{"verdict":"skip","reason":"简短原因"}`;
  }

  // ─── 输出解析 ───────────────────────────────────────────────

  private parseOutput(raw: string): SearchEvalResult | null {
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

    if (o.verdict === 'search') {
      const keyword = typeof o.keyword === 'string' ? o.keyword : '';
      const reason = typeof o.reason === 'string' ? o.reason : 'search';
      if (!keyword) return null;
      return { verdict: 'search', keyword, reason };
    } else if (o.verdict === 'skip') {
      const reason = typeof o.reason === 'string' ? o.reason : 'no_need';
      return { verdict: 'skip', reason };
    }

    return null;
  }
}

// ─── 内部类型 ─────────────────────────────────────────────────

interface SearchEvalResultSearch {
  verdict: 'search';
  keyword: string;
  reason: string;
}

interface SearchEvalResultSkip {
  verdict: 'skip';
  reason: string;
}

type SearchEvalResult = SearchEvalResultSearch | SearchEvalResultSkip;
