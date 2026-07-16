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
 * Facebook 评论**开帖步**超时（change fb-comment-open-hydration-window）。
 *
 * 分工是「边端先答」：边端自我掐表跑完有界窗口后如实回 `open_failed`，云端这道只做兜底上界——
 * 云端先掐表只会把一个诚实的 `open_failed` 改判成 `timeout`（经 `mapFacebookOpenOutcome` 塌进同一个
 * `no_strong_candidate`、运营看到的卡片一模一样），等于把诊断信息烧掉却没救回任何一条评论。
 *
 * 边端开帖最坏耗时（`aidcp-edge/src/facebook/comment-executor.ts` openPost）：
 *   settle 2.5s + 详情水合窗 22 轮×600ms ≈ 12.6s + 评论框催拉 6 轮×(滚动 + 4 探测×600ms) ≈ 12s
 *   + 约 26 次 CDP eval 往返 ≈ 3s  ≈ **30s** —— 已超固定 28s，故开帖步必须脱离 `FACEBOOK_STEP_TIMEOUT_MS`。
 * 取 45s = 最坏 ~30s + 余量，仍远在加群步上限（90s）内、绝不无界等待；超此上限仍诚实 `timeout`。
 *
 * **搜索步继续用 `FACEBOOK_STEP_TIMEOUT_MS`（28s）**：它的探测跑在 `editorScrollRounds` 循环内、每轮仍是 4 轮预算，
 * 预算未变，不跟着放宽。改边端详情窗（`postDetailProbeRounds`）须同步复算此值。
 */
export const FACEBOOK_OPEN_STEP_TIMEOUT_MS = 45_000;

/**
 * Facebook 评论提交步的**长度感知超时**（change facebook-join-comment-resilience，P0-1）。
 * 边端提交 = 逐字拟人输入（text.length × median ~110ms）+ Enter + 等待（waitAfterSubmit 4s）+ reload +
 * 等待（waitAfterReload 5s）+ own-identity 收窄校验。长评论在慢网下整段耗时会超过固定 28s 步超时 →
 * 云端误判 `timeout` → 调度器 `reallySubmitted` 为假 → 不打去重标记 → 下一轮同帖再发一条**真评论**
 *（平台可见重复）。故提交步超时按文案字符数放大；search 仍用固定 28s（open 见
 * `FACEBOOK_OPEN_STEP_TIMEOUT_MS`）。上限对齐加群步（90s）防边端真挂时无界等待——超上限仍诚实 `timeout`，绝不假成功。
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
  /**
   * keep-open 边端租约的 taskId（change facebook-manual-comment-keepopen-lease）：**必须**随每条 FB 评论命令下发。
   * 边端 FB 命令入口按 `canExecute(payload.taskId)` 无差别门控（`aidcp-edge/src/main.ts:873`）——持租约期内无 taskId 的
   * 命令一律被挡，故本任务的评论命令若不带匹配 taskId 会被自己持有的租约一起挡死（自锁）。缺省（无租约的旧构造/测试）→
   * 命令不带 taskId、边端空闲时照常放行（零回归）。
   */
  taskId?: string;
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
  // 开帖步专用上界（边端先答，见 FACEBOOK_OPEN_STEP_TIMEOUT_MS）。与上一行同形：显式注入优先（测试用小值快速验超时），
  // 未注入才取 45s 默认——生产未注入（server.ts 不传 stepTimeoutMs），故实际取 45s。
  const openTimeout = deps.stepTimeoutMs ?? FACEBOOK_OPEN_STEP_TIMEOUT_MS;
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
        () => push(makeEnvelope('search.execute', randomUUID(), Date.now(), { keyword, source: 'manager', container, ...(deps.taskId ? { taskId: deps.taskId } : {}) } as never)),
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
        // 开帖步专用上界：边端的详情水合窗（22 轮）+ 评论框催拉最坏 ≈30s > 固定 28s。用 28s 会把边端诚实的
        // open_failed 改判成 timeout（两者塌进同一 outcome、卡片无差别），故让边端先答。
        openTimeout,
        () => push(makeEnvelope('note.open', randomUUID(), Date.now(), { url, ...(deps.taskId ? { taskId: deps.taskId } : {}) } as never)),
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
              ...(deps.taskId ? { taskId: deps.taskId } : {}),
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
