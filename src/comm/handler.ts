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
} from './protocol.js';
import type { MessageHandler, EdgeSession } from './ws-server.js';
import type { TaskPlanner } from '../planner/types.js';
import type { LlmClient } from '../llm/qwen.js';

/** 锚点缓存的最小接口（PgAnchorCache 实现它，单测可打桩） */
export interface AnchorStore {
  get(actionId: string): Promise<import('./protocol.js').RemoteAnchor | null>;
  recordHit(actionId: string): Promise<void>;
  recordFailure(actionId: string): Promise<void>;
  stage(anchor: import('./protocol.js').RemoteAnchor): Promise<void>;
  confirmStaged(actionId: string): Promise<{ promoted: boolean; successes: number; needed: number }>;
  dropStaged(actionId: string): Promise<void>;
}

export interface HandlerDeps {
  planner: TaskPlanner;
  llm: LlmClient;
  cache: AnchorStore;
  clock?: () => number;
  serverVersion?: string;
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

  constructor(private readonly deps: HandlerDeps) {
    this.clock = deps.clock ?? Date.now;
    this.serverVersion = deps.serverVersion ?? '0.1.0';
  }

  async handle(env: Envelope, session: EdgeSession): Promise<Envelope | null> {
    switch (env.type) {
      case 'hello':
        return this.onHello(env, session);
      case 'ping':
        return makeEnvelope('pong', env.id, this.clock(), {});
      case 'plan.request':
        return this.onPlan(env);
      case 'select.request':
        return this.onSelect(env);
      case 'anchor.get':
        return this.onAnchorGet(env);
      case 'anchor.report':
        return this.onAnchorReport(env);
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

  private async onPlan(env: Envelope): Promise<Envelope> {
    const p = env.payload as PlanRequestPayload;
    const plan = await this.deps.planner.plan({ goal: p.goal, context: p.context });
    return makeEnvelope('plan.response', env.id, this.clock(), {
      steps: plan.steps,
      reason: plan.reason,
    });
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
}
