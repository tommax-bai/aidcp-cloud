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

/**
 * 看门狗恢复轻推阈值写死默认（毫秒，~4min）。change raise-model-call-timeouts-for-thinking-models：
 * MUST 严格大于「单次模型调用天花板（180s）」与「详情页停留上限（pacing capMs=90s）」之更大者，
 * 否则一次进行中的合法 thinking 决策（其间无 edge 活动、空转计时在涨）会被中途注入恢复滚动、滚走正要返回决策的页面。
 * 抬高单次模型天花板时 MUST 同步抬高本值以守该不变量。
 */
export const DEFAULT_IDLE_NUDGE_MS = 240_000;

/** 看门狗放弃结束阈值写死默认（毫秒，1h）。仅戳不活的真死局才回收。MUST 大于 idle-nudge。 */
export const DEFAULT_IDLE_END_MS = 3_600_000;

/**
 * 轻推阈值下限（毫秒）。change raise-model-call-timeouts-for-thinking-models：MUST ≥ 单次模型调用天花板（180s），
 * 使运营经后台绝不能把轻推配到低于一次合法模型调用（旧 91s 只挡详情页停留上限，已不足以挡 thinking 决策）。
 *
 * change pacing-floor-config-min-interval 看门狗 lockstep 不变量：MUST 严格大于前台操作 gate floor 上限
 * `CAP_MS(15_000)`（src/risk/pacing.ts）——单次前台最小间隔等待恒 ≤ 15s ≪ 本值，永不误触 idle 看门狗。
 * 内容阅读停留另有 90s 内容模型上限，也必须低于本下限；由不变量测试断言这些常量关系（tripwire）。
 */
export const IDLE_NUDGE_MIN_MS = 200_000;

/** 看门狗阈值合理上限（毫秒，24h）：防误填。 */
export const IDLE_MS_MAX = 24 * 3_600_000;

/** 一天的分钟数（活跃时段窗口默认止 = 全天）。 */
export const MINUTES_PER_DAY = 1440;

/** 活跃时段窗口写死默认：全天（start=0, end=1440）→ 不限。 */
export const DEFAULT_ACTIVE_WINDOW = { startMin: 0, endMin: MINUTES_PER_DAY } as const;

/** 每日上限写死默认：0 = 不限（场数 / 累计分钟均不设限）。 */
export const DEFAULT_DAILY_MAX_SESSIONS = 0;
export const DEFAULT_DAILY_MAX_MINUTES = 0;

/**
 * Facebook 每日累计在线分钟默认（change account-nurture-discipline-spine §4.2）：360 = 6h。
 * 养号「每天在线 0.5–6h」——FB 号在全局每日时长未设（0=不限）时回落这个非零安全日窗，防长挂。
 */
export const DEFAULT_FB_DAILY_ONLINE_MINUTES = 360;

/**
 * 计算某账号「有效每日在线分钟上限」（0 = 不限）。全局每日时长阈值是全局单例（`dailyCaps().maxMinutes`），
 * 不分平台；本函数在其未显式设值（0）时给 Facebook 账号回落一个非零安全日窗，其它平台维持历史「不限」。
 * 全局显式设值（>0）时以全局为准（运营意图优先，覆盖平台默认）。纯函数、可单测；platform 用字符串避免
 * risk 层反向依赖 platform 层。
 */
export function effectiveDailyMaxMinutes(
  globalMaxMinutes: number,
  platform: string | undefined,
  facebookDefaultMinutes: number = DEFAULT_FB_DAILY_ONLINE_MINUTES,
): number {
  if (globalMaxMinutes > 0) return globalMaxMinutes;
  if (platform === 'facebook') return Math.max(0, facebookDefaultMinutes);
  return 0;
}

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
 * 自动续场护栏 + 看门狗阈值提供者（安全限额层接口）：全局单例，不再按账号。
 * 由 ResumeConfigStore（config 层）实现（同步读内存镜像、缺值逐项回落写死默认、永不抛），
 * 注入调度器（续场闸 + 休息时长）与会话监测体（看门狗阈值）供运行时每次现读（PUT 后无需重启）。
 */
export interface ResumeConfigProvider {
  /** 全局休息比例（小数，如 0.10）。缺 / 非法 → DEFAULT_REST_RATIO_PCT/100。 */
  restRatio(): number;
  /** 全局活跃时段窗口。缺 / 非法 → 全天不限。 */
  activeWindow(): ActiveWindow;
  /** 全局每日上限（阈值；计数仍按账号按日）。缺 / 非法 → 不限（0/0）。 */
  dailyCaps(): DailyCaps;
  /** 全局看门狗恢复轻推阈值（毫秒）。缺 / 非法 → DEFAULT_IDLE_NUDGE_MS（且保证 >= IDLE_NUDGE_MIN_MS）。 */
  idleNudgeMs(): number;
  /** 全局看门狗放弃结束阈值（毫秒）。缺 / 非法 → DEFAULT_IDLE_END_MS（且保证 > idleNudge）。 */
  idleEndMs(): number;
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
