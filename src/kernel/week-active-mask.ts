/**
 * 周历掩码纯时间判定（kernel）：这一格是不是 1。
 * 「活跃与否代表什么业务后果」留调用方。
 */

/**
 * 全局「可活跃时间」周历掩码（change weekly-active-window）：7 天 × 24 小时 = 168 格，
 * 每格 '1' = 该小时活跃（允许开/续浏览会话）、'0' = 休眠（不开、运行中跨入则结束）。
 * 索引 = 周内天 × 24 + 小时；周内天 0=周一 … 6=周日（贴合中文周序与后台展示），小时 0..23。
 * 按**服务器本地时间**判定（与既有「每日活跃窗口」同口径，单地域、无时区参数）。
 * 掩码缺失 / 非法（长度≠168 或含非 0/1 字符）→ 视作**全周全天活跃**（零回归、不设闸；= 未配置=不限）。
 */
export const WEEK_ACTIVE_MASK_LEN = 7 * 24; // 168

/** 周历掩码是否合法：168 长定串、仅含 '0'/'1'。非法 → 调用方按「不限」回落。 */
export function isValidWeekActiveMask(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length === WEEK_ACTIVE_MASK_LEN && /^[01]+$/.test(raw);
}

/** 由本地 Date 取周内天（0=周一 … 6=周日）：把 JS getDay() 的 0=周日 折算为周一起头。 */
export function mondayBasedDayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/**
 * 给定本地时刻是否落在「可活跃时间」内。掩码缺失 / 非法 → true（全天活跃、零回归）。
 * 否则查对应格：周内天 × 24 + 小时。
 */
export function isWeekActiveAt(mask: string | null | undefined, d: Date): boolean {
  if (!isValidWeekActiveMask(mask)) return true;
  return mask[mondayBasedDayIndex(d) * 24 + d.getHours()] === '1';
}

/** 一小时的毫秒数（窗口唤醒按整点粒度推进）。 */
const HOUR_MS = 3_600_000;

/**
 * 距「下一个活跃整点」的毫秒数（change weekly-active-window 窗口唤醒增强）：用于休眠期主动安排到窗口
 * 重开时唤醒续场，不再干等边端重连。返回 null 表示**无需唤醒**：
 * - 掩码缺失 / 非法 → 全天活跃（本就不会休眠）；
 * - 当前时刻已活跃（调用方不该在活跃时安排唤醒，保险起见也返回 null）；
 * - 整周无任何活跃格（全休眠）→ 永不唤醒（运营显式关停，尊重之）。
 * 否则从**下一个整点**起逐小时向前找首个活跃格（至多扫满一周 168 格），返回距其起点的毫秒数。
 * 按服务器本地时间、整点粒度（单地域无 DST，整点 + k×HOUR_MS 即精确推进一小时）。
 */
export function msUntilNextActive(mask: string | null | undefined, nowMs: number): number | null {
  if (!isValidWeekActiveMask(mask)) return null;
  const now = new Date(nowMs);
  if (isWeekActiveAt(mask, now)) return null;
  const nextHour = new Date(now);
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  for (let k = 0; k < WEEK_ACTIVE_MASK_LEN; k++) {
    const cand = new Date(nextHour.getTime() + k * HOUR_MS);
    if (isWeekActiveAt(mask, cand)) return cand.getTime() - nowMs;
  }
  return null;
}
