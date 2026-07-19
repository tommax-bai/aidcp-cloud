/**
 * CommentLikeAppraiser — 详情页「给别人某条评论点赞」的决策角色（LLM）。
 *
 * 职责：评论区滚完、候选评论已随回执上来后，结合正文 + 候选评论，按价值（趣味性 / 知识深度 / 共鸣）
 * 偶尔挑「0 或 1 条」评论点赞。绝大多数访问弃权。
 *
 * 关键不变量：
 * - 自有单航班，【绝不 defer / 阻塞 reading.done】——CommentReviewer 照常同步推进，无死锁；
 * - 便宜预闸（每场上限 → 风控当日配额 → 频率比率 → Bernoulli「偶尔不点」）全部跑在 LLM 之前，
 *   过不了就不调 LLM（省钱、无解析失败面）；
 * - 解析失败 / LLM 选「都不点」 = 弃权（不下发、不动预算），绝不默认挑第一条；
 * - 选中后持有 {anchor,text,author} 单航班态，真点成功（comment_like 回执 ok）再 emit confirmed 供归档。
 *
 * 消费事件：reading.scroll_comments（拿 noteId + 新一篇开始）、action.completed（scroll_comments 候选 / comment_like 回执）
 * 产出事件：comment_like.intended（下发意图）、comment_like.confirmed（真点成功）、comment_like.skipped（观测）
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { NoteData } from './content-curator-role.js';
import { tieredInterests } from './persona-format.js';
import type { CommentCandidate } from '../comm/protocol.js';
import type { RoleName, ReadingScrollCommentsPayload } from '../event-bus/types.js';
import { XHS_COMMENT_PROFILE, type CommentPlatformProfile } from '../platform/index.js';
import { commentLikeProbability, likeAffinityLabel, resolveLikeAffinity } from '../soul/like-affinity.js';

/** 点赞哲学兜底（soul 缺 behavior_guidelines 时）：选择性、只在真戳到时点。 */
const LIKE_PRINCIPLE_FALLBACK = '只在真有共鸣 / 觉得有意思 / 学到东西时才点；平淡的、随手认同的不点';

export interface CommentLikeAppraiserOptions extends RoleOptions {
  getNoteData: (noteId: string) => NoteData | null;
  /** 平台词汇画像（站名 / 内容名 / 指标名）；缺省回落小红书。 */
  platformProfile?: CommentPlatformProfile;
  /** 每场会话「评论赞」硬上限剩余（预算闸） */
  getRemainingCommentLikes: () => number;
  /** 本场已发生的 笔记赞 / 评论赞 计数（频率比率闸：评论赞数 ≈ 笔记赞数的 ratio） */
  getSessionLikeCounts: () => { noteLikes: number; commentLikes: number };
  /** 风控当日 comment_like 剩余配额（可选；耗尽则不调 LLM） */
  getCommentLikeDailyRemaining?: () => number;
  /** 评论赞数 ≈ 笔记赞数的该比率（默认 0.15） */
  ratio?: number;
  /** 显式覆盖 Bernoulli 允许概率；未提供时按 soul 点赞倾向取 0.60/0.75/0.90。 */
  likeProbability?: number;
  random?: () => number;
}

interface LikePick {
  noteId: string;
  commentAnchorId: string;
  author?: string;
  text: string;
  reason: string;
  /** 该评论点赞数（change curated-inspiration-corpus Phase 2b），透传到 confirmed → 精选语料。 */
  likeCount?: number;
}

export class CommentLikeAppraiser extends BaseRole {
  readonly roleName: RoleName = 'comment_like_appraiser';
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private readonly platformProfile: CommentPlatformProfile;
  private readonly getRemainingCommentLikes: () => number;
  private readonly getSessionLikeCounts: () => { noteLikes: number; commentLikes: number };
  private readonly getCommentLikeDailyRemaining?: () => number;
  private readonly ratio: number;
  private readonly likeProbability: number;
  private readonly random: () => number;
  private unsubscribers: (() => void)[] = [];
  /** 当前正在深读评论的笔记（reading.scroll_comments 设，scroll_comments 回执用后即清）。 */
  private scrollPending: { noteId: string } | null = null;
  /** 已下发、等 comment_like 回执确认的 pick（供 confirmed 归档关联；单航班一次一个）。 */
  private likePending: LikePick | null = null;

  constructor(options: CommentLikeAppraiserOptions) {
    super(options);
    if (!options.llm) throw new Error('CommentLikeAppraiser 需要 LlmClient');
    this.getNoteData = options.getNoteData;
    this.platformProfile = options.platformProfile ?? XHS_COMMENT_PROFILE;
    this.getRemainingCommentLikes = options.getRemainingCommentLikes;
    this.getSessionLikeCounts = options.getSessionLikeCounts;
    this.getCommentLikeDailyRemaining = options.getCommentLikeDailyRemaining;
    this.ratio = options.ratio ?? 0.15;
    this.likeProbability = options.likeProbability ?? commentLikeProbability(this.soul);
    this.random = options.random ?? Math.random;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('reading.scroll_comments', (p) => this.onScrollComments(p)),
      this.eventBus.on('action.completed', (p) => this.onActionCompleted(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.scrollPending = null;
    this.likePending = null;
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private onScrollComments(payload: ReadingScrollCommentsPayload): void {
    this.scrollPending = { noteId: payload.noteId };
    // 新一篇评论区开始：丢弃上一篇可能残留的未决 pick（interleaving guard——绝不把上一篇的 pick 归到这一篇）。
    if (this.likePending) {
      this.log(`丢弃上一篇未决 comment_like pick（新一篇开始）note=${this.likePending.noteId}`);
      this.likePending = null;
    }
  }

  private onActionCompleted(payload: { action: string; ok: boolean; candidates?: CommentCandidate[] }): void {
    // 1) comment_like 回执：真点成功 → confirmed（供归档）；失败/无 pick → 仅清态。
    if (payload.action === 'comment_like') {
      const pick = this.likePending;
      this.likePending = null;
      if (pick && payload.ok === true) {
        this.emit('comment_like.confirmed', {
          noteId: pick.noteId,
          commentAnchorId: pick.commentAnchorId,
          author: pick.author,
          text: pick.text,
          reason: pick.reason,
          likeCount: pick.likeCount,
          ts: Date.now(),
        });
      }
      return;
    }
    // 2) scroll_comments 回执：评估是否点一条评论赞（自有单航班，不碰 reading.done）。
    if (payload.action !== 'scroll_comments' || !this.scrollPending) return;
    const ctx = this.scrollPending;
    this.scrollPending = null;
    if (payload.ok !== true) return; // 没滚成功 → 没候选，弃权
    void this.appraise(ctx.noteId, payload.candidates ?? []);
  }

  private async appraise(noteId: string, candidates: CommentCandidate[]): Promise<void> {
    // ── 便宜预闸（LLM 之前）：任一不过即弃权 ──
    // 1) 每场硬上限
    if (this.getRemainingCommentLikes() <= 0) return this.skip(noteId, 'no_session_budget');
    // 2) 风控当日配额
    if (this.getCommentLikeDailyRemaining && this.getCommentLikeDailyRemaining() <= 0) {
      return this.skip(noteId, 'daily_cap_reached');
    }
    // 3) 频率比率：评论赞数 ≈ 笔记赞数的 ratio（早场笔记赞少 → 比率≈0 → 不点，符合预期）
    const { noteLikes, commentLikes } = this.getSessionLikeCounts();
    if ((commentLikes + 1) / Math.max(1, noteLikes) > this.ratio) return this.skip(noteId, 'ratio_gate');
    // 4) Bernoulli「偶尔不点」
    if (this.random() >= this.likeProbability) return this.skip(noteId, 'bernoulli_abstain');

    // ── 候选硬过滤：去已赞 / 无锚点 / 空文本（绝不回点已赞）──
    const usable = candidates.filter((c) => c && c.anchorId && c.text && !c.alreadyLiked);
    if (usable.length === 0) return this.skip(noteId, 'no_usable_candidate');

    // ── LLM 结合正文挑 0-or-1 ──
    const note = this.getNoteData(noteId);
    let raw: string;
    try {
      raw = await this.decide(this.buildPrompt(note, usable));
    } catch {
      return this.skip(noteId, 'llm_error');
    }
    const pick = this.parsePick(raw, usable);
    if (!pick) return this.skip(noteId, 'abstain_or_parse_failed'); // 解析失败 / 选「都不点」= 弃权，绝不默认挑第一条

    this.likePending = { noteId, commentAnchorId: pick.anchorId, author: pick.author, text: pick.text, reason: pick.reason, likeCount: pick.likeCount };
    this.emit('comment_like.intended', {
      noteId,
      commentAnchorId: pick.anchorId,
      author: pick.author,
      text: pick.text,
      reason: pick.reason,
      ts: Date.now(),
    });
  }

  private skip(noteId: string, reason: string): void {
    this.emit('comment_like.skipped', { noteId, reason, ts: Date.now() });
  }

  // ─── Prompt 构建 / 解析 ────────────────────────────────────

  /** 只读预览（change role-prompt-visibility）：用最小示例数据 + 真实人设渲染真实 prompt，仅供后台查看；不改 buildPrompt 逻辑。 */
  previewPrompt(): string {
    return this.buildPrompt({ noteId: '<示例noteId>', title: '<示例标题>', content: '<示例正文，运行时为真实笔记内容>', author: '<示例作者>', likeCount: 0, collectCount: 0 }, [{ anchorId: 'comment-1', author: '<示例评论作者>', text: '<示例评论正文>', alreadyLiked: false }]);
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）：与 buildPrompt 同源拼接，仅供查看器定位标注；不改 buildPrompt。 */
  personaSegments(): string[] {
    return [this.personaHeader()];
  }

  /** 人设头（change humanize-interaction-prompts）：注入语气 + 兴趣 + 点赞哲学，
   *  让「给哪条评论点赞」按账号口味不同而不同（不再全 fleet 共用固定三轴）。 */
  private personaHeader(): string {
    const { identity, interests, behavior_guidelines: bg } = this.soul;
    const likePrinciple = bg?.like_principle ?? LIKE_PRINCIPLE_FALLBACK;
    const likeAffinity = resolveLikeAffinity(this.soul);
    return `你是「${identity.name}」，${identity.role}。语气：${identity.tone}。兴趣：${tieredInterests(interests)}。\n你点赞的一贯标准：${likePrinciple}\n点赞倾向：${likeAffinityLabel(likeAffinity)}（只提高普通点赞意愿，不代表每条必点）`;
  }

  private buildPrompt(note: NoteData | null, usable: CommentCandidate[]): string {
    const noteBlock = note
      ? `当前${this.platformProfile.contentName}：\n标题：${note.title}\n内容：${note.content}`
      : '（正文暂不可用，只凭评论判断）';
    const list = usable
      .map((c, i) => `${i + 1}. ${c.author ? `@${c.author}：` : ''}${c.text}`)
      .join('\n');

    return `${this.personaHeader()}

你正在看一篇${this.platformProfile.siteName}${this.platformProfile.contentName}的评论区，像真人一样**偶尔**会给某条特别戳到你的评论点个赞。
多数时候不必点；只在确有一条评论**按你上面的点赞标准**真的戳到你时，才点它一个。

${noteBlock}

评论候选（最多挑 1 条点赞，挑不出就不点）：
${list}

一律不点的：平庸、口水、广告、与正文无关的；像你自己会写的、或明显是自夸 / 带货的。

只输出JSON（不要其他内容）：
点某条：{"pick": <1..${usable.length} 的序号>, "reason": "简短原因"}
都不点：{"pick": 0, "reason": "简短原因"}`;
  }

  /** 解析 LLM 输出；返回选中的候选，或 null（弃权：解析失败 / pick=0 / 越界）。绝不回退默认挑第一条。 */
  private parsePick(raw: string, usable: CommentCandidate[]): { anchorId: string; author?: string; text: string; reason: string; likeCount?: number } | null {
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
    const pick = typeof o.pick === 'number' ? o.pick : Number(o.pick);
    if (!Number.isInteger(pick) || pick < 1 || pick > usable.length) return null; // 0 / NaN / 越界 → 弃权
    const chosen = usable[pick - 1];
    const reason = typeof o.reason === 'string' ? o.reason : 'comment_like_picked';
    return { anchorId: chosen.anchorId, author: chosen.author, text: chosen.text, reason, likeCount: chosen.likeCount };
  }
}
