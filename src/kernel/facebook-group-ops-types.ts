/**
 * Facebook 群组面板所需的单向 operation port。
 *
 * 这里只描述可直接由 automation 进程提供、由 api 进程调用的操作。刻意不包含
 * `importTargets` / `replaceTargetScopes`：它们可能在请求期间反向刷新 api 持有的账号投影，
 * 不是单向依赖。因此本端口也不能被当作完整的 `PanelDeps.facebookGroupTargets` 注入。
 *
 * 本文件只含 kernel 类型，不含 SQL、HTTP 或进程内活状态。
 */
import type {
  FacebookGroupAccountProgress,
  FacebookGroupJoinRecentScheduledResult,
  FacebookGroupMembershipRow,
  FacebookRegionCommentTemplateRow,
  SetFacebookRegionCommentTemplatesResult,
  FacebookGroupScopedTargetCount,
  FacebookGroupTargetFacets,
  FacebookGroupTargetListOptions,
  FacebookGroupTargetListResult,
  FacebookGroupTargetRow,
} from './facebook-group-types.js';

export interface FacebookGroupOpsPort {
  listTargets(options?: FacebookGroupTargetListOptions): Promise<FacebookGroupTargetListResult>;
  listFacets(): Promise<FacebookGroupTargetFacets>;
  listRegionCommentTemplates(): Promise<FacebookRegionCommentTemplateRow[]>;
  setRegionCommentTemplates(
    region: string,
    commentTemplates: string[],
    updatedBy: string,
  ): Promise<SetFacebookRegionCommentTemplatesResult>;
  setEnabled(groupUrl: string, enabled: boolean): Promise<FacebookGroupTargetRow | null>;
  accountProgress(): Promise<FacebookGroupAccountProgress[]>;
  listAssignments(limit?: number): Promise<FacebookGroupMembershipRow[]>;
  reclaimStaleAssignments(ttlMs: number): Promise<number>;
  scopedTargetCountForAccount(accountId: string): Promise<FacebookGroupScopedTargetCount>;
  scopedTargetCountsForAccounts(
    accountIds: readonly string[],
  ): Promise<Map<string, FacebookGroupScopedTargetCount>>;
  latestScheduledResult(
    accountId: string,
  ): Promise<FacebookGroupJoinRecentScheduledResult | null>;
  latestScheduledResults(
    accountIds: readonly string[],
  ): Promise<Map<string, FacebookGroupJoinRecentScheduledResult>>;
}
