/**
 * DeepReader — 多图浏览决策与编排角色。
 *
 * 职责：详情页质量粗筛通过后，决定是否浏览多图、浏览几张，并下发 browse_images 指令。
 * 纯策略角色（不调 LLM）：基于正文长度的启发 + 概率门，体现真人"有时看图、有时不看"的取舍多样性。
 *
 * 消费事件：quality.pass、action.completed（browse_images 回执）
 * 产出事件：
 *   - reading.browse_images（意图，dispatcher 翻译为 browse_images 指令）
 *   - reading.images_done（多图阶段完成，comment_reviewer 据此进入评论阶段）
 *
 * 时序：边缘单页面顺序操作，故"看图"后必须等 browse_images 的 action.completed 再推进，
 * 保证图→评论→互动有序；失败回执也推进（不卡死）。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { NoteData } from './content-curator-role.js';
import type { RoleName, QualityPassPayload } from '../event-bus/types.js';

export interface DeepReaderOptions extends RoleOptions {
  getNoteData: (noteId: string) => NoteData | null;
  /** 随机源（注入便于测试确定性），默认 Math.random。 */
  random?: () => number;
}

/** 短正文（更可能是图文/图集笔记）→ 更可能翻图；长正文（文字向）→ 较少翻图。 */
const SHORT_BODY_THRESHOLD = 80;
const BROWSE_PROB_SHORT = 0.7;
const BROWSE_PROB_LONG = 0.4;
/** 高质量/高互动图文给足上限；边缘会按真实图片总数截断，达到“能看完就看完”。 */
const VIEW_ALL_IMAGE_CAP = 18;

function parseReasonCount(reason: unknown, key: string): number | null {
  if (typeof reason !== 'string') return null;
  const m = reason.match(new RegExp(`${key}=(\\d+)`));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export class DeepReader extends BaseRole {
  readonly roleName: RoleName = 'deep_reader';
  private readonly getNoteData: (noteId: string) => NoteData | null;
  private readonly random: () => number;
  private unsubscribers: (() => void)[] = [];
  /** 等待 browse_images 回执的在途上下文（单飞：一次只深读一篇）。 */
  private pending: { noteId: string; sourcePageType: 'feed' | 'search'; count: number } | null = null;

  constructor(options: DeepReaderOptions) {
    super(options);
    this.getNoteData = options.getNoteData;
    this.random = options.random ?? Math.random;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('quality.pass', (p) => this.onQualityPass(p)),
      this.eventBus.on('action.completed', (p) => this.onActionCompleted(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.pending = null;
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private onQualityPass(payload: QualityPassPayload): void {
    const note = this.getNoteData(payload.noteId);
    const plan = this.planBrowse(note);

    if (plan) {
      this.pending = {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        count: plan.count,
      };
      this.log(`决定浏览多图（count≈${plan.count}，${plan.reason}）`);
      this.emit('reading.browse_images', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        count: plan.count,
        ts: Date.now(),
      });
    } else {
      this.log('本次不浏览多图，直接进入评论阶段');
      this.emit('reading.images_done', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        imagesBrowsed: 0,
        ts: Date.now(),
      });
    }
  }

  private onActionCompleted(payload: { action: string; ok: boolean; reason?: string }): void {
    if (payload.action !== 'browse_images' || !this.pending) return;
    const ctx = this.pending;
    this.pending = null;
    const actual = payload.ok ? (parseReasonCount(payload.reason, 'browsed') ?? ctx.count) : 0;
    this.emit('reading.images_done', {
      noteId: ctx.noteId,
      sourcePageType: ctx.sourcePageType,
      imagesBrowsed: actual,
      ts: Date.now(),
    });
  }

  // ─── 决策 ─────────────────────────────────────────────────

  /** 概率门 + 正文长度/互动强度启发：是否浏览多图，以及浏览多少张。 */
  private planBrowse(note: NoteData | null): { count: number; reason: string } | null {
    const textLen = note?.content?.length ?? 0;
    const engagement = (note?.likeCount ?? 0) + (note?.collectCount ?? 0) * 1.5;
    const imageLed = textLen > 0 && textLen < SHORT_BODY_THRESHOLD;
    const highQuality = engagement >= 300 || (imageLed && engagement >= 80);
    const prob = highQuality ? 0.9 : imageLed ? BROWSE_PROB_SHORT : BROWSE_PROB_LONG;
    if (this.random() >= prob) return null;

    if (highQuality) return { count: VIEW_ALL_IMAGE_CAP, reason: '高互动图文，尽量看完' };
    if (imageLed) return { count: engagement >= 80 ? 8 : 6, reason: '短正文偏图文，增加翻图' };
    if (textLen < 220) return { count: engagement >= 120 ? 7 : 5, reason: '图文并重，适中翻图' };
    return { count: engagement >= 120 ? 5 : 3, reason: '长正文为主，少量看图' };
  }
}
