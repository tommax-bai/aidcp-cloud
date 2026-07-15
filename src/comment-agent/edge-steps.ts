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
  /** 当前 comment_prepare/comment_commit 租约；所有页面写命令逐条携带。 */
  taskId?: string;
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

/**
 * 多事件竞态（happy-path 报文 vs 该步的诚实失败回执）：谁先命中用谁；超时 / 无送达 → null。
 * 与 sendAndAwait 同语义，但可同时监听 page.cards.arrived 与 action.completed{action}——
 * 让边端「未导航到结果页」的诚实回执被立刻消费（快速失败），而非干等满超时（消除 maxTerms×超时空转）。
 * 与 facebook-edge-steps.sendAndRace 同款范式（change comment-search-nav-confirm）。
 */
function sendAndRace<T>(
  bus: EventBus,
  subscriptions: Array<{ event: 'page.cards.arrived' | 'note.detail.arrived' | 'action.completed'; match: (data: unknown) => T | undefined }>,
  timeoutMs: number,
  send: () => number,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let done = false;
    const offs: Array<() => void> = [];
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      for (const off of offs) off();
      clearTimeout(timer);
      resolve(v);
    };
    for (const sub of subscriptions) {
      offs.push(
        bus.on(sub.event, (data) => {
          const mapped = sub.match(data);
          if (mapped !== undefined) finish(mapped);
        }),
      );
    }
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
  readCurrentNote(note: NoteForComment): Promise<{ note: NoteForComment; comments: OnPageComment[] } | null>;
  post(noteId: string, text: string, contactInfo?: string | null): Promise<boolean>;
  recordCommented(noteId: string): Promise<void>;
} {
  const { bus, pusher, edgeId, taskId, dedup } = deps;
  const timeout = deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const maxCandidates = deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const log = deps.logger ?? console;

  const push = (env: unknown) => pusher.pushToEdges(env, edgeId);

  const readCurrentNote = async (note: NoteForComment): Promise<{ note: NoteForComment; comments: OnPageComment[] } | null> => {
    const noteId = note.noteId;
    const scrolled = await sendAndAwait<ActionCompleted>(
      bus,
      'action.completed',
      (d) => d.action === 'scroll_comments',
      timeout,
      () => push(makeEnvelope('note.scroll_comments', randomUUID(), Date.now(), { taskId, noteId, count: 2 })),
    );
    const candidates = scrolled?.candidates ?? [];
    if (!scrolled) {
      log.warn(`[comment-edge] 当前笔记 ${noteId} 采评论无 scroll_comments 回执（超时/边端离线）`);
    } else if (scrolled.reason === 'no_target' && candidates.length === 0) {
      log.warn(
        `[comment-edge] 当前笔记 ${noteId} 未命中评论容器（no_target），可能布局变体/选择器待校准，非确定「无评论」`,
      );
    }
    const comments: OnPageComment[] = candidates.map((c) => ({
      author: c.author,
      text: c.text,
      likeCount: c.likeCount,
    }));
    return { note, comments };
  };

  return {
    async searchAndHarvest(term: string): Promise<CommentCandidateCard[]> {
      // 竞速（change comment-search-nav-confirm）：page.cards.arrived（候选）vs
      // action.completed{action:'search', ok:false}（边端诚实回失败，如未导航到结果页 not_on_search_page）。
      // 谁先到用谁——边端诚实回执立即快速失败，不再干等满超时（消除多搜索词各等一遍的空转）。
      const outcome = await sendAndRace<
        { kind: 'cards'; cards: PageCardsArrived['cards'] } | { kind: 'fail'; reason: string }
      >(
        bus,
        [
          {
            event: 'page.cards.arrived',
            match: (data) => ({ kind: 'cards', cards: (data as PageCardsArrived).cards ?? [] }),
          },
          {
            event: 'action.completed',
            match: (data) => {
              const d = data as ActionCompleted;
              if (d.action !== 'search' || d.ok) return undefined;
              return { kind: 'fail', reason: d.reason ?? 'search_failed' };
            },
          },
        ],
        timeout,
        () =>
          push(
            makeEnvelope('search.execute', randomUUID(), Date.now(), {
              taskId,
              keyword: term,
              source: 'manager',
              ...(deps.sort ? { sort: deps.sort as never } : {}),
              ...(deps.timeWindow ? { timeWindow: deps.timeWindow as never } : {}),
            }),
          ),
      );
      if (outcome === null) {
        // 措辞中性（change comment-keep-open-through-approval）：cloud 的步超时 race 无法区分「边端在跑筛选/慢渲」
        // 与「边端真离线」——相邻租约常在 ~10s 有快速响应即证在线；故不再断言「边端离线」，避免误导下游。
        log.warn(`[comment-edge] 搜索「${term}」无 page.cards（搜索超时/结果未就绪）→ 空候选`);
        return [];
      }
      if (outcome.kind === 'fail') {
        // 边端在线、诚实回失败——独立真实结论，绝不冒充「离线」、绝不折叠成「无匹配笔记」（假归因红线）。
        if (outcome.reason === 'not_on_search_page') {
          log.warn(`[comment-edge] 搜索「${term}」未导航到结果页（nav 未确认，边端在线诚实回失败）→ 空候选`);
        } else {
          log.warn(`[comment-edge] 搜索「${term}」边端诚实回失败（${outcome.reason}）→ 空候选`);
        }
        return [];
      }
      // 结果**顺序即原生排序序**（最多收藏）；只取带 noteId 的，封顶 maxCandidates。
      return outcome.cards
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
      // 竞速三路（change comment-readnote-fastfail，对齐 searchAndHarvest 的 sendAndRace）：
      //  ① note.detail.arrived 且 noteId 匹配 = 成功；
      //  ② action.completed{open_note, ok:false} = 边端诚实回失败（弹层不弹/抽取失败/墙钟耗尽/无 noteId 找不到卡）；
      //  ③ page.cards.arrived = 目标卡已被回收、边端重报卡片（开不了）。
      // 任一失败信号先到即**快速失败**、不干等满单步超时；失败原因如实（绝不把边端在线的诚实失败冒充「超时/边端离线」）。
      const outcome = await sendAndRace<
        { kind: 'detail'; detail: NoteDetailArrived['detail'] } | { kind: 'fail'; reason: string }
      >(
        bus,
        [
          {
            event: 'note.detail.arrived',
            match: (data) => {
              const d = data as NoteDetailArrived;
              return d.detail?.noteId === noteId ? { kind: 'detail', detail: d.detail } : undefined;
            },
          },
          {
            event: 'action.completed',
            match: (data) => {
              const d = data as ActionCompleted;
              if (d.action !== 'open_note' || d.ok) return undefined;
              return { kind: 'fail', reason: d.reason ?? 'open_note_failed' };
            },
          },
          {
            // 开笔记命令后收到重报卡片而非目标详情 = 目标卡已不在当前页。
            event: 'page.cards.arrived',
            match: () => ({ kind: 'fail', reason: 'target_not_on_page' }),
          },
        ],
        timeout,
        () => push(makeEnvelope('note.open', randomUUID(), Date.now(), { taskId, noteId })),
      );
      if (outcome === null) {
        // 措辞中性：步超时 race 无法区分「边端在跑/慢渲」与「真离线」——不断言离线（对齐 searchAndHarvest）。
        log.warn(`[comment-edge] 开笔记 ${noteId} 无回执（超时/结果未就绪）`);
        return null;
      }
      if (outcome.kind === 'fail') {
        // 边端在线、诚实回失败——独立真实结论，绝不冒充「离线」。
        log.warn(`[comment-edge] 开笔记 ${noteId} 边端诚实回失败（${outcome.reason}）→ 不评`);
        return null;
      }
      const note: NoteForComment = {
        noteId: outcome.detail.noteId,
        title: outcome.detail.title,
        content: outcome.detail.content,
        author: outcome.detail.author,
        likeCount: outcome.detail.likeCount,
        collectCount: outcome.detail.collectCount,
      };
      // 翻两屏评论区采现场评论（best-effort：抓不到 → 空，不致命）。
      // change fix-interaction-and-comment-capture：区分「采集失败」（ok:false：没找到可滚容器/滚不动/异常）
      // 与「真无评论」（ok:true 且候选空）——采集失败记 warn，不静默当作「这篇没评论」（红线：空数组≠无评论）。
      // 找不到评论容器：偏采集/布局问题（选择器待真机校准），非确定「无评论」——值得留意。
      // 注意：no_scroll（短评论区不可滚）多为真的评论很少/没有，故不在此告警（避免误报真无评论）。
      return readCurrentNote(note);
    },

    readCurrentNote,

    async post(noteId: string, text: string, contactInfo?: string | null): Promise<boolean> {
      const completed = await sendAndAwait<ActionCompleted>(
        bus,
        'action.completed',
        (d) => d.action === 'comment',
        timeout,
        () =>
          push(
            makeEnvelope('interaction.comment', randomUUID(), Date.now(), {
              taskId,
              noteId,
              text,
              // 联系方式（account-group-chat-injection）：非空时边缘逐字敲 text 后整段插入此码（绕过 @/# 补全）。
              // 线协议字段名仍为 groupChatCode（protocol.ts 热点字段，重命名属另行协调步骤）。
              ...(contactInfo ? { groupChatCode: contactInfo } : {}),
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
