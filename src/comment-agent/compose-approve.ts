/**
 * 按需评论任务的「撰写 → 去 AI 味 → 飞书人审」装配（change comment-search-command，task 3.2 最终装配 + 9.3 人审红线）。
 *
 * 复用既有评论链零件，命令式拼成 CommentTaskRunner 的 composeAndApprove 一步：
 *  ① 撰写：CommentComposer.composeDraft（正文 + 现场评论 + 人设 + 可选精选参考）→ 草稿 / null；
 *  ② 去 AI 味：PostProcessor（禁用词扫描 + 可选改写）+ 反照搬（overlapsAny，撞参考即弃）；
 *  ③ 人审：复用 CommentApprovalPort（发飞书卡 + 轮询 /tmp 先到先得授权信号），与发帖 AC-PUB 同机制、评论 requestId 命名空间。
 *
 * 红线：
 *  - AC-PUB：审批口未接线 / 超时 / 拒绝 → 返回 null（绝不裸发）。
 *  - honest：撰写空 / 清洗空 / 撞参考 → null（不伪造、不照搬）。
 *  - 命令路径**跳过**自治 CommentAppraiser 的硬阈值（赞>1000 且 藏>300），但**保留**人审（本步即人审）。
 */

import { PostProcessor } from '../publish-agent/post-processor.js';
import { overlapsAny } from '../agents/comment-de-ai-flavor.js';
import type { CommentApprovalPort } from '../agents/comment-approval-gate.js';
import { buildCommentApprovalRequestId } from '../agents/comment-approval-request-id.js';
import type { NoteData } from '../agents/content-curator-role.js';
import type { ContentScheduleApprovalMode } from '../config/content-schedule-store.js';
import type { NoteForComment, OnPageComment } from './comment-task-runner.js';
import { sendAutoApproveNotificationBestEffort } from './auto-approve-notification.js';

/** 撰写口（CommentComposer.composeDraft 的窄接口，便于桩）。 */
export interface ComposerLike {
  composeDraft(note: NoteData, opts: { references?: string[]; onPageComments?: string[] }): Promise<string | null>;
}

export interface AutoApproveCommentNotificationInput {
  requestId: string;
  noteId: string;
  text: string;
  title?: string;
  authorName?: string;
  accountId?: string;
  accountName?: string;
  contactIncluded?: boolean;
  /** 命令来源会话（change unify-card-routing-origin-then-team）；缺省 → 回落账号团队群 → 默认群。 */
  originChatId?: string;
}

export type AutoApproveCommentNotification = (input: AutoApproveCommentNotificationInput) => Promise<void>;

export interface ComposeApproveDeps {
  composer: ComposerLike;
  /** 去 AI 味处理器；缺省 new PostProcessor({})（仅禁用词扫描、不改写）。可传带 rewrite 的实例。 */
  postProcessor?: Pick<PostProcessor, 'process'>;
  /** 人审端口；缺省（未接线）→ 一律不发（返回 null，绝不裸发）。 */
  approval?: CommentApprovalPort;
  /** 排期审批模式；缺省 review。auto_approve 直接授权并旁路通知，不等待交互审批。 */
  approvalMode?: ContentScheduleApprovalMode;
  /** 免审旁路通知口；未接线或发送失败只记日志，不参与授权。 */
  autoApproveNotify?: AutoApproveCommentNotification;
  /** 当前评论账号 id；仅用于人审卡展示。 */
  accountId?: string;
  /** 当前评论账号展示名/昵称；仅用于人审卡展示。 */
  accountName?: string;
  /**
   * 命令来源会话（change unify-card-routing-origin-then-team）：由飞书命令创建的委托评论任务透传，
   * 人审卡 / 免审通知卡回下命令的那个会话。缺省（排期 / 自然浏览等自动化）→ 发卡端补集回落
   * 账号团队群 → 默认群。此处只负责**带到发卡端**，不参与撰写与授权判定。
   */
  originChatId?: string;
  /** 可选精选参考召回（仅作灵感、撞则弃）；缺省/出错 → 无参考。 */
  getReferences?: (note: NoteForComment) => Promise<string[]>;
  /**
   * 联系方式（change account-group-chat-injection）：非 null 时在去 AI 味 + 反照搬之后、人审之前 verbatim 追加。
   * 由 CommentScheduler 在任务开始处解析一次（/comment --contact 且账号已配联系方式；否则 null=不注入）。
   * 缺省 / null → 不注入（普通评论，零回归）。边缘保真（trim / 提及补全）由 edge 侧任务处置，此处保证云端「审=发」。
   */
  contactInfo?: string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn'>;
}

/**
 * composeAndApprove 结果（change account-group-chat-injection）：正文与联系方式**分开**返回——
 * 边缘逐字符敲 `text`（正文），再单次整段插入 `contactInfo`（联系方式，绕过 @/# 提及补全）。
 * 人审卡展示的是二者合并的完整终稿（审=发）。contactInfo 为 null = 不注入（普通评论）。
 */
export interface ComposeApproveResult {
  text: string;
  contactInfo: string | null;
}

/**
 * 未发出的判别原因（change comment-keep-open-through-approval 收尾）：让回执诚实区分
 * 「撰写阶段就没稿」与「已出稿送审但没获批」——绝不再把后者误说成"撰写为空"。
 * 注：「拒绝」与「超时」在授权口层不可区分（先到先得 /tmp 信号只看 approved===true，"不发"不写独立拒绝信号），
 * 故二者合并为单一 `approval_unapproved`（回执表述为"超时或被拒"）。
 */
export type ComposeSkipReason =
  | 'empty_compose' // 模型未产出 / 去 AI 味清洗后为空
  | 'overlaps_reference' // 与精选参考近似照搬 → 弃发
  | 'approval_not_wired' // 人审口未接线
  | 'approval_send_failed' // 审批卡发送失败
  | 'approval_unapproved'; // 送审后审批时限内未获批（超时或被拒）

/** composeAndApprove 结果：approved=true 带 {正文, 联系方式}；approved=false 带判别跳过原因（诚实回执）。 */
export type ComposeApproveOutcome =
  | ({ approved: true } & ComposeApproveResult)
  | { approved: false; reason: ComposeSkipReason };

/**
 * 装配 composeAndApprove：返回「(note, 现场评论) → {approved:true, 正文, 联系方式} / {approved:false, reason}」。
 */
export function buildComposeAndApprove(
  deps: ComposeApproveDeps,
): (note: NoteForComment, comments: OnPageComment[]) => Promise<ComposeApproveOutcome> {
  const postProcessor = deps.postProcessor ?? new PostProcessor({});
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.logger ?? console;

  return async (note: NoteForComment, comments: OnPageComment[]): Promise<ComposeApproveOutcome> => {
    const references = deps.getReferences ? await deps.getReferences(note).catch(() => []) : [];
    const onPageComments = comments.map((c) => c.text).filter(Boolean);
    const noteData: NoteData = {
      noteId: note.noteId,
      title: note.title,
      content: note.content,
      author: note.author,
      likeCount: note.likeCount ?? 0,
      collectCount: note.collectCount ?? 0,
    };

    // ① 撰写（含现场评论）。
    const draft = await deps.composer.composeDraft(noteData, { references, onPageComments });
    if (!draft) {
      log.log(`[comment-compose] 撰写为空/失败 note=${note.noteId} → 不发`);
      return { approved: false, reason: 'empty_compose' };
    }

    // ② 去 AI 味（确定性，不抛）+ 反照搬。
    let text = draft;
    try {
      text = (await postProcessor.process(draft)).content;
    } catch {
      text = draft;
    }
    text = text.trim();
    if (!text) {
      log.log(`[comment-compose] 清洗后为空 note=${note.noteId} → 不发`);
      return { approved: false, reason: 'empty_compose' };
    }
    if (references.length && overlapsAny(text, references)) {
      log.log(`[comment-compose] 与精选参考近似照搬 note=${note.noteId} → 弃发（绝不照搬）`);
      return { approved: false, reason: 'overlaps_reference' };
    }

    // ③ 联系方式（change account-group-chat-injection）：命中开关且有联系方式时，正文（text）与联系方式**分开**——
    //    正文交边缘逐字符敲、联系方式交边缘单次整段插入（绕过 @/# 提及补全）。此处只把二者的**合并终稿**送人审卡，
    //    保证「人审看到的 = 边缘将拼出的」（AC-PUB 审=发）；联系方式不参与上面的 overlapsAny 反照搬比对（只比正文）。
    //    正文长度闸在 composeDraft 内、作用于正文草稿；联系方式走整段插入、天然绕过（有意，联系方式本身长）。
    const code = deps.contactInfo || null;
    const reviewText = code ? `${text}\n${code}` : text; // 人审卡 = 正文 + 换行 + 联系方式（边缘将逐字敲正文、整段插联系方式拼出同一终稿）
    if (code) {
      log.log(`[comment-compose] 联系方式待注入 note=${note.noteId}（正文逐字 + 联系方式整段插入；人审卡展示合并终稿）`);
    }

    // ④ 审批模式：review 走交互人审；auto_approve 直接授权，并旁路发送免审通知。
    // 通知不参与授权判定，也不延迟提交链。
    const requestId = buildCommentApprovalRequestId(note.noteId, now());
    if (deps.approvalMode === 'auto_approve') {
      sendAutoApproveNotificationBestEffort({
        notify: deps.autoApproveNotify,
        payload: {
          requestId,
          noteId: note.noteId,
          text: reviewText,
          title: note.title,
          authorName: note.author,
          accountId: deps.accountId,
          accountName: deps.accountName,
          contactIncluded: code != null,
          ...(deps.originChatId ? { originChatId: deps.originChatId } : {}),
        },
        context: `[comment-compose] note=${note.noteId} `,
        logger: log,
      });
      log.log(`[comment-compose] 免审已授权 note=${note.noteId} requestId=${requestId}`);
      return { approved: true, text, contactInfo: code };
    }

    // ⑤ 人审（AC-PUB）：未接线 / 超时 / 拒绝 → null（绝不裸发）。审的是 reviewText（含码合并终稿）。
    if (!deps.approval) {
      log.warn(`[comment-compose] 评论人审口未接线 note=${note.noteId} → 不发（绝不裸发）`);
      return { approved: false, reason: 'approval_not_wired' };
    }
    try {
      await deps.approval.request({
        requestId,
        noteId: note.noteId,
        text: reviewText,
        title: note.title,
        authorName: note.author,
        accountId: deps.accountId,
        accountName: deps.accountName,
        ...(deps.originChatId ? { originChatId: deps.originChatId } : {}),
      });
    } catch (err) {
      log.warn(`[comment-compose] 审批卡发送失败 note=${note.noteId}：${(err as Error).message} → 不发`);
      return { approved: false, reason: 'approval_send_failed' };
    }
    const timeoutMs = deps.approval.timeoutMs ?? 90_000;
    const pollMs = deps.approval.pollMs ?? 2_000;
    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
      let approved = false;
      try {
        approved = await deps.approval.isApproved(requestId);
      } catch {
        approved = false;
      }
      if (approved) {
        log.log(`[comment-compose] 人审通过 note=${note.noteId} requestId=${requestId}`);
        return { approved: true, text, contactInfo: code }; // 正文与联系方式分开回给发送步骤（边缘分别处理）
      }
      await sleep(pollMs);
    }
    log.log(`[comment-compose] 人审超时（${timeoutMs}ms）note=${note.noteId} → 不发`);
    return { approved: false, reason: 'approval_unapproved' };
  };
}
