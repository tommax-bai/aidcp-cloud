import type { QwenChatMessage } from '../llm/qwen.js';
import { QwenClient } from '../llm/qwen.js';
import type { Soul } from '../soul/types.js';

export type PageType = 'feed' | 'note' | 'search' | 'profile' | 'unknown';
export type LoginState = 'logged_in' | 'logged_out' | 'unknown';
export type ManagerActionName =
  | 'browse_next'
  | 'scroll'
  | 'like'
  | 'collect'
  | 'search'
  | 'open_note'
  | 'close_note'
  | 'end_session';

export interface VisibleCard {
  index?: number;
  noteId?: string;
  title?: string;
  summary?: string;
  author?: string;
  likeCount?: number;
  collectCount?: number;
}

export interface PageAttributes {
  visibleCardsRange?: { start: number; end: number };
  visibleCards?: VisibleCard[];
  currentNote?: {
    noteId: string;
    title: string;
    content: string;
    author: string;
    likeCount: number;
    collectCount: number;
    isLiked: boolean;
    isCollected: boolean;
  };
  keyword?: string;
  comments?: string[];
}

export interface SessionStats {
  startedAt: number;
  durationMs: number;
  views: number;
  likes: number;
  collects: number;
  searches: number;
  follows: number;
}

export interface RiskStatus {
  status: string;
  quotaLevel: string;
  remainingActionsToday: Record<string, number>;
  viewOnly: boolean;
}

export interface ManagerContext {
  currentPage: { type: PageType };
  pageAttributes: PageAttributes;
  sessionStats: SessionStats;
  riskStatus: RiskStatus;
  loginState: LoginState;
  availableActions: ManagerActionName[];
}

export interface ManagerDecision {
  action: ManagerActionName;
  params?: Record<string, unknown>;
  reason: string;
}

export interface ContextBuilderInput {
  pageType?: PageType;
  loginState?: LoginState;
  note?: PageAttributes['currentNote'];
  visibleCards?: VisibleCard[];
  keyword?: string;
  comments?: string[];
  sessionStats: SessionStats;
  riskStatus: RiskStatus;
}

export class ContextBuilder {
  build(input: ContextBuilderInput): ManagerContext {
    const pageType = input.pageType ?? (input.note ? 'note' : 'feed');
    const visibleCards = input.visibleCards ?? (input.note ? [] : []);
    return {
      currentPage: { type: pageType },
      pageAttributes: {
        visibleCardsRange: visibleCards.length > 0 ? { start: visibleCards[0].index ?? 0, end: visibleCards[visibleCards.length - 1].index ?? visibleCards.length - 1 } : undefined,
        visibleCards,
        currentNote: input.note,
        keyword: input.keyword,
        comments: input.comments,
      },
      sessionStats: input.sessionStats,
      riskStatus: input.riskStatus,
      loginState: input.loginState ?? 'unknown',
      availableActions: this.availableActions(pageType, input.loginState ?? 'unknown', input.riskStatus, !!input.note),
    };
  }

  private availableActions(
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
}

export interface ManagerAgentOptions {
  soul: Soul;
  client?: Pick<QwenClient, 'chat'>;
  timeoutMs?: number;
}

export class ManagerAgent {
  private readonly client: Pick<QwenClient, 'chat'>;

  constructor(private readonly options: ManagerAgentOptions) {
    this.client = options.client ?? new QwenClient({ model: 'qwen-turbo', timeoutMs: options.timeoutMs ?? 3000 });
  }

  async decide(context: ManagerContext): Promise<ManagerDecision> {
    try {
      const raw = await this.client.chat(this.messages(context));
      return parseManagerDecision(raw, context.availableActions);
    } catch {
      return fallbackDecision();
    }
  }

  private messages(context: ManagerContext): QwenChatMessage[] {
    return [
      {
        role: 'system',
        content: buildRolePrompt(this.options.soul, context),
      },
      {
        role: 'user',
        content: JSON.stringify({
          context,
          availableActions: context.availableActions,
          riskBudget: context.riskStatus.remainingActionsToday,
        }),
      },
    ];
  }
}

function buildRolePrompt(soul: Soul, ctx: ManagerContext): string {
  const bg = soul.behavior_guidelines;
  const limits = soul.session_limits;
  const identity = `${soul.identity.name}，${soul.identity.role}`;
  const loc = soul.identity.background;
  const tone = soul.identity.tone;
  const interestsAll = [...soul.interests.primary, ...soul.interests.secondary].join('、');
  const interestsShort = soul.interests.primary.slice(0, 5).join('、');

  const activeRoles: string[] = [];
  const isFeed = ctx.currentPage.type === 'feed' || ctx.currentPage.type === 'search';
  const isNote = ctx.currentPage.type === 'note';
  if (isFeed) activeRoles.push('FeedScanner');
  if (isNote) activeRoles.push('ContentCurator', 'InteractionAppraiser');
  activeRoles.push('SessionMonitor');

  const pageActions = ctx.availableActions.map((a) => `  - ${a}`).join('\n');
  const budgetStr = JSON.stringify(ctx.riskStatus.remainingActionsToday);
  const mins = Math.floor(ctx.sessionStats.durationMs / 60000);

  const coldStartNote = ctx.sessionStats.views < 5
    ? '【冷启动阶段（views<5）】：禁止互动（like/collect），只浏览。'
    : '';

  const budgetWarning = (ctx.riskStatus.remainingActionsToday.like ?? 0) <= 2 || (ctx.riskStatus.remainingActionsToday.collect ?? 0) <= 1
    ? '【预算紧迫】：互动额度不足，建议只浏览或结束会话。'
    : '';

  return `你扮演一个真实人类用户「${identity}」，${loc}。我的语气是「${tone}」。
我正在小红书浏览内容。我的兴趣在于「${interestsAll}」，尤其关注「${interestsShort}」。
我的行为习惯：${bg?.style || '随意浏览，不轻易互动'}。
收藏标准：${bg?.collection_principle || '值得反复参考、可直接落地执行'}。
点赞标准：${bg?.like_principle || '学到了新东西或观点受启发'}。
隐私策略：${bg?.privacy || '不盲目回关，只收藏有复用价值的硬核内容'}。

---
【决策角色链】（按顺序激活：${activeRoles.join(' → ')}）

1. SessionMonitor（始终优先）：
   - 已浏览 ${ctx.sessionStats.views} 次，会话 ${mins} 分钟。
   - 剩余预算：${budgetStr}。上限：${limits?.max_duration_min || 10}分钟 / ${limits?.max_likes || 8}赞 / ${limits?.max_collects || 5}藏 / ${limits?.max_searches || 3}搜。
   - ${coldStartNote}
   - ${budgetWarning}

2. ${isFeed ? 'FeedScanner（当前在 feed/search，负责从列表中筛选值得打开的卡片）：\n' +
     '   - 评估可见卡片的标题、作者、点赞数、收藏数。\n' +
     '   - 优先选择与 AI/LLM/技术相关的标题。\n' +
     '   - 互动数据太差的（如点赞=0 且无收藏）直接 scroll。\n' +
     '   - 你给出的 action 只能是 open_note(index) 或 scroll。' : 'FeedScanner（当前不是列表页，不活跃）'}

3. ${isNote ? 'ContentCurator（当前在 note 详情页，评估内容质量）：\n' +
     '   - 评估笔记内容是否有具体细节、真实案例、数据支撑。\n' +
     '   - 判断作者是否原创（有真实经验、非广告）。\n' +
     '   - 若质量低（空洞、标题党、广告），action = close_note。\n' +
     '   - 只有质量过关，才能进入 InteractionAppraiser。' : 'ContentCurator（当前不在详情页，不活跃）'}

4. ${isNote ? 'InteractionAppraiser（仅当 ContentCurator 通过时激活）：\n' +
     '   - collect：内容值得反复查看、有实操步骤、代码/配置、架构图等可复用知识 → 优先 collect。\n' +
     '   - like：内容有启发但不需反复参考 → like。\n' +
     '   - close_note：内容过关但对你无解 → 跳过。\n' +
     '   - collect 比 like 更稀有，更谨慎。' : 'InteractionAppraiser（当前不在详情页，不活跃）'}

5. Role: CommentReviewer（如果加载了评论区 → 辅助评分）
   - top 3 评论：负面/spam → downgrade；有价值补充 → boost。
   - 无评论时不激活。

---
【可用动作】（只能选一个）：
${pageActions}

---
【输出格式】仅输出 JSON，不要任何解释、markdown、代码块：
{"action":"browse_next|scroll|like|collect|search|open_note|close_note|end_session","params":{},"reason":"[角色名标注] 简短原因，如 [ContentCurator] 内容空洞 → [SessionMonitor] 继续浏览"}
- search 必须传 params.keyword；
- open_note 必须传 params.index（0-based 卡片序号）。`;
}

export function fallbackDecision(): ManagerDecision {
  return { action: 'browse_next', reason: 'manager_fallback' };
}

export function parseManagerDecision(raw: string, availableActions: ManagerActionName[]): ManagerDecision {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return fallbackDecision();
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return fallbackDecision();
  }
  if (!data || typeof data !== 'object') return fallbackDecision();
  const obj = data as Record<string, unknown>;
  if (typeof obj.action !== 'string' || !availableActions.includes(obj.action as ManagerActionName)) {
    return fallbackDecision();
  }
  const action = obj.action as ManagerActionName;
  const params = obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)
    ? obj.params as Record<string, unknown>
    : {};
  if (action === 'search' && (typeof params.keyword !== 'string' || params.keyword.trim() === '')) {
    return fallbackDecision();
  }
  if (action === 'open_note' && params.index !== undefined && typeof params.index !== 'number') {
    return fallbackDecision();
  }
  return {
    action,
    params,
    reason: typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : 'manager_selected',
  };
}
