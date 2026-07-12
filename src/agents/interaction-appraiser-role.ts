/**
 * InteractionAppraiserRole — 互动评估与执行角色（LLM，事件驱动版）。
 *
 * 职责：评估并执行互动（点赞/收藏）。
 * 消费事件：reading.done
 * 产出事件：interaction.completed（执行了互动）或 interaction.skipped（不互动）
 *
 * 与旧版 InteractionAppraiser 的区别：
 * - 输入从黑板模式改为事件驱动
 * - 输出从 AgentDecision 改为 emit 角色事件
 * - actions 字段为数组，支持同时 like+collect
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { SessionContext } from './session-context.js';
import type { NoteData } from './content-curator-role.js';
import { tieredInterests } from './persona-format.js';
import type { RoleName, ReadingDonePayload } from '../event-bus/types.js';

/**
 * 收藏硬数值阈值（engagement-restraint）：仅当笔记「收藏数 / 点赞数 ≥ 此比例」（默认 1/3）才收藏。
 * 高收藏率=有反复参考 / 保存价值；必要非充分条件——达阈值后仍叠加 LLM 收藏判定 + 风控 / 冷却 / 预算。点赞不受此闸约束。
 * change category-adaptive-images-and-judgment：默认比例是**通用地板**，非「硬核=唯一收藏标准」——审美 / 灵感 / 心情板类
 * 口味（好看即收藏、高赞低藏）的账号应经后台 getMinSaveLikeRatio 钩子调低 / 旁路此比例；仍保留地板存在性与「0 赞不收藏」防线。
 */
export const COLLECT_MIN_SAVE_LIKE_RATIO = 1 / 3;

export interface InteractionAppraiserRoleOptions extends RoleOptions {
  sessionContext: SessionContext;
  getNoteData: (noteId: string) => NoteData | null;
  getRemainingBudget: () => { likes: number; collects: number };
  /** 收藏质量闸比例（后台可配，热加载）；缺省回落 COLLECT_MIN_SAVE_LIKE_RATIO。 */
  getMinSaveLikeRatio?: () => number;
  /**
   * 平台/编排来源闸：返回 false 时不调 LLM、不 emit interaction.completed。
   * 用于 Facebook 这类 shadow-first 平台，确保自然点赞只来自内容评估后的深读链。
   */
  isInteractionEligible?: (noteId: string, sourcePageType: 'feed' | 'search') => { ok: true } | { ok: false; reason: string };
}

export class InteractionAppraiserRole extends BaseRole {
  readonly roleName: RoleName = 'interaction_appraiser';
  private readonly sessionContext: SessionContext;
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private readonly getRemainingBudget: () => { likes: number; collects: number };
  private readonly getMinSaveLikeRatio?: () => number;
  private readonly isInteractionEligible?: (noteId: string, sourcePageType: 'feed' | 'search') => { ok: true } | { ok: false; reason: string };
  private unsubscribers: (() => void)[] = [];

  constructor(options: InteractionAppraiserRoleOptions) {
    super(options);
    if (!options.llm) throw new Error('InteractionAppraiserRole 需要 LlmClient');
    this.sessionContext = options.sessionContext;
    this.getNoteData = options.getNoteData;
    this.getRemainingBudget = options.getRemainingBudget;
    this.getMinSaveLikeRatio = options.getMinSaveLikeRatio;
    this.isInteractionEligible = options.isInteractionEligible;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('reading.done', (p) => this.onReadingDone(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  /**
   * 统一「不互动」出口（change skip-reason-buckets）：每条 skip 打一行带**稳定 token** 的日志
   * （`[interaction_appraiser] skip reason=<token>`），journalctl 可 grep 分桶,区分「设计内克制」
   * (no_budget / model_pass) 与「故障吞赞」(note_data_unavailable / llm_error / parse_failed)。
   * 事件 payload 形状不变(reason 仍是 string),下游(back-to-feed / comment-appraiser)消费不受影响。
   */
  private emitSkip(noteId: string, sourcePageType: 'feed' | 'search', reason: string): void {
    this.log(`skip reason=${reason} note=${noteId}`);
    this.emit('interaction.skipped', { noteId, sourcePageType, reason, ts: Date.now() });
  }

  private async onReadingDone(payload: ReadingDonePayload): Promise<void> {
    const budget = this.getRemainingBudget();

    // 无预算可用，直接 skip（设计内克制：预算耗尽）。
    if (budget.likes <= 0 && budget.collects <= 0) {
      this.emitSkip(payload.noteId, payload.sourcePageType, 'no_budget');
      return;
    }

    const noteData = this.getNoteData(payload.noteId);
    if (!noteData) {
      // 故障：读完瞬间笔记数据取不到（feed 已滚动、currentNote 已被下一篇覆盖）。
      this.emitSkip(payload.noteId, payload.sourcePageType, 'note_data_unavailable');
      return;
    }
    const eligibility = this.isInteractionEligible?.(payload.noteId, payload.sourcePageType);
    if (eligibility && !eligibility.ok) {
      this.emitSkip(payload.noteId, payload.sourcePageType, eligibility.reason);
      return;
    }

    const prompt = this.buildPrompt(noteData, this.readingContext(payload));
    let raw: string;
    try {
      raw = await this.decide(prompt);
    } catch {
      // 故障：判定 LLM 超时/报错。
      this.emitSkip(payload.noteId, payload.sourcePageType, 'llm_error');
      return;
    }

    const result = this.parseOutput(raw, budget, noteData);
    if (!result) {
      // 故障：模型没回合法 JSON。与「模型判 pass」分开计,才能区分吞赞 vs 克制。
      this.emitSkip(payload.noteId, payload.sourcePageType, 'parse_failed');
      return;
    }
    if (result.actions.length === 0) {
      // 设计内克制：模型判 pass（多数普通笔记落这里）。LLM 自由文本原因只进日志、不当稳定 token 透出。
      this.log(`model_pass detail=${result.reason}`);
      this.emitSkip(payload.noteId, payload.sourcePageType, 'model_pass');
      return;
    }

    this.emit('interaction.completed', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: result.actions,
      ts: Date.now(),
    });
    // 会话连续性（change humanize-interaction-prompts）：记下这次真实互动，供后续笔记判定注入
    // 「刚点过什么」的当下状态（有界 recency）。仅记真发生的互动，pass/skip 不记。
    this.sessionContext.recordInteraction(result.actions.join('+'));
  }

  /** 从 reading.done 抽出注入判定 prompt 的「刚读完体验 + 会话状态」（change humanize-interaction-prompts）。 */
  private readingContext(payload: ReadingDonePayload): ReadingContext {
    return {
      imagesBrowsed: payload.imagesBrowsed,
      commentsRead: payload.commentsRead,
      keyPoints: payload.keyPoints,
      visitedCount: this.sessionContext.visitedCount,
      recentInteractions: [...this.sessionContext.recentInteractions],
    };
  }

  // ─── Prompt 构建 ───────────────────────────────────────────

  /** 只读预览（change role-prompt-visibility）：用最小示例数据 + 真实人设渲染真实 prompt，仅供后台查看；不改 buildPrompt 逻辑。 */
  previewPrompt(): string {
    return this.buildPrompt(
      { noteId: '<示例noteId>', title: '<示例标题>', content: '<示例正文，运行时为真实笔记内容>', author: '<示例作者>', likeCount: 0, collectCount: 0 },
      { imagesBrowsed: 3, commentsRead: 0, keyPoints: [], visitedCount: 4, recentInteractions: ['like', 'pass'] },
    );
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）：与 buildPrompt 同源拼接，仅供查看器定位标注；不改 buildPrompt。 */
  personaSegments(): string[] {
    const { identity, interests, behavior_guidelines: bg } = this.soul;
    const collectionPrinciple = bg?.collection_principle ?? COLLECT_PRINCIPLE_FALLBACK;
    const likePrinciple = bg?.like_principle ?? LIKE_PRINCIPLE_FALLBACK;
    const interestsStr = tieredInterests(interests);
    return [`你是「${identity.name}」，${identity.role}。${identity.background}\n语气：${identity.tone}\n\n你的兴趣：${interestsStr}\n收藏标准：${collectionPrinciple}\n点赞标准：${likePrinciple}`];
  }

  private buildPrompt(note: NoteData, ctx: ReadingContext): string {
    const { identity, interests, behavior_guidelines: bg } = this.soul;
    const collectionPrinciple = bg?.collection_principle ?? COLLECT_PRINCIPLE_FALLBACK;
    const likePrinciple = bg?.like_principle ?? LIKE_PRINCIPLE_FALLBACK;
    const interestsStr = tieredInterests(interests);
    const experienceBlock = buildExperienceBlock(ctx);
    const stateBlock = buildStateBlock(ctx);

    // 决策逻辑段只承载**动作空间语义**（选择性层级 + 多数 pass 的克制先验）；
    // 「什么内容够格点 / 藏」的具体口味判据交上文注入的人设「点赞标准 / 收藏标准」派生
    // （change humanize-interaction-prompts：不再对全部账号硬编码同一套知识型 rubric）。
    return `你是「${identity.name}」，${identity.role}。${identity.background}
语气：${identity.tone}

你的兴趣：${interestsStr}
收藏标准：${collectionPrinciple}
点赞标准：${likePrinciple}

当前笔记：
标题：${note.title}
内容：${note.content}
点赞数：${note.likeCount}，收藏数：${note.collectCount}
${experienceBlock}${stateBlock}
你在刷手机，决定对这篇笔记做什么（点赞是选择性互动，收藏是更稀有的选择性互动）：
- like：按你上面的**点赞标准**判断这篇够不够格点；只是泛泛认同、刷过即忘的不点（多数笔记如此）
- collect：按你上面的**收藏标准**判断——更稀有、更谨慎，只有真会反复回看 / 照着做的才收藏
- both：值得收藏的内容几乎也值得点赞，收藏时优先选 both
- pass：不够格互动（多数普通笔记落这里）

只输出JSON：{"action":"like","reason":"简短原因"}
或：{"action":"collect","reason":"简短原因"}
或：{"action":"both","reason":"简短原因"}
或：{"action":"pass","reason":"简短原因"}`;
  }

  // ─── 输出解析 ───────────────────────────────────────────────

  private parseOutput(raw: string, budget: { likes: number; collects: number }, note: NoteData): AppraiserResult | null {
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

    const validActions = new Set(['like', 'collect', 'both', 'pass']);
    if (typeof o.action !== 'string' || !validActions.has(o.action)) {
      return null;
    }

    const reason = typeof o.reason === 'string' ? o.reason : 'interaction_decided';
    const action = o.action as 'like' | 'collect' | 'both' | 'pass';

    // 根据预算过滤可执行的 actions
    const actions: ('like' | 'collect')[] = [];

    if (action === 'like' && budget.likes > 0) {
      actions.push('like');
    } else if (action === 'collect' || action === 'both') {
      // 收藏即点赞：真人收藏几乎都先点赞，且 LLM 实测从不主动选 both（0/40）。
      // 故 collect 与 both 一视同仁——在 like 配额允许下同时点赞，收藏受 collect 配额约束。
      if (budget.likes > 0) actions.push('like');
      // 收藏数值闸：仅当「收藏数 / 点赞数 ≥ 比例阈值」（默认 1:3，后台可配、热加载）才收藏。
      // 点赞数为 0（低流量 / 未加载）视为不达标、保守不收藏；点赞已在上面按其自身逻辑独立执行。
      const minRatio = this.getMinSaveLikeRatio?.() ?? COLLECT_MIN_SAVE_LIKE_RATIO;
      if (budget.collects > 0 && note.likeCount > 0 && note.collectCount >= note.likeCount * minRatio) {
        actions.push('collect');
      }
    }
    // action === 'pass' → actions 为空

    return { actions, reason };
  }
}

// ─── 内部类型 ─────────────────────────────────────────────────

interface AppraiserResult {
  actions: ('like' | 'collect')[];
  reason: string;
}

/** 注入判定 prompt 的「刚读完体验 + 会话状态」（change humanize-interaction-prompts）。 */
interface ReadingContext {
  imagesBrowsed: number;
  commentsRead: number;
  keyPoints: string[];
  visitedCount: number;
  recentInteractions: string[];
}

// 兜底原则（soul 缺 behavior_guidelines 时）：与「点赞是选择性、收藏更稀有」的框定一致，
// 不出现「轻量高频」等与选择性框定矛盾的表述（change humanize-interaction-prompts）。
const LIKE_PRINCIPLE_FALLBACK = '只在真有共鸣 / 学到具体东西 / 观点让你眼前一亮时才点；普通的、泛泛认同的、刷过即忘的不点';
const COLLECT_PRINCIPLE_FALLBACK = '只有会反复参考、能直接落地复用的硬核内容才收藏，更稀有更谨慎';

/**
 * 「刚读完这篇」的体验片段（change humanize-interaction-prompts）：用真实流动的 imagesBrowsed /
 * commentsRead 作体验信号（数据现成、由 reading.done 透传）。keyPoints 为**非空才注入**的休眠钩子——
 * 当前浏览闭环里 reading.done 的 keyPoints 恒为空（唯一发出者 comment_reviewer 硬编码 []），
 * 待将来有深读角色真产出要点后自动生效；空则省略，绝不编造占位。全部信号都无时整段省略。
 */
function buildExperienceBlock(ctx: ReadingContext): string {
  const parts: string[] = [];
  if (ctx.imagesBrowsed > 0) parts.push(`翻了 ${ctx.imagesBrowsed} 张图`);
  if (ctx.commentsRead > 0) parts.push('扫了下评论区');
  const keyPoints = ctx.keyPoints.filter(Boolean).slice(0, 3);
  let line = '';
  if (parts.length) line += `你刚读完这篇：${parts.join('、')}`;
  if (keyPoints.length) line += `${line ? '；' : '你刚读完这篇：'}印象最深的是 ${keyPoints.join('；')}`;
  return line ? `\n${line}。\n` : '';
}

/** 会话状态片段（change humanize-interaction-prompts）：本场已看过多少篇 + 最近点过什么，给判定引入序列依赖。 */
function buildStateBlock(ctx: ReadingContext): string {
  if (ctx.visitedCount <= 0 && ctx.recentInteractions.length === 0) return '';
  let line = `本场你已经看过 ${ctx.visitedCount} 篇笔记`;
  if (ctx.recentInteractions.length) line += `，最近几次互动：${ctx.recentInteractions.join('、')}`;
  return `${line}。\n`;
}
