/**
 * 客户端慢启动曲线投影（change sync-slow-start-curve-to-client）。
 *
 * 桌面客户端此前把曲线数字写死在页面结构里，与管理后台可编辑的 Facebook 全局冷启动配置**完全不联动**：
 * 那 42 个数字恰好等于后台出厂默认值，所以运营没改过配置时看不出问题；改过一格之后，运营看到的
 * 就是一张永远不会变的假表——而他正是照这张表判断新号今天还能做多少。
 *
 * 三条不变量：
 *
 * 1. **缺席只有一种表达：返回 null（调用方整个不下发该字段）**。MUST NOT 用编译期默认曲线冒充
 *    （它很可能比运营当前所配更松，正是要消灭的那张假表），MUST NOT 下发空数组或全零曲线
 *    （等同于宣称这个号没有任何逐日上限）。故本模块的入参**刻意取后台权威配置本身**
 *    （策略未就绪时属主返回 null），而不是那个「取不到就回落编译默认」的运行时取用口。
 * 2. **动作项就取后台配置里的那几项**：曲线的来源是 Facebook 全局策略，它本身只按该平台真能执行的
 *    动作建格。这里既不补零、也不另查一张「平台能做什么」的表——补出来的项是系统永远不会执行的计划，
 *    另查一张表则是同一个判断的第二份实现。
 * 3. **总天数与行数必须自洽**：对不上就整体缺席。半张表比没有表更危险——徽章说第 9 天、
 *    表里只有 7 行，运营无从知道第 9 天到底允许多少。
 */
import { normalizePlatformId } from '../kernel/platform-types.js';
import type { FacebookSlowStartDailyCaps } from '../config/facebook-operation-policy-store.js';

/** 曲线的一行。字段与后台 Facebook 全局策略的逐日上限逐格同名同义。 */
export interface ClientSlowStartCurveDay {
  day: number;
  view: number;
  like: number;
  comment: number;
  follow: number;
  publish: number;
  search: number;
  joinGroup: number;
}

export interface ClientSlowStartCurve {
  totalDays: number;
  days: ClientSlowStartCurveDay[];
}

/** 后台权威配置里的慢启动那一段（属主未就绪时为 null，见不变量 1）。 */
export interface FacebookSlowStartAuthoredCurve {
  totalDays: number;
  dailyCaps: FacebookSlowStartDailyCaps[];
}

/**
 * 后台策略取不到时（属主未就绪、或平台不是 Facebook）的总天数。
 *
 * 这**不是**「显示的≠生效的」的又一次复发：策略取不到时，风控 clamp 本身也回落到编译期那条
 * 7 天曲线，所以这里报 7 与系统此刻真在执行的天数一致。真正被本 change 修掉的是另一件事——
 * 策略**取得到**时，未绑定账号那条分支仍内联 7、对配置视而不见。
 *
 * 与风控侧 `SLOW_START_TOTAL_DAYS` 同值。两处各写一份是刻意的（分属不同服务、拆进程后不共编译单元），
 * 由验收用例按引用断言相等，而不是靠人记得同步。
 */
export const FALLBACK_SLOW_START_TOTAL_DAYS = 7;

/**
 * 该环境是否走 Facebook 慢启动曲线。
 *
 * **判据刻意与本文件所在服务里那条既有的 Facebook 环境准入逐字同源**（同一个平台归一化函数），
 * 而不是自己比一次字符串：环境平台列里既有 `facebook` 也有 `fb` 别名，各写一份判断的现形方式
 * 不是报错，而是一半环境看得到曲线、另一半看不到。
 *
 * 归一化对未登记平台会抛、对空值回落小红书 —— 两种情况都不是 Facebook，方向安全（不下发曲线）。
 */
function usesFacebookCurve(platform: string | null | undefined): boolean {
  try {
    return normalizePlatformId(platform) === 'facebook';
  } catch {
    return false;
  }
}

/** 该环境此刻应当对外报出的慢启动总天数：Facebook 取后台权威配置，其余平台取回落值。 */
export function slowStartTotalDaysFor(
  platform: string | null | undefined,
  authored: FacebookSlowStartAuthoredCurve | null | undefined,
): number {
  if (!usesFacebookCurve(platform)) return FALLBACK_SLOW_START_TOTAL_DAYS;
  const totalDays = authored?.totalDays;
  return Number.isSafeInteger(totalDays) && (totalDays as number) > 0
    ? (totalDays as number)
    : FALLBACK_SLOW_START_TOTAL_DAYS;
}

/** 曲线只对 Facebook 存在（其余平台走编译期常量曲线，没有后台配置来源）。 */
export function projectClientSlowStartCurve(
  platform: string | null | undefined,
  authored: FacebookSlowStartAuthoredCurve | null | undefined,
): ClientSlowStartCurve | null {
  if (!usesFacebookCurve(platform)) return null;
  if (!authored) return null;
  const { totalDays } = authored;
  if (!Number.isSafeInteger(totalDays) || totalDays <= 0) return null;
  const caps = Array.isArray(authored.dailyCaps) ? authored.dailyCaps : [];
  if (caps.length !== totalDays) return null;
  const days = caps.map((row, index) => ({
    day: Number.isSafeInteger(row.day) && row.day > 0 ? row.day : index + 1,
    view: row.view,
    like: row.like,
    comment: row.comment,
    follow: row.follow,
    publish: row.publish,
    search: row.search,
    joinGroup: row.joinGroup,
  }));
  if (days.some((row) => Object.values(row).some((value) => !Number.isFinite(value)))) return null;
  return { totalDays, days };
}
