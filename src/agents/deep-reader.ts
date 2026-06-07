/**
 * DeepReader — 深度阅读角色。
 *
 * 职责：在详情页浏览全部图片和评论区。
 * 纯执行角色，不使用 LLM。
 *
 * 消费事件：quality.pass
 * 产出事件：reading.done
 */

import { BaseRole } from './base-role.js';
import type { RoleName, QualityPassPayload } from '../event-bus/types.js';

export class DeepReader extends BaseRole {
  readonly roleName: RoleName = 'deep_reader';
  private unsubscribers: (() => void)[] = [];

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('quality.pass', (p) => this.onQualityPass(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private async onQualityPass(payload: QualityPassPayload): Promise<void> {
    const startTime = Date.now();

    // 模拟深度阅读（实际会向边缘发送指令浏览图片、滚动评论区）
    const imagesBrowsed = 0;  // placeholder — 边缘执行后填充
    const commentsRead = 0;   // placeholder — 边缘执行后填充

    this.emit('reading.done', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      imagesBrowsed,
      commentsRead,
      keyPoints: [],
      readDurationMs: Date.now() - startTime,
      ts: Date.now(),
    });
  }
}
