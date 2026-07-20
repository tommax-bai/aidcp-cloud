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
import type { MandatoryInteractionContext, RoleName, CommentAppraisedPayload } from '../event-bus/types.js';
import { topicKeysFromTitle, type ValuableCommentRef } from '../cache/valuable-comment-store.js';
import { XHS_COMMENT_PROFILE, type CommentPlatformProfile } from '../platform/index.js';
import { checkWritingLanguage, writingLanguageInstruction } from '../soul/writing-language.js';
import type { WritingLanguage } from '../soul/types.js';

/** 撰写语境（change humanize-interaction-prompts）：把「为何值得评 / 刚做了什么互动」穿透进 prompt。 */
interface ComposeContext {
  /** 评估角色判「值得评」的理由（来自 comment.appraised payload）。 */
  reason?: string;
  /** 本次对该笔记的真实互动（like / collect）。 */
  actions?: ('like' | 'collect')[];
  /** 详情确认的强制规则：注入具体写作指引，并禁止普通语义弃权。 */
  mandatoryInteraction?: MandatoryInteractionContext;
  /** mandatory 首次无效后的唯一一次补写。 */
  retry?: boolean;
}

export const DEFAULT_MAX_COMMENT_LEN = XHS_COMMENT_PROFILE.maxCommentLength;
/** 可选语料召回是写作增强，不得无限阻塞主浏览闭环。 */
export const DEFAULT_COMMENT_CORPUS_LOOKUP_TIMEOUT_MS = 3_000;

export interface CommentComposerOptions extends RoleOptions {
  getNoteData: (noteId: string) => NoteData | null;
  platformProfile?: CommentPlatformProfile;
  /** 可选：按主题键召回语料库优质评论作参考（仅作灵感、不可照抄）。缺省/空/出错 → 行为同今天。
   *  主题键由本角色用 topicKeysFromTitle 从当前笔记标题派生（与归档侧同一套键）。 */
  getCorpusReferences?: (topics: string[]) => Promise<ValuableCommentRef[]>;
  /** 可选语料召回等待上限；超时按空参考继续。 */
  corpusLookupTimeoutMs?: number;
  /** 总评论子链超时后拦截迟到异步结果。 */
  isCommentSublineExpired?: (noteId: string) => boolean;
  /** 计时器注入（测试桩）；生产由 dispatcher 注入真计时器。 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export class CommentComposer extends BaseRole {
  readonly roleName: RoleName = 'comment_composer';
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private readonly platformProfile: CommentPlatformProfile;
  private readonly getCorpusReferences?: (topics: string[]) => Promise<ValuableCommentRef[]>;
  private readonly corpusLookupTimeoutMs: number;
  private readonly isCommentSublineExpired: (noteId: string) => boolean;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private unsubscribers: (() => void)[] = [];

  constructor(options: CommentComposerOptions) {
    super(options);
    if (!options.llm) throw new Error('CommentComposer 需要 LlmClient');
    this.getNoteData = options.getNoteData;
    this.platformProfile = options.platformProfile ?? XHS_COMMENT_PROFILE;
    this.getCorpusReferences = options.getCorpusReferences;
    this.corpusLookupTimeoutMs = positiveMs(options.corpusLookupTimeoutMs, DEFAULT_COMMENT_CORPUS_LOOKUP_TIMEOUT_MS);
    this.isCommentSublineExpired = options.isCommentSublineExpired ?? (() => false);
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
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
    if (this.isCommentSublineExpired(payload.noteId)) return;
    this.emit('comment.skipped', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: payload.actions,
      reason,
      ...(payload.mandatoryInteraction ? { mandatoryInteraction: payload.mandatoryInteraction } : {}),
      ts: Date.now(),
    });
  }

  private async onAppraised(payload: CommentAppraisedPayload): Promise<void> {
    if (this.isCommentSublineExpired(payload.noteId)) return;
    const note = this.getNoteData(payload.noteId);
    if (!note) {
      this.skip(payload, 'note_data_unavailable');
      return;
    }
    const writingLanguage = this.facebookWritingLanguage();
    if (this.platformProfile.platform === 'facebook' && !writingLanguage) {
      this.skip(payload, 'writing_language_required');
      return;
    }

    // 语料库参考（best-effort）：取不到 / 出错 / 为空 → references 为空，prompt 与今天一致。
    let references: string[] = [];
    if (this.getCorpusReferences) {
      try {
        const timedOut = Symbol('corpus_lookup_timeout');
        let timer: unknown;
        const timeout = new Promise<typeof timedOut>((resolve) => {
          timer = this.setTimeoutFn(() => resolve(timedOut), this.corpusLookupTimeoutMs);
          unrefTimer(timer);
        });
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => this.getCorpusReferences!(topicKeysFromTitle(note.title))),
            timeout,
          ]);
          if (result === timedOut) {
            this.log(`corpus_lookup_timeout note=${payload.noteId} timeoutMs=${this.corpusLookupTimeoutMs}`);
          } else {
            references = result.map((r) => r.text).filter(Boolean).slice(0, 3);
          }
        } finally {
          if (timer !== undefined) this.clearTimeoutFn(timer);
        }
      } catch {
        references = [];
      }
    }
    if (this.isCommentSublineExpired(payload.noteId)) return;

    // 现场评论（change platform-vocabulary-and-thresholds 2.1）：Facebook 由 note.detail 直接带回、
    // 小红书由 dispatcher 从 scroll_comments 回执归集。采不到即空 ⇒ prompt 与今天一致。
    const onPageComments = (note.comments ?? []).filter(Boolean).slice(0, 6);
    const attempts = payload.mandatoryInteraction || writingLanguage ? 2 : 1;
    let draft: string | null = null;
    let failureReason = 'llm_error';
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.isCommentSublineExpired(payload.noteId)) return;
      let raw: string;
      try {
        raw = await this.decide(this.buildPrompt(note, references, onPageComments, {
          reason: payload.reason,
          actions: payload.actions,
          mandatoryInteraction: payload.mandatoryInteraction,
          retry: attempt > 0,
        }));
      } catch {
        if (this.isCommentSublineExpired(payload.noteId)) return;
        failureReason = 'llm_error';
        continue;
      }
      if (this.isCommentSublineExpired(payload.noteId)) return;

      const parsed = this.parseOutput(raw);
      // 普通路径维持“写不出则弃权”；mandatory 最多补写一次，仍失败就诚实 skip，不塞模板。
      if (parsed.decline) {
        failureReason = 'nothing_genuine';
        continue;
      }
      const candidate = this.sanitize(parsed.text);
      if (!candidate) {
        failureReason = 'compose_empty';
        continue;
      }
      if (candidate.length > this.platformProfile.maxCommentLength) {
        failureReason = 'compose_too_long';
        continue;
      }
      if (writingLanguage && checkWritingLanguage(candidate, writingLanguage) !== 'match') {
        failureReason = 'writing_language_mismatch';
        continue;
      }
      draft = candidate;
      break;
    }
    if (!draft) {
      this.skip(payload, failureReason);
      return;
    }

    if (this.isCommentSublineExpired(payload.noteId)) return;
    this.emit('comment.composed', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: payload.actions,
      draft,
      ...(references.length ? { references } : {}),
      ...(payload.mandatoryInteraction ? { mandatoryInteraction: payload.mandatoryInteraction } : {}),
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
    const writingLanguage = this.facebookWritingLanguage();
    if (this.platformProfile.platform === 'facebook' && !writingLanguage) return null;
    const references = (opts.references ?? []).filter(Boolean).slice(0, 3);
    // 显式传入优先；未传则回落到笔记自带的现场评论（Facebook note.detail 直接带回）。
    const onPageComments = (opts.onPageComments ?? note.comments ?? []).filter(Boolean).slice(0, 6);
    for (let attempt = 0; attempt < (writingLanguage ? 2 : 1); attempt++) {
      let raw: string;
      try {
        raw = await this.decide(this.buildPrompt(note, references, onPageComments, { retry: attempt > 0 }));
      } catch {
        continue;
      }
      const parsed = this.parseOutput(raw);
      if (parsed.decline) return null; // 诚实弃权 → 命令路径视为无草稿
      const draft = this.sanitize(parsed.text);
      if (!draft || draft.length > this.platformProfile.maxCommentLength) continue;
      if (writingLanguage && checkWritingLanguage(draft, writingLanguage) !== 'match') continue;
      return draft;
    }
    return null;
  }

  private facebookWritingLanguage(): WritingLanguage | undefined {
    return this.platformProfile.platform === 'facebook' ? this.soul.writing_language : undefined;
  }

  private buildPrompt(note: NoteData, references: string[] = [], onPageComments: string[] = [], ctx: ComposeContext = {}): string {
    // 平台词汇（change platform-vocabulary-and-thresholds 1.2）：内容名词随平台取（小红书=笔记 / Facebook=帖子）。
    // 缺省 profile = 小红书 ⇒ 本 prompt 对小红书逐字节不变。
    const { contentName, maxCommentLength, composeLanguageRule } = this.platformProfile;
    const refBlock = references.length
      ? `\n参考（仅作灵感，体会真人怎么留言；【严禁照抄/改写句子】，只借角度与口吻）：\n${references.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`
      : '';
    // 现场评论块（change comment-search-command）：让评论贴合这条笔记下大家正在聊的，别重复别人已说过的。
    const liveBlock = onPageComments.length
      ? `\n这条${contentName}现有的评论（体会大家在聊什么、从哪个角度切入；别重复别人已说过的，也别照抄）：\n${onPageComments.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`
      : '';
    // 语境穿透（change humanize-interaction-prompts）：刚做了什么互动 + 评估角色为何觉得值得评。
    const actLine = ctx.actions && ctx.actions.length ? `你刚${interactionLabel(ctx.actions)}这篇。` : '';
    const reasonLine = ctx.reason ? `你觉得它值得评，是因为：${ctx.reason}` : '';
    const ctxBlock = actLine || reasonLine ? `\n${[actLine, reasonLine].filter(Boolean).join('')}\n` : '';
    const mandatory = ctx.mandatoryInteraction;
    const mandatoryBlock = mandatory
      ? `\n这篇已由详情全文确认命中账号强制规则「${mandatory.ruleId}」。本次必须写出一条贴合正文的评论，不得选择弃权。\n评论指引：${mandatory.commentGuidance ?? '紧扣正文，写一条自然、具体的真人评论。'}${ctx.retry ? '\n上一次输出无效；这是唯一一次补写，请只给合法、非空、不过长的具体评论。' : ''}\n`
      : '';
    // 语言约束（change platform-vocabulary-and-thresholds 2.2）：只有声明了该规则的平台才渲染这条 bullet。
    const writingLanguage = this.facebookWritingLanguage();
    const languageRule = writingLanguage
      ? writingLanguageInstruction(writingLanguage)
      : composeLanguageRule;
    const langLine = languageRule
      ? `\n- ${languageRule}${ctx.retry && writingLanguage ? '；上一次没有满足发言语言要求，这次必须纠正' : ''}；`
      : '';
    // 空正文（Facebook 图片帖常无正文）：诚实说明「没有文字正文」，并禁止臆造画面内容——不写「标题：」空行。
    // 现场评论此时就是唯一文字依据；连评论也没有 ⇒ 模型应走 decline，绝不硬凑。
    const titleLine = note.title.trim() ? `\n标题：${note.title}` : '';
    const bodyLine = note.content.trim()
      ? `\n内容：${note.content}`
      : `\n内容：（这条${contentName}没有文字正文，只有图片/视频。你看不到画面，别臆造里面有什么；只能就着上面的评论区语境写，没有可写的就诚实弃权）`;
    return `${this.personaHeader()}
为下面这篇你认可的${contentName}写**一条**评论。${ctxBlock}${mandatoryBlock}
要求：
- 像真人随手留言，真诚、不营销不客套；一般就一两句，可以更短、更随口（最多 ${maxCommentLength} 字）；
- 贴这篇${contentName}的具体内容，别泛泛而谈；${langLine}
- 怎么切入你自己定，挑最自然的一种、别每条都一个套路：接一句真实共鸣 / 问一个你真想问的问题 / 讲一句你相关的经历 / 一句纯情绪的短评；
- 用你的人格语气；不要 emoji 堆砌、不要 AI 腔（如「值得一提」「总而言之」「感谢分享」这类客套）；
- **不要出现 @ 提及**、不要话题标签、不要外链；
- ${mandatory ? '本篇已获强制规则确认，不提供弃权出口；必须依据正文和指引写具体内容，仍不得编造正文没有的信息。' : '如果这篇你其实没有真东西可说、只挤得出客套话，就别硬写。'}
${refBlock}${liveBlock}
当前${contentName}：
作者：${note.author ?? '未知'}${titleLine}${bodyLine}

只输出JSON：${mandatory ? '{"text":"你的评论"}' : '有真东西想说 → {"text":"你的评论"}；实在没有真东西可说 → {"decline":"nothing_genuine"}'}`;
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

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function unrefTimer(handle: unknown): void {
  if (typeof handle !== 'object' || handle === null || !('unref' in handle)) return;
  const unref = (handle as { unref?: unknown }).unref;
  if (typeof unref === 'function') unref.call(handle);
}
