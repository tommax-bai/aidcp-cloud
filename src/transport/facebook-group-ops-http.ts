/**
 * `FacebookGroupOpsPort` 的内部 HTTP 适配。
 *
 * transport 只做参数解包、转调和 JSON 线格式转换，不包含业务判断。两个批量方法在
 * 线上使用 entries 数组，避免 `Map` 被 JSON.stringify 静默编码成空对象；客户端收到后
 * 再还原为 kernel 契约要求的 `Map`。
 */
import type { FacebookGroupOpsPort } from '../kernel/facebook-group-ops-types.js';
import type {
  FacebookGroupJoinRecentScheduledResult,
  FacebookGroupScopedTargetCount,
  FacebookGroupTargetListOptions,
} from '../kernel/facebook-group-types.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';

export const FACEBOOK_GROUP_OPS_ROUTES = {
  listTargets: 'facebook-group-ops/list-targets',
  listFacets: 'facebook-group-ops/list-facets',
  listRegionCommentTemplates: 'facebook-group-ops/list-region-comment-templates',
  setRegionCommentTemplates: 'facebook-group-ops/set-region-comment-templates',
  setEnabled: 'facebook-group-ops/set-enabled',
  accountProgress: 'facebook-group-ops/account-progress',
  listAssignments: 'facebook-group-ops/list-assignments',
  reclaimStaleAssignments: 'facebook-group-ops/reclaim-stale-assignments',
  scopedTargetCountForAccount: 'facebook-group-ops/scoped-target-count-for-account',
  scopedTargetCountsForAccounts: 'facebook-group-ops/scoped-target-counts-for-accounts',
  latestScheduledResult: 'facebook-group-ops/latest-scheduled-result',
  latestScheduledResults: 'facebook-group-ops/latest-scheduled-results',
} as const satisfies Record<keyof FacebookGroupOpsPort, string>;

type ScopedTargetCountEntry = [string, FacebookGroupScopedTargetCount];
type RecentScheduledResultEntry = [string, FacebookGroupJoinRecentScheduledResult];

export function registerFacebookGroupOpsRoutes(
  server: InternalHttpServer,
  local: FacebookGroupOpsPort,
): void {
  server.register(FACEBOOK_GROUP_OPS_ROUTES.listTargets, (args) => {
    const a = args as { options?: FacebookGroupTargetListOptions };
    return local.listTargets(a.options);
  });
  server.register(FACEBOOK_GROUP_OPS_ROUTES.listFacets, () => local.listFacets());
  server.register(FACEBOOK_GROUP_OPS_ROUTES.listRegionCommentTemplates, () =>
    local.listRegionCommentTemplates());
  server.register(FACEBOOK_GROUP_OPS_ROUTES.setRegionCommentTemplates, (args) => {
    const a = args as {
      region: string;
      commentTemplates: string[];
      updatedBy: string;
    };
    return local.setRegionCommentTemplates(
      a.region,
      a.commentTemplates,
      a.updatedBy,
    );
  });
  server.register(FACEBOOK_GROUP_OPS_ROUTES.setEnabled, (args) => {
    const a = args as { groupUrl: string; enabled: boolean };
    return local.setEnabled(a.groupUrl, a.enabled);
  });
  server.register(FACEBOOK_GROUP_OPS_ROUTES.accountProgress, () => local.accountProgress());
  server.register(FACEBOOK_GROUP_OPS_ROUTES.listAssignments, (args) => {
    const a = args as { limit?: number };
    return local.listAssignments(a.limit);
  });
  server.register(FACEBOOK_GROUP_OPS_ROUTES.reclaimStaleAssignments, (args) => {
    const a = args as { ttlMs: number };
    return local.reclaimStaleAssignments(a.ttlMs);
  });
  server.register(FACEBOOK_GROUP_OPS_ROUTES.scopedTargetCountForAccount, (args) => {
    const a = args as { accountId: string };
    return local.scopedTargetCountForAccount(a.accountId);
  });
  server.register(FACEBOOK_GROUP_OPS_ROUTES.scopedTargetCountsForAccounts, async (args) => {
    const a = args as { accountIds: string[] };
    const counts = await local.scopedTargetCountsForAccounts(a.accountIds);
    return [...counts.entries()] satisfies ScopedTargetCountEntry[];
  });
  server.register(FACEBOOK_GROUP_OPS_ROUTES.latestScheduledResult, (args) => {
    const a = args as { accountId: string };
    return local.latestScheduledResult(a.accountId);
  });
  server.register(FACEBOOK_GROUP_OPS_ROUTES.latestScheduledResults, async (args) => {
    const a = args as { accountIds: string[] };
    const results = await local.latestScheduledResults(a.accountIds);
    return [...results.entries()] satisfies RecentScheduledResultEntry[];
  });
}

export class FacebookGroupOpsHttpClient implements FacebookGroupOpsPort {
  constructor(private readonly http: InternalHttpClient) {}

  listTargets(
    options?: FacebookGroupTargetListOptions,
  ): ReturnType<FacebookGroupOpsPort['listTargets']> {
    return this.http.call(FACEBOOK_GROUP_OPS_ROUTES.listTargets, { options });
  }

  listFacets(): ReturnType<FacebookGroupOpsPort['listFacets']> {
    return this.http.call(FACEBOOK_GROUP_OPS_ROUTES.listFacets, {});
  }

  listRegionCommentTemplates(): ReturnType<FacebookGroupOpsPort['listRegionCommentTemplates']> {
    return this.http.call(FACEBOOK_GROUP_OPS_ROUTES.listRegionCommentTemplates, {});
  }

  setRegionCommentTemplates(
    region: string,
    commentTemplates: string[],
    updatedBy: string,
  ): ReturnType<FacebookGroupOpsPort['setRegionCommentTemplates']> {
    return this.http.call(FACEBOOK_GROUP_OPS_ROUTES.setRegionCommentTemplates, {
      region,
      commentTemplates,
      updatedBy,
    });
  }

  setEnabled(
    groupUrl: string,
    enabled: boolean,
  ): ReturnType<FacebookGroupOpsPort['setEnabled']> {
    return this.http.call(FACEBOOK_GROUP_OPS_ROUTES.setEnabled, { groupUrl, enabled });
  }

  accountProgress(): ReturnType<FacebookGroupOpsPort['accountProgress']> {
    return this.http.call(FACEBOOK_GROUP_OPS_ROUTES.accountProgress, {});
  }

  listAssignments(
    limit?: number,
  ): ReturnType<FacebookGroupOpsPort['listAssignments']> {
    return this.http.call(FACEBOOK_GROUP_OPS_ROUTES.listAssignments, { limit });
  }

  reclaimStaleAssignments(
    ttlMs: number,
  ): ReturnType<FacebookGroupOpsPort['reclaimStaleAssignments']> {
    return this.http.call(FACEBOOK_GROUP_OPS_ROUTES.reclaimStaleAssignments, { ttlMs });
  }

  scopedTargetCountForAccount(
    accountId: string,
  ): ReturnType<FacebookGroupOpsPort['scopedTargetCountForAccount']> {
    return this.http.call(
      FACEBOOK_GROUP_OPS_ROUTES.scopedTargetCountForAccount,
      { accountId },
    );
  }

  async scopedTargetCountsForAccounts(
    accountIds: readonly string[],
  ): ReturnType<FacebookGroupOpsPort['scopedTargetCountsForAccounts']> {
    const entries = await this.http.call<ScopedTargetCountEntry[]>(
      FACEBOOK_GROUP_OPS_ROUTES.scopedTargetCountsForAccounts,
      { accountIds },
    );
    return new Map(entries);
  }

  latestScheduledResult(
    accountId: string,
  ): ReturnType<FacebookGroupOpsPort['latestScheduledResult']> {
    return this.http.call(FACEBOOK_GROUP_OPS_ROUTES.latestScheduledResult, { accountId });
  }

  async latestScheduledResults(
    accountIds: readonly string[],
  ): ReturnType<FacebookGroupOpsPort['latestScheduledResults']> {
    const entries = await this.http.call<RecentScheduledResultEntry[]>(
      FACEBOOK_GROUP_OPS_ROUTES.latestScheduledResults,
      { accountIds },
    );
    return new Map(entries);
  }
}
