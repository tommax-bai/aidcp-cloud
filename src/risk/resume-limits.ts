/**
 * 自动续场护栏 + 看门狗阈值（安全限额层）—— change session-auto-resume-with-excursions。
 *
 * 单场**正常结束**后，云端歇一段（= 单场时长 × rest_ratio）再自动续场，受「活跃时段窗口 + 每日上限 +
 * 撞风控不续」三道护栏约束；空闲看门狗两段阈值（恢复轻推 / 放弃结束）也按账号可调、热加载。
 * 本模块只持**写死默认 + 类型 + 提供者接口**（与 session-limits.ts 同层）；落库 / 内存镜像由
 * src/config/resume-config-store.ts 实现该接口。
 *
 * 零回归基线：缺配置时回落 rest 10% / 窗口全天不限 / 每日不限 / 轻推 130s / 放弃 1h——即
 * 「单场结束后按 10% 歇再续、看门狗轻推保持、放弃放宽到 1h」的默认行为，无运营介入即生效。
 */

/** 休息比例写死默认（百分比）：休息时长 = 单场时长 × 10%。 */
export const DEFAULT_REST_RATIO_PCT = 10;

/** 休息比例上限（校验用，防误填天文数字）：最多 10×（1000%）。 */
export const REST_RATIO_PCT_MAX = 1000;

/** 看门狗恢复轻推阈值写死默认（毫秒，~2min）。须 > 详情页停留上限（pacing capMs=90s）以免正常长停留误触。 */
export const DEFAULT_IDLE_NUDGE_MS = 130_000;

/** 看门狗放弃结束阈值写死默认（毫秒，1h）。仅戳不活的真死局才回收。 */
export const DEFAULT_IDLE_END_MS = 3_600_000;

/** 轻推阈值下限（毫秒）：必须严格大于详情页停留上限 90s，否则正常长停留会误触 nudge。 */
export const IDLE_NUDGE_MIN_MS = 91_000;

/** 看门狗阈值合理上限（毫秒，24h）：防误填。 */
export const IDLE_MS_MAX = 24 * 3_600_000;

/** 一天的分钟数（活跃时段窗口默认止 = 全天）。 */
export const MINUTES_PER_DAY = 1440;

/** 活跃时段窗口写死默认：全天（start=0, end=1440）→ 不限。 */
export const DEFAULT_ACTIVE_WINDOW = { startMin: 0, endMin: MINUTES_PER_DAY } as const;

/** 每日上限写死默认：0 = 不限（场数 / 累计分钟均不设限）。 */
export const DEFAULT_DAILY_MAX_SESSIONS = 0;
export const DEFAULT_DAILY_MAX_MINUTES = 0;

export interface ActiveWindow {
  /** 窗口起（自午夜分钟数，0..1440）。 */
  startMin: number;
  /** 窗口止（自午夜分钟数，0..1440）。start>end 视作跨午夜。start==end 或 (0,1440) 视作全天不限。 */
  endMin: number;
}

export interface DailyCaps {
  /** 每日自动续场场数上限；0 = 不限。 */
  maxSessions: number;
  /** 每日自动续场累计时长上限（分钟）；0 = 不限。 */
  maxMinutes: number;
}

/**
 * 自动续场护栏 + 看门狗阈值提供者（安全限额层接口）。
 * 由 ResumeConfigStore（config 层）实现（同步读内存镜像、缺值逐项回落写死默认、永不抛），
 * 注入调度器（续场闸 + 休息时长）与会话监测体（看门狗阈值）供运行时每次现读（PUT 后无需重启）。
 */
export interface ResumeConfigProvider {
  /** 某账号休息比例（小数，如 0.10）。缺 / 非法 → DEFAULT_REST_RATIO_PCT/100。 */
  restRatioFor(accountId: string): number;
  /** 某账号活跃时段窗口。缺 / 非法 → 全天不限。 */
  activeWindowFor(accountId: string): ActiveWindow;
  /** 某账号每日上限。缺 / 非法 → 不限（0/0）。 */
  dailyCapsFor(accountId: string): DailyCaps;
  /** 某账号看门狗恢复轻推阈值（毫秒）。缺 / 非法 → DEFAULT_IDLE_NUDGE_MS（且保证 >= IDLE_NUDGE_MIN_MS）。 */
  idleNudgeMsFor(accountId: string): number;
  /** 某账号看门狗放弃结束阈值（毫秒）。缺 / 非法 → DEFAULT_IDLE_END_MS（且保证 > idleNudge）。 */
  idleEndMsFor(accountId: string): number;
}

/**
 * 给定「自午夜分钟数」now 与窗口，判是否在活跃时段内。
 * - 全天不限：start==end，或 (start<=0 && end>=1440)。
 * - 普通窗口（start<end）：start <= now < end。
 * - 跨午夜窗口（start>end）：now >= start || now < end。
 */
export function isWithinActiveWindow(nowMinOfDay: number, win: ActiveWindow): boolean {
  const { startMin, endMin } = win;
  if (startMin === endMin) return true;
  if (startMin <= 0 && endMin >= MINUTES_PER_DAY) return true;
  if (startMin < endMin) return nowMinOfDay >= startMin && nowMinOfDay < endMin;
  return nowMinOfDay >= startMin || nowMinOfDay < endMin; // 跨午夜
}
