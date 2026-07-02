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
import type { NoteData } from '../agents/content-curator-role.js';
import type { NoteForComment, OnPageComment } from './comment-task-runner.js';

/** 撰写口（CommentComposer.composeDraft 的窄接口，便于桩）。 */
export interface ComposerLike {
  composeDraft(note: NoteData, opts: { references?: string[]; onPageComments?: string[] }): Promise<string | null>;
}

export interface ComposeApproveDeps {
  composer: ComposerLike;
  /** 去 AI 味处理器；缺省 new PostProcessor({})（仅禁用词扫描、不改写）。可传带 rewrite 的实例。 */
  postProcessor?: Pick<PostProcessor, 'process'>;
  /** 人审端口；缺省（未接线）→ 一律不发（返回 null，绝不裸发）。 */
  approval?: CommentApprovalPort;
  /** 可选精选参考召回（仅作灵感、撞则弃）；缺省/出错 → 无参考。 */
  getReferences?: (note: NoteForComment) => Promise<string[]>;
  /**
   * 群聊引流码（change account-group-chat-injection）：非 null 时在去 AI 味 + 反照搬之后、人审之前 verbatim 追加。
   * 由 CommentScheduler 在任务开始处解析一次（/comment group:on 且账号已配码；否则 null=不注入）。
   * 缺省 / null → 不注入（普通评论，零回归）。边缘保真（trim / 提及补全）由 edge 侧任务处置，此处保证云端「审=发」。
   */
  groupChatCode?: string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn'>;
}

/**
 * 装配 composeAndApprove：返回「(note, 现场评论) → 授权通过的评论文本 / null」。
 */
export function buildComposeAndApprove(
  deps: ComposeApproveDeps,
): (note: NoteForComment, comments: OnPageComment[]) => Promise<string | null> {
  const postProcessor = deps.postProcessor ?? new PostProcessor({});
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.logger ?? console;

  return async (note: NoteForComment, comments: OnPageComment[]): Promise<string | null> => {
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
      return null;
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
      return null;
    }
    if (references.length && overlapsAny(text, references)) {
      log.log(`[comment-compose] 与精选参考近似照搬 note=${note.noteId} → 弃发（绝不照搬）`);
      return null;
    }

    // ③ 群聊引流码注入（change account-group-chat-injection）：命中开关且有码时，在去 AI 味 + 反照搬**之后**、
    //    人审**之前** verbatim 追加——① 追加在去 AI 味之后 → 不被重写吞掉；② 追加在人审卡之前 → 人审看到的即含码完整
    //    终稿（AC-PUB「审=发」）；③ 码不参与上面的 overlapsAny 反照搬比对（只比正文）。正文长度闸在 composeDraft 内、
    //    作用于正文草稿，追加后终稿可超上限——有意（码本身长），非缺陷。边缘保真（trim / 提及补全）另由 edge 侧任务处置。
    if (deps.groupChatCode) {
      text = `${text}\n${deps.groupChatCode}`;
      log.log(`[comment-compose] 已注入群聊引流码 note=${note.noteId}（人审卡将展示含码终稿）`);
    }

    // ④ 人审（AC-PUB）：未接线 / 超时 / 拒绝 → null（绝不裸发）。
    if (!deps.approval) {
      log.warn(`[comment-compose] 评论人审口未接线 note=${note.noteId} → 不发（绝不裸发）`);
      return null;
    }
    const requestId = `comment-${note.noteId}-${now()}`;
    try {
      await deps.approval.request({ requestId, noteId: note.noteId, text, title: note.title });
    } catch (err) {
      log.warn(`[comment-compose] 审批卡发送失败 note=${note.noteId}：${(err as Error).message} → 不发`);
      return null;
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
        return text;
      }
      await sleep(pollMs);
    }
    log.log(`[comment-compose] 人审超时（${timeoutMs}ms）note=${note.noteId} → 不发`);
    return null;
  };
}
