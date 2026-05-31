/**
 * 浏览会话状态机（Soul.browse_patterns 的运行时实现）。
 *
 * 职责：
 * - 维护一次浏览会话的状态（browse / search / idle / done）与计数；
 * - 吃边缘上报的动作结果（liked / skipped / browsed），更新计数与概念池；
 * - 依据 soul 配置的状态迁移规则评估下一步，产出一条编排命令
 *   （browse_next / search / like / skip / end_session）；
 * - 强制会话上限（时长 / 点赞数 / 搜索数），到顶即结束；
 * - 为下一步附带一个随机冷却（3-8 秒，区间取自 soul.session）。
 *
 * 该模块是纯逻辑（不碰网络/模型/DB），完全可单测：时钟与随机数都可注入。
 */

import type { Soul, SearchSource } from '../soul/types.js';

/** 概念池：已搜过的（known）+ 待搜队列（candidates）+ 概念→来源笔记标题 */
export interface ConceptPool {
  known: string[];
  candidates: string[];
  source: Map<string, string>;
}

/** 一次浏览会话的可变状态 */
export interface BrowseSession {
  state: 'browse' | 'search' | 'idle' | 'done';
  likedCount: number;
  skippedCount: number;
  searchCount: number;
  startedAt: number;
  likedTopics: string[];
  conceptPool: ConceptPool;
  /** search 状态下已浏览的结果数（达 max 回到 browse） */
  searchResultsBrowsed: number;
  /** 会话内累计点赞总数（用于 max_likes 硬上限；迁移不清零，与 likedCount 区分） */
  totalLikes: number;
}

/** 边缘上报的动作结果种类 */
export type ActionResultKind = 'liked' | 'skipped' | 'browsed';

/** 喂给状态机的一次动作结果 */
export interface ActionFeedback {
  kind: ActionResultKind;
  /** liked 时附带的笔记标题（用于 extract_from_liked 的搜索来源） */
  topic?: string;
  /** 本次是否发现了新概念（驱动 found_new_concept 迁移） */
  foundNewConcept?: boolean;
}

/** 状态机产出的下一步命令 */
export type NextCommand =
  | { kind: 'browse_next'; cooldownSec: number; reason: string }
  | { kind: 'search'; keyword: string; source: SearchSource; cooldownSec: number; reason: string }
  | { kind: 'end_session'; reason: string };

export interface StateMachineOptions {
  soul: Soul;
  /** 注入时钟（默认 Date.now），便于测时长上限 */
  clock?: () => number;
  /** 注入随机数 [0,1)（默认 Math.random），便于测冷却/随机选词 */
  rng?: () => number;
}

/** 创建一个空概念池 */
export function emptyConceptPool(): ConceptPool {
  return { known: [], candidates: [], source: new Map() };
}

/** 创建一个初始浏览会话（默认从 browse 起步） */
export function createSession(now: number, pool: ConceptPool = emptyConceptPool()): BrowseSession {
  return {
    state: 'browse',
    likedCount: 0,
    skippedCount: 0,
    searchCount: 0,
    startedAt: now,
    likedTopics: [],
    conceptPool: pool,
    searchResultsBrowsed: 0,
    totalLikes: 0,
  };
}

export class BrowseStateMachine {
  private readonly soul: Soul;
  private readonly clock: () => number;
  private readonly rng: () => number;
  readonly session: BrowseSession;

  constructor(options: StateMachineOptions, session?: BrowseSession) {
    this.soul = options.soul;
    this.clock = options.clock ?? Date.now;
    this.rng = options.rng ?? Math.random;
    this.session = session ?? createSession(this.clock());
  }

  /** 当前会话是否已结束 */
  get done(): boolean {
    return this.session.state === 'done';
  }

  /** 随机冷却秒数（取自 soul.session.cooldown_between_actions_sec 区间，含端点） */
  private cooldown(): number {
    const [min, max] = this.soul.browse_patterns.session.cooldown_between_actions_sec;
    if (max <= min) return min;
    return min + Math.floor(this.rng() * (max - min + 1));
  }

  /** 是否触达任一会话硬上限 */
  private overLimit(): string | null {
    const s = this.soul.browse_patterns.session;
    const elapsedMin = (this.clock() - this.session.startedAt) / 60000;
    if (elapsedMin >= s.max_duration_min) return 'max_duration_reached';
    if (this.session.totalLikes >= s.max_likes) return 'max_likes_reached';
    if (this.session.searchCount >= s.max_searches) return 'max_searches_reached';
    return null;
  }

  /**
   * 吃一次动作结果，更新状态，返回下一步命令。
   * 调用方负责把命令翻译为协议消息下发给边缘。
   */
  feed(feedback: ActionFeedback): NextCommand {
    if (this.session.state === 'done') {
      return { kind: 'end_session', reason: 'already_done' };
    }

    this.applyFeedback(feedback);

    // 任一硬上限触发 → 结束会话
    const limit = this.overLimit();
    if (limit) {
      this.session.state = 'done';
      return { kind: 'end_session', reason: limit };
    }

    return this.session.state === 'search'
      ? this.stepSearch(feedback)
      : this.stepBrowse();
  }

  /** 把反馈并入会话计数与概念/话题池 */
  private applyFeedback(feedback: ActionFeedback): void {
    switch (feedback.kind) {
      case 'liked':
        this.session.likedCount++;
        this.session.totalLikes++;
        if (feedback.topic) this.session.likedTopics.push(feedback.topic);
        break;
      case 'skipped':
        this.session.skippedCount++;
        break;
      case 'browsed':
        if (this.session.state === 'search') this.session.searchResultsBrowsed++;
        break;
    }
  }

  /** browse 状态：评估迁移规则，决定继续刷还是发起搜索 */
  private stepBrowse(): NextCommand {
    const def = this.soul.browse_patterns.states.browse;
    for (const tr of def.transitions ?? []) {
      if (!this.triggerFires(tr.trigger)) continue;
      if (tr.to === 'search') {
        const cmd = this.enterSearch(tr.search_source ?? 'random_from_interests', tr.trigger);
        if (cmd) return cmd;
        // 没有可用关键词 → 不迁移，继续刷
      }
    }
    return { kind: 'browse_next', cooldownSec: this.cooldown(), reason: 'browse_continue' };
  }

  /** search 状态：浏览够 max_results 或无优质结果就回到 browse */
  private stepSearch(feedback: ActionFeedback): NextCommand {
    const def = this.soul.browse_patterns.states.search;
    const max = def.max_results_to_browse ?? 3;
    const noQuality = feedback.kind === 'skipped' && this.session.searchResultsBrowsed === 0;
    if (this.session.searchResultsBrowsed >= max || noQuality) {
      this.session.state = 'browse';
      this.session.searchResultsBrowsed = 0;
      return {
        kind: 'browse_next',
        cooldownSec: this.cooldown(),
        reason: noQuality ? 'no_quality_results' : 'browsed_all_results',
      };
    }
    return { kind: 'browse_next', cooldownSec: this.cooldown(), reason: 'search_browse_more' };
  }

  /** 评估一个 trigger 字符串是否成立（支持 count 比较与具名事件） */
  private triggerFires(trigger: string): boolean {
    // 支持 >= 和 <= 比较
    const cmpGe = trigger.match(/^(\w+)\s*>=\s*(\d+)$/);
    if (cmpGe) {
      const value = this.counterValue(cmpGe[1]);
      return value !== null && value >= Number.parseInt(cmpGe[2], 10);
    }
    const cmpLe = trigger.match(/^(\w+)\s*<=\s*(\d+)$/);
    if (cmpLe) {
      const value = this.counterValue(cmpLe[1]);
      return value !== null && value <= Number.parseInt(cmpLe[2], 10);
    }
    if (trigger === 'found_new_concept') {
      return this.session.conceptPool.candidates.length > 0;
    }
    return false;
  }

  private counterValue(name: string): number | null {
    switch (name) {
      case 'liked_count':
        return this.session.likedCount;
      case 'skipped_count':
        return this.session.skippedCount;
      case 'search_count':
        return this.session.searchCount;
      case 'total_browsed':
        return this.session.likedCount + this.session.skippedCount;
      case 'relevance_rate': {
        // 相关率：liked / (liked + skipped)，百分比整数
        const total = this.session.likedCount + this.session.skippedCount;
        if (total < 10) return 100; // 样本不足时不触发（返回高值）
        return Math.round((this.session.likedCount / total) * 100);
      }
      default:
        return null;
    }
  }

  /**
   * 进入 search 状态：按来源策略选出关键词。
   * 选不出关键词时返回 null（调用方应保持 browse）。
   */
  private enterSearch(source: SearchSource, trigger: string): NextCommand | null {
    const keyword = this.pickKeyword(source);
    if (!keyword) return null;
    this.session.state = 'search';
    this.session.searchCount++;
    this.session.searchResultsBrowsed = 0;
    // 计数清零：迁移后重新累计，避免反复触发同一迁移
    if (trigger.startsWith('liked_count')) this.session.likedCount = 0;
    if (trigger.startsWith('skipped_count')) this.session.skippedCount = 0;
    // 标记关键词已搜
    this.markSearched(keyword);
    return {
      kind: 'search',
      keyword,
      source,
      cooldownSec: this.cooldown(),
      reason: `enter_search:${trigger}`,
    };
  }

  /** 按来源策略选关键词 */
  private pickKeyword(source: SearchSource): string | null {
    switch (source) {
      case 'new_concept':
        return this.nextCandidate();
      case 'extract_from_liked': {
        // 优先用最近点赞的话题；没有就退化为兴趣随机
        const topics = this.session.likedTopics.filter((t) => !this.isKnown(t));
        if (topics.length > 0) return topics[topics.length - 1];
        return this.randomInterest();
      }
      case 'random_from_interests':
      default:
        return this.randomInterest();
    }
  }

  /** 取一个未搜过的候选概念 */
  private nextCandidate(): string | null {
    const pool = this.session.conceptPool;
    while (pool.candidates.length > 0) {
      const c = pool.candidates.shift()!;
      if (!this.isKnown(c)) return c;
    }
    return null;
  }

  /** 随机挑一个未搜过的种子关键词/兴趣 */
  private randomInterest(): string | null {
    const seeds = this.soul.interests.seed_keywords.filter((k) => !this.isKnown(k));
    const pool = seeds.length > 0 ? seeds : this.soul.interests.primary.filter((k) => !this.isKnown(k));
    if (pool.length === 0) return null;
    const idx = Math.floor(this.rng() * pool.length);
    return pool[Math.min(idx, pool.length - 1)];
  }

  private isKnown(keyword: string): boolean {
    return this.session.conceptPool.known.includes(keyword);
  }

  private markSearched(keyword: string): void {
    const pool = this.session.conceptPool;
    if (!pool.known.includes(keyword)) pool.known.push(keyword);
    const i = pool.candidates.indexOf(keyword);
    if (i >= 0) pool.candidates.splice(i, 1);
  }

  /** 主动结束会话（达时长/外部停止） */
  end(reason: string): NextCommand {
    this.session.state = 'done';
    return { kind: 'end_session', reason };
  }
}
