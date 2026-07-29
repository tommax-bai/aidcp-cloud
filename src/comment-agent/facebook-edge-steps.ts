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
import { facebookPostKey } from '../platform/facebook-presented-video.js';
import type { EdgePusher } from './edge-steps.js';

// Facebook 时间预算整体 ×1.5（用户口径，2026-07-29）。云端各步只做**兜底上界**：
// 必须晚于边端自掐表，否则会把边端一个具名失败改判成 timeout，诊断信息被烧掉却救不回任何一条评论。
export const FACEBOOK_STEP_TIMEOUT_MS = 42_000;
const DEFAULT_MAX_CANDIDATES = 8;

/**
 * Facebook 评论**开帖步**超时（change fb-comment-open-hydration-window）。
 *
 * 分工是「边端先答」：边端自我掐表跑完有界窗口后如实回 `open_failed`，云端这道只做兜底上界——
 * 云端先掐表只会把一个诚实的 `open_failed` 改判成 `timeout`（经 `mapFacebookOpenOutcome` 塌进同一个
 * `no_strong_candidate`、运营看到的卡片一模一样），等于把诊断信息烧掉却没救回任何一条评论。
 *
 * Native-only 边端开帖：文档就绪上限 12s + 目标身份水合窗 23s，外层 Native 命令原子上限 45s。
 * 因此 Cloud 不能沿用固定 42s 抢先掐断；取 68s = 边端 45s 上限 + 传输余量，仍远在加群步上限
 *（135s）内、绝不无界等待；超此上限仍诚实 `timeout`。
 *
 * **搜索步继续用 `FACEBOOK_STEP_TIMEOUT_MS`（42s）**：它的探测跑在 `editorScrollRounds` 循环内、每轮仍是 4 轮预算，
 * 轮数未变，只随整体 ×1.5。改 Native 详情水合窗或命令原子上限时须同步复算此值。
 */
export const FACEBOOK_OPEN_STEP_TIMEOUT_MS = 68_000;

/**
 * **空关键词首帖开帖步**的超时（change restore-facebook-post-join-comment-continuity）。
 *
 * 首帖开帖与按 URL 开帖是两条预算完全不同的路径，不能共用一个上界。首帖那条在边端是一串**串行**
 * 有界窗口：群页导航后就绪 12s + 首次探测约 2s + 四轮下滚约 12s + 可选固链导航后就绪 12s +
 * 评论框绑定 18s + 身份回读 30s ≈ 86s，外层 Native 原子上限因此为 135s
 *（`aidcp-edge/src/native-page-engine/browse-session.ts`）。
 *
 * 沿用本文件既有的推导形状：**云端 = 边端原子上限 + 传输余量**，故 158s。仍在评论 keep-open 租约
 *（9min）与会话空转看门狗内，绝不无界等待；超上限仍诚实 `timeout`。
 *
 * 按 URL 开帖走 `FACEBOOK_OPEN_STEP_TIMEOUT_MS`（68s）——两条路径的内层窗口不同，别合并。
 */
export const FACEBOOK_FIRST_POST_OPEN_STEP_TIMEOUT_MS = 158_000;

/**
 * Facebook 评论提交步的**长度感知超时**（change facebook-join-comment-resilience，P0-1）。
 * 边端提交 = 逐字拟人输入 + Enter + 等待（waitAfterSubmit 4s）+ reload + 等待（waitAfterReload 5s）
 * + own-identity 收窄校验。长评论在慢网下整段耗时会超过固定步超时 → 云端误判 `timeout` →
 * 调度器 `reallySubmitted` 为假 → 不打去重标记 → 下一轮同帖再发一条**真评论**（平台可见重复）。
 * 故提交步超时按文案字符数放大。
 *
 * **逐字输入的实测均速约 165ms/字符**（边端 `input.rs`：对数正态中位 110ms + 标点 ×1.4
 * + 8% 概率插入 300–600ms 停顿），故 per-char 系数必须明显高于它才留得下固定开销。
 * 2026-07-29 真机：约 277 字符的越南语招聘长文按旧参数只有 78s 预算，没输完就撞 deadline，
 * 边端如实回 `comment_deadline_exceeded` 并清空编辑框。
 *
 * **上限才是长评论的真正约束**：公式再大也被它夹回去。整体 ×1.5 的同时上限单独抬到 180s
 *（用户 2026-07-29 决定），覆盖约 880 字符，且仍在会话空转看门狗之内——超上限仍诚实 `timeout`，绝不假成功。
 */
export const FACEBOOK_COMMENT_SUBMIT_BASE_MS = 27_000;
export const FACEBOOK_COMMENT_SUBMIT_PER_CHAR_MS = 330;
export const FACEBOOK_COMMENT_SUBMIT_MAX_MS = 180_000;

/**
 * 按评论字符数算提交步超时：`clamp(base + perChar×len, 传入步超时, 上限)`。
 * len 按 code point 计（对齐边端 `Array.from` 逐字），单调不减；短评论回落到传入步超时（≥28s）。
 */
export function facebookCommentSubmitTimeoutMs(text: string, stepTimeoutMs: number): number {
  const len = Array.from(text ?? '').length;
  const derived = FACEBOOK_COMMENT_SUBMIT_BASE_MS + FACEBOOK_COMMENT_SUBMIT_PER_CHAR_MS * len;
  return Math.min(FACEBOOK_COMMENT_SUBMIT_MAX_MS, Math.max(stepTimeoutMs, derived));
}

function canonicalFacebookPostKey(value: string | undefined): string | null {
  if (!value) return null;
  const key = facebookPostKey(value);
  return key && key !== value ? key : null;
}

const FACEBOOK_FIRST_POST_TARGET_PREFIX = 'aidcp:facebook-group-feed-post:v1:';

export function isFacebookFirstPostTargetRef(value: string | undefined): boolean {
  return typeof value === 'string'
    && value.startsWith(FACEBOOK_FIRST_POST_TARGET_PREFIX)
    && /^[0-9a-f]{64}$/.test(value.slice(FACEBOOK_FIRST_POST_TARGET_PREFIX.length));
}

function isCanonicalFacebookGroupPostPermalink(value: string): boolean {
  if (!canonicalFacebookPostKey(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || (host !== 'facebook.com' && !host.endsWith('.facebook.com')) || url.hash) {
      return false;
    }
    if (/^\/groups\/[^/]+\/(?:posts|permalink)\/[^/?#]+\/?$/i.test(url.pathname)) {
      return !url.search;
    }
    if (!/^\/groups\/[^/]+\/?$/i.test(url.pathname)) return false;
    const keys = [...url.searchParams.keys()];
    return (
      keys.length === 1 &&
      keys[0] === 'multi_permalinks' &&
      (url.searchParams.get('multi_permalinks') ?? '').trim().length > 0
    );
  } catch {
    return false;
  }
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
  /** First-post mode returns this only when Facebook exposed a canonical group-post URL. */
  permalink?: string;
  /** First-post-only Edge-issued live-container target; never a Facebook permalink or post ID. */
  targetRef?: string;
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
  activityId?: string;
  searchOutcome?: 'results_ready' | 'no_results' | 'failed_after_submit' | 'not_submitted';
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
  openFirstPost(container: string): Promise<FacebookOpenStepResult>;
  openPost(url: string): Promise<FacebookOpenStepResult>;
  submitComment(target: string, text: string, groupChatCode?: string, fastReturnToFeed?: boolean): Promise<FacebookCommentStepResult>;
} {
  const timeout = deps.stepTimeoutMs ?? FACEBOOK_STEP_TIMEOUT_MS;
  // 开帖步专用上界（边端先答，见 FACEBOOK_OPEN_STEP_TIMEOUT_MS）。与上一行同形：显式注入优先（测试用小值快速验超时），
  // 未注入才取 45s 默认——生产未注入（server.ts 不传 stepTimeoutMs），故实际取 45s。
  const openTimeout = deps.stepTimeoutMs ?? FACEBOOK_OPEN_STEP_TIMEOUT_MS;
  // 首帖开帖是另一条预算（见 FACEBOOK_FIRST_POST_OPEN_STEP_TIMEOUT_MS）：边端串行窗口更长，
  // 沿用 45s 会在边端答话前先掐断，把具名失败改判成 timeout。显式注入仍优先（测试用小值）。
  const firstPostOpenTimeout = deps.stepTimeoutMs ?? FACEBOOK_FIRST_POST_OPEN_STEP_TIMEOUT_MS;
  const maxCandidates = deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const log = deps.logger ?? console;
  const push = (env: unknown): number => deps.pusher.pushToEdges(env, deps.edgeId);

  return {
    async searchInContainer(keyword, container) {
      const activityId = randomUUID();
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
              if (d.action !== 'search' || (d.activityId && d.activityId !== activityId)) return undefined;
              if (d.ok && d.searchOutcome === 'no_results') return { kind: 'cards', cards: [] };
              if (d.ok) return undefined;
              return { kind: 'fail', reason: d.reason ?? 'search_failed' };
            },
          },
        ],
        timeout,
        () => push(makeEnvelope('search.execute', activityId, Date.now(), {
          activityId,
          purpose: 'task_targeting',
          scope: 'container',
          keyword,
          source: 'manager',
          container,
          ...(deps.taskId ? { taskId: deps.taskId } : {}),
        } as never)),
      );
      if (outcome === null) {
        log.warn?.('[fb-edge-steps] search 超时/离线');
        return { ok: false, reason: 'timeout', candidates: [] };
      }
      if (outcome.kind === 'fail') return { ok: false, reason: outcome.reason, candidates: [] };
      return { ok: true, candidates: outcome.cards, ...(outcome.containerName ? { containerName: outcome.containerName } : {}) };
    },

    async openFirstPost(container) {
      if (!container.trim()) {
        return { ok: false, reason: 'invalid_target' };
      }
      const outcome = await sendAndRace<
        {
          kind: 'detail';
          target: string;
          canonical: boolean;
          postText?: string;
          comments?: string[];
        } | { kind: 'fail'; reason: string }
      >(
        deps.bus,
        [
          {
            event: 'note.detail.arrived',
            match: (data) => {
              const d = data as NoteDetailArrived;
              const target = String(d.detail?.noteId ?? '').trim();
              const canonical = isCanonicalFacebookGroupPostPermalink(target);
              if (!canonical && !isFacebookFirstPostTargetRef(target)) {
                return undefined;
              }
              const postText = (d.detail.content ?? '').trim();
              const comments = Array.isArray(d.detail.comments) ? d.detail.comments : [];
              return {
                kind: 'detail',
                target,
                canonical,
                ...(postText ? { postText } : {}),
                ...(comments.length > 0 ? { comments } : {}),
              };
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
        firstPostOpenTimeout,
        () => push(makeEnvelope('note.open', randomUUID(), Date.now(), {
          selection: 'first_commentable_group_post',
          container,
          ...(deps.taskId ? { taskId: deps.taskId } : {}),
        } as never)),
      );
      if (outcome === null) {
        log.warn?.('[fb-edge-steps] first-post open 超时/离线');
        return { ok: false, reason: 'timeout' };
      }
      if (outcome.kind === 'fail') return { ok: false, reason: outcome.reason };
      return {
        ok: true,
        ...(outcome.canonical ? { permalink: outcome.target } : { targetRef: outcome.target }),
        ...(outcome.postText ? { postText: outcome.postText } : {}),
        ...(outcome.comments ? { comments: outcome.comments } : {}),
      };
    },

    async openPost(url) {
      const targetPostKey = canonicalFacebookPostKey(url);
      if (!targetPostKey) {
        log.warn?.('[fb-edge-steps] open 目标缺少规范 Facebook 帖身份');
        return { ok: false, reason: 'invalid_target' };
      }
      const outcome = await sendAndRace<
        { kind: 'detail'; postText?: string; comments?: string[] } | { kind: 'fail'; reason: string }
      >(
        deps.bus,
        [
          {
            event: 'note.detail.arrived',
            match: (data) => {
              const d = data as NoteDetailArrived;
              if (canonicalFacebookPostKey(d.detail?.noteId) !== targetPostKey) return undefined;
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

    async submitComment(target, text, groupChatCode, fastReturnToFeed = false) {
      // 长度感知超时（P0-1）：长评论逐字输入+提交后 reload/校验整段耗时可超固定步超时；用文案长度放大提交步超时，
      // 让慢但成功的提交等到真实回执（ok / verification_ambiguous，两者都会打去重标记），杜绝「误判 timeout → 再发一条」。
      //
      // **字数口径必须与边端逐字打的内容一致**：边端真正要输入的是「正文 + 换行 + 联系方式」
      //（`aidcp-edge/src/native-page-engine/browse-session.ts` 的 facebookCommandTimeoutMs 就是这么算的）。
      // 这里只数正文 ⇒ 算出比边端更小的预算 ⇒ 云端反而先掐断，把一个还在正常输入的提交判成 timeout。
      // 带联系方式的评论一直是这个形状（既有单测里就并排写着 40 000 与 40 980），与本次 ×1.5 无关。
      const pacedText = groupChatCode && groupChatCode.length > 0 ? `${text}\n${groupChatCode}` : text;
      const submitTimeout = facebookCommentSubmitTimeoutMs(pacedText, timeout);
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
              noteId: target,
              text,
              ...(groupChatCode && groupChatCode.length > 0 ? { groupChatCode } : {}),
              ...(fastReturnToFeed ? { fastReturnToFeed: true } : {}),
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
