/**
 * Facebook 群组目标 / 成员 / 加群审计的**纯数据模型类型 + 哨兵错误**（kernel 段）。
 *
 * 只含类型、枚举字面量联合与一个纯 Error 子类——无 SQL、无 pg 连接、无存储类、无进程内活状态。
 * 存储实现（FacebookGroupStore 类、SCHEMA_SQL、pg 读写、DbRow 内部映射类型、FacebookGroupStoreOptions）
 * 留在 src/comment-agent/facebook-group-store.ts（automation）。本文件供 api 侧面板 / 配置视图
 * （panel-server / panel/types / facebook-group-join-automation-view）type-only 共导，
 * 绝不让消费方拿到存储实现。满足 §4.7 kernel 准入（FacebookGroupScopeError 为纯 Error 子类，
 * 与 kernel/schema-capability-contract 的 SchemaCapabilityError 同一手法）。
 */

export type FacebookGroupJoinGating = 'unknown' | 'instant' | 'gated';
export type FacebookGroupAccountScopeMode = 'restricted' | 'global';
export type FacebookGroupAccountScopeFilter = FacebookGroupAccountScopeMode | 'unscoped';

export type FacebookGroupMembershipStatus =
  | 'assigned'
  | 'joining'
  | 'joined'
  | 'pending'
  | 'gated'
  | 'no_button'
  | 'checkpoint'
  | 'failed'
  | 'left';

export class FacebookGroupScopeError extends Error {
  constructor(
    readonly reason:
      | 'invalid_target'
      | 'invalid_account_group'
      | 'invalid_scope_mode'
      | 'invalid_scope_combination',
  ) {
    super(reason);
    this.name = 'FacebookGroupScopeError';
  }
}

export interface FacebookGroupTargetInput {
  url: string;
  name?: string | null;
  region?: string | null;
  park?: string | null;
  direction?: string | null;
}

export interface FacebookGroupTargetRow {
  groupUrl: string;
  accountScopeMode: FacebookGroupAccountScopeMode;
  groupName: string | null;
  region: string | null;
  park: string | null;
  direction: string | null;
  joinGating: FacebookGroupJoinGating;
  priority: number;
  enabled: boolean;
  importBatch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FacebookGroupTargetScopedRow extends FacebookGroupTargetRow {
  accountGroupLabels: string[];
}

export interface FacebookGroupTargetListRow extends FacebookGroupTargetRow {
  accountGroupLabels: string[];
  accountId: string | null;
  membershipStatus: FacebookGroupMembershipStatus | null;
  joinedAt: string | null;
  lastAttemptAt: string | null;
  lastReason: string | null;
  lastCommentedAt: string | null;
  commentsTotal: number;
}

export interface FacebookGroupTargetScopeWriteRow {
  groupUrl: string;
  accountScopeMode: FacebookGroupAccountScopeMode;
  accountGroupLabels: string[];
  updatedAt: string;
  updatedBy: string;
}

export type ReplaceFacebookGroupTargetScopesResult =
  | { ok: true; items: FacebookGroupTargetScopeWriteRow[] }
  | {
      ok: false;
      reason:
        | 'no_targets'
        | 'invalid_target'
        | 'invalid_account_group'
        | 'invalid_scope_mode'
        | 'invalid_scope_combination';
    };

export interface FacebookGroupTargetListOptions {
  limit?: number;
  offset?: number;
  status?: FacebookGroupMembershipStatus | 'unassigned';
  enabled?: boolean;
  region?: string | null;
  park?: string | null;
  direction?: string | null;
  accountScopeMode?: FacebookGroupAccountScopeFilter | null;
  accountGroupLabel?: string | null;
}

export interface FacebookGroupTargetListResult {
  items: FacebookGroupTargetListRow[];
  total: number;
}

export interface FacebookGroupRegionFacet {
  region: string;
  parks: string[];
}

export interface FacebookGroupTargetFacets {
  regions: FacebookGroupRegionFacet[];
  directions: string[];
  accountGroupLabels: string[];
  globalTargetCount: number;
  unscopedTargetCount: number;
}

export interface FacebookRegionCommentTemplateRow {
  region: string;
  commentTemplates: string[];
  updatedAt: string;
  updatedBy: string;
}

export type SetFacebookRegionCommentTemplatesResult =
  | { ok: true; row: FacebookRegionCommentTemplateRow }
  | {
      ok: false;
      reason: 'invalid_region' | 'region_not_found' | 'invalid_templates';
    };

export type ResolveFacebookRegionCommentTemplatesResult =
  | { ok: true; region: string; commentTemplates: string[] }
  | {
      ok: false;
      reason: 'missing_group_region' | 'regional_template_missing';
    };

export interface FacebookGroupMembershipRow {
  accountId: string;
  groupUrl: string;
  status: FacebookGroupMembershipStatus;
  assignedAt: string | null;
  joinedAt: string | null;
  lastAttemptAt: string | null;
  attempts: number;
  lastReason: string | null;
  lastCommentedAt: string | null;
  cooldownUntil: string | null;
  commentsTotal: number;
  leftConfirmations: number;
  updatedAt: string;
}

export type FacebookGroupJoinAuditOutcome =
  | 'shadow_observed'
  | 'quota_denied'
  | 'claimed'
  | 'joined'
  | 'already_member'
  | 'gated_skip'
  | 'pending'
  | 'questionnaire_required'
  | 'no_button'
  | 'login_required'
  | 'blocked_by_captcha'
  | 'nav_error'
  | 'join_failed'
  | 'ambiguous_skip'
  | 'no_targets'
  | 'scope_mismatch';

export interface FacebookGroupJoinRecentScheduledResult {
  outcome: FacebookGroupJoinAuditOutcome;
  reason: string | null;
  groupUrl: string | null;
  createdAt: string;
}

export interface FacebookGroupScopedTargetCount {
  accountGroupLabel: string | null;
  count: number;
}

export interface FacebookGroupImportResult {
  imported: number;
  updated: number;
  duplicate: number;
  invalid: number;
  rows: FacebookGroupTargetScopedRow[];
}

export interface FacebookGroupAccountProgress {
  accountId: string;
  assigned: number;
  joining: number;
  joined: number;
  pending: number;
  gated: number;
  failed: number;
  lastJoinedAt: string | null;
  lastCommentedAt: string | null;
}
