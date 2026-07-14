import type { UiBrowserStandbyPayload } from './protocol.js';
import type { RiskAction, RiskWindow } from '../risk/types.js';

/**
 * 待机门槛（change standby-covers-idle-waits：20min → 5min）。
 *
 * **红线：这个默认值在边缘也有一份**（aidcp-edge `src/electron/browser-cold-standby.cjs` 的
 * `DEFAULT_BROWSER_COLD_STANDBY_MIN_WAIT_MS`），而边缘取的是**两者的较大值**。**只改这一端不生效、且无任何
 * 报错**——边缘会按自己那份旧门槛把提示拦下来。改门槛 MUST 两端同改。
 */
export const DEFAULT_BROWSER_STANDBY_MIN_WAIT_MS = 5 * 60_000;
export const DEFAULT_BROWSER_STANDBY_WARMUP_MS = 90_000;

/**
 * 「回访时刻」的默认跨度（change standby-covers-idle-waits）。
 *
 * 有一类停工**永远算不出恢复时刻**：风控 `frozen` / `restricted`（状态机里虽有恢复常量与 `recoverIfEligible`，
 * 但**全仓无人调用、也从不发出恢复信号**，唯一出口是运营手动改状态），以及周历整周全关（运营显式停号）。
 *
 * 这类账号最该让出槽位，但 `wakeAt` **MUST NOT 伪造成「那时会恢复」**——没有任何代码会在那时恢复它。
 * 这里赋予的是**回访**语义：「多久之后回来再问一次」。它表达的是「边缘确实会在那时醒来」这一事实，而非
 * 对恢复的承诺。
 *
 * 主唤醒路径其实是 `ui.snapshot` 那条约 60s 的周期链（冷待机期间核心进程与云端连接不断、链继续）：账号一恢复，
 * 下一跳提示即 `eligible=false`，边缘据此唤醒。周期链健在时每跳都会把回访时刻顺延，**回访因而只在周期链断掉时
 * 才真正触发——它是一道死人开关，不是常规路径**。
 */
export const DEFAULT_BROWSER_STANDBY_REVISIT_MS = 6 * 3_600_000;

const WAIT_WINDOWS: RiskWindow[] = ['minute', 'hour', 'day'];
const STANDBY_ACTION: RiskAction = 'view';

export interface BrowserStandbyConfig {
  enabled: boolean;
  minWaitMs: number;
  warmupMs: number;
  /** 回访跨度；缺省 → DEFAULT_BROWSER_STANDBY_REVISIT_MS。 */
  revisitMs?: number;
}

export interface BrowserStandbyRiskSource {
  explain(action: RiskAction): { allowed: boolean; reason?: string; retryAfterMs?: number };
  quotaReleaseAfterMs(action: RiskAction, window: RiskWindow): number | undefined;
  /** 当前风控状态（可选）：只用于把「无恢复时刻」的阻塞标注成 frozen / restricted，缺失时回落成通用标注。 */
  getState?(): { status?: string };
}

/**
 * 续场闸的结构化裁决（由 `RoleDispatcher.resumeGateSnapshot()` 产出）。
 *
 * 这是「让账号停下来的闸」与「让它关浏览器的闸」之间那根线。过去二者互不相通：只有**风控配额耗尽**会让边缘
 * 关浏览器，而**排期外 / 周历关闭 / 每日时长满 / 冻结**这几类停工完全不产出待机提示——账号安静下来了，浏览器
 * 却一直开着占 700MB，直到明天，或者永远。
 *
 * `resumeAt` 缺省 = **算不出恢复时刻** → 走上面 `DEFAULT_BROWSER_STANDBY_REVISIT_MS` 的回访语义。
 */
export interface ResumeGateVerdict {
  blocked: boolean;
  /** `'week' | 'active_window' | 'daily_sessions' | 'daily_minutes' | 'risk_state' | 'not_ready'` */
  reason?: string;
  /** 恢复时刻（绝对 ms）。缺省 = 算不出（冻结 / 整周全关）。 */
  resumeAt?: number;
}

export interface BuildBrowserStandbyHintOptions {
  now?: number;
  config?: BrowserStandbyConfig;
  /** 续场闸裁决；缺省（边缘离线 / 无 dispatcher）→ 只按风控判，行为与本 change 之前一致。 */
  resumeGate?: ResumeGateVerdict | null;
}

export function resolveBrowserStandbyConfig(env: NodeJS.ProcessEnv = process.env): BrowserStandbyConfig {
  return {
    enabled: parseEnabled(env.AIDCP_BROWSER_COLD_STANDBY, true),
    minWaitMs: parsePositiveMs(env.AIDCP_BROWSER_COLD_STANDBY_MIN_WAIT_MS, DEFAULT_BROWSER_STANDBY_MIN_WAIT_MS),
    warmupMs: parsePositiveMs(env.AIDCP_BROWSER_COLD_STANDBY_WARMUP_MS, DEFAULT_BROWSER_STANDBY_WARMUP_MS),
    revisitMs: parsePositiveMs(env.AIDCP_BROWSER_COLD_STANDBY_REVISIT_MS, DEFAULT_BROWSER_STANDBY_REVISIT_MS),
  };
}

/**
 * 产出浏览器冷待机提示。
 *
 * **准入判据是「解除这个阻塞需不需要浏览器」，不是「有没有确定的恢复时刻」**（change standby-covers-idle-waits）。
 * 旧判据（只有以 `quota:` 开头的 reason 才让位）把**冻结账号**——等待最长、可能永远不再干活的那一类——恰好排除
 * 在让位之外：`explain('view')` 对 frozen 回 `state:frozen`，不以 `quota:` 开头 → 落进 `hard_blocker` → 判「等待 0
 * 分钟、不用让位」。**越是不该占着浏览器的，占得越牢。**
 *
 * 两个来源、一条判据：
 * - **风控**（`source.explain('view')`）：配额窗口未释放 → 等窗口滑出；frozen → 无恢复时刻。
 * - **续场闸**（`options.resumeGate`）：周历排期 / 活跃时段窗口 / 每日场数 / 每日分钟 / restricted。
 *
 * **`restricted` 只能在续场闸这一问里被抓到**：风控对 `view` 动作豁免 restricted（`risk-controller.ts` 的
 * `explain`），所以 `explain('view')` 会回 allowed——账号明明已经不再续场了，风控那一问却说「能浏览」。
 */
export function buildBrowserStandbyHint(
  source: BrowserStandbyRiskSource,
  options: BuildBrowserStandbyHintOptions = {},
): UiBrowserStandbyPayload {
  const config = options.config ?? resolveBrowserStandbyConfig();
  const generatedAt = Math.floor(options.now ?? Date.now());
  const payload = (
    reason: string,
    waitMs: number,
    eligible = false,
    hintSource: UiBrowserStandbyPayload['source'] = 'risk',
  ): UiBrowserStandbyPayload => {
    const safeWaitMs = Number.isFinite(waitMs) && waitMs > 0 ? Math.ceil(waitMs) : 0;
    return {
      enabled: config.enabled,
      eligible,
      reason,
      waitMs: safeWaitMs,
      wakeAt: generatedAt + safeWaitMs,
      generatedAt,
      source: hintSource,
      minWaitMs: config.minWaitMs,
      warmupMs: config.warmupMs,
    };
  };

  /**
   * 无恢复时刻的阻塞 → 让位 + 回访。`wakeAt` 在此是「多久之后回来再问一次」，**不是恢复承诺**。
   * 唤醒主路径是 ui.snapshot 的 ~60s 周期链（每跳都会把回访时刻顺延）；回访只在周期链断掉时才真正触发。
   */
  const revisit = (reason: string, hintSource: UiBrowserStandbyPayload['source']) =>
    payload(reason, Math.max(config.revisitMs ?? DEFAULT_BROWSER_STANDBY_REVISIT_MS, config.minWaitMs), true, hintSource);

  if (!config.enabled) return payload('disabled', 0, false);

  const decision = source.explain(STANDBY_ACTION);
  if (!decision.allowed) {
    const reason = decision.reason ?? '';
    // 冻结：等待无限期、解除不需要浏览器（唯一出口是运营在后台改状态）→ 最该让位的一类。
    if (reason === 'state:frozen') return revisit('risk_state:frozen', 'risk');
    // 需要浏览器才能解除的阻塞（验证码 / 登录 / 人工介入 / 未知）→ 绝不让位，保持既有诚实告警。
    if (!reason.startsWith('quota:')) return payload('hard_blocker', 0, false);
    return quotaHint();
  }

  // 风控说「能浏览」，但账号可能已被续场闸停下来（排期外 / 时长满 / restricted）——正是旧判据的整片盲区。
  const gate = options.resumeGate;
  if (gate?.blocked) {
    const reason = gate.reason ?? '';
    // 「还没准备好」≠「没活干」：调度未开 / 人设未绑 / 无续场配置。人设绑定等动作可能要用浏览器 → 不让位。
    if (reason === 'not_ready') return payload('not_ready', 0, false);
    if (reason === 'risk_state') {
      const status = source.getState?.().status;
      return revisit(status ? `risk_state:${status}` : 'risk_state', 'risk');
    }
    // 算不出恢复时刻（周历整周全关 = 运营显式停号）→ 同样让位 + 回访。
    if (typeof gate.resumeAt !== 'number' || !Number.isFinite(gate.resumeAt)) {
      return revisit(`session:${reason || 'unknown'}`, 'session');
    }
    const waitMs = gate.resumeAt - generatedAt;
    if (waitMs <= 0) return payload('no_wait', 0, false);
    const eligible = waitMs >= config.minWaitMs;
    return payload(eligible ? `session:${reason || 'unknown'}` : 'short_wait', waitMs, eligible, 'session');
  }

  return payload('no_wait', 0, false);

  /** 风控配额等待（本 change 之前的唯一路径，行为保持不变）：等最慢的那个窗口滑出。 */
  function quotaHint(): UiBrowserStandbyPayload {
    const waits = WAIT_WINDOWS
      .map((window) => ({ window, waitMs: source.quotaReleaseAfterMs(STANDBY_ACTION, window) }))
      .filter((entry): entry is { window: RiskWindow; waitMs: number } =>
        typeof entry.waitMs === 'number' && Number.isFinite(entry.waitMs) && entry.waitMs > 0,
      );
    if (waits.length === 0) {
      const fallback = typeof decision.retryAfterMs === 'number' && Number.isFinite(decision.retryAfterMs) && decision.retryAfterMs > 0
        ? decision.retryAfterMs
        : 0;
      if (fallback <= 0) return payload('unknown_wait', 0, false);
      const eligible = fallback >= config.minWaitMs;
      return payload(eligible ? 'view_quota:unknown' : 'short_wait', fallback, eligible);
    }

    const maxWait = Math.max(...waits.map((entry) => entry.waitMs));
    const blockers = waits
      .filter((entry) => Math.abs(entry.waitMs - maxWait) < 1)
      .map((entry) => entry.window)
      .join('+');
    const eligible = maxWait >= config.minWaitMs;
    return payload(eligible ? `view_quota:${blockers || 'unknown'}` : 'short_wait', maxWait, eligible);
  }
}

function parseEnabled(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (!v) return fallback;
  if (['0', 'false', 'off', 'no', 'disabled'].includes(v)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(v)) return true;
  return fallback;
}

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000) return fallback;
  return Math.floor(n);
}
