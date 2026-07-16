/**
 * CommentApprovalGate — 评论循环内人审闸（复用发帖 AC-PUB /tmp 先到先得信号）。
 *
 * 职责：评论下发前过飞书人审。循环内等：详情页仍开着时整条跑完。
 * 消费事件：comment.cleared
 * 产出事件：comment.approved（人审通过 → 交 RoleDispatcher 下发）或 comment.skipped（超时/拒绝/未接线）
 *
 * 红线（AC-PUB）：**未获授权 MUST NOT 下发评论**。审批口未接线（缺省）时一律 comment.skipped，绝不裸发。
 * 硬短超时：人盯一篇笔记几分钟本身是异常信号；超时即本篇不评、记审计、走「是否进主页评估」。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import type { RoleName, CommentApprovalTrace, CommentClearedPayload } from '../event-bus/types.js';
import { buildCommentApprovalRequestId } from './comment-approval-request-id.js';

/** 评论人审端口：发卡 + 查授权信号（复用发帖 messenger + isPublishApproved，换评论 requestId 命名空间）。 */
export interface CommentApprovalPort {
  /** 发飞书审批卡（携账号、拟发评论原文 + requestId + 笔记标题/用户昵称供人识别）。缺省时卡片显示未获取，不展示 id。 */
  request(input: {
    requestId: string;
    noteId: string;
    text: string;
    title?: string;
    authorName?: string;
    accountId?: string;
    accountName?: string;
    /**
     * 命令来源会话（change unify-card-routing-origin-then-team）：由飞书命令创建的委托评论任务
     * 透传其 originChatId，审批卡回下命令的那个会话。缺省（自然浏览闭环 / 排期等无来源会话的
     * 自动化路径）→ 发卡端补集回落账号团队群 → 默认群。
     */
    originChatId?: string;
  }): Promise<void>;
  /** 查 /tmp 先到先得授权信号；仅 approved===true 视为已授权。 */
  isApproved(requestId: string): Promise<boolean>;
  /** 等待上限（毫秒；可信停留上限），缺省 90000。 */
  timeoutMs?: number;
  /** 轮询间隔（毫秒），缺省 2000。 */
  pollMs?: number;
}

export interface CommentApprovalNoticeInput {
  requestId: string;
  noteId: string;
  text: string;
  title?: string;
  authorName?: string;
  accountId?: string;
  accountName?: string;
}

export interface CommentApprovalGateOptions extends RoleOptions {
  /** 人审端口；缺省（未接线）→ 一律 comment.skipped（绝不裸发）。 */
  approval?: CommentApprovalPort;
  /** 结构化 mandatory auto_approve 的免审通知口；先通知成功才授权，缺失/失败 fail-closed。 */
  autoApproveNotify?: (input: CommentApprovalNoticeInput) => Promise<void>;
  /** 当前账号 id；仅用于审批卡展示，缺省则卡片不显示账号。 */
  getAccountId?: () => string | null | undefined;
  /** 当前账号展示名/昵称；仅用于审批卡展示，缺省时由发卡端按 accountId 兜底。 */
  getAccountName?: () => string | null | undefined;
  /** 当前笔记标题解析（noteId→标题），仅供审批卡人识别；缺省/取不到 → 卡片显示未获取标题。 */
  getNoteTitle?: (noteId: string) => string | null;
  /** 当前笔记作者/用户昵称解析（noteId→昵称），仅供审批卡人识别；缺省/取不到 → 卡片显示未获取昵称。 */
  getNoteAuthor?: (noteId: string) => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class CommentApprovalGate extends BaseRole {
  readonly roleName: RoleName = 'comment_approval_gate';
  private readonly approval?: CommentApprovalPort;
  private readonly autoApproveNotify?: (input: CommentApprovalNoticeInput) => Promise<void>;
  private readonly getAccountId?: () => string | null | undefined;
  private readonly getAccountName?: () => string | null | undefined;
  private readonly getNoteTitle?: (noteId: string) => string | null;
  private readonly getNoteAuthor?: (noteId: string) => string | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private unsubscribers: (() => void)[] = [];

  constructor(options: CommentApprovalGateOptions) {
    super(options);
    this.approval = options.approval;
    this.autoApproveNotify = options.autoApproveNotify;
    this.getAccountId = options.getAccountId;
    this.getAccountName = options.getAccountName;
    this.getNoteTitle = options.getNoteTitle;
    this.getNoteAuthor = options.getNoteAuthor;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('comment.cleared', (p) => this.onCleared(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private skip(payload: CommentClearedPayload, reason: string): void {
    this.emit('comment.skipped', {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: payload.actions,
      reason,
      ...(payload.mandatoryInteraction ? { mandatoryInteraction: payload.mandatoryInteraction } : {}),
      ts: this.now(),
    });
  }

  private async onCleared(payload: CommentClearedPayload): Promise<void> {
    const mandatoryAutoApprove = payload.mandatoryInteraction?.actions.includes('comment') === true &&
      payload.mandatoryInteraction.commentApproval === 'auto_approve';
    const title = this.getNoteTitle?.(payload.noteId) ?? undefined;
    const authorName = this.getNoteAuthor?.(payload.noteId) ?? undefined;
    const accountId = this.getAccountId?.() ?? undefined;
    const accountName = this.getAccountName?.() ?? undefined;
    const requestId = buildCommentApprovalRequestId(payload.noteId, this.now());

    if (mandatoryAutoApprove) {
      if (!this.autoApproveNotify) {
        this.log(`mandatory auto_approve 通知口未接线，绝不裸发 note=${payload.noteId}`);
        this.skip(payload, 'auto_approve_notice_failed');
        return;
      }
      try {
        await this.autoApproveNotify({ requestId, noteId: payload.noteId, text: payload.text, title, authorName, accountId, accountName });
      } catch (err) {
        this.log(`mandatory auto_approve 通知失败：${(err as Error).message}`);
        this.skip(payload, 'auto_approve_notice_failed');
        return;
      }
      this.log(`mandatory auto_approve 已通知并授权 rule=${payload.mandatoryInteraction!.ruleId} note=${payload.noteId}`);
      const approvalTrace: CommentApprovalTrace = {
        requestId,
        ...(accountId ? { accountId } : {}),
        ...(accountName ? { accountName } : {}),
        ...(title ? { title } : {}),
        ...(authorName ? { authorName } : {}),
      };
      this.emit('comment.approved', {
        noteId: payload.noteId,
        sourcePageType: payload.sourcePageType,
        actions: payload.actions,
        text: payload.text,
        mandatoryInteraction: payload.mandatoryInteraction,
        approvalTrace,
        ts: this.now(),
      });
      return;
    }

    // 红线：审批口未接线 → 绝不裸发。
    if (!this.approval) {
      this.log('评论人审口未接线，本篇不发（绝不裸发）');
      this.skip(payload, 'approval_unwired');
      return;
    }

    const timeoutMs = this.approval.timeoutMs ?? 90_000;
    const pollMs = this.approval.pollMs ?? 2_000;

    // 解析笔记标题和作者昵称供人识别（取不到 → 卡片显示未获取，不展示内部 id）。
    try {
      await this.approval.request({ requestId, noteId: payload.noteId, text: payload.text, title, authorName, accountId, accountName });
    } catch (err) {
      this.log(`审批卡发送失败：${(err as Error).message}`);
      this.skip(payload, 'approval_request_failed');
      return;
    }

    const deadline = this.now() + timeoutMs;
    while (this.now() <= deadline) {
      let approved = false;
      try {
        approved = await this.approval.isApproved(requestId);
      } catch {
        approved = false;
      }
      if (approved) {
        this.emit('comment.approved', {
          noteId: payload.noteId,
          sourcePageType: payload.sourcePageType,
          actions: payload.actions,
          text: payload.text,
          ...(payload.mandatoryInteraction ? { mandatoryInteraction: payload.mandatoryInteraction } : {}),
          ts: this.now(),
        });
        return;
      }
      await this.sleep(pollMs);
    }
    // 超时：本篇不评、记审计，走「是否进主页评估」。
    this.log(`评论人审超时（${timeoutMs}ms），本篇不发 requestId=${requestId}`);
    this.skip(payload, 'approval_timeout');
  }
}
