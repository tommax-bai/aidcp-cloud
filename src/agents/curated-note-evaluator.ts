/**
 * CuratedNoteEvaluator — 「正文进精选」评估角色（两段式准入第二段，LLM）。
 * change curated-admission-eval-roles（Phase 3）。
 *
 * 流程（消费 note.detail.arrived，payload 带全文 content + 赞藏数）：
 *   ① 正文为空先短路；第一段共鸣预筛（passesResonance，零 LLM）短路——不过即返回，绝不进第二段（成本红线）；
 *   ② 过则按账号人设领域、**读笔记全文** LLM 评估（相关性 + 内容丰富度 + 非纯广告/标题党/蹭热点）；
 *   ③ admit ∧ relevanceOk ∧ richnessOk ∧ !isPromoOrClickbait → curatedStore.upsertObservation（admitReason='llm_eval'）。
 *
 * 取代 server.ts 全局 note.detail.arrived 处理器里「笔记精选捕获」段（挪进角色以拿到账号绑定 LLM 与人设）。
 * 自有收藏不经本角色——它仍在全局处理器免评估直接纳入（用户决策①）。
 *
 * 红线：
 *  - 成本：MUST 只评共鸣预筛幸存者；预筛不过 → 零 LLM 调用、不纳入。
 *  - 诚实：LLM 降级 / 解析失败 → 诚实判不纳入（绝不静默纳入、不编造分）。
 *  - fire-and-forget：评估 / 落库失败只 log、不抛、不阻塞浏览主路径。
 *
 * 消费事件：note.detail.arrived
 * 副作用：curatedStore.upsertObservation（落精选语料，账号维度）。
 */

// change cloud-coupling-phase5 P5-2：脱离 automation 属主的公共基类。
// ContentRole 与它是同一份 kernel 实现的两个薄壳，逻辑零重复；差别只有两处：
// 事件总线只收「订阅」这一半（本角色从不 emit），角色名不标注 automation 的联合。
import { ContentRole } from './content-role.js';
import type { ContentRoleOptions } from './content-role.js';
import type { NoteDetailData } from '../kernel/note-detail.js';
import { topicKeysFromTitle } from '../kernel/valuable-comment-types.js';
import { passesResonance, resolveCuratedGateConfig } from '../publish-agent/curated-gate.js';
// 这四个类型的定义早已抬进 kernel；`cache/curated-content-store.ts` 对它们只是再导出壳。
// 经壳取用会让这条边在扫描器眼里继续存在（它认的是 import 说明符，不是最终定义处），
// 属 CLAUDE §8.3 的假消边残留。直取 kernel。
import type {
  CuratedObservation,
  CuratedReferenceImageInput,
  CuratedTextCardContext,
  TextCardTranscription,
} from '../kernel/curated-content-types.js';
import {
  mergeBodyWithTextCardTranscription,
  type TextCardTranscriber,
} from '../publish-agent/text-card-transcriber.js';

/** 评估角色只需精选库的「观测落库」口（窄接口，便于测试桩）。 */
export interface CuratedNoteSink {
  upsertObservation(obs: CuratedObservation): Promise<void>;
  refreshReferenceImages?(
    accountId: string,
    sourceId: string,
    contentType: 'image_text' | 'video',
    images: NonNullable<NoteDetailData['images']>,
  ): Promise<number>;
  getTextCardContext?(
    accountId: string,
    sourceId: string,
    contentType: 'image_text' | 'video',
  ): Promise<CuratedTextCardContext | null>;
}

export interface CuratedNoteEvaluatorOptions extends ContentRoleOptions {
  curatedStore: CuratedNoteSink;
  /** 取当前连接账号（落库账号归属）。 */
  getAccountId: () => string;
  /**
   * 模型评估总开关（缺省 true）。false → 回退「仅共鸣」：第一段预筛过即纳入、不调 LLM
   * （等价 Phase 2b 行为，相关性/丰富度不评）。
   */
  llmEvalEnabled?: boolean;
  textCardTranscriber?: TextCardTranscriber;
}

/** LLM 正文评估的严格 JSON 输出契约。 */
interface NoteEvalResult {
  admit: boolean;
  relevanceOk: boolean;
  richnessOk: boolean;
  isPromoOrClickbait: boolean;
  reason: string;
}

export class CuratedNoteEvaluator extends ContentRole {
  readonly roleName = 'curated_note_evaluator' as const;
  private readonly curatedStore: CuratedNoteSink;
  private readonly getAccountId: () => string;
  private readonly llmEvalEnabled: boolean;
  private readonly textCardTranscriber?: TextCardTranscriber;
  private unsubscribers: (() => void)[] = [];

  constructor(options: CuratedNoteEvaluatorOptions) {
    super(options);
    if (!options.llm) throw new Error('CuratedNoteEvaluator 需要 LlmClient');
    this.curatedStore = options.curatedStore;
    this.getAccountId = options.getAccountId;
    this.llmEvalEnabled = options.llmEvalEnabled ?? true;
    this.textCardTranscriber = options.textCardTranscriber;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('note.detail.arrived', (p) => this.onNoteDetailArrived(p)),
      this.eventBus.on('note.image_snapshot.arrived', (p) => this.onImageSnapshotArrived(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  /**
   * 内容派生的会话内引用绝不进精选库
   * （change generalize-facebook-content-derived-post-identity，task 4.3）。
   *
   * 精选库是**交付人工的面**：后台精选页会把它列出来，还挂着「定向评论」按钮，按下去就按 `sourceId`
   * 去开那条帖子。引用在别的会话里解析不出任何东西，那颗按钮必然失败。交不出去的东西不许交。
   * 判据只认事件上的显式分档，绝不去看 noteId 长什么样。
   */
  private contentRefOnly(payload: { noteIdKind?: 'permalink' | 'content_ref' }): boolean {
    return payload.noteIdKind === 'content_ref';
  }

  private onNoteDetailArrived(payload: {
    detail: NoteDetailData;
    accountId?: string;
    ts: number;
    noteIdKind?: 'permalink' | 'content_ref';
  }): void {
    if (this.contentRefOnly(payload)) return;
    // 异步评估，绝不阻塞浏览主路径（fire-and-forget）。
    void this.evaluate(payload.detail, payload.accountId, payload.ts);
  }

  private onImageSnapshotArrived(payload: {
    detail: NoteDetailData;
    accountId?: string;
    ts: number;
    noteIdKind?: 'permalink' | 'content_ref';
  }): void {
    if (this.contentRefOnly(payload)) return;
    void this.refreshImages(payload.detail, payload.accountId, payload.ts);
  }

  private async refreshImages(d: NoteDetailData, eventAccountId: string | undefined, snapshotAt: number): Promise<void> {
    if (!d || !d.noteId || !d.images?.length) return;
    // OCR 开启时必须让新图片快照重新走锚判断与正文重建，不能只替换图片后留下旧转写。
    if (this.textCardTranscriber?.enabled()) {
      await this.evaluate(d, eventAccountId, snapshotAt);
      return;
    }
    const accountId = eventAccountId ?? this.getAccountId();
    if (!accountId || accountId === '__unbound__') return;
    const contentType = d.mediaType === 'video' ? 'video' : 'image_text';
    try {
      const updated = await this.curatedStore.refreshReferenceImages?.(accountId, d.noteId, contentType, d.images);
      if (updated && updated > 0) {
        this.log(`刷新精选参考图 note=${d.noteId} images=${d.images.length}`);
        return;
      }
    } catch (err) {
      this.log(`刷新精选参考图失败（回落准入评估）：${(err as Error).message}`);
    }
    await this.evaluate(d, eventAccountId, snapshotAt);
  }

  private async evaluate(d: NoteDetailData, eventAccountId: string | undefined, snapshotAt: number): Promise<void> {
    if (!d || !d.noteId) return;
    const accountId = eventAccountId ?? this.getAccountId();
    // honest-fail：缺账号 / 未绑定占位 → 不落（杜绝脏流量记到退役账号名下）。
    if (!accountId || accountId === '__unbound__') return;

    const config = resolveCuratedGateConfig(accountId);
    // ── 第一段：共鸣预筛（零 LLM）。不过即弃，绝不进第二段（成本红线）。 ──
    const res = passesResonance({ likeCount: d.likeCount, collectCount: d.collectCount }, config);
    if (!res.ok) return;

    const contentType = d.mediaType === 'video' ? 'video' : 'image_text';
    let referenceImages: CuratedReferenceImageInput[] = d.images ?? [];
    let textCardTranscription: TextCardTranscription | undefined;
    let body = d.content.trim();
    if (contentType === 'image_text' && referenceImages.length > 0 && this.textCardTranscriber?.enabled()) {
      let cached: CuratedTextCardContext | null = null;
      try {
        cached = (await this.curatedStore.getTextCardContext?.(accountId, d.noteId, contentType)) ?? null;
      } catch (err) {
        this.log(`读取文字卡转写缓存失败（继续现转）：${(err as Error).message}`);
      }
      try {
        const outcome = await this.textCardTranscriber.transcribe({
          accountId,
          sourceId: d.noteId,
          images: referenceImages,
          snapshotAt,
          cached,
        });
        referenceImages = outcome.images;
        textCardTranscription = outcome.transcription;
        body = mergeBodyWithTextCardTranscription(body, textCardTranscription);
      } catch (err) {
        // 服务承诺吞视觉失败；此处再防御，正文保持 DOM 原值，绝不阻断浏览。
        this.log(`文字卡转写异常（保持 DOM 正文）：${(err as Error).message}`);
      }
    }
    if (!body) return;
    const note = { ...d, content: body };

    const topics = topicKeysFromTitle(note.title);

    // 开关关 → 回退「仅共鸣」：预筛过即纳入（不调 LLM、不评相关性/丰富度）。
    if (!this.llmEvalEnabled) {
      await this.admit(accountId, note, topics, res.reason, referenceImages, snapshotAt, textCardTranscription);
      return;
    }

    // ── 第二段：模型评估（仅预筛幸存者）。读全文判相关 + 丰富 + 非广告标题党。 ──
    let raw: string;
    try {
      raw = await this.decide(this.buildPrompt(note));
    } catch {
      // 诚实红线 + fire-and-forget：LLM 降级 → 不纳入；不抛、不阻塞浏览。
      this.log(`LLM 评估失败 → 诚实不纳入 note=${d.noteId}`);
      return;
    }
    const parsed = this.parse(raw);
    if (!parsed) {
      this.log(`评估输出解析失败 → 诚实不纳入 note=${d.noteId}`);
      return;
    }
    if (!(parsed.admit && parsed.relevanceOk && parsed.richnessOk && !parsed.isPromoOrClickbait)) {
      this.log(`评估不准入 note=${d.noteId}：${parsed.reason}`);
      return;
    }
    await this.admit(accountId, note, topics, 'llm_eval', referenceImages, snapshotAt, textCardTranscription);
  }

  /** 落精选语料（fire-and-forget：失败只 log，不抛、不阻塞浏览主路径）。 */
  private async admit(
    accountId: string,
    d: NoteDetailData,
    topics: string[],
    admitReason: string,
    referenceImages: CuratedReferenceImageInput[],
    publishedObservedAt: number,
    textCardTranscription?: TextCardTranscription,
  ): Promise<void> {
    try {
      await this.curatedStore.upsertObservation({
        accountId,
        contentType: d.mediaType === 'video' ? 'video' : 'image_text',
        sourceId: d.noteId,
        title: d.title,
        body: d.content,
        author: d.author,
        sourceUrl: d.url,
        topics,
        likeCount: d.likeCount,
        collectCount: d.collectCount,
        ...(d.publishedAtText ? { publishedAtText: d.publishedAtText, publishedObservedAt } : {}),
        admitReason,
        referenceImages,
        ...(textCardTranscription ? { textCardTranscription } : {}),
      });
      this.log(`纳入精选 note=${d.noteId}（${admitReason}）`);
    } catch (err) {
      this.log(`落库失败（不影响浏览主路径）：${(err as Error).message}`);
    }
  }

  // ─── Prompt 构建 ───────────────────────────────────────────

  /** 只读预览（change role-prompt-visibility）：最小示例数据 + 真实人设渲染真实 prompt，仅供后台查看；不改 buildPrompt。 */
  previewPrompt(): string {
    return this.buildPrompt({
      noteId: '<示例noteId>',
      title: '<示例标题>',
      content: '<示例正文，运行时为真实笔记全文>',
      author: '<示例作者>',
      likeCount: 0,
      collectCount: 0,
    });
  }

  /** 只读人设来源片段（change prompt-viewer-persona-source）：与 buildPrompt 同源拼接，仅供查看器定位标注。 */
  personaSegments(): string[] {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary, ...(interests.seed_keywords ?? [])].join('、');
    return [`你是「${identity.name}」，${identity.role}。\n你的创作领域 / 兴趣（作软背景，不要硬性字面匹配）：${interestsStr}`];
  }

  private buildPrompt(note: NoteDetailData): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary, ...(interests.seed_keywords ?? [])].join('、');

    return `你是「${identity.name}」，${identity.role}。
你的创作领域 / 兴趣（作软背景，不要硬性字面匹配）：${interestsStr}

正在判断：这篇小红书笔记**值不值得收进你的「创作灵感素材库」**。素材库只留「和你创作领域真正相关、且内容扎实」的笔记。

笔记信息：
标题：${note.title}
正文（请依据**全文**判断，不要只看标题）：
${note.content}
点赞：${note.likeCount}，收藏：${note.collectCount}

逐项判断（三个维度都要给）：
1. relevanceOk：**依据全文**，这篇内容是否与你的创作领域真正相关（不是标题蹭边、不是只有标题像）。
2. richnessOk：内容是否丰富扎实——有具体信息 / 观点 / 经验 / 可复用细节；区别于「几句话配图」的水帖、通篇空话。
3. isPromoOrClickbait：是否纯广告 / 带货导流 / 标题党 / 纯蹭热点无实质（命中其一即 true）。

只输出 JSON（不要其他内容）：
{"admit": true 或 false, "relevanceOk": true 或 false, "richnessOk": true 或 false, "isPromoOrClickbait": true 或 false, "reason": "简短中文理由"}
其中 admit = relevanceOk 且 richnessOk 且 非广告标题党 时为 true，否则为 false。拿不准时倾向不纳入（admit:false）。`;
  }

  // ─── 输出解析 ───────────────────────────────────────────────

  /** 严格解析评估 JSON；缺核心字段 / 类型不符 → null（诚实判不纳入，绝不默认纳入）。 */
  private parse(raw: string): NoteEvalResult | null {
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
    // 三个实质判断必须是布尔（缺一即视为评估无效 → 不纳入）。
    if (typeof o.relevanceOk !== 'boolean' || typeof o.richnessOk !== 'boolean' || typeof o.isPromoOrClickbait !== 'boolean') {
      return null;
    }
    // admit 可缺：给定则用之，缺省按三维推导（实质判断已严格校验，故推导是安全方向）。
    const admit = typeof o.admit === 'boolean' ? o.admit : o.relevanceOk && o.richnessOk && !o.isPromoOrClickbait;
    const reason = typeof o.reason === 'string' ? o.reason : 'note_evaluated';
    return { admit, relevanceOk: o.relevanceOk, richnessOk: o.richnessOk, isPromoOrClickbait: o.isPromoOrClickbait, reason };
  }
}
