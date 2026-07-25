/**
 * CuratedCommentEvaluator — 「评论进精选」评估角色（**独立于正文角色**，LLM）。
 * change curated-admission-eval-roles（Phase 3）。
 *
 * 流程（消费 comment_like.confirmed，Phase 2b 起带 likeCount）：
 *   ① 评论第一段共鸣预筛（passesCommentResonance）——评论赞数达地板 ∪ 已确认点赞；
 *      本事件即「已确认点赞」(confirmedLike=true) → 恒过预筛，放行进第二段；
 *   ② LLM 评估评论：相关性（对账号领域）+ 作为「角度/口吻范例」的借鉴价值 + 非水评/广告；
 *   ③ admit ∧ relevanceOk ∧ exemplarValueOk ∧ !isSpamOrPromo → curatedStore.archiveComment。
 *
 * 与正文角色拆开：判定标准 / prompt 完全不同（评论看「借鉴价值」而非「内容丰富度」）。
 * 取代 server.ts 评论双写里直接 archiveComment 那段；valuableCommentStore.archive（写评论用语料）行为不变（仍在原闭包）。
 *
 * 红线：诚实（LLM 降级/解析失败 → 不纳入）；fire-and-forget（不抛、不阻塞）；评估只跑预筛幸存者（成本红线）。
 *
 * 消费事件：comment_like.confirmed
 * 副作用：curatedStore.archiveComment（落精选语料 content_type='comment'，账号维度）。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { NoteData } from '../kernel/note-detail.js';
import { topicKeysFromTitle } from '../kernel/valuable-comment-types.js';
import { passesCommentResonance, resolveCuratedGateConfig } from '../publish-agent/curated-gate.js';

/** 评论评估角色只需精选库的「评论归档」口（窄接口，便于测试桩）。 */
export interface CuratedCommentSink {
  archiveComment(
    accountId: string,
    input: {
      sourceId: string;
      text: string;
      author?: string;
      topics: string[];
      sourceNoteTitle?: string;
      reason?: string;
      likeCount?: number | null;
    },
  ): Promise<void>;
}

export interface CuratedCommentEvaluatorOptions extends RoleOptions {
  curatedStore: CuratedCommentSink;
  /** 取来源笔记（拿标题作上下文/归档来源）。 */
  getNoteData: (noteId: string) => NoteData | null;
  /** 取当前连接账号（落库账号归属）。 */
  getAccountId: () => string;
  /** 模型评估总开关（缺省 true）。false → 回退「仅共鸣」：预筛过即归档、不调 LLM（等价 Phase 2b 行为）。 */
  llmEvalEnabled?: boolean;
}

/** comment_like.confirmed 载荷（Phase 2b 起带 likeCount）。 */
interface CommentConfirmedPayload {
  noteId: string;
  commentAnchorId: string;
  author?: string;
  text: string;
  reason: string;
  likeCount?: number;
  ts: number;
}

/** LLM 评论评估的严格 JSON 输出契约。 */
interface CommentEvalResult {
  admit: boolean;
  relevanceOk: boolean;
  exemplarValueOk: boolean;
  isSpamOrPromo: boolean;
  reason: string;
}

export class CuratedCommentEvaluator extends BaseRole {
  // change cloud-coupling-phase0：不再为一个自标注跨边界导入角色名联合。`as const` 保住字面量类型
  // 不塌成 string（下游按 `browse:${roleName}` 拼模型解析键，塌了会静默丢配置）。
  // 写错角色名的防线改由 test/agents/content-role-names.test.ts 与角色目录对拍承担。
  readonly roleName = 'curated_comment_evaluator' as const;
  private readonly curatedStore: CuratedCommentSink;
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private readonly getAccountId: () => string;
  private readonly llmEvalEnabled: boolean;
  private unsubscribers: (() => void)[] = [];

  constructor(options: CuratedCommentEvaluatorOptions) {
    super(options);
    if (!options.llm) throw new Error('CuratedCommentEvaluator 需要 LlmClient');
    this.curatedStore = options.curatedStore;
    this.getNoteData = options.getNoteData;
    this.getAccountId = options.getAccountId;
    this.llmEvalEnabled = options.llmEvalEnabled ?? true;
  }

  subscribe(): void {
    this.unsubscribers.push(this.eventBus.on('comment_like.confirmed', (p) => this.onConfirmed(p)));
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private onConfirmed(payload: CommentConfirmedPayload): void {
    // 异步评估，绝不阻塞浏览主路径（fire-and-forget）。
    void this.evaluate(payload);
  }

  private async evaluate(p: CommentConfirmedPayload): Promise<void> {
    if (!p || !p.commentAnchorId || !p.text) return;
    const accountId = this.getAccountId();
    if (!accountId || accountId === '__unbound__') return; // honest-fail：缺账号不落

    const config = resolveCuratedGateConfig(accountId);
    // ── 第一段：评论共鸣预筛。本事件即「已确认点赞」→ 恒过；保留预筛口供将来其他来源复用。 ──
    const res = passesCommentResonance({ likeCount: p.likeCount ?? null, confirmedLike: true }, config);
    if (!res.ok) return;

    const sourceNoteTitle = this.getNoteData(p.noteId)?.title;
    const topics = topicKeysFromTitle(sourceNoteTitle);

    // 开关关 → 回退「仅共鸣」：预筛过即归档（不调 LLM、不评相关性/范例价值）。
    if (!this.llmEvalEnabled) {
      await this.admit(accountId, p, topics, sourceNoteTitle, p.reason);
      return;
    }

    // ── 第二段：模型评估（仅预筛幸存者）。 ──
    let raw: string;
    try {
      raw = await this.decide(this.buildPrompt(p, sourceNoteTitle));
    } catch {
      this.log(`LLM 评估失败 → 诚实不纳入 comment=${p.commentAnchorId}`);
      return;
    }
    const parsed = this.parse(raw);
    if (!parsed) {
      this.log(`评估输出解析失败 → 诚实不纳入 comment=${p.commentAnchorId}`);
      return;
    }
    if (!(parsed.admit && parsed.relevanceOk && parsed.exemplarValueOk && !parsed.isSpamOrPromo)) {
      this.log(`评估不准入 comment=${p.commentAnchorId}：${parsed.reason}`);
      return;
    }
    await this.admit(accountId, p, topics, sourceNoteTitle, 'llm_eval');
  }

  /** 落精选语料（评论）。fire-and-forget：失败只 log、不抛、不阻塞主路径。 */
  private async admit(
    accountId: string,
    p: CommentConfirmedPayload,
    topics: string[],
    sourceNoteTitle: string | undefined,
    reason: string,
  ): Promise<void> {
    try {
      await this.curatedStore.archiveComment(accountId, {
        sourceId: p.commentAnchorId,
        text: p.text,
        author: p.author,
        topics,
        sourceNoteTitle,
        reason,
        likeCount: p.likeCount ?? null,
      });
      this.log(`纳入精选评论 comment=${p.commentAnchorId}（${reason}）`);
    } catch (err) {
      this.log(`评论落库失败（不影响主路径）：${(err as Error).message}`);
    }
  }

  // ─── Prompt 构建 ───────────────────────────────────────────

  /** 只读预览（change role-prompt-visibility）。 */
  previewPrompt(): string {
    return this.buildPrompt(
      { noteId: '<示例noteId>', commentAnchorId: '<示例锚点>', author: '<示例评论作者>', text: '<示例评论正文>', reason: '<点赞原因>', ts: 0 },
      '<示例来源笔记标题>',
    );
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）。 */
  personaSegments(): string[] {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');
    return [`你是「${identity.name}」，${identity.role}。创作领域 / 兴趣：${interestsStr}`];
  }

  private buildPrompt(p: CommentConfirmedPayload, sourceNoteTitle: string | undefined): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary, ...(interests.seed_keywords ?? [])].join('、');

    return `你是「${identity.name}」，${identity.role}。
你的创作领域 / 兴趣（作软背景）：${interestsStr}

正在判断：这条小红书评论**值不值得收进你的「评论范例库」**——库里只留「相关、且作为真人留言有借鉴价值（角度新 / 口吻好 / 有信息）」的评论，供你将来写评论/发帖时找语感和角度。

来源笔记标题：${sourceNoteTitle ?? '（未知）'}
评论正文：${p.text}
${p.likeCount != null ? `该评论点赞数：${p.likeCount}` : ''}

逐项判断（三个维度都要给）：
1. relevanceOk：这条评论是否与你的创作领域相关（话题相关、或表达方式对你有参考意义）。
2. exemplarValueOk：作为一条真人留言，它的**角度 / 口吻 / 信息量**是否有借鉴价值（区别于平庸口水、纯附和）。
3. isSpamOrPromo：是否水评 / 广告 / 带货 / 纯刷存在感（命中其一即 true）。

只输出 JSON（不要其他内容）：
{"admit": true 或 false, "relevanceOk": true 或 false, "exemplarValueOk": true 或 false, "isSpamOrPromo": true 或 false, "reason": "简短中文理由"}
其中 admit = relevanceOk 且 exemplarValueOk 且 非水评广告 时为 true，否则为 false。拿不准时倾向不纳入。`;
  }

  // ─── 输出解析 ───────────────────────────────────────────────

  /** 严格解析；缺核心字段 / 类型不符 → null（诚实判不纳入，绝不默认纳入）。 */
  private parse(raw: string): CommentEvalResult | null {
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
    if (typeof o.relevanceOk !== 'boolean' || typeof o.exemplarValueOk !== 'boolean' || typeof o.isSpamOrPromo !== 'boolean') {
      return null;
    }
    const admit = typeof o.admit === 'boolean' ? o.admit : o.relevanceOk && o.exemplarValueOk && !o.isSpamOrPromo;
    const reason = typeof o.reason === 'string' ? o.reason : 'comment_evaluated';
    return { admit, relevanceOk: o.relevanceOk, exemplarValueOk: o.exemplarValueOk, isSpamOrPromo: o.isSpamOrPromo, reason };
  }
}
