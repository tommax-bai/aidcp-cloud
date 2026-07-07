/**
 * CommentComposer — 评论撰写角色（LLM）。
 *
 * 职责：为已判定值得评论的笔记，生成一条短、真诚、贴题、人格化的评论文本。
 * 消费事件：comment.appraised
 * 产出事件：comment.composed（draft）或 comment.skipped（撰写失败/空/超长）
 *
 * 这是浏览闭环里**首个产出自由文本**的角色（其余只产结构化判定）：自管空/超长/裸@/去引号。
 * data-tribute 提及：撰写须避开裸 `@`，否则边缘输入会触发提及弹窗。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { NoteData } from './content-curator-role.js';
import { tieredInterests } from './persona-format.js';
import { interactionLabel } from './interaction-label.js';
import type { RoleName, CommentAppraisedPayload } from '../event-bus/types.js';
import { topicKeysFromTitle, type ValuableCommentRef } from '../cache/valuable-comment-store.js';
import { XHS_COMMENT_PROFILE, type CommentPlatformProfile } from '../platform/index.js';

/** 撰写语境（change humanize-interaction-prompts）：把「为何值得评 / 刚做了什么互动」穿透进 prompt。 */
interface ComposeContext {
  /** 评估角色判「值得评」的理由（来自 comment.appraised payload）。 */
  reason?: string;
  /** 本次对该笔记的真实互动（like / collect）。 */
  actions?: ('like' | 'collect')[];
}

export const DEFAULT_MAX_COMMENT_LEN = XHS_COMMENT_PROFILE.maxCommentLength;

export interface CommentComposerOptions extends RoleOptions {
  getNoteData: (noteId: string) => NoteData | null;
  platformProfile?: CommentPlatformProfile;
  /** 可选：按主题键召回语料库优质评论作参考（仅作灵感、不可照抄）。缺省/空/出错 → 行为同今天。
   *  主题键由本角色用 topicKeysFromTitle 从当前笔记标题派生（与归档侧同一套键）。 */
  getCorpusReferences?: (topics: string[]) => Promise<ValuableCommentRef[]>;
}

export class CommentComposer extends BaseRole {
  readonly roleName: RoleName = 'comment_composer';
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private readonly platformProfile: CommentPlatformProfile;
  private readonly getCorpusReferences?: (topics: string[]) => Promise<ValuableCommentRef[]>;
  private unsubscribers: (() => void)[] = [];

  constructor(options: CommentComposerOptions) {
    super(options);
    if (!options.llm) throw new Error('CommentComposer 需要 LlmClient');
    this.getNoteData = options.getNoteData;
    this.platformProfile = options.platformProfile ?? XHS_COMMENT_PROFILE;
    this.getCorpusReferences = options.getCorpusReferences;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('comment.appraised', (p) => this.onAppraised(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private skip(payload: CommentAppraisedPayload, reason: string): void {
    this.emit('comment.skipped', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: payload.actions,
      reason,
      ts: Date.now(),
    });
  }

  private async onAppraised(payload: CommentAppraisedPayload): Promise<void> {
    const note = this.getNoteData(payload.noteId);
    if (!note) {
      this.skip(payload, 'note_data_unavailable');
      return;
    }

    // 语料库参考（best-effort）：取不到 / 出错 / 为空 → references 为空，prompt 与今天一致。
    let references: string[] = [];
    if (this.getCorpusReferences) {
      try {
        const refs = await this.getCorpusReferences(topicKeysFromTitle(note.title));
        references = refs.map((r) => r.text).filter(Boolean).slice(0, 3);
      } catch {
        references = [];
      }
    }

    let raw: string;
    try {
      raw = await this.decide(this.buildPrompt(note, references, [], { reason: payload.reason, actions: payload.actions }));
    } catch {
      this.skip(payload, 'llm_error');
      return;
    }

    const parsed = this.parseOutput(raw);
    // 语义弃权（change humanize-interaction-prompts）：写不出真东西时诚实不写，绝不硬凑客套话。
    if (parsed.decline) {
      this.skip(payload, 'nothing_genuine');
      return;
    }
    const draft = this.sanitize(parsed.text);
    if (!draft) {
      this.skip(payload, 'compose_empty');
      return;
    }
    if (draft.length > this.platformProfile.maxCommentLength) {
      this.skip(payload, 'compose_too_long');
      return;
    }

    this.emit('comment.composed', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: payload.actions,
      draft,
      ...(references.length ? { references } : {}),
      ts: Date.now(),
    });
  }

  /** 只读预览（change role-prompt-visibility）：用最小示例数据 + 真实人设渲染真实 prompt，仅供后台查看；不改 buildPrompt 逻辑。 */
  previewPrompt(): string {
    return this.buildPrompt({ noteId: '<示例noteId>', title: '<示例标题>', content: '<示例正文，运行时为真实笔记内容>', author: '<示例作者>', likeCount: 0, collectCount: 0 }, ['<示例参考评论，运行时为语料库引用>']);
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）：与 buildPrompt 同源拼接，仅供查看器定位标注；不改 buildPrompt。 */
  personaSegments(): string[] {
    return [this.personaHeader()];
  }

  /** 人设头（change humanize-interaction-prompts）：补注个人经历背景（对齐互动评估角色的注入水平），
   *  让不同账号写出的评论口吻不同。 */
  private personaHeader(): string {
    const { identity, interests } = this.soul;
    return `你是「${identity.name}」，${identity.role}。${identity.background}\n语气：${identity.tone}。兴趣：${tieredInterests(interests)}。`;
  }

  /**
   * 命令式撰写一条评论草稿（change comment-search-command，按需评论任务调用）。
   * 与事件路径（onAppraised）共用同一 buildPrompt + sanitize + 长度闸；额外可注入**现场评论**作语境
   * （现状事件路径只看标题+正文+语料参考，不读评论区）。空 / 超长 / LLM 失败 → 诚实返回 null（不伪造）。
   */
  async composeDraft(
    note: NoteData,
    opts: { references?: string[]; onPageComments?: string[] } = {},
  ): Promise<string | null> {
    const references = (opts.references ?? []).filter(Boolean).slice(0, 3);
    const onPageComments = (opts.onPageComments ?? []).filter(Boolean).slice(0, 6);
    let raw: string;
    try {
      raw = await this.decide(this.buildPrompt(note, references, onPageComments));
    } catch {
      return null;
    }
    const parsed = this.parseOutput(raw);
    if (parsed.decline) return null; // 诚实弃权 → 命令路径视为无草稿
    const draft = this.sanitize(parsed.text);
    if (!draft || draft.length > this.platformProfile.maxCommentLength) return null;
    return draft;
  }

  private buildPrompt(note: NoteData, references: string[] = [], onPageComments: string[] = [], ctx: ComposeContext = {}): string {
    const refBlock = references.length
      ? `\n参考（仅作灵感，体会真人怎么留言；【严禁照抄/改写句子】，只借角度与口吻）：\n${references.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`
      : '';
    // 现场评论块（change comment-search-command）：让评论贴合这条笔记下大家正在聊的，别重复别人已说过的。
    const liveBlock = onPageComments.length
      ? `\n这条笔记现有的评论（体会大家在聊什么、从哪个角度切入；别重复别人已说过的，也别照抄）：\n${onPageComments.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`
      : '';
    // 语境穿透（change humanize-interaction-prompts）：刚做了什么互动 + 评估角色为何觉得值得评。
    const actLine = ctx.actions && ctx.actions.length ? `你刚${interactionLabel(ctx.actions)}这篇。` : '';
    const reasonLine = ctx.reason ? `你觉得它值得评，是因为：${ctx.reason}` : '';
    const ctxBlock = actLine || reasonLine ? `\n${[actLine, reasonLine].filter(Boolean).join('')}\n` : '';
    return `${this.personaHeader()}
为下面这篇你认可的笔记写**一条**评论。${ctxBlock}
要求：
- 像真人随手留言，真诚、不营销不客套；一般就一两句，可以更短、更随口（最多 ${this.platformProfile.maxCommentLength} 字）；
- 贴这篇笔记的具体内容，别泛泛而谈；
- 怎么切入你自己定，挑最自然的一种、别每条都一个套路：接一句真实共鸣 / 问一个你真想问的问题 / 讲一句你相关的经历 / 一句纯情绪的短评；
- 用你的人格语气；不要 emoji 堆砌、不要 AI 腔（如「值得一提」「总而言之」「感谢分享」这类客套）；
- **不要出现 @ 提及**、不要话题标签、不要外链；
- 如果这篇你其实没有真东西可说、只挤得出客套话，就别硬写。
${refBlock}${liveBlock}
当前笔记：
作者：${note.author ?? '未知'}
标题：${note.title}
内容：${note.content}

只输出JSON：有真东西想说 → {"text":"你的评论"}；实在没有真东西可说 → {"decline":"nothing_genuine"}`;
  }

  /** 解析撰写输出：JSON {text} → 文本；JSON {decline} → 弃权；否则退化为首个非空行当文本。 */
  private parseOutput(raw: string): { text: string; decline?: false } | { decline: true } {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
        if (o.decline) return { decline: true };
        if (typeof o.text === 'string') return { text: o.text };
      } catch {
        /* fall through */
      }
    }
    const line = raw.split('\n').map((l) => l.trim()).find(Boolean);
    return { text: line ?? '' };
  }

  /** 去首尾引号/空白；剥掉裸 @ 提及（data-tribute 防误触发）。 */
  private sanitize(text: string): string {
    let t = text.trim().replace(/^["'“”『「]+|["'“”』」]+$/g, '').trim();
    t = t.replace(/@\S+/g, '').replace(/\s{2,}/g, ' ').trim();
    return t;
  }
}
