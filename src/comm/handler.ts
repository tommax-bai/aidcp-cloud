/**
 * 默认边-云消息处理器：把协议消息接到云端三大能力。
 *
 * - plan.request   → TaskPlanner（规划层）
 * - select.request → LlmClient（文本模型做选择题）
 * - anchor.get     → PgAnchorCache.get（主缓存）
 * - anchor.report  → 反污染晋升（命中统计 / 暂存→确认→晋升）
 * - hello          → 分配会话，回 welcome
 * - ping           → pong
 *
 * 所有外部能力都通过接口注入，便于单测打桩（无需真实 PG / 模型 / 网络）。
 */

import {
  makeEnvelope,
  type Envelope,
  type SelectRequestPayload,
  type PlanRequestPayload,
  type AnchorGetPayload,
  type AnchorReportPayload,
  type HelloPayload,
  type RemoteElement,
  type NoteContentPayload,
  type PublishApprovalRequestPayload,
  type RiskCanDoPayload,
  type RiskRecordPayload,
} from './protocol.js';
import type { MessageHandler, EdgeSession, EdgePusher } from './ws-server.js';
import type { TaskPlanner } from '../planner/types.js';
import type { LlmClient } from '../llm/qwen.js';
import { buildPublishApprovalCard } from '../feishu/cards.js';
import type { FeishuMessenger } from '../feishu/messenger.js';
import type { BotChatStore } from '../cache/bot-chat-store.js';
import { RiskController, SessionBudget } from '../risk/index.js';
import type { RiskAction } from '../risk/index.js';

/** 锚点缓存的最小接口（PgAnchorCache 实现它，单测可打桩） */
export interface AnchorStore {
  get(actionId: string): Promise<import('./protocol.js').RemoteAnchor | null>;
  recordHit(actionId: string): Promise<void>;
  recordFailure(actionId: string): Promise<void>;
  stage(anchor: import('./protocol.js').RemoteAnchor): Promise<void>;
  confirmStaged(actionId: string): Promise<{ promoted: boolean; successes: number; needed: number }>;
  dropStaged(actionId: string): Promise<void>;
}

export interface SessionRouter {
  onNote(note: NoteContentPayload): Promise<unknown>;
}

export interface HandlerDeps {
  planner: TaskPlanner;
  llm: LlmClient;
  cache: AnchorStore;
  messenger?: Pick<FeishuMessenger, 'sendApprovalCard'>;
  botChatStore?: Pick<BotChatStore, 'getDefaultChat'>;
  approvalChatId?: string;
  logger?: Pick<Console, 'error' | 'warn' | 'log'>;
  clock?: () => number;
  serverVersion?: string;
  session?: SessionRouter;
  riskController?: RiskController;
}

/** 把元素清单渲染成给 LLM 的编号列表（与 edge selector 一致的格式） */
export function renderElementList(elements: RemoteElement[]): string {
  return elements
    .map((el) => {
      const attrs = Object.entries(el.attributes)
        .filter(([k]) => k !== 'value')
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      const text = el.text ? ` "${el.text}"` : '';
      return `[${el.index}] <${el.tag} role=${el.role}${text}${attrs ? ' ' + attrs : ''}>`;
    })
    .join('\n');
}

export function buildSelectionPrompt(goal: string, elements: RemoteElement[]): string {
  return [
    '你是页面元素定位助手。下面是当前页面（或当前作用域）内的可交互元素清单。',
    '请从清单中选出最符合目标的唯一元素编号。',
    '只输出一个整数编号；如果没有任何元素符合目标，输出 -1。不要输出其他文字。',
    '',
    `目标：${goal}`,
    '',
    '元素清单：',
    renderElementList(elements),
    '',
    '编号：',
  ].join('\n');
}

/** 从模型输出解析整数编号 */
export function parseIndex(raw: string): number | null {
  const m = raw.match(/-?\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isNaN(n) ? null : n;
}

export class DefaultMessageHandler implements MessageHandler {
  private readonly clock: () => number;
  private readonly serverVersion: string;
  private readonly logger: Pick<Console, 'error' | 'warn' | 'log'>;
  private readonly riskController: RiskController;

  constructor(private readonly deps: HandlerDeps) {
    this.clock = deps.clock ?? Date.now;
    this.serverVersion = deps.serverVersion ?? '0.1.0';
    this.logger = deps.logger ?? console;
    this.riskController = deps.riskController ?? new RiskController();
  }

  async handle(
    env: Envelope,
    session: EdgeSession,
    pusher?: EdgePusher,
  ): Promise<Envelope | null> {
    switch (env.type) {
      case 'hello':
        return this.onHello(env, session);
      case 'ping':
        return makeEnvelope('pong', env.id, this.clock(), {});
      case 'plan.request':
        return this.onPlan(env, pusher);
      case 'select.request':
        return this.onSelect(env);
      case 'anchor.get':
        return this.onAnchorGet(env);
      case 'anchor.report':
        return this.onAnchorReport(env);
      case 'note.content':
        if (this.deps.session) {
          // 字段映射：edge payload (likes/collects/body) → IncomingNote (likeCount/collectCount/summary)
          const p = env.payload as Record<string, unknown>;
          const incomingNote = {
            noteId: (p.noteId as string) || '',
            title: (p.title as string) || '',
            summary: (p.body as string) || (p.summary as string) || '',
            likeCount: (p.likes as number) ?? (p.likeCount as number) ?? 0,
            collectCount: (p.collects as number) ?? (p.collectCount as number) ?? 0,
            author: (p.author as string) || undefined,
          };
          const outcome = await this.deps.session.onNote(incomingNote).catch(() => null) as { envelope?: Envelope } | null;
          if (outcome?.envelope) {
            // 用请求的 id 回包，让 edge request/response 关联上
            return { ...outcome.envelope, id: env.id };
          }
        }
        return makeEnvelope('browse.next', env.id, this.clock(), { reason: 'no_session' });
      case 'publish.approval_request':
        await this.onPublishApprovalRequest(env, session);
        return null;
      case 'session.budget.request':
        return this.onSessionBudgetRequest(env);
      case 'risk.canDo':
        return this.onRiskCanDo(env);
      case 'risk.record':
        return this.onRiskRecord(env);
      case 'action.result':
        // 观测类消息：记录即可，不强制回包
        return null;
      default:
        return makeEnvelope('error', env.id, this.clock(), {
          code: 'unsupported_type',
          message: `不支持的消息类型: ${env.type}`,
        });
    }
  }

  private onHello(env: Envelope, session: EdgeSession): Envelope {
    const p = env.payload as HelloPayload;
    session.edgeId = p.edgeId;
    session.app = p.app;
    return makeEnvelope('welcome', env.id, this.clock(), {
      sessionId: session.sessionId,
      serverVersion: this.serverVersion,
    });
  }

  private onSessionBudgetRequest(env: Envelope): Envelope {
    const state = this.riskController.getState();
    const budget = new SessionBudget({ quotaLevel: state.quotaLevel });
    return makeEnvelope('session.budget', env.id, this.clock(), {
      ...budget.snapshot(),
      viewOnly: state.status === 'restricted' || state.status === 'frozen',
    });
  }

  private onRiskCanDo(env: Envelope): Envelope {
    const p = env.payload as RiskCanDoPayload;
    const action = p.action as RiskAction;
    const result = this.riskController.explain(action);
    return makeEnvelope('risk.canDo.result', env.id, this.clock(), {
      action,
      allowed: result.allowed,
      reason: result.reason,
    });
  }

  private async onRiskRecord(env: Envelope): Promise<Envelope> {
    const p = env.payload as RiskRecordPayload;
    const action = p.action as RiskAction;
    const recorded = await this.riskController.record(action);
    return makeEnvelope('risk.record.result', env.id, this.clock(), {
      action,
      recorded,
      reason: recorded ? undefined : 'denied',
    });
  }

  private async onPlan(env: Envelope, pusher?: EdgePusher): Promise<Envelope> {
    const p = env.payload as PlanRequestPayload;
    const plan = await this.deps.planner.plan({ goal: p.goal, context: p.context });
    const response = makeEnvelope('plan.response', env.id, this.clock(), {
      steps: plan.steps,
      reason: plan.reason,
    });
    // 控制端（如 trigger-like）可要求把命令主动下发给已上线边缘：
    // context.dispatch === 'edge' 时，把规划结果推给边缘（可选 context.edgeId 定向）。
    if (pusher && p.context && p.context.dispatch === 'edge' && plan.steps.length > 0) {
      const sent = pusher.pushToEdges(response, p.context.edgeId);
      return makeEnvelope('plan.response', env.id, this.clock(), {
        steps: plan.steps,
        reason: plan.reason + ';dispatched_to=' + sent,
      });
    }
    return response;
  }

  private async onSelect(env: Envelope): Promise<Envelope> {
    const p = env.payload as SelectRequestPayload;
    if (!p.elements || p.elements.length === 0) {
      return makeEnvelope('select.response', env.id, this.clock(), {
        index: null,
        reason: 'empty_element_list',
      });
    }
    let raw: string;
    try {
      raw = await this.deps.llm.complete(buildSelectionPrompt(p.goal, p.elements));
    } catch (err) {
      return makeEnvelope('select.response', env.id, this.clock(), {
        index: null,
        reason: `llm_error:${(err as Error).message}`,
      });
    }
    const n = parseIndex(raw);
    if (n === null) {
      return makeEnvelope('select.response', env.id, this.clock(), {
        index: null,
        reason: `unparsable_output:${raw.slice(0, 40)}`,
      });
    }
    if (n < 0) {
      return makeEnvelope('select.response', env.id, this.clock(), {
        index: null,
        reason: 'llm_no_match',
      });
    }
    const exists = p.elements.some((e) => e.index === n);
    if (!exists) {
      return makeEnvelope('select.response', env.id, this.clock(), {
        index: null,
        reason: `index_out_of_range:${n}`,
      });
    }
    return makeEnvelope('select.response', env.id, this.clock(), {
      index: n,
      reason: 'llm_selected',
    });
  }

  private async onAnchorGet(env: Envelope): Promise<Envelope> {
    const p = env.payload as AnchorGetPayload;
    const anchor = await this.deps.cache.get(p.actionId);
    return makeEnvelope('anchor.get.result', env.id, this.clock(), { anchor });
  }

  private async onAnchorReport(env: Envelope): Promise<Envelope | null> {
    const p = env.payload as AnchorReportPayload;
    if (p.source === 'cache') {
      if (p.validated) await this.deps.cache.recordHit(p.actionId);
      else await this.deps.cache.recordFailure(p.actionId);
    } else {
      // llm 来源：反污染暂存→确认→晋升
      if (p.validated && p.candidate) {
        await this.deps.cache.stage(p.candidate);
        await this.deps.cache.confirmStaged(p.actionId);
      } else {
        await this.deps.cache.dropStaged(p.actionId);
      }
    }
    return null;
  }

  private async onPublishApprovalRequest(env: Envelope, session: EdgeSession): Promise<void> {
    const payload = env.payload as Partial<PublishApprovalRequestPayload>;
    if (
      typeof payload.requestId !== 'string' ||
      typeof payload.title !== 'string' ||
      typeof payload.content !== 'string' ||
      !Array.isArray(payload.tags) ||
      payload.tags.some((tag) => typeof tag !== 'string')
    ) {
      throw new Error('invalid_publish_approval_request');
    }
    if (!this.deps.messenger) {
      throw new Error('publish_approval_chat_not_configured');
    }
    this.logger.log('[comm] 收到 publish.approval_request:', {
      requestId: payload.requestId,
      edgeId: payload.edgeId ?? session.edgeId,
      sessionId: session.sessionId,
    });
    let defaultChat = null;
    try {
      defaultChat = await this.deps.botChatStore?.getDefaultChat();
      this.logger.log('[comm] publish.approval_request 默认群查询完成:', {
        requestId: payload.requestId,
        defaultChatId: defaultChat?.chatId ?? null,
        defaultChatName: defaultChat?.chatName ?? null,
      });
    } catch (error) {
      this.logger.warn('[comm] publish.approval_request 默认群查询失败，回退 FEISHU_CHAT_ID:', {
        requestId: payload.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const chatId = defaultChat?.chatId ?? this.deps.approvalChatId ?? process.env.FEISHU_CHAT_ID ?? '';
    if (!chatId) {
      const message = '未配置默认审批群：请先在目标飞书群发送 /bind 设为默认审批群，或配置 FEISHU_CHAT_ID 作为兜底。';
      this.logger.error('[comm] publish.approval_request 缺少目标群:', {
        requestId: payload.requestId,
        edgeId: payload.edgeId ?? session.edgeId,
        hint: message,
      });
      throw new Error(message);
    }
    try {
      this.logger.log('[comm] publish.approval_request 目标群解析完成:', {
        requestId: payload.requestId,
        edgeId: payload.edgeId ?? session.edgeId,
        chatId,
        source: defaultChat?.chatId ? 'bot_chats.default' : this.deps.approvalChatId || process.env.FEISHU_CHAT_ID ? 'env.FEISHU_CHAT_ID' : 'none',
        chatName: defaultChat?.chatName ?? null,
      });
      await this.deps.messenger.sendApprovalCard(
        chatId,
        buildPublishApprovalCard({
          requestId: payload.requestId,
          title: payload.title,
          content: payload.content,
          tags: payload.tags,
        }),
      );
      this.logger.log('[comm] publish.approval_request 发卡成功:', {
        requestId: payload.requestId,
        edgeId: payload.edgeId ?? session.edgeId,
        chatId,
      });
    } catch (error) {
      this.logger.error('[comm] publish.approval_request 发卡失败:', {
        requestId: payload.requestId,
        edgeId: payload.edgeId ?? session.edgeId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}



