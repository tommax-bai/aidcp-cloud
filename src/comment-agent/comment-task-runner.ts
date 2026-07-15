/**
 * CommentTaskRunner — 按需评论任务的**有界换词重试控制流**（change comment-search-command，task 3.2 核心）。
 *
 * 这是编排的「大脑」，与边端 I/O 解耦：所有触达边端 / LLM / 风控的步骤都以 `CommentTaskSteps` 注入，
 * 本文件只负责控制流——故可脱离 live edge 完整单测（spec 强调的：逐词换词重试、去重在择优前、
 * 强相关命中即止、词用尽诚实结束、尝试上限）。真正的步骤实现（搜索+原生筛选、开笔记+翻评论、
 * 撰写+人审、发布、记账）由 CommentScheduler 用连接运行时 / 角色 / 评论链 / 风控装配（适配层，后续 task）。
 *
 * 控制流：
 *   生成有序搜索词 →〔逐词（至多 K）：搜索+原生筛选 → 去重(未评过) → 强相关甄选；
 *     强相关命中即开笔记→读正文+现场评论→撰写+人审→发布→记账，**返回 commented（首中即止）**；
 *     当前词无强相关 / 全被去重 → 换下一个词〕→ 词用尽/达上限仍无 → 诚实结束（未评）。
 *
 * 红线：
 *  - 强相关命中后开笔记/撰写/发布失败 = 本次任务诚实失败（不偷换另一篇、不假成功）。
 *  - 无强相关 / 全去重 = 换词；不在弱相关里凑评论。
 *  - 有界：至多尝试 maxTerms 个词（实际搜索限频/预算由步骤实现内部再把关）。
 */

import type { CommentCandidateCard, PickResult } from '../agents/comment-target-picker.js';

/**
 * 发评论的三态结果（change lease-strict-preemption 7.6 / HOLE-8）。旧版 `post(): Promise<boolean>` 把
 * 「提交按下已派发但未确认」塌成 false → post_failed → 去重账本不写 → 下次排期重触发 = **重复评论**。升级为三态，
 * 去重写入门改为「提交已派发（confirmed ∪ submitted_unconfirmed）」而非 ok===true。判据是边缘 action.completed.reason
 * 字符串（评论路径无 submitDispatched 布尔位；submitted_unconfirmed 为 XHS 提交后未确认，verification_ambiguous 为 FB 同义）。
 */
export type CommentPostResult =
  /** 边缘确认真发出（ok:true）。写去重、记 commented。 */
  | { status: 'confirmed' }
  /** 提交按下已派发但未确认（reason=submitted_unconfirmed）——可能已发出：写去重、**绝不重投**（防双发）。 */
  | { status: 'submitted_unconfirmed' }
  /** 提交前被抢占（reason 属抢占类）——放弃本轮：不写去重、不重建、不本轮换词重试。 */
  | { status: 'preempted'; reason: string }
  /** 压根没发出（超时 / 边端离线 / 其它未成功回执）——提交前，可安全按 post_failed 处置、下次排期再评。 */
  | { status: 'not_dispatched'; reason?: string };

/** 开笔记后读到的正文 + 现场评论（喂撰写）。 */
export interface NoteForComment {
  noteId: string;
  title: string;
  content: string;
  author?: string;
  likeCount?: number;
  collectCount?: number;
}

export interface OnPageComment {
  author?: string;
  text: string;
  likeCount?: number;
}

/** 注入的步骤集（边端 / LLM / 风控 / 记账全在此，便于单测桩）。 */
export interface CommentTaskSteps {
  /** 角色①：人设 + 精选集 → 有序搜索词。 */
  generateTerms(): Promise<string[]>;
  /** 某搜索词：搜索 + 原生「最多收藏 + 一天内」筛选 + 采候选卡片（含收藏数）。 */
  searchAndHarvest(term: string): Promise<CommentCandidateCard[]>;
  /** 去重：滤掉本账号**已评论过**的笔记（按账号，复用每笔记去重）。 */
  filterUncommented(cards: CommentCandidateCard[]): Promise<CommentCandidateCard[]>;
  /** 角色②：强相关甄选；pickIndex=null 表示该词无强相关（换词）。 */
  pick(cards: CommentCandidateCard[]): Promise<PickResult>;
  /** 开选中笔记 → 读正文 + 翻评论区采现场评论；失败返回 null。 */
  readNote(card: CommentCandidateCard): Promise<{ note: NoteForComment; comments: OnPageComment[] } | null>;
  /**
   * 撰写（含现场评论）→ 去 AI 味 → 飞书人审；返回授权通过的 {正文, 联系方式}，跳过/未授权/失败返回 null。
   * 正文（text）与联系方式（contactInfo，account-group-chat-injection）分开：边缘逐字敲正文、整段插入联系方式。
   */
  composeAndApprove(
    note: NoteForComment,
    comments: OnPageComment[],
  ): Promise<{ text: string; contactInfo: string | null } | null>;
  /** 发布评论（interaction.comment + 真回执校验）；正文逐字、联系方式整段插入；返回三态（7.6/HOLE-8）。 */
  post(noteId: string, text: string, contactInfo?: string | null): Promise<CommentPostResult>;
  /** 发布成功后记一笔「已评论」（供下次去重）。 */
  recordCommented(noteId: string): Promise<void>;
}

export type CommentTaskOutcome =
  | 'commented' // 成功评了一篇
  | 'submitted_unconfirmed' // 命中并提交已派发但未确认——可能已发出、已写去重、绝不重投（7.6）
  | 'preempted' // 命中后提交前被抢占——放弃本轮、不重建不重试（7.6）
  | 'not_started' // 尚未接管 edge，未执行搜索/选中/发布
  | 'no_terms' // 一个搜索词都没生成（人设/精选都空）
  | 'no_strong_candidate' // 所有词试完/达上限仍无强相关未评过的候选
  | 'read_failed' // 命中后开笔记/读正文失败
  | 'compose_skipped' // 命中后撰写为空/未授权/被拒
  | 'post_failed'; // 命中后发布未真成功

export interface CommentTaskResult {
  outcome: CommentTaskOutcome;
  /** 命中的搜索词 / 笔记 / 文本（命中后才有）。 */
  term?: string;
  noteId?: string;
  noteTitle?: string;
  text?: string;
  /** 实际尝试过的搜索词数。 */
  termsTried: number;
  reason?: string;
}

export interface CommentTaskRunnerOptions {
  /** 换词尝试上限 K（缺省 5）。 */
  maxTerms?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
}

const DEFAULT_MAX_TERMS = 5;

/**
 * 跑一次按需评论任务（纯控制流；边端 I/O 经 steps 注入）。
 */
export async function runCommentTask(
  steps: CommentTaskSteps,
  options: CommentTaskRunnerOptions = {},
): Promise<CommentTaskResult> {
  const maxTerms = options.maxTerms ?? DEFAULT_MAX_TERMS;
  const log = options.logger ?? console;

  const terms = await steps.generateTerms();
  if (!terms.length) {
    log.log('[comment-task] 未生成任何搜索词 → 诚实结束');
    return { outcome: 'no_terms', termsTried: 0 };
  }

  let tried = 0;
  for (const term of terms) {
    if (tried >= maxTerms) break;
    tried++;
    log.log(`[comment-task] 尝试第 ${tried} 个搜索词「${term}」`);

    const cards = await steps.searchAndHarvest(term);
    const fresh = await steps.filterUncommented(cards);
    if (!fresh.length) {
      log.log(`[comment-task] 「${term}」无未评过候选（${cards.length} 张全被去重或为空）→ 换词`);
      continue;
    }

    const picked = await steps.pick(fresh);
    if (picked.pickIndex == null) {
      log.log(`[comment-task] 「${term}」无强相关候选 → 换词（${picked.reason}）`);
      continue;
    }
    const card = fresh.find((c) => c.index === picked.pickIndex);
    if (!card || !card.noteId) {
      log.log(`[comment-task] 「${term}」pickIndex=${picked.pickIndex} 无对应卡片/noteId → 换词`);
      continue;
    }

    // —— 强相关命中：首中即止，对这一篇走到底（失败=诚实失败，不偷换另一篇）。 ——
    const read = await steps.readNote(card);
    if (!read) {
      return { outcome: 'read_failed', term, noteId: card.noteId, noteTitle: card.title, termsTried: tried, reason: 'open/read note failed' };
    }
    const composed = await steps.composeAndApprove(read.note, read.comments);
    if (!composed) {
      return { outcome: 'compose_skipped', term, noteId: card.noteId, noteTitle: read.note.title, termsTried: tried, reason: 'empty/unapproved/rejected' };
    }
    // 结果卡 / 日志展示的是合并终稿（正文 + 换行 + 联系方式），= 人审通过、边缘将拼出的文本。
    const displayText = composed.contactInfo ? `${composed.text}\n${composed.contactInfo}` : composed.text;
    const posted = await steps.post(card.noteId, composed.text, composed.contactInfo);
    const base = { term, noteId: card.noteId, noteTitle: read.note.title, text: displayText, termsTried: tried } as const;
    if (posted.status === 'preempted') {
      // 提交前被抢占：放弃本轮（不写去重、不换词重试、不假失败），90s 人审沉没，运营需重敲一次（7.6）。
      return { outcome: 'preempted', ...base, reason: `preempted:${posted.reason}` };
    }
    if (posted.status === 'not_dispatched') {
      return { outcome: 'post_failed', ...base, reason: posted.reason ?? 'comment not verified posted' };
    }
    // confirmed ∪ submitted_unconfirmed = 提交已派发 → 必写去重（防重复评论）。
    await steps.recordCommented(card.noteId);
    if (posted.status === 'submitted_unconfirmed') {
      // 提交已派发但未确认：已写去重、绝不重投（防双发）。
      return { outcome: 'submitted_unconfirmed', ...base, reason: 'comment submitted but unconfirmed' };
    }
    log.log(`[comment-task] 已评论 note=${card.noteId}（词「${term}」，尝试 ${tried} 个词）`);
    return { outcome: 'commented', ...base };
  }

  log.log(`[comment-task] 试过 ${tried} 个搜索词仍无强相关未评过候选 → 诚实结束、本次不评`);
  return { outcome: 'no_strong_candidate', termsTried: tried };
}

// ─── 定向评论（change curated-note-actions）──────────────────────────────────
//
// 与按需评论共用步骤集的边端/撰写子集，但目标已知：不生成搜索词、不 LLM 择优——
// 以指定搜索词检索后在返回卡片中按 noteId **精确匹配**；命中即对这一篇走到底（失败=诚实失败），
// 有界搜索尝试（≤2 次，兼顺带消化 takeover 重醒后的首包错配），用尽未命中 → note_not_found 诚实结束。
// 红线：绝不「差不多就评」——非目标 noteId 的卡片一律不评；详情上报 noteId 与目标不一致不评。

/** 定向评论所需步骤子集（去重在调度层前置检查，此处不再过滤）。 */
export type TargetedCommentSteps = Pick<
  CommentTaskSteps,
  'searchAndHarvest' | 'readNote' | 'composeAndApprove' | 'post' | 'recordCommented'
> & {
  /** 当前详情页已是目标笔记时：复用已读 detail，只补采现场评论，不再按标题搜索。 */
  readCurrentNote?: (note: NoteForComment) => Promise<{ note: NoteForComment; comments: OnPageComment[] } | null>;
};

export interface TargetedCommentTarget {
  /** 目标笔记 id（精选行 source_id）。 */
  noteId: string;
  /** 目标笔记标题，仅用于人审/结果卡展示，不参与机器定位。 */
  title?: string;
  /** 已打开并读过的当前笔记详情；存在时直接在当前笔记评论，绝不再按标题搜索兜底。 */
  currentNote?: NoteForComment;
  /** 首次搜索词（笔记标题截断）。 */
  searchTerm: string;
  /** 第二次尝试的放宽搜索词（如标题前 12 字）；缺省沿用 searchTerm 重发。 */
  fallbackTerm?: string;
}

export type TargetedCommentOutcome =
  | 'commented' // 成功评在目标笔记上
  | 'submitted_unconfirmed' // 提交已派发但未确认——可能已发出、已写去重、绝不重投（7.6）
  | 'preempted' // 命中后提交前被抢占——放弃本轮、不重建不重试（7.6）
  | 'not_started' // 尚未接管 edge（租约没拿到），未搜索/未定位目标/未发布
  | 'note_not_found' // 有界搜索尝试用尽，返回卡片中始终无目标 noteId
  | 'read_failed' // 命中后开笔记/读正文失败（含详情 noteId 与目标不一致）
  | 'compose_skipped' // 撰写为空/未授权/被拒
  | 'post_failed'; // 发布未真成功

export interface TargetedCommentResult {
  outcome: TargetedCommentOutcome;
  noteId: string;
  noteTitle?: string;
  /** 人审通过的合并终稿（正文 + 换行 + 联系方式），命中撰写后才有。 */
  text?: string;
  /** 实际发起的搜索尝试次数。 */
  searchAttempts: number;
  reason?: string;
}

export interface TargetedCommentRunnerOptions {
  /** 搜索尝试上限（缺省 2）。 */
  maxSearchAttempts?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
}

const DEFAULT_MAX_SEARCH_ATTEMPTS = 2;

/**
 * 跑一次定向评论任务（纯控制流；边端 I/O 经 steps 注入）。
 */
export async function runTargetedCommentTask(
  steps: TargetedCommentSteps,
  target: TargetedCommentTarget,
  options: TargetedCommentRunnerOptions = {},
): Promise<TargetedCommentResult> {
  const maxAttempts = options.maxSearchAttempts ?? DEFAULT_MAX_SEARCH_ATTEMPTS;
  const log = options.logger ?? console;

  let card: CommentCandidateCard | undefined;
  let attempts = 0;

  let read: { note: NoteForComment; comments: OnPageComment[] } | null = null;
  if (target.currentNote) {
    if (target.currentNote.noteId !== target.noteId) {
      return { outcome: 'read_failed', noteId: target.noteId, noteTitle: target.title, searchAttempts: 0, reason: `current_detail_mismatch(${target.currentNote.noteId})` };
    }
    log.log(`[targeted-comment] 复用当前笔记上下文 target=${target.noteId}，跳过标题搜索兜底`);
    read = steps.readCurrentNote ? await steps.readCurrentNote(target.currentNote) : { note: target.currentNote, comments: [] };
    if (!read) {
      return { outcome: 'read_failed', noteId: target.noteId, noteTitle: target.title ?? target.currentNote.title, searchAttempts: 0, reason: 'current note context unavailable' };
    }
  } else {
    while (attempts < maxAttempts && !card) {
      attempts++;
      const term = attempts === 1 ? target.searchTerm : (target.fallbackTerm ?? target.searchTerm);
      log.log(`[targeted-comment] 搜索定位第 ${attempts}/${maxAttempts} 次「${term}」 target=${target.noteId}`);
      const cards = await steps.searchAndHarvest(term);
      card = cards.find((c) => c.noteId === target.noteId);
      if (!card) {
        log.log(`[targeted-comment] 第 ${attempts} 次返回 ${cards.length} 张卡片，无目标 noteId → ${attempts < maxAttempts ? '重试' : '用尽'}`);
      }
    }
    if (!card) {
      return { outcome: 'note_not_found', noteId: target.noteId, noteTitle: target.title, searchAttempts: attempts, reason: `target not in search results after ${attempts} attempts` };
    }

    // —— 目标命中：对这一篇走到底（失败=诚实失败，绝不偷换另一篇）。 ——
    read = await steps.readNote(card);
    if (!read) {
      return { outcome: 'read_failed', noteId: target.noteId, noteTitle: target.title ?? card.title, searchAttempts: attempts, reason: 'open/read note failed' };
    }
  }
  if (read.note.noteId !== target.noteId) {
    // 防御：详情上报的 noteId 与目标不一致 —— 宁可不评，绝不评错帖。
    return { outcome: 'read_failed', noteId: target.noteId, noteTitle: target.title ?? read.note.title, searchAttempts: attempts, reason: `detail_note_mismatch(${read.note.noteId})` };
  }
  const composed = await steps.composeAndApprove(read.note, read.comments);
  if (!composed) {
    return { outcome: 'compose_skipped', noteId: target.noteId, noteTitle: read.note.title || target.title, searchAttempts: attempts, reason: 'empty/unapproved/rejected' };
  }
  const displayText = composed.contactInfo ? `${composed.text}\n${composed.contactInfo}` : composed.text;
  const posted = await steps.post(target.noteId, composed.text, composed.contactInfo);
  const base = { noteId: target.noteId, noteTitle: read.note.title || target.title, text: displayText, searchAttempts: attempts } as const;
  if (posted.status === 'preempted') {
    return { outcome: 'preempted', ...base, reason: `preempted:${posted.reason}` };
  }
  if (posted.status === 'not_dispatched') {
    return { outcome: 'post_failed', ...base, reason: posted.reason ?? 'comment not verified posted' };
  }
  // confirmed ∪ submitted_unconfirmed = 提交已派发 → 必写去重（防重复评论）。
  await steps.recordCommented(target.noteId);
  if (posted.status === 'submitted_unconfirmed') {
    return { outcome: 'submitted_unconfirmed', ...base, reason: 'comment submitted but unconfirmed' };
  }
  log.log(`[targeted-comment] 已评论 note=${target.noteId}（${attempts > 0 ? `${attempts} 次搜索定位` : '复用当前笔记上下文'}）`);
  return { outcome: 'commented', ...base };
}
