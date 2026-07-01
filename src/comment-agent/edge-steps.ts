/**
 * 按需评论任务的**边端触达步骤适配**（change comment-search-command，task 3.2 接真边端 + 6.1/6.3 去重）。
 *
 * 把 CommentTaskRunner 的「搜索+采列表 / 开笔记+翻评论 / 去重 / 发布 / 记账」几步接到**真边端**：
 * 评论任务接管该账号边端后独占之，本模块用「发命令 + 等该连接私有总线上的下一条匹配上报 + 超时」驱动
 * （浏览类上报无配对 id，不同于发布的 recordId+seq；靠接管独占消除竞争）。
 *
 * 红线：
 *  - honest：边端离线（pushToEdges 送达 0）/ 超时无上报 → 该步空/失败，不假成功。
 *  - 去重：发布前滤掉本账号已评过的；发布**真回执 ok** 后才记一笔。
 *  - 每步超时压在边端单步 ~30s 内（缺省 28s）。
 *  - 不读库越权：去重经注入的 dedup（已按账号绑定）。
 *
 * 注：撰写/人审（composeAndApprove）、搜索词生成（generateTerms）、甄选（pick）不在本模块——
 * 它们是 LLM / 评论链步骤，由 CommentScheduler 装配。本模块只管「边端 I/O + 去重」这几步。
 */

import { randomUUID } from 'node:crypto';
import { makeEnvelope } from '../comm/protocol.js';
import type { EventBus } from '../event-bus/index.js';
import type { CommentCandidateCard } from '../agents/comment-target-picker.js';
import type { NoteForComment, OnPageComment } from './comment-task-runner.js';

/**
 * 边端推送（与 EdgeCloudServer.pushToEdges 同构）。
 * edge-command-target-guard：缺目标 edgeId 时绝不广播——返回 0 视为诚实失败（送达 0 → 该步空 / 失败，不假成功）。
 */
export interface EdgePusher {
  pushToEdges(envelope: unknown, edgeId?: string): number;
}

/** 每笔记去重（InteractionDedup 已按账号绑定；窄接口便于桩）。 */
export interface CommentDedup {
  hasInteracted(noteId: string, action: 'comment'): Promise<boolean>;
  recordInteraction(noteId: string, action: 'comment'): Promise<void>;
}

export interface EdgeCommentStepsDeps {
  /** 该连接的私有事件总线（接管后边端上报灌进这里）。 */
  bus: EventBus;
  pusher: EdgePusher;
  /** 目标边端 edgeId（定向下发；解析见 CommentScheduler，离线则不启动任务）。 */
  edgeId: string;
  dedup: CommentDedup;
  /** 原生筛选：排序 / 时间窗（透传进 search.execute）。 */
  sort?: string;
  timeWindow?: string;
  /** 候选卡片上限（缺省 12）。 */
  maxCandidates?: number;
  /** 单步等待边端上报的超时（毫秒，缺省 28s，压在边端 30s 内）。 */
  stepTimeoutMs?: number;
  /** 发评论前犹豫中心值（毫秒，可选；拟人）。 */
  thinkMs?: () => number;
  logger?: Pick<Console, 'log' | 'warn'>;
}

const DEFAULT_STEP_TIMEOUT_MS = 28_000;
const DEFAULT_MAX_CANDIDATES = 12;

/**
 * 发命令并等待该连接私有总线上的下一条匹配上报（超时 / 边端离线 → null）。
 * 先订阅再下发，避免错过快上报；命中即 unsub + 清超时。
 */
function sendAndAwait<E>(
  bus: EventBus,
  event: 'page.cards.arrived' | 'note.detail.arrived' | 'action.completed',
  match: (data: E) => boolean,
  timeoutMs: number,
  send: () => number,
): Promise<E | null> {
  return new Promise<E | null>((resolve) => {
    let done = false;
    const finish = (v: E | null) => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve(v);
    };
    const off = bus.on(event, (data) => {
      const d = data as E;
      if (match(d)) finish(d);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    const sent = send();
    if (sent <= 0) finish(null); // honest：无在线边端送达
  });
}

interface PageCardsArrived {
  cards: Array<{ index?: number; title?: string; author?: string; likeCount?: number; collectCount?: number; noteId?: string }>;
}
interface NoteDetailArrived {
  detail: { noteId: string; title: string; content: string; author?: string; likeCount: number; collectCount: number };
}
interface ActionCompleted {
  action: string;
  ok: boolean;
  reason?: string;
  candidates?: Array<{ author?: string; text: string; likeCount?: number }>;
}

/**
 * 装配「搜索+采列表 / 去重 / 开笔记+翻评论 / 发布 / 记账」这几步（CommentTaskSteps 的边端 + 去重部分）。
 * generateTerms / pick / composeAndApprove 由 CommentScheduler 补齐。
 */
export function buildEdgeCommentSteps(deps: EdgeCommentStepsDeps): {
  searchAndHarvest(term: string): Promise<CommentCandidateCard[]>;
  filterUncommented(cards: CommentCandidateCard[]): Promise<CommentCandidateCard[]>;
  readNote(card: CommentCandidateCard): Promise<{ note: NoteForComment; comments: OnPageComment[] } | null>;
  post(noteId: string, text: string): Promise<boolean>;
  recordCommented(noteId: string): Promise<void>;
} {
  const { bus, pusher, edgeId, dedup } = deps;
  const timeout = deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const maxCandidates = deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const log = deps.logger ?? console;

  const push = (env: unknown) => pusher.pushToEdges(env, edgeId);

  return {
    async searchAndHarvest(term: string): Promise<CommentCandidateCard[]> {
      const arrived = await sendAndAwait<PageCardsArrived>(
        bus,
        'page.cards.arrived',
        () => true,
        timeout,
        () =>
          push(
            makeEnvelope('search.execute', randomUUID(), Date.now(), {
              keyword: term,
              source: 'manager',
              ...(deps.sort ? { sort: deps.sort as never } : {}),
              ...(deps.timeWindow ? { timeWindow: deps.timeWindow as never } : {}),
            }),
          ),
      );
      if (!arrived) {
        log.warn(`[comment-edge] 搜索「${term}」无 page.cards（超时/边端离线）→ 空候选`);
        return [];
      }
      // 结果**顺序即原生排序序**（最多收藏）；只取带 noteId 的，封顶 maxCandidates。
      return arrived.cards
        .filter((c) => c.noteId)
        .slice(0, maxCandidates)
        .map((c, i) => ({
          index: i,
          noteId: c.noteId,
          title: c.title ?? '',
          author: c.author,
          collectCount: c.collectCount ?? 0,
          likeCount: c.likeCount ?? 0,
        }));
    },

    async filterUncommented(cards: CommentCandidateCard[]): Promise<CommentCandidateCard[]> {
      const out: CommentCandidateCard[] = [];
      for (const c of cards) {
        if (!c.noteId) continue;
        if (await dedup.hasInteracted(c.noteId, 'comment')) continue; // 已评过 → 滤掉
        out.push(c);
      }
      // 重排 index 连续（picker 按 index 对齐）。
      return out.map((c, i) => ({ ...c, index: i }));
    },

    async readNote(card: CommentCandidateCard): Promise<{ note: NoteForComment; comments: OnPageComment[] } | null> {
      if (!card.noteId) return null;
      const noteId = card.noteId;
      const detail = await sendAndAwait<NoteDetailArrived>(
        bus,
        'note.detail.arrived',
        (d) => d.detail?.noteId === noteId,
        timeout,
        () => push(makeEnvelope('note.open', randomUUID(), Date.now(), { noteId })),
      );
      if (!detail) {
        log.warn(`[comment-edge] 开笔记 ${noteId} 无 note.detail（超时/边端离线）`);
        return null;
      }
      const note: NoteForComment = {
        noteId: detail.detail.noteId,
        title: detail.detail.title,
        content: detail.detail.content,
        author: detail.detail.author,
        likeCount: detail.detail.likeCount,
        collectCount: detail.detail.collectCount,
      };
      // 翻一屏评论区采现场评论（best-effort：抓不到 → 空，不致命）。
      const scrolled = await sendAndAwait<ActionCompleted>(
        bus,
        'action.completed',
        (d) => d.action === 'scroll_comments',
        timeout,
        () => push(makeEnvelope('note.scroll_comments', randomUUID(), Date.now(), { noteId, count: 1 })),
      );
      const comments: OnPageComment[] = (scrolled?.candidates ?? []).map((c) => ({
        author: c.author,
        text: c.text,
        likeCount: c.likeCount,
      }));
      return { note, comments };
    },

    async post(noteId: string, text: string): Promise<boolean> {
      const completed = await sendAndAwait<ActionCompleted>(
        bus,
        'action.completed',
        (d) => d.action === 'comment',
        timeout,
        () =>
          push(
            makeEnvelope('interaction.comment', randomUUID(), Date.now(), {
              noteId,
              text,
              ...(deps.thinkMs ? { thinkMs: deps.thinkMs() } : {}),
            }),
          ),
      );
      const ok = !!completed?.ok;
      if (!ok) log.warn(`[comment-edge] 发评论 ${noteId} 未真成功：${completed?.reason ?? '超时/边端离线'}`);
      return ok;
    },

    async recordCommented(noteId: string): Promise<void> {
      await dedup.recordInteraction(noteId, 'comment');
    },
  };
}
