/**
 * 浏览会话编排器（顶层）：把 Soul + 内容理解 + ManagerAgent 串成一次
 * "自然刷小红书"的会话。
 *
 * 数据流（事件驱动，由边缘上报的 note.content 推进）：
 *   edge 上报 note.content
 *     → 互动决策（硬门槛 + Qwen）得到 like/collect/skip
 *     → 概念抽取（Qwen）把新概念并入概念池 + 持久化
 *     → ContextBuilder 汇总页面/会话/风控上下文
 *     → ManagerAgent 产出下一步命令
 *     → 翻译为协议消息，经 EdgePusher 下发给边缘
 *
 * 设计：编排器不直接依赖网络，命令通过注入的 CommandSink 下发；
 * 概念持久化通过 ConceptPersistence 接口注入（PG 实现或测试桩）。
 * 这样 onNote() 完全可单测（无需真实网络/PG/模型）。
 */

import { makeEnvelope, type Envelope } from '../comm/protocol.js';
import type { EdgePusher } from '../comm/ws-server.js';
import type { Soul } from '../soul/types.js';
import { ConceptExtractor } from './concept-extractor.js';
import { EngagementDecider, type NoteForDecision } from './engagement-decider.js';
import {
  ContextBuilder,
  ManagerAgent,
  type ManagerContext,
  type ManagerDecision,
  type RiskStatus,
  type SessionStats,
} from './manager-agent.js';

export interface ConceptPool {
  known: string[];
  candidates: string[];
  source: Map<string, string>;
}

export function emptyConceptPool(): ConceptPool {
  return { known: [], candidates: [], source: new Map() };
}

/** 概念持久化接口（ConceptStore 实现，测试可打桩） */
export interface ConceptPersistence {
  loadPool(): Promise<ConceptPool>;
  addCandidates(keywords: string[], sourceNote?: string): Promise<string[]>;
  markSearched(keyword: string): Promise<void>;
}

/** 命令下发口：把一条编排命令翻译并送给边缘 */
export interface CommandSink {
  send(env: Envelope): void;
}

/** 用 EdgePusher 作为命令下发口（生产用） */
export function pusherSink(pusher: EdgePusher, edgeId?: string): CommandSink {
  return {
    send(env) {
      pusher.pushToEdges(env, edgeId);
    },
  };
}

/** edge 上报的笔记内容（与协议 NoteContentPayload 对齐的精简结构） */
export interface IncomingNote {
  noteId: string;
  title: string;
  summary: string;
  likeCount: number;
  collectCount: number;
  author?: string;
}

/** 处理一条笔记后的结果（观测/测试用） */
export interface NoteOutcome {
  action: 'like' | 'collect' | 'skip';
  reason: string;
  newConcepts: string[];
  command: ManagerDecision;
  envelope: Envelope;
  context: ManagerContext;
}

export interface SessionOrchestratorOptions {
  soul: Soul;
  decider: EngagementDecider;
  extractor: ConceptExtractor;
  sink: CommandSink;
  manager?: ManagerAgent;
  contextBuilder?: ContextBuilder;
  /** 概念持久化（可选；不传则只用内存概念池） */
  persistence?: ConceptPersistence;
  clock?: () => number;
  rng?: () => number;
  idGen?: () => string;
}

/** 浏览会话编排器 */
export class SessionOrchestrator {
  private readonly soul: Soul;
  private readonly decider: EngagementDecider;
  private readonly extractor: ConceptExtractor;
  private readonly manager: ManagerAgent;
  private readonly contextBuilder: ContextBuilder;
  private readonly sink: CommandSink;
  private readonly persistence?: ConceptPersistence;
  private readonly clock: () => number;
  private readonly idGen: () => string;
  private seq = 0;
  private startedAt = 0;
  private stats!: SessionStats;
  private pool: ConceptPool = emptyConceptPool();

  constructor(options: SessionOrchestratorOptions) {
    this.soul = options.soul;
    this.decider = options.decider;
    this.extractor = options.extractor;
    this.manager = options.manager ?? new ManagerAgent({ soul: options.soul });
    this.contextBuilder = options.contextBuilder ?? new ContextBuilder();
    this.sink = options.sink;
    if (options.persistence) this.persistence = options.persistence;
    this.clock = options.clock ?? Date.now;
    this.idGen = options.idGen ?? (() => `sess-cmd-${++this.seq}`);
  }

  /** 当前会话快照 */
  get session(): SessionStats {
    return this.stats;
  }

  get done(): boolean {
    return false;
  }

  /**
   * 启动一次会话：从持久化载入概念池（若有），初始化统计。
   * 不主动下发命令——首条命令由 onNote 的反馈驱动，或调用 kick() 触发首刷。
   */
  async start(): Promise<void> {
    let pool: ConceptPool = emptyConceptPool();
    if (this.persistence) {
      pool = await this.persistence.loadPool();
    }
    this.pool = pool;
    this.startedAt = this.clock();
    this.stats = {
      startedAt: this.startedAt,
      durationMs: 0,
      views: 0,
      likes: 0,
      collects: 0,
      searches: 0,
      follows: 0,
    };
  }

  /** 触发首条 browse_next，让边缘开始刷流 */
  kick(): Envelope {
    const env = this.toEnvelope({ action: 'browse_next', reason: 'session_start' });
    this.sink.send(env);
    return env;
  }

  /**
   * 处理一条边缘上报的笔记：决策 → 抽概念 → ManagerAgent → 下发下一步命令。
   */
  async onNote(note: IncomingNote): Promise<NoteOutcome> {
    console.log(`[soul] 收到笔记: "${note.title}" (likes=${note.likeCount}, collects=${note.collectCount})`);
    const decisionInput: NoteForDecision = {
      title: note.title,
      summary: note.summary,
      likeCount: note.likeCount,
      collectCount: note.collectCount,
    };
    const decision = await this.decider.decide(decisionInput);
    console.log(`[soul] 决策: ${decision.action} (${decision.reason})`);

    // 概念抽取（只对值得看的内容抽，skip 的低质内容不浪费模型）
    const pool = this.pool;
    let newConcepts: string[] = [];
    if (decision.action !== 'skip') {
      const ex = await this.extractor.extract(
        { title: note.title, summary: note.summary },
        pool,
        note.title,
      );
      newConcepts = ex.newConcepts;
    }
    // 决策器顺带给的新概念也并入
    if (decision.newConcepts) {
      for (const c of decision.newConcepts) {
        if (!pool.known.includes(c) && !pool.candidates.includes(c)) {
          pool.candidates.push(c);
          pool.source.set(c, note.title);
          newConcepts.push(c);
        }
      }
    }
    if (newConcepts.length > 0 && this.persistence) {
      await this.persistence.addCandidates(newConcepts, note.title).catch(() => {});
    }

    this.stats.views++;
    if (decision.action === 'like') this.stats.likes++;
    if (decision.action === 'collect') this.stats.collects++;
    this.stats.durationMs = this.clock() - this.startedAt;

    const context = this.contextBuilder.build({
      pageType: 'note',
      loginState: 'unknown',
      note: {
        noteId: note.noteId,
        title: note.title,
        content: note.summary ?? '',
        author: note.author ?? '',
        likeCount: note.likeCount,
        collectCount: note.collectCount,
        isLiked: false,
        isCollected: false,
      },
      sessionStats: this.stats,
      riskStatus: this.riskStatus(),
    });
    const command = await this.manager.decide(context);

    if (command.action === 'search') {
      this.stats.searches++;
      const keyword = command.params?.keyword;
      if (typeof keyword === 'string' && this.persistence) {
        await this.persistence.markSearched(keyword).catch(() => {});
      }
    }

    const envelope = this.toEnvelope(command);
    // 将 like/collect 动作附加到 envelope payload 中，让 edge 知道要执行互动
    if (decision.action !== 'skip') {
      (envelope.payload as Record<string, unknown>).action = decision.action;
    }
    this.sink.send(envelope);
    return {
      action: decision.action,
      reason: decision.reason,
      newConcepts,
      command,
      envelope,
      context,
    };
  }

  private riskStatus(): RiskStatus {
    const maxLikes = this.soul.session_limits?.max_likes ?? this.soul.browse_patterns?.session?.max_likes ?? 8;
    const maxSearches = this.soul.session_limits?.max_searches ?? this.soul.browse_patterns?.session?.max_searches ?? 3;
    return {
      status: 'normal',
      quotaLevel: 'normal',
      remainingActionsToday: {
        view: Number.MAX_SAFE_INTEGER,
        like: Math.max(0, maxLikes - this.stats.likes),
        collect: Math.max(0, maxLikes - this.stats.collects),
        search: Math.max(0, maxSearches - this.stats.searches),
        follow: Number.MAX_SAFE_INTEGER,
      },
      viewOnly: false,
    };
  }

  /** 把 ManagerAgent 命令翻译成协议信封 */
  private toEnvelope(command: ManagerDecision): Envelope {
    const now = this.clock();
    switch (command.action) {
      case 'browse_next':
        return makeEnvelope('browse.next', this.idGen(), now, { reason: command.reason });
      case 'scroll':
        return makeEnvelope('browse.scroll', this.idGen(), now, { reason: command.reason });
      case 'open_note':
        return makeEnvelope('note.open', this.idGen(), now, {
          noteId: typeof command.params?.noteId === 'string' ? command.params.noteId : undefined,
          index: typeof command.params?.index === 'number' ? command.params.index : undefined,
          reason: command.reason,
        });
      case 'close_note':
        return makeEnvelope('note.close', this.idGen(), now, { reason: command.reason });
      case 'like':
      case 'collect':
        return makeEnvelope('browse.next', this.idGen(), now, { reason: command.reason });
      case 'search':
        const keyword = typeof command.params?.keyword === 'string' ? command.params.keyword : this.soul.interests.seed_keywords[0] ?? '';
        return makeEnvelope('search.execute', this.idGen(), now, {
          keyword,
          source: 'manager',
          maxResults: this.soul.session_limits?.max_searches ?? this.soul.browse_patterns?.session?.max_searches ?? 3,
        });
      case 'end_session':
        return makeEnvelope('session.end', this.idGen(), now, {
          reason: command.reason,
          stats: {
            likedCount: this.stats.likes,
            skippedCount: Math.max(0, this.stats.views - this.stats.likes - this.stats.collects),
            searchCount: this.stats.searches,
            durationMs: now - this.startedAt,
          },
        });
    }
  }
}
