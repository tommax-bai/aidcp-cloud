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
   * 撰写（含现场评论）→ 去 AI 味 → 飞书人审；返回授权通过的 {正文, 群聊码}，跳过/未授权/失败返回 null。
   * 正文（text）与群聊码（groupChatCode，account-group-chat-injection）分开：边缘逐字敲正文、整段插码。
   */
  composeAndApprove(
    note: NoteForComment,
    comments: OnPageComment[],
  ): Promise<{ text: string; groupChatCode: string | null } | null>;
  /** 发布评论（interaction.comment + 真回执校验）；正文逐字、群聊码整段插入；返回是否真成功。 */
  post(noteId: string, text: string, groupChatCode?: string | null): Promise<boolean>;
  /** 发布成功后记一笔「已评论」（供下次去重）。 */
  recordCommented(noteId: string): Promise<void>;
}

export type CommentTaskOutcome =
  | 'commented' // 成功评了一篇
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
      return { outcome: 'read_failed', term, noteId: card.noteId, termsTried: tried, reason: 'open/read note failed' };
    }
    const composed = await steps.composeAndApprove(read.note, read.comments);
    if (!composed) {
      return { outcome: 'compose_skipped', term, noteId: card.noteId, termsTried: tried, reason: 'empty/unapproved/rejected' };
    }
    // 结果卡 / 日志展示的是合并终稿（正文 + 换行 + 码），= 人审通过、边缘将拼出的文本。
    const displayText = composed.groupChatCode ? `${composed.text}\n${composed.groupChatCode}` : composed.text;
    const ok = await steps.post(card.noteId, composed.text, composed.groupChatCode);
    if (!ok) {
      return { outcome: 'post_failed', term, noteId: card.noteId, text: displayText, termsTried: tried, reason: 'comment not verified posted' };
    }
    await steps.recordCommented(card.noteId);
    log.log(`[comment-task] 已评论 note=${card.noteId}（词「${term}」，尝试 ${tried} 个词）`);
    return { outcome: 'commented', term, noteId: card.noteId, text: displayText, termsTried: tried };
  }

  log.log(`[comment-task] 试过 ${tried} 个搜索词仍无强相关未评过候选 → 诚实结束、本次不评`);
  return { outcome: 'no_strong_candidate', termsTried: tried };
}
