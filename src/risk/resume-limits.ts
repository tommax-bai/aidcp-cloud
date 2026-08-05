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

/**
 * 通知巡视「停滞」时限（毫秒，5min）—— change guard-excursion-stall。
 *
 * 计的是**距上一次巡视前进的间隔**，不是巡视总时长：巡视结构上限是 3 类 × 3 次尝试 = 9 轮、每轮含一次
 * 边缘往返（评论类还含一次分类模型调用），要不误杀健康巡视，一个「总时长」上限得设到 27min 以上——
 * 那个数字大到对挂死毫无兜底价值。停滞判据没有这个矛盾：健康巡视每轮都在前进、时限永不到点。
 *
 * 两条 lockstep 不变量（由 acceptance tripwire 断言，改值前先看断言）：
 *  ① MUST >= `IDLE_NUDGE_MIN_MS`——健康巡视里存在一段不可压缩、期间零边缘上报的间隔（评论类的分类模型
 *     调用，天花板 180s），低于它就会在一次合法模型判定中途注入自愈导航。`IDLE_NUDGE_MIN_MS` 已锚定该
 *     天花板，直接拿它当机器可查的下界。
 *  ② `本值 × (EXCURSION_STALL_MAX_RECOVERIES + 1)` MUST 远小于 `DEFAULT_IDLE_END_MS`——最坏停滞窗口必须
 *     远早于会话级看门狗的放弃结束阈值，使巡视先自愈，而不是先被「杀掉整场会话」这个更粗的手段回收。
 *
 * 量级参考：健康巡视全程实测 5–20s，本值是它的 15–60 倍，健康轮次上不可能触发。
 */
export const EXCURSION_STALL_TIMEOUT_MS = 300_000;

/**
 * 通知巡视停滞的自愈预算（次）—— change guard-excursion-stall。
 *
 * 停滞时限到点 ⇒ 先花 1 次预算做**只读**重新对齐（重开通知首页、重读三栏计数）；预算耗尽仍无进展 ⇒
 * 诚实收尾（解除浏览暂停 + 回信息流）。红线：**恢复预算 MUST 只由停滞消费**——健康巡视里的导航与
 * 返回一次都不占；且自愈 MUST NOT 发分类栏点击（那是消费未读、无回滚的提交动作）。
 */
export const EXCURSION_STALL_MAX_RECOVERIES = 1;

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

/**
 * 「下一个活跃时段窗口开始」的绝对时刻（change standby-covers-idle-waits）。
 *
 * **仅在 `isWithinActiveWindow(...) === false` 时有意义**——窗口外才谈得上「下一次何时开」。全天不限的
 * 两个分支永不阻塞，返回 undefined。
 *
 * 规则：下一次出现 `startMin` 的**本地**时刻；今日的已过则取明日同一时刻。**该规则对跨午夜窗口
 * （start > end）同样正确**——跨午夜窗口只在 `endMin <= now < startMin` 时才判为窗口外，此时今日的
 * `startMin` 必然仍在未来，直接命中，走不到「明日」那一支。
 *
 * 时区口径 = 服务器本地时区（与调用方 `minuteOfDay` 一致）。
 */
export function nextActiveWindowStartAt(nowMs: number, win: ActiveWindow): number | undefined {
  const { startMin, endMin } = win;
  if (startMin === endMin) return undefined; // 全天不限
  if (startMin <= 0 && endMin >= MINUTES_PER_DAY) return undefined; // 全天不限
  const now = new Date(nowMs);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime() + startMin * 60_000;
  if (at > nowMs) return at;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime() + startMin * 60_000;
}

/**
 * 「下一个本地日界」的绝对时刻（change standby-covers-idle-waits）。
 *
 * **红线：MUST NOT 用上海日界（`time/shanghai-day.ts`）替代本函数。** 本仓并存两套日界口径——风控滑动窗口
 * 与 UI 今日用量按**上海**日界，而**续场计数（`dailyTally` / `localDayKey`）按服务器本地日界**。每日续场
 * 场数 / 分钟上限「何时重置」只能按后者算；进程 TZ 一旦不是 Asia/Shanghai，混用就会算错恢复时刻——让账号
 * 提前醒来空转，或睡过头错过整个活跃日。
 *
 * 用 `new Date(y, m, d + 1)` 而非 `+24h`，与 `localDayKey` 的 `getFullYear/getMonth/getDate` 逐字对齐。
 */
export function nextLocalDayStartAt(nowMs: number): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}
