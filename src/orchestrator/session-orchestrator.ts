/**
 * 浏览会话编排器（事件驱动 + 黑板 + 多Agent并行 + 仲裁器模式）。
 *
 * 数据流：
 *   EventBus 'note.arrived'
 *     → 更新 sessionStats / riskStatus / availableActions
 *     → 黑板 reset + setInput
 *     → 并行调用所有激活 Agent 的 decide(board)
 *     → 仲裁器 arbitrate(board) 得到 finalCommand
 *     → 翻译为 Envelope，经 CommandSink 下发给边缘
 *     → emit 跨模块事件
 *
 * 设计：
 * - 编排器不直接依赖网络，命令通过注入的 CommandSink 下发；
 * - 所有外部依赖通过构造函数注入，保持可测试性；
 * - 单个 Agent 失败不影响其他 Agent（Promise.allSettled）；
 * - 概念抽取不在 orchestrator 内部执行，通过事件通知外部。
 */

import { makeEnvelope, type Envelope } from '../comm/protocol.js';
import type { EdgePusher } from '../comm/ws-server.js';
import type { Soul } from '../soul/types.js';
import type { EventBus } from '../event-bus/index.js';
import type {
  IncomingNote,
  SessionStats,
  RiskStatus,
  PageType,
  LoginState,
  ManagerActionName,
  ManagerDecision,
  ConceptPool,
} from '../event-bus/types.js';
import type { Blackboard } from '../blackboard/index.js';
import type { Arbiter } from '../blackboard/arbiter.js';
import type { BaseAgent } from '../agents/types.js';

// ─── 公共接口 ────────────────────────────────────────────────────────────────

export interface ConceptPersistence {
  loadPool(): Promise<ConceptPool>;
  addCandidates(keywords: string[], sourceNote?: string): Promise<string[]>;
  markSearched(keyword: string): Promise<void>;
}

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

export interface SessionOrchestratorOptions {
  soul: Soul;
  eventBus: EventBus;
  blackboard: Blackboard;
  agents: BaseAgent[];
  arbiter: Arbiter;
  sink: CommandSink;
  persistence?: ConceptPersistence;
  clock?: () => number;
  idGen?: () => string;
}

// ─── SessionOrchestrator ─────────────────────────────────────────────────────

export class SessionOrchestrator {
  private readonly soul: Soul;
  private readonly eventBus: EventBus;
  private readonly blackboard: Blackboard;
  private readonly agents: BaseAgent[];
  private readonly arbiter: Arbiter;
  private readonly sink: CommandSink;
  private readonly persistence?: ConceptPersistence;
  private readonly clock: () => number;
  private readonly idGen: () => string;

  private seq = 0;
  private startedAt = 0;
  private stats!: SessionStats;
  private pool: ConceptPool = { known: [], candidates: [], source: new Map() };
  private unsubscribe?: () => void;

  constructor(options: SessionOrchestratorOptions) {
    this.soul = options.soul;
    this.eventBus = options.eventBus;
    this.blackboard = options.blackboard;
    this.agents = options.agents;
    this.arbiter = options.arbiter;
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
   * 启动会话：加载概念池、初始化统计、订阅 EventBus。
   */
  async start(): Promise<void> {
    // 加载概念池
    if (this.persistence) {
      this.pool = await this.persistence.loadPool();
    }

    // 初始化统计
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

    // 订阅 note.arrived 事件
    this.unsubscribe = this.eventBus.on('note.arrived', (data) => {
      this.onNoteArrived(data.note).catch((err) => {
        console.error('[SessionOrchestrator] onNoteArrived error:', err);
      });
    });

    // emit session.started
    this.eventBus.emit('session.started', { sessionId: this.idGen() });
  }

  /**
   * 停止会话：取消订阅、emit session.ended。
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.eventBus.emit('session.ended', { stats: { ...this.stats } });
  }

  /** 触发首条 browse_next，让边缘开始刷流 */
  kick(): Envelope {
    const env = this.toEnvelope({ action: 'browse_next', reason: 'session_start' });
    this.sink.send(env);
    return env;
  }

  // ─── 核心处理流程 ──────────────────────────────────────────────────────────

  private async onNoteArrived(note: IncomingNote): Promise<void> {
    console.log(`[soul] 收到笔记: "${note.title}" (likes=${note.likeCount}, collects=${note.collectCount})`);

    // 1. 更新 sessionStats
    this.stats.views++;
    this.stats.durationMs = this.clock() - this.startedAt;

    // 2. 计算 riskStatus
    const risk = this.riskStatus();

    // 3. 计算 availableActions
    const pageType: PageType = 'note';
    const loginState: LoginState = 'unknown';
    const hasNoteContent = !!(note.title || note.summary);
    const availableActions = this.computeAvailableActions(pageType, loginState, risk, hasNoteContent);

    // 4. 黑板 reset + setInput
    this.blackboard.reset();
    this.blackboard.setInput({
      currentNote: note,
      pageType,
      sessionStats: { ...this.stats },
      riskStatus: risk,
      loginState,
      conceptPool: this.pool,
      availableActions,
    });

    // 5. 确定本轮激活 Agent 列表
    const boardState = this.blackboard.getState();
    const activeAgents = this.agents.filter((a) => a.shouldActivate(boardState));

    // 6. 黑板 setExpectedAgents
    this.blackboard.setExpectedAgents(activeAgents.map((a) => a.role));

    // 7. 并行调用所有激活 Agent 的 decide
    const results = await Promise.allSettled(
      activeAgents.map((agent) => agent.decide(boardState))
    );

    // 8. 各 Agent 完成后 writeDecision 到黑板
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        this.blackboard.writeDecision(result.value);
      } else {
        // 失败的 Agent 视为 pass
        console.warn(`[SessionOrchestrator] Agent "${activeAgents[i].role}" failed:`, result.reason);
        this.blackboard.writeDecision({
          agent: activeAgents[i].role,
          action: 'pass',
          reason: 'agent_error',
          confidence: 0,
          ts: this.clock(),
        });
      }
    }

    // 9. 调用 arbiter.arbitrate 得到 finalCommand
    const finalCommand = this.arbiter.arbitrate(boardState);
    this.blackboard.setFinalCommand(finalCommand);

    // 10. 处理互动统计
    if (finalCommand.interaction === 'like') this.stats.likes++;
    if (finalCommand.interaction === 'collect') this.stats.collects++;

    // 11. 处理搜索统计
    if (finalCommand.action === 'search') this.stats.searches++;

    // 12. toEnvelope → sink.send
    const envelope = this.toEnvelope(finalCommand);
    this.sink.send(envelope);

    // emit command.ready
    this.eventBus.emit('command.ready', { command: finalCommand, envelope });

    // 13. emit 跨模块事件
    if (finalCommand.interaction) {
      this.eventBus.emit('interaction.occurred', {
        action: finalCommand.interaction,
        noteId: note.noteId,
      });
    }
  }

  // ─── availableActions 计算 ──────────────────────────────────────────────────

  private computeAvailableActions(
    pageType: PageType,
    loginState: LoginState,
    risk: RiskStatus,
    hasNoteContent: boolean,
  ): ManagerActionName[] {
    const actions: ManagerActionName[] = ['browse_next', 'scroll', 'end_session'];
    if (pageType === 'feed' || pageType === 'search') actions.push('open_note');
    if (pageType === 'note') {
      actions.push('close_note');
      if (loginState !== 'logged_out' && !risk.viewOnly && hasNoteContent) {
        if ((risk.remainingActionsToday.like ?? 0) > 0) actions.push('like');
        if ((risk.remainingActionsToday.collect ?? 0) > 0) actions.push('collect');
      }
    }
    actions.push('search');
    return actions;
  }

  // ─── riskStatus 计算（修复 collect 配额 bug） ───────────────────────────────

  private riskStatus(): RiskStatus {
    const maxLikes = this.soul.session_limits?.max_likes ?? 8;
    const maxCollects = this.soul.session_limits?.max_collects ?? 5;
    const maxSearches = this.soul.session_limits?.max_searches ?? 3;
    return {
      status: 'normal',
      quotaLevel: 'normal',
      remainingActionsToday: {
        view: Number.MAX_SAFE_INTEGER,
        like: Math.max(0, maxLikes - this.stats.likes),
        collect: Math.max(0, maxCollects - this.stats.collects),
        search: Math.max(0, maxSearches - this.stats.searches),
        follow: Number.MAX_SAFE_INTEGER,
      },
      viewOnly: false,
    };
  }

  // ─── toEnvelope ─────────────────────────────────────────────────────────────

  private toEnvelope(command: ManagerDecision): Envelope {
    const now = this.clock();
    let env: Envelope;

    switch (command.action) {
      case 'browse_next':
        env = makeEnvelope('browse.next', this.idGen(), now, { reason: command.reason });
        break;
      case 'scroll':
        env = makeEnvelope('browse.scroll', this.idGen(), now, { reason: command.reason });
        break;
      case 'open_note':
        env = makeEnvelope('note.open', this.idGen(), now, {
          noteId: typeof command.params?.noteId === 'string' ? command.params.noteId : undefined,
          index: typeof command.params?.index === 'number' ? command.params.index : undefined,
          reason: command.reason,
        });
        break;
      case 'close_note':
        env = makeEnvelope('note.close', this.idGen(), now, { reason: command.reason });
        break;
      case 'like':
      case 'collect':
        env = makeEnvelope('browse.next', this.idGen(), now, { reason: command.reason });
        break;
      case 'search': {
        const keyword = typeof command.params?.keyword === 'string'
          ? command.params.keyword
          : this.soul.interests.seed_keywords[0] ?? '';
        env = makeEnvelope('search.execute', this.idGen(), now, {
          keyword,
          source: 'manager',
          maxResults: this.soul.session_limits?.max_searches ?? this.soul.browse_patterns?.session?.max_searches ?? 3,
        });
        break;
      }
      case 'end_session':
        env = makeEnvelope('session.end', this.idGen(), now, {
          reason: command.reason,
          stats: {
            likedCount: this.stats.likes,
            skippedCount: Math.max(0, this.stats.views - this.stats.likes - this.stats.collects),
            searchCount: this.stats.searches,
            durationMs: now - this.startedAt,
          },
        });
        break;
    }

    // 如果有互动附加
    if (command.interaction) {
      (env!.payload as Record<string, unknown>).action = command.interaction;
    }

    return env!;
  }
}
