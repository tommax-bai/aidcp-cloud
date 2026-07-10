// Facebook 定向评论边端 I/O 步骤（change facebook-scheduled-comment，task 2.2 真发接线）。
//
// 与小红书 edge-steps.ts 同构（订阅私有总线在先 → pushToEdges → 有界超时等回执），但 Facebook 边端把
// 「诚实非成功」经 action.completed 回报，而候选/详情走 page.cards/note.detail——故每步 race 两个事件：
// 命中happy-path报文 或 该步的 action.completed{action} 失败回执，谁先到用谁。
//
// 安全不变量：
// - 有界超时（DEFAULT_STEP_TIMEOUT_MS，此路径无巡视看门狗）：超时即诚实 timeout、绝不无限等。
// - 无在线边端（pushToEdges 命中 0）→ 立即 offline，绝不假成功。
// - 绝不在此模块记风控/冷却/去重——记账留给调度器（真发成功经 interaction.occurred 自动路径记风控）。

import { randomUUID } from 'node:crypto';

import { makeEnvelope } from '../comm/protocol.js';
import type { EventBus } from '../event-bus/index.js';
import type { EdgePusher } from './edge-steps.js';

export const FACEBOOK_STEP_TIMEOUT_MS = 28_000;
const DEFAULT_MAX_CANDIDATES = 8;

/**
 * Facebook 评论提交步的**长度感知超时**（change facebook-join-comment-resilience，P0-1）。
 * 边端提交 = 逐字拟人输入（text.length × median ~110ms）+ Enter + 等待（waitAfterSubmit 4s）+ reload +
 * 等待（waitAfterReload 5s）+ own-identity 收窄校验。长评论在慢网下整段耗时会超过固定 28s 步超时 →
 * 云端误判 `timeout` → 调度器 `reallySubmitted` 为假 → 不打去重标记 → 下一轮同帖再发一条**真评论**
 *（平台可见重复）。故提交步超时按文案字符数放大；search/open 仍用固定 28s。上限对齐加群步（90s）防
 * 边端真挂时无界等待——超上限仍诚实 `timeout`，绝不假成功。
 */
export const FACEBOOK_COMMENT_SUBMIT_BASE_MS = 18_000;
export const FACEBOOK_COMMENT_SUBMIT_PER_CHAR_MS = 220;
export const FACEBOOK_COMMENT_SUBMIT_MAX_MS = 90_000;

/**
 * 按评论字符数算提交步超时：`clamp(base + perChar×len, 传入步超时, 上限)`。
 * len 按 code point 计（对齐边端 `Array.from` 逐字），单调不减；短评论回落到传入步超时（≥28s）。
 */
export function facebookCommentSubmitTimeoutMs(text: string, stepTimeoutMs: number): number {
  const len = Array.from(text ?? '').length;
  const derived = FACEBOOK_COMMENT_SUBMIT_BASE_MS + FACEBOOK_COMMENT_SUBMIT_PER_CHAR_MS * len;
  return Math.min(FACEBOOK_COMMENT_SUBMIT_MAX_MS, Math.max(stepTimeoutMs, derived));
}

export interface FacebookEdgeStepsDeps {
  /** 该连接的私有事件总线（handler.ts 把边端上报 emit 到这里）。 */
  bus: EventBus;
  pusher: EdgePusher;
  /** 定向边端 edgeId（缺失/离线 → pushToEdges 命中 0 → 诚实 offline）。 */
  edgeId: string;
  stepTimeoutMs?: number;
  maxCandidates?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
}

/** 容器内搜索到的候选帖（permalink 作为 note.open{url} 的目标）。 */
export interface FacebookCandidate {
  permalink: string;
}

export interface FacebookSearchStepResult {
  ok: boolean;
  reason?: string;
  candidates: FacebookCandidate[];
  /** 容器真实群名（边缘从群页读出回传，change facebook-container-display-name）；供云端回填配置容器名。 */
  containerName?: string;
}
export interface FacebookOpenStepResult {
  ok: boolean;
  reason?: string;
  /** 帖子文字正文（图片帖常空）+ 顶部他人评论（change facebook-comment-read-before-write）——供撰写器读了再写。 */
  postText?: string;
  comments?: string[];
}
export interface FacebookCommentStepResult {
  ok: boolean;
  reason?: string;
}

interface PageCardsArrived {
  cards: Array<{ noteId?: string }>;
  containerName?: string;
}
interface NoteDetailArrived {
  detail: { noteId?: string; content?: string; comments?: string[] };
}
interface ActionCompleted {
  action: string;
  ok: boolean;
  reason?: string;
}

type AwaitEvent = 'page.cards.arrived' | 'note.detail.arrived' | 'action.completed';

/**
 * 订阅一组事件（在先）→ send（pushToEdges）→ 首个命中 match 的事件 resolve；有界超时 / 无送达 → null。
 * 与 edge-steps.sendAndAwait 同语义，但支持多事件竞态（happy-path 报文 vs 诚实失败回执）。
 */
function sendAndRace<T>(
  bus: EventBus,
  subscriptions: Array<{ event: AwaitEvent; match: (data: unknown) => T | undefined }>,
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

export function buildFacebookEdgeSteps(deps: FacebookEdgeStepsDeps): {
  searchInContainer(keyword: string, container: string): Promise<FacebookSearchStepResult>;
  openPost(url: string): Promise<FacebookOpenStepResult>;
  submitComment(permalink: string, text: string, groupChatCode?: string): Promise<FacebookCommentStepResult>;
} {
  const timeout = deps.stepTimeoutMs ?? FACEBOOK_STEP_TIMEOUT_MS;
  const maxCandidates = deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const log = deps.logger ?? console;
  const push = (env: unknown): number => deps.pusher.pushToEdges(env, deps.edgeId);

  return {
    async searchInContainer(keyword, container) {
      // 命中：page.cards.arrived（候选）或 action.completed{action:'search'}（诚实阻断/权限失败）。
      const outcome = await sendAndRace<
        { kind: 'cards'; cards: FacebookCandidate[]; containerName?: string } | { kind: 'fail'; reason: string }
      >(
        deps.bus,
        [
          {
            event: 'page.cards.arrived',
            match: (data) => {
              const p = data as PageCardsArrived;
              const cards = p.cards ?? [];
              const list: FacebookCandidate[] = [];
              for (const c of cards) {
                if (c.noteId) list.push({ permalink: c.noteId });
                if (list.length >= maxCandidates) break;
              }
              return { kind: 'cards', cards: list, ...(p.containerName ? { containerName: p.containerName } : {}) };
            },
          },
          {
            event: 'action.completed',
            match: (data) => {
              const d = data as ActionCompleted;
              if (d.action !== 'search') return undefined;
              return { kind: 'fail', reason: d.reason ?? 'search_failed' };
            },
          },
        ],
        timeout,
        () => push(makeEnvelope('search.execute', randomUUID(), Date.now(), { keyword, source: 'manager', container } as never)),
      );
      if (outcome === null) {
        log.warn?.('[fb-edge-steps] search 超时/离线');
        return { ok: false, reason: 'timeout', candidates: [] };
      }
      if (outcome.kind === 'fail') return { ok: false, reason: outcome.reason, candidates: [] };
      return { ok: true, candidates: outcome.cards, ...(outcome.containerName ? { containerName: outcome.containerName } : {}) };
    },

    async openPost(url) {
      const outcome = await sendAndRace<
        { kind: 'detail'; postText?: string; comments?: string[] } | { kind: 'fail'; reason: string }
      >(
        deps.bus,
        [
          {
            event: 'note.detail.arrived',
            match: (data) => {
              const d = data as NoteDetailArrived;
              if (d.detail?.noteId !== url) return undefined;
              const postText = (d.detail.content ?? '').trim();
              const comments = Array.isArray(d.detail.comments) ? d.detail.comments : [];
              return { kind: 'detail', ...(postText ? { postText } : {}), ...(comments.length > 0 ? { comments } : {}) };
            },
          },
          {
            event: 'action.completed',
            match: (data) => {
              const d = data as ActionCompleted;
              if (d.action !== 'open_note') return undefined;
              return { kind: 'fail', reason: d.reason ?? 'open_failed' };
            },
          },
        ],
        timeout,
        () => push(makeEnvelope('note.open', randomUUID(), Date.now(), { url } as never)),
      );
      if (outcome === null) {
        log.warn?.('[fb-edge-steps] open 超时/离线');
        return { ok: false, reason: 'timeout' };
      }
      if (outcome.kind === 'fail') return { ok: false, reason: outcome.reason };
      return { ok: true, ...(outcome.postText ? { postText: outcome.postText } : {}), ...(outcome.comments ? { comments: outcome.comments } : {}) };
    },

    async submitComment(permalink, text, groupChatCode) {
      // 长度感知超时（P0-1）：长评论逐字输入+提交后 reload/校验整段耗时可超固定 28s；用文案长度放大提交步超时，
      // 让慢但成功的提交等到真实回执（ok / verification_ambiguous，两者都会打去重标记），杜绝「误判 timeout → 再发一条」。
      const submitTimeout = facebookCommentSubmitTimeoutMs(text, timeout);
      const outcome = await sendAndRace<{ ok: boolean; reason?: string }>(
        deps.bus,
        [
          {
            event: 'action.completed',
            match: (data) => {
              const d = data as ActionCompleted;
              if (d.action !== 'comment') return undefined;
              return { ok: d.ok, ...(d.reason ? { reason: d.reason } : {}) };
            },
          },
        ],
        submitTimeout,
        () =>
          push(
            makeEnvelope('interaction.comment', randomUUID(), Date.now(), {
              noteId: permalink,
              text,
              ...(groupChatCode && groupChatCode.length > 0 ? { groupChatCode } : {}),
            } as never),
          ),
      );
      if (outcome === null) {
        log.warn?.('[fb-edge-steps] comment 超时/离线');
        return { ok: false, reason: 'timeout' };
      }
      return outcome;
    },
  };
}
