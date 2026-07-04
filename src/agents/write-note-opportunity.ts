/**
 * WriteNoteOpportunity — 读完笔记后的写作机会判定旁路。
 *
 * 消费 reading.done，只在极少数“值得衍生创作”的笔记上触发现有发布链路的参照创作。
 * 不 emit 浏览主链事件、不等待发布终态、不消费互动预算；失败只记录日志，绝不阻塞互动或返回信息流。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { NoteData } from './content-curator-role.js';
import type { FeedEnteredPayload, ReadingDonePayload, RoleName } from '../event-bus/types.js';

export interface WriteNoteReference {
  sourceId: string;
  title: string;
  body: string;
  topics: string[];
  author?: string;
}

export type WriteNoteTriggerResult =
  | { triggered: true; reason?: string; status?: string; failureReason?: string }
  | { triggered: false; reason: string };

export interface WriteNoteOpportunityOptions extends RoleOptions {
  getNoteData: (noteId: string) => NoteData | null;
  getAccountId: () => string;
  triggerWriteNote: (accountId: string, referenceNote: WriteNoteReference) => Promise<WriteNoteTriggerResult>;
  /** 发布链路忙时不抢占；缺省视为不忙。 */
  isWriteNoteBusy?: () => boolean;
  /** 单场最多触发几次。缺省 1，保证“写笔记”是旁路而不是主流程。 */
  maxPerSession?: number;
  /** 单日最多触发几次。缺省 2，避免刷 feed 期间持续堆草稿。 */
  maxPerDay?: number;
  /** 两次触发最小间隔。缺省 6 小时。 */
  cooldownMs?: number;
  /** LLM 判 write 的最低置信度。缺省 0.8。 */
  minConfidence?: number;
  clock?: () => number;
}

interface WriteDecision {
  action: 'write' | 'skip';
  reason: string;
  confidence: number;
}

const HOUR_MS = 3_600_000;

function topicKeysFromTitle(title: string | undefined, max = 24): string[] {
  if (!title) return [];
  const keys = new Set<string>();
  const latin = title.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  for (const word of latin) keys.add(word);
  const cjk = title.match(/[一-鿿]/g) ?? [];
  for (let i = 0; i + 1 < cjk.length; i += 1) keys.add(cjk[i] + cjk[i + 1]);
  return Array.from(keys).slice(0, max);
}

export class WriteNoteOpportunity extends BaseRole {
  readonly roleName: RoleName = 'write_note_opportunity';
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private readonly getAccountId: () => string;
  private readonly triggerWriteNote: (accountId: string, referenceNote: WriteNoteReference) => Promise<WriteNoteTriggerResult>;
  private readonly isWriteNoteBusy: () => boolean;
  private readonly maxPerSession: number;
  private readonly maxPerDay: number;
  private readonly cooldownMs: number;
  private readonly minConfidence: number;
  private readonly clock: () => number;
  private unsubscribers: (() => void)[] = [];
  private attemptedNoteIds = new Set<string>();
  private sessionTriggers = 0;
  private dayKey = '';
  private dayTriggers = 0;
  private lastTriggeredAt = 0;
  private triggerInFlight = false;

  constructor(options: WriteNoteOpportunityOptions) {
    super(options);
    if (!options.llm) throw new Error('WriteNoteOpportunity 需要 LlmClient');
    this.getNoteData = options.getNoteData;
    this.getAccountId = options.getAccountId;
    this.triggerWriteNote = options.triggerWriteNote;
    this.isWriteNoteBusy = options.isWriteNoteBusy ?? (() => false);
    this.maxPerSession = options.maxPerSession ?? 1;
    this.maxPerDay = options.maxPerDay ?? 2;
    this.cooldownMs = options.cooldownMs ?? 6 * HOUR_MS;
    this.minConfidence = options.minConfidence ?? 0.8;
    this.clock = options.clock ?? Date.now;
    this.rollDayWindow();
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('feed.entered', (p) => this.onFeedEntered(p)),
      this.eventBus.on('reading.done', (p) => {
        void this.onReadingDone(p).catch((err) => {
          this.log(`写作机会判定异常（不影响浏览）：${(err as Error).message}`);
        });
      }),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private onFeedEntered(payload: FeedEnteredPayload): void {
    if (payload.trigger !== 'session_start') return;
    this.attemptedNoteIds = new Set();
    this.sessionTriggers = 0;
    this.triggerInFlight = false;
    this.rollDayWindow();
  }

  private async onReadingDone(payload: ReadingDonePayload): Promise<void> {
    this.rollDayWindow();
    if (!this.canConsider(payload.noteId)) return;

    const note = this.getNoteData(payload.noteId);
    if (!note) {
      this.log(`skip reason=note_data_unavailable note=${payload.noteId}`);
      return;
    }
    if (!note.title.trim() || !note.content.trim()) {
      this.log(`skip reason=empty_reference note=${payload.noteId}`);
      return;
    }

    this.attemptedNoteIds.add(payload.noteId);
    let raw: string;
    try {
      raw = await this.decide(this.buildPrompt(note));
    } catch {
      this.log(`skip reason=llm_error note=${payload.noteId}`);
      return;
    }

    const decision = this.parseOutput(raw);
    if (!decision) {
      this.log(`skip reason=parse_failed note=${payload.noteId}`);
      return;
    }
    if (decision.action !== 'write' || decision.confidence < this.minConfidence) {
      this.log(`skip reason=model_pass note=${payload.noteId} detail=${decision.reason}`);
      return;
    }
    if (!this.canTrigger(payload.noteId)) return;

    const referenceNote = this.toReferenceNote(note);
    this.triggerInFlight = true;
    try {
      const result = await this.triggerWriteNote(this.getAccountId(), referenceNote);
      if (!result.triggered) {
        this.log(`trigger skipped note=${payload.noteId} reason=${result.reason}`);
        return;
      }
      this.sessionTriggers += 1;
      this.dayTriggers += 1;
      this.lastTriggeredAt = this.clock();
      this.log(
        `triggered note=${payload.noteId} reason=${result.reason ?? 'read_reference'} status=${result.status ?? 'started'}`,
      );
      if (result.failureReason) this.log(`trigger failureReason=${result.failureReason}`);
    } finally {
      this.triggerInFlight = false;
    }
  }

  /** 只读预览（role-prompt-visibility）：用最小示例数据 + 真实人设渲染真实 prompt。 */
  previewPrompt(): string {
    return this.buildPrompt({
      noteId: '<示例noteId>',
      title: '<示例标题>',
      content: '<示例正文，运行时为真实笔记内容>',
      author: '<示例作者>',
      likeCount: 0,
      collectCount: 0,
    });
  }

  /** 只读人设来源片段：与 buildPrompt 同源拼接，供后台定位。 */
  personaSegments(): string[] {
    const { identity, interests, behavior_guidelines: bg } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary, ...(interests.seed_keywords ?? [])].join('、');
    const publishStyle = bg?.style ?? '保持本人语气，克制改写，不照搬原文';
    return [`你是「${identity.name}」，${identity.role}。\n创作领域 / 兴趣：${interestsStr}\n写作口径：${publishStyle}`];
  }

  private canConsider(noteId: string): boolean {
    if (this.attemptedNoteIds.has(noteId)) return false;
    return this.canTrigger(noteId);
  }

  private canTrigger(noteId: string): boolean {
    const now = this.clock();
    if (this.triggerInFlight || this.isWriteNoteBusy()) {
      this.log(`skip reason=publish_busy note=${noteId}`);
      return false;
    }
    if (this.sessionTriggers >= this.maxPerSession) {
      this.log(`skip reason=session_cap note=${noteId}`);
      return false;
    }
    if (this.dayTriggers >= this.maxPerDay) {
      this.log(`skip reason=day_cap note=${noteId}`);
      return false;
    }
    if (this.lastTriggeredAt > 0 && now - this.lastTriggeredAt < this.cooldownMs) {
      this.log(`skip reason=cooldown note=${noteId}`);
      return false;
    }
    return true;
  }

  private buildPrompt(note: NoteData): string {
    const { identity, interests, behavior_guidelines: bg } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary, ...(interests.seed_keywords ?? [])].join('、');
    const publishStyle = bg?.style ?? '保持本人语气，克制改写，不照搬原文';

    return `你是「${identity.name}」，${identity.role}。${identity.background}
语气：${identity.tone}
创作领域 / 兴趣：${interestsStr}
写作口径：${publishStyle}

你刚读完一篇小红书笔记。请判断：它是否值得作为“参照材料”触发一篇自己的新笔记。

当前笔记：
标题：${note.title}
作者：${note.author ?? '未知'}
正文：
${note.content}
点赞数：${note.likeCount}，收藏数：${note.collectCount}

判定标准（非常克制）：
- 只有当这篇笔记能激发一个清晰的新选题、结构、经验拆解或观点延展时才 write。
- 只是普通有用、适合点赞/收藏、或者只值得评论的内容，都 skip。
- 不能照搬原文；触发写作只表示把它作为灵感参照，后续仍走创作链和人审。
- 拿不准时 skip。

只输出 JSON：
{"action":"write","reason":"简短中文理由","confidence":0.85}
或：
{"action":"skip","reason":"简短中文理由","confidence":0.5}`;
  }

  private parseOutput(raw: string): WriteDecision | null {
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
    if (o.action !== 'write' && o.action !== 'skip') return null;
    if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence)) return null;
    const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim() : 'write_note_decided';
    return { action: o.action, reason, confidence: o.confidence };
  }

  private toReferenceNote(note: NoteData): WriteNoteReference {
    return {
      sourceId: note.noteId,
      title: note.title,
      body: note.content,
      topics: topicKeysFromTitle(note.title),
      ...(note.author ? { author: note.author } : {}),
    };
  }

  private rollDayWindow(): void {
    const next = new Date(this.clock()).toISOString().slice(0, 10);
    if (this.dayKey === next) return;
    this.dayKey = next;
    this.dayTriggers = 0;
  }
}
