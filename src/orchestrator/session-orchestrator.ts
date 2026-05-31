/**
 * 浏览会话编排器（顶层）：把 Soul + 状态机 + 概念抽取 + 互动决策 + 概念持久化
 * 串成一次"自然刷小红书"的会话。
 *
 * 数据流（事件驱动，由边缘上报的 note.content 推进）：
 *   edge 上报 note.content
 *     → 互动决策（硬门槛 + Qwen）得到 like/collect/skip
 *     → 概念抽取（Qwen）把新概念并入概念池 + 持久化
 *     → 喂状态机（liked/skipped/browsed + foundNewConcept）
 *     → 状态机产出下一步命令（browse_next / search / end_session）
 *     → 翻译为协议消息，经 EdgePusher 下发给边缘
 *
 * 设计：编排器不直接依赖网络，命令通过注入的 CommandSink 下发；
 * 概念持久化通过 ConceptPersistence 接口注入（PG 实现或测试桩）。
 * 这样 onNote() 完全可单测（无需真实网络/PG/模型）。
 */

import { makeEnvelope, type Envelope } from '../comm/protocol.js';
import type { EdgePusher } from '../comm/ws-server.js';
import type { Soul } from '../soul/types.js';
import {
  BrowseStateMachine,
  createSession,
  emptyConceptPool,
  type BrowseSession,
  type ConceptPool,
  type NextCommand,
  type ActionFeedback,
} from './state-machine.js';
import { ConceptExtractor } from './concept-extractor.js';
import { EngagementDecider, type NoteForDecision } from './engagement-decider.js';

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
  command: NextCommand;
  envelope: Envelope;
}

export interface SessionOrchestratorOptions {
  soul: Soul;
  decider: EngagementDecider;
  extractor: ConceptExtractor;
  sink: CommandSink;
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
  private readonly sink: CommandSink;
  private readonly persistence?: ConceptPersistence;
  private readonly clock: () => number;
  private readonly rng: () => number;
  private readonly idGen: () => string;
  private seq = 0;
  private machine!: BrowseStateMachine;

  constructor(options: SessionOrchestratorOptions) {
    this.soul = options.soul;
    this.decider = options.decider;
    this.extractor = options.extractor;
    this.sink = options.sink;
    if (options.persistence) this.persistence = options.persistence;
    this.clock = options.clock ?? Date.now;
    this.rng = options.rng ?? Math.random;
    this.idGen = options.idGen ?? (() => `sess-cmd-${++this.seq}`);
  }

  /** 当前会话快照 */
  get session(): BrowseSession {
    return this.machine.session;
  }

  get done(): boolean {
    return this.machine.done;
  }

  /**
   * 启动一次会话：从持久化载入概念池（若有），建状态机。
   * 不主动下发命令——首条命令由 onNote 的反馈驱动，或调用 kick() 触发首刷。
   */
  async start(): Promise<void> {
    let pool: ConceptPool = emptyConceptPool();
    if (this.persistence) {
      pool = await this.persistence.loadPool();
    }
    const session = createSession(this.clock(), pool);
    const opts: { soul: Soul; clock: () => number; rng: () => number } = {
      soul: this.soul,
      clock: this.clock,
      rng: this.rng,
    };
    this.machine = new BrowseStateMachine(opts, session);
  }

  /** 触发首条 browse_next，让边缘开始刷流 */
  kick(): Envelope {
    const env = this.toEnvelope({
      kind: 'browse_next',
      cooldownSec: 0,
      reason: 'session_start',
    });
    this.sink.send(env);
    return env;
  }

  /**
   * 处理一条边缘上报的笔记：决策 → 抽概念 → 推进状态机 → 下发下一步命令。
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
    const pool = this.machine.session.conceptPool;
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

    // 推进状态机
    const feedback: ActionFeedback = {
      kind: decision.action === 'skip' ? 'skipped' : 'liked',
      foundNewConcept: newConcepts.length > 0,
    };
    if (decision.action !== 'skip') feedback.topic = note.title;
    // search 状态下，无论点赞与否都算"浏览了一个结果"
    if (this.machine.session.state === 'search') feedback.kind = 'browsed';

    const command = this.machine.feed(feedback);

    // search 命令需要把关键词写回持久化为 searched
    if (command.kind === 'search' && this.persistence) {
      await this.persistence.markSearched(command.keyword).catch(() => {});
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
    };
  }

  /** 把状态机命令翻译成协议信封 */
  private toEnvelope(command: NextCommand): Envelope {
    const now = this.clock();
    switch (command.kind) {
      case 'browse_next':
        return makeEnvelope('browse.next', this.idGen(), now, { reason: command.reason });
      case 'search':
        return makeEnvelope('search.execute', this.idGen(), now, {
          keyword: command.keyword,
          source: command.source,
          maxResults: this.soul.browse_patterns.states.search?.max_results_to_browse ?? 3,
        });
      case 'end_session':
        return makeEnvelope('session.end', this.idGen(), now, {
          reason: command.reason,
          stats: {
            likedCount: this.machine.session.likedCount,
            skippedCount: this.machine.session.skippedCount,
            searchCount: this.machine.session.searchCount,
            durationMs: now - this.machine.session.startedAt,
          },
        });
    }
  }
}
