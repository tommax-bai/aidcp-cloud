/**
 * 后台配置写通道的**跨段端口契约**（kernel 段）。
 *
 * 这里只放「取数进程持有、自动化进程实现」的四个窄写接口与它们的纯载荷类型：
 * 安全限额（quota_config）/ 操作兜底区间（pacing_floor_config）/ 单场会话上限（session_config_global）/
 * 自动续场护栏（resume_config_global）。四者形态同构：`getXxx()` 回真态视图 + `setXxx(patch, updatedBy)`
 * 校验后整块写、写后回真态。
 *
 * **为什么落在共享层而不是取数侧**：接口由取数侧持有、由自动化侧的外观实现，两边都要引它。
 * 放取数侧会让自动化侧的四个外观各产生一条反向依赖（拆包后就是自动化包依赖取数包）。
 *
 * kernel 准入（§4.7）：纯类型 + 接口，无 SQL、无路由注册、无供应商调用、无模块级活状态，
 * 且只引本层的 `risk-read-types.ts`（同层引用），不引任何业务段文件。
 *
 * **两处词表刻意收窄成裸串，不在本层另抄一份穷举**：
 *   - `PacingConfigRowView.operation` / `PacingConfigPatchInput.operation`：节奏操作词表的权威定义在边云协议
 *     文件里，而该文件按 §10.9 终局裁决 MUST NOT 进本层。这里声明为裸 `string`，词表校验留在自动化侧外观
 *     （它本来就有一张 `PACING_OPS` 白名单，不合法回 `unknown_operation`）。同款先例见
 *     `panel-automation-types.ts` 的 `PanelActionTotal.action`。
 *   - 档位 / 动作两个枚举**没有**在本文件重抄：直接复用本层既有的 `risk-read-types.ts` 里那两份
 *     （逐字同源、同层引用），避免出现第三份穷举。
 */

import type { RiskActionView, RiskQuotaLevelView } from './risk-read-types.js';

/* ─────────────────────────────── 安全限额（quota_config） ─────────────────────────────── */

/** 单 (tier,action) 三窗口生效数字 + 来源/审计（GET /api/quotas 形状）。库缺行处以派生写死默认合成。 */
export interface QuotaConfigRowView {
  tier: RiskQuotaLevelView;
  action: RiskActionView;
  daily: number;
  perMinute: number;
  perHour: number;
  /** 是否存在库内覆盖（false=显示的是派生写死默认，即当前真生效）。 */
  overridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface QuotaConfigCatalogView {
  quotas: QuotaConfigRowView[];
}

/** PUT /api/quotas 入参补丁。未传的窗口保持原值（或回落派生默认）。 */
export interface QuotaConfigPatchInput {
  tier: RiskQuotaLevelView;
  action: RiskActionView;
  daily?: number;
  perMinute?: number;
  perHour?: number;
}

export type QuotaConfigSetResult =
  | { ok: true; view: QuotaConfigCatalogView }
  | { ok: false; reason: 'unknown_tier' | 'unknown_action' | 'invalid_value' | 'no_valid_fields' };

// 写入通道归属（change config-table-write-collection；定稿方案 §5.1 / §4.6.8）：`PanelQuotaConfig`
// 是取数侧持有的窄内部写接口契约，自动化侧实现（src/config/quota-config-facade.ts）并独占 store。
// 后台编辑 MUST 走 console → 取数侧 → 自动化侧；**取数侧 MUST NOT 直写 quota_config**。
// 拆进程时把此接口的实现换成内部客户端、调用点不改、行为零变更。
export interface PanelQuotaConfig {
  /** 三档 × 全动作 × 三窗口生效值 + 审计（库缺行以写死默认合成回显）。 */
  getCatalog(): Promise<QuotaConfigCatalogView>;
  /** 写某 (tier,action) 限额。校验不过整块拒（绝不部分落库 / 假成功）。写后回真态目录。 */
  setQuota(patch: QuotaConfigPatchInput, updatedBy: string): Promise<QuotaConfigSetResult>;
}

/* ────────────────────── 操作兜底 floor（pacing_floor_config） ────────────────────── */
// 各类浏览节奏兜底区间 {minMs,maxMs}，全局一套。
// 生效值 = 读出口 clamp 后（含非零防呆下限护栏、类别上限封顶）；overridden=false 显示的是内置默认（当前真生效）。

/** 单 op 生效兜底区间（已含读出口夹逼护栏）+ 来源/审计（GET /api/pacing 形状）。 */
export interface PacingConfigRowView {
  /** 操作名为裸串（词表权威在边云协议侧，本层不重抄穷举）。 */
  operation: string;
  minMs: number;
  maxMs: number;
  /** 是否存在库内覆盖（false=显示的是内置默认，即当前真生效）。 */
  overridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PacingConfigCatalogView {
  pacing: PacingConfigRowView[];
}

/**
 * PUT /api/pacing 入参：两值须成对给（校验在外观：非负整数、min≤max、max≥min×1.5、≤类别上限）。
 *
 * `minMs` / `maxMs` 声明为**可选**，与外观的真实判定一致：外观按 `undefined` 判 `no_valid_fields` /
 * `invalid_value`，取数侧从请求体里也确实可能一个都拿不到。声明必填只会逼调用点写强转。
 */
export interface PacingConfigPatchInput {
  /** 操作名为裸串（词表权威在边云协议侧，本层不重抄穷举）。 */
  operation: string;
  minMs?: number;
  maxMs?: number;
}

export type PacingConfigSetResult =
  | { ok: true; view: PacingConfigCatalogView }
  | { ok: false; reason: 'unknown_operation' | 'invalid_value' | 'no_valid_fields' };

// 写入通道归属（change config-table-write-collection；定稿方案 §5.1 / §4.6.8）：`PanelPacingConfig`
// 是取数侧持有的窄内部写接口契约，自动化侧实现（src/config/pacing-config-facade.ts）并独占 store。
// 后台编辑 MUST 走 console → 取数侧 → 自动化侧；**取数侧 MUST NOT 直写 pacing_floor_config**。
export interface PanelPacingConfig {
  /** 各类操作生效兜底区间 + 审计（库缺行以内置默认合成、含 clamp 护栏回显）。 */
  getCatalog(): Promise<PacingConfigCatalogView>;
  /** 写某 op 兜底区间。校验不过整块拒（绝不部分落库 / 假成功）。写后回真态目录。 */
  setPacing(patch: PacingConfigPatchInput, updatedBy: string): Promise<PacingConfigSetResult>;
}

/* ─────────────────── 单场会话上限（session_config_global，全局单例） ─────────────────── */

/**
 * 单场互动预算形态（对齐现役调度器的新鲜预算；注意含 searches/join_groups、不含 view/publish）。
 *
 * **本层是这个形状的唯一定义处**：自动化侧的安全限额层与取数侧的面板视图共用同一份，
 * `src/risk/session-limits.ts` 只做等值再导出，MUST NOT 各留一份。
 */
export interface SessionInteractionBudget {
  likes: number;
  collects: number;
  follows: number;
  searches: number;
  comments: number;
  comment_likes: number;
  join_groups: number;
}

/** 全局单场上限生效值 + 来源/审计（GET /api/session-limits 形状）。 */
export interface SessionLimitView {
  /** 单场时长上限（分钟）。 */
  maxDurationMin: number;
  /** 单场互动预算（七项）。 */
  budget: SessionInteractionBudget;
  /** 收藏质量闸：收藏:赞 比例的分母 N（即 1:N；默认 3）。 */
  collectSaveLikeDenom: number;
  /** 关注质量闸：粉丝:赞藏 比例的分母 N（即 1:N；默认 8）。 */
  followFansDenom: number;
  /** 「可活跃时间」周历掩码（168 格 '0'/'1'，周一起头×24h；按服务器本地时间）。null = 未配置 / 全天活跃。 */
  activeWeekMask: string | null;
  /** 是否存在库内覆盖（false=显示的是写死默认，即当前真生效）。 */
  overridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** PUT /api/session-limits 入参补丁（全局，无账号）。未传的字段保持原值（无原值则回落写死默认）。 */
export interface SessionLimitPatchInput {
  maxDurationMin?: number;
  likes?: number;
  collects?: number;
  follows?: number;
  searches?: number;
  comments?: number;
  comment_likes?: number;
  join_groups?: number;
  /** 收藏质量闸分母 N（1:N，需 >= 1）。 */
  collectSaveLikeDenom?: number;
  /** 关注质量闸分母 N（1:N，需 >= 1）。 */
  followFansDenom?: number;
  /** 「可活跃时间」周历掩码（168 格 '0'/'1'，周一起头×24h）。 */
  activeWeekMask?: string;
}

export type SessionLimitSetResult =
  | { ok: true; view: SessionLimitView }
  | { ok: false; reason: 'invalid_value' | 'no_valid_fields' };

// 写入通道归属（change config-table-write-collection；定稿方案 §5.1 / §4.6.8）：`PanelSessionLimits`
// 是取数侧持有的窄内部写接口契约，自动化侧实现（src/config/session-config-facade.ts）并独占 store。
// 后台编辑 MUST 走 console → 取数侧 → 自动化侧；**取数侧 MUST NOT 直写 session_config_global**。
export interface PanelSessionLimits {
  /** 全局单场时长 + 互动预算生效值 + 审计（库无行以写死默认合成回显）。 */
  getView(): Promise<SessionLimitView>;
  /** 写全局单场上限。校验不过整块拒（绝不部分落库 / 假成功）。写后回真态。 */
  set(patch: SessionLimitPatchInput, updatedBy: string): Promise<SessionLimitSetResult>;
}

/* ───────────────── 自动续场护栏 + 看门狗（resume_config_global，全局单例） ───────────────── */

/** 全局续场护栏 + 看门狗阈值生效值 + 来源/审计（GET /api/resume-config 形状）。 */
export interface ResumeConfigView {
  /** 休息比例（百分比，如 10 = 单场时长的 10%）。 */
  restRatioPct: number;
  /** 活跃时段窗口起/止（自午夜分钟数，0..1440；0..1440 = 全天不限）。 */
  activeWindowStartMin: number;
  activeWindowEndMin: number;
  /** 每日自动续场上限（场数 / 累计分钟）；0 = 不限。 */
  dailyMaxSessions: number;
  dailyMaxMinutes: number;
  /** 看门狗两段阈值（毫秒）：恢复轻推 / 放弃结束。 */
  idleNudgeMs: number;
  idleEndMs: number;
  /** 是否存在库内覆盖（false=显示的是写死默认）。 */
  overridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** PUT /api/resume-config 入参补丁（全局，无账号）。未传的字段保持原值（无原值则回落写死默认）。 */
export interface ResumeConfigPatchInput {
  restRatioPct?: number;
  activeWindowStartMin?: number;
  activeWindowEndMin?: number;
  dailyMaxSessions?: number;
  dailyMaxMinutes?: number;
  idleNudgeMs?: number;
  idleEndMs?: number;
}

export type ResumeConfigSetResult =
  | { ok: true; view: ResumeConfigView }
  | { ok: false; reason: 'invalid_value' | 'no_valid_fields' };

// 写入通道归属（change config-table-write-collection；定稿方案 §5.1 / §4.6.8）：`PanelResumeConfig`
// 是取数侧持有的窄内部写接口契约，自动化侧实现（src/config/resume-config-facade.ts）并独占 store。
// 后台编辑 MUST 走 console → 取数侧 → 自动化侧；**取数侧 MUST NOT 直写 resume_config_global**。
export interface PanelResumeConfig {
  /** 全局续场护栏 + 看门狗阈值生效值 + 审计（库无行以写死默认合成回显）。 */
  getView(): Promise<ResumeConfigView>;
  /** 写全局续场配置。校验不过整块拒（绝不部分落库 / 假成功）。写后回真态。 */
  set(patch: ResumeConfigPatchInput, updatedBy: string): Promise<ResumeConfigSetResult>;
}
