/**
 * 固定规则定义的两级节奏：
 *   一级 每 FACEBOOK_RULE_VIEW_THRESHOLD 条确认浏览 → 开一个轮次 → 尝试 1 次点赞；
 *   二级 每 FACEBOOK_RULE_JOIN_EVERY_N_ROUNDS 个轮次里的最后一个 → 额外做 1 次加群 + 联系评论。
 *
 * 定义号字符串**自身编码了这两个数字**，且与 definition_version 一起是 progress / view_fact /
 * batch 三张表的主键与去重键组成部分（四张表另有 CHECK 钉住取值）。因此改节奏 = 换定义身份，
 * 换身份后旧进度在新定义下不可见——这是有意的语义（新节奏从零重新收集），不是副作用。
 */
export const FACEBOOK_RULE_DEFINITION_ID = 'facebook_browse_5_like_1_join_contact_every_2';
export const FACEBOOK_RULE_DEFINITION_VERSION = 2;
export const FACEBOOK_RULE_VIEW_THRESHOLD = 5;
export const FACEBOOK_RULE_JOIN_EVERY_N_ROUNDS = 2;

/** Stable runtime algorithm identity. Cadence numbers live in a revisioned policy snapshot. */
export const FACEBOOK_RULE_RUNTIME_DEFINITION_ID = 'facebook_rule_cadence';
export const FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION = 3;

export interface FacebookRulePolicySnapshot {
  viewsPerLike: number;
  joinEveryNRounds: number;
}

export interface FacebookRuleRuntimePolicy {
  policyRevision: number;
  snapshot: FacebookRulePolicySnapshot;
}

export const DEFAULT_FACEBOOK_RULE_POLICY_SNAPSHOT: Readonly<FacebookRulePolicySnapshot> = {
  viewsPerLike: FACEBOOK_RULE_VIEW_THRESHOLD,
  joinEveryNRounds: FACEBOOK_RULE_JOIN_EVERY_N_ROUNDS,
};

export const DEFAULT_FACEBOOK_RULE_RUNTIME_POLICY: Readonly<FacebookRuleRuntimePolicy> = {
  policyRevision: 0,
  snapshot: DEFAULT_FACEBOOK_RULE_POLICY_SNAPSHOT,
};

/** 上一版单轴定义（10 浏览 → 1 批次含点赞+加群联系评论）。仅用于识别存量行，不再写入。 */
export const FACEBOOK_RULE_LEGACY_DEFINITION_ID = 'facebook_browse_10_like_1_join_contact_1';
export const FACEBOOK_RULE_LEGACY_DEFINITION_VERSION = 1;

/**
 * 轮次序号（1 起、单调递增、稠密无洞，由 progress.collecting_sequence 派生）落在两轮周期的哪一位，
 * 决定本轮是否额外做加群联系评论。
 *
 * 判据是**轮次序号**而不是「已确认点赞数」：点赞被风控抑制 / 结构性跳过 / 已赞 / 结果不明一律照常
 * 推进周期。若改成只数成功点赞，点赞日配额或冷却一旦耗尽，加群与联系评论会静默全停。
 */
export function facebookRuleRoundIncludesJoin(
  sequence: number,
  joinEveryNRounds = FACEBOOK_RULE_JOIN_EVERY_N_ROUNDS,
): boolean {
  if (!Number.isFinite(sequence) || sequence < 1) return false;
  if (!Number.isInteger(joinEveryNRounds) || joinEveryNRounds < 1) return false;
  return Math.trunc(sequence) % joinEveryNRounds === 0;
}

export type FacebookBrowseMode =
  | 'facebook_rule'
  | 'persona'
  | 'slow_start'
  | 'consumption'
  | 'blocked'
  | 'unsupported';

export type FacebookRuleActionState =
  | 'pending'
  | 'dispatched'
  | 'confirmed'
  | 'already_satisfied'
  | 'risk_suppressed'
  | 'structural_skip'
  | 'not_started'
  | 'rejected'
  | 'failed'
  | 'ambiguous'
  | 'submitted_unknown'
  /**
   * 本轮按节奏不执行该动作（只点赞的轮次的加群与评论两格）。
   * MUST NOT 用 not_started / structural_skip 代替——那两个表示「本该做却没起来 / 目标结构上做不到」，
   * 与「节奏规定本轮不做」是不同事实，混用会让后台把一半轮次显示成两个假失败。
   */
  | 'not_scheduled'
  /** The policy changed before this action reached irreversible dispatch. */
  | 'policy_superseded'
  /**
   * 评论已确认上墙，但**不带联系方式**——账号没配联系方式、按显式声明降级发的普通评论
   * （change facebook-rule-comment-plain-fallback）。
   * MUST NOT 记成 confirmed：那会让后台与客户端认为联系方式已经发出去了。
   */
  | 'confirmed_without_contact';

export interface FacebookRuleModeConfig {
  /**
   * 配置的权威主键（change environment-level-rule-mode-and-approval）：**环境**，不是账号。
   * 按账号读时若反查不出唯一环境，这里是 `null` 且 `enabled=false` —— 那是 fail-closed 的
   * 「不启用」，MUST NOT 被读成「某个环境把它配置成了关」。
   */
  envKey: string | null;
  enabled: boolean;
  /** 库中持久化的定义号原值。MUST NOT 用代码常量顶替——顶替会把存量旧定义行谎报成当前定义。 */
  definitionId: string;
  definitionVersion: number;
  /** 库中定义身份与当前代码定义不一致；为 true 时该行的节奏不可按当前定义解读。 */
  definitionMismatch: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface FacebookRuleModeBatchView {
  batchId: string;
  policyRevision: number;
  policySnapshot: FacebookRulePolicySnapshot;
  sequence: number;
  /** 本轮是否包含加群联系评论（由 sequence 派生，二级节奏的真态）。 */
  includesJoin: boolean;
  triggerContentKey: string;
  likeState: FacebookRuleActionState;
  joinState: FacebookRuleActionState;
  commentState: FacebookRuleActionState;
  terminal: boolean;
  blocker: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FacebookRuleModeRuntimeView {
  policyRevision: number;
  viewCount: number;
  threshold: number;
  joinEveryNRounds: number;
  /** 正在收集的那一轮将拿到的轮次序号。 */
  collectingSequence: number;
  /** 正在收集的那一轮是否会包含加群联系评论。 */
  collectingRoundIncludesJoin: boolean;
  currentBatch: FacebookRuleModeBatchView | null;
  updatedAt: string | null;
}

/**
 * 该账号的加群联系评论会不会降级为普通评论（change facebook-rule-comment-plain-fallback）。
 * 读时由服务端真值派生，MUST NOT 当成配置值缓存——账号随时可能补上联系方式。
 * `unknown` 是诚实的第三态：读不到联系方式就说读不到，MUST NOT 猜成 `not_pending`
 * （那会让运营以为一切正常，而实际发出去的是不带联系方式的评论）。
 */
export type FacebookRuleContactFallbackState = 'not_pending' | 'pending' | 'unknown';

export interface FacebookRuleModeView {
  config: FacebookRuleModeConfig;
  runtime: FacebookRuleModeRuntimeView;
  contactFallback: FacebookRuleContactFallbackState;
}

export type SetFacebookRuleModeResult =
  | { ok: true; row: FacebookRuleModeConfig }
  | {
      ok: false;
      reason:
        /** 目标环境不存在，或按账号寻址时该账号今天不绑在任何环境上。 */
        | 'environment_not_found'
        /** 按账号寻址时该账号落在多个环境或跨客户争用——MUST NOT 任取一个写。 */
        | 'environment_conflict'
        /** 绑定副本陈旧 / 环境注册表读不到：**不是**「没配置」，调用方 MUST 报不可用。 */
        | 'environment_unavailable'
        | 'unsupported_platform'
        | 'invalid_value'
        | 'no_valid_fields';
    };

export type ApplyFacebookRuleViewResult =
  | { kind: 'counted'; viewCount: number }
  | { kind: 'duplicate'; viewCount: number }
  | { kind: 'batch_active'; batchId: string }
  /**
   * A policy switch terminalized one or more old-revision batches before any
   * irreversible dispatch. The view that observed the switch is deliberately
   * not credited to the new revision; its collection starts at zero.
   */
  | { kind: 'policy_superseded'; batchIds: string[] }
  | { kind: 'batch_created'; batch: FacebookRuleModeBatchView };
