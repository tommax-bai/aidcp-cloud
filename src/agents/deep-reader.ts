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
/** 一次浏览的目标张数（边缘按实际可见图数截断）。 */
const TARGET_IMAGE_COUNT = 3;

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
    const browse = this.decideBrowse(note);

    if (browse) {
      this.pending = {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        count: TARGET_IMAGE_COUNT,
      };
      this.log(`决定浏览多图（count≈${TARGET_IMAGE_COUNT}）`);
      this.emit('reading.browse_images', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        count: TARGET_IMAGE_COUNT,
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

  private onActionCompleted(payload: { action: string; ok: boolean }): void {
    if (payload.action !== 'browse_images' || !this.pending) return;
    const ctx = this.pending;
    this.pending = null;
    this.emit('reading.images_done', {
      noteId: ctx.noteId,
      sourcePageType: ctx.sourcePageType,
      imagesBrowsed: payload.ok ? ctx.count : 0,
      ts: Date.now(),
    });
  }

  // ─── 决策 ─────────────────────────────────────────────────

  /** 概率门 + 正文长度启发：是否浏览多图。 */
  private decideBrowse(note: NoteData | null): boolean {
    const textLen = note?.content?.length ?? 0;
    const prob = textLen > 0 && textLen < SHORT_BODY_THRESHOLD ? BROWSE_PROB_SHORT : BROWSE_PROB_LONG;
    return this.random() < prob;
  }
}
