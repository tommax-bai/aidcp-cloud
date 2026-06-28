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
}
