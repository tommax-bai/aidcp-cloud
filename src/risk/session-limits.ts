/**
 * 单场会话上限（安全限额层）—— change session-limits-to-quota-layer。
 *
 * 把「单场会话上限」从人设（soul.session_limits）/ 写死常量（RoleDispatcher.freshBudget）搬进安全限额层：
 * 单场时长 + 单场互动预算，按账号可后台编辑 + 热加载 + 绝不 brick。本模块只持**写死默认 + 类型 + 提供者接口**
 * （安全限额层 = 风控层，与 quotas.ts 同层）；落库 / 内存镜像由 src/config/session-config-store.ts 实现该接口。
 *
 * 零回归基线 = 平铺现值（用户 2026-06-24 拍板）：空表 / 缺行回落 时长 10min + 现 freshBudget 数字，
 * 与改造前逐位一致（**不是** v1 session-budget.ts 的 15/30/60 档位梯度——那是 v1 兼容路径、非现役闭环）。
 */

/** 单场互动预算形态（对齐现役 RoleDispatcher.freshBudget 的六项；注意含 searches、不含 view/publish）。 */
export interface SessionInteractionBudget {
  likes: number;
  collects: number;
  follows: number;
  searches: number;
  comments: number;
  comment_likes: number;
}

/** 单场互动预算的字段键（校验 / 遍历用，穷举与 SessionInteractionBudget 一致）。 */
export const SESSION_BUDGET_KEYS = [
  'likes',
  'collects',
  'follows',
  'searches',
  'comments',
  'comment_likes',
] as const;

export type SessionBudgetKey = (typeof SESSION_BUDGET_KEYS)[number];

/** 单场时长写死默认（分钟）。等于改造前 soul.yaml 的 max_duration_min（默认账号），保证零回归。 */
export const DEFAULT_SESSION_DURATION_MIN = 10;

/** 单场时长写死默认（毫秒）。 */
export const DEFAULT_SESSION_DURATION_MS = DEFAULT_SESSION_DURATION_MIN * 60_000;

/** 单场互动预算写死默认。等于改造前 RoleDispatcher.freshBudget()，保证零回归。 */
export const DEFAULT_SESSION_BUDGET: Readonly<SessionInteractionBudget> = {
  likes: 10,
  collects: 5,
  follows: 3,
  searches: 5,
  comments: 2,
  comment_likes: 3,
};

/** 单场上限数字的合理上限（校验用，防误填天文数字）。复用 quotas.ts 的 QUOTA_MAX 同量级。 */
export const SESSION_LIMIT_MAX = 100_000;

/**
 * 互动质量比例闸的写死默认（engagement-restraint，change engagement-ratio-config）：以「1:N 的 N」（整数分母）表达。
 * 收藏门槛默认 1:3（收藏数 / 点赞数 >= 1/3 才收藏）；关注门槛默认 1:8（粉丝数 / 获赞与收藏 >= 1/8 才关注）。
 * 与两决策角色内导出的兜底常量等值；空表 / 缺值 / 非法 → 回落这两个默认。N=0 无意义（除零），校验须 >= 1。
 */
export const DEFAULT_COLLECT_SAVE_LIKE_DENOM = 3;
export const DEFAULT_FOLLOW_FANS_DENOM = 8;

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

/** 写死默认预算的**新拷贝**（live budget 会被逐项扣减，绝不返回共享的只读常量）。 */
export function defaultSessionBudget(): SessionInteractionBudget {
  return { ...DEFAULT_SESSION_BUDGET };
}

/**
 * 单场上限提供者（安全限额层接口）：全局单例给出单场时长（毫秒）与单场互动预算（不再按账号）。
 * 由 SessionConfigStore（config 层）实现（同步读内存镜像、缺值逐项回落写死默认、永不抛），
 * 注入浏览闭环调度器与会话监测体供运行时每次现读（PUT 后无需重启）。消费方只持接口、不依赖 config 实现。
 */
export interface SessionLimitProvider {
  /** 全局单场时长上限（毫秒）。缺配置 / 非法 → 回落 DEFAULT_SESSION_DURATION_MS。 */
  sessionDurationMs(): number;
  /** 全局单场互动预算（新拷贝，可被调用方扣减）。缺配置 / 字段非法 → 该项回落写死默认。 */
  sessionBudget(): SessionInteractionBudget;
  /** 收藏质量闸比例（= 1/N，N 为「收藏:赞」分母）。缺配置 / 非法 → 回落 1/DEFAULT_COLLECT_SAVE_LIKE_DENOM。 */
  collectSaveLikeRatio(): number;
  /** 关注质量闸比例（= 1/N，N 为「粉丝:赞藏」分母）。缺配置 / 非法 → 回落 1/DEFAULT_FOLLOW_FANS_DENOM。 */
  followFansRatio(): number;
  /** 全局「可活跃时间」周历掩码（168 格 '0'/'1'，周一起头 × 24h）。null = 未配置 / 非法 / 不限（全周全天活跃）。 */
  weekActiveMask(): string | null;
}
