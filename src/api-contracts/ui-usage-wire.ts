/**
 * 客户端日用量 / 慢启动投影的**线上载荷形状**在 api 段的本地声明（定稿 §10.9）。
 * 见 publish-approval-wire.ts 文件头「为什么复制而不是 import」。
 */

export type UiDailyUsageAction =
  | 'view'
  | 'search'
  | 'like'
  | 'collect'
  | 'comment'
  | 'follow'
  | 'publish'
  | 'join_group';
export type UiDailyUsageCounts = Partial<Record<UiDailyUsageAction, number>>;
export type UiDailyUsageWindow = 'session' | 'minute' | 'hour' | 'day';

export interface UiDailyUsageInspirationSummary {
  count: number;
  sourceLikeCount?: number;
}

export interface UiDailyUsageWindowStatus {
  active?: boolean;
  startedAt?: number;
  windowMs?: number;
  expiresAt?: number;
  refreshAt?: number;
  releaseAt?: number;
  totals: UiDailyUsageCounts;
  quotas?: UiDailyUsageCounts;
  saturated?: UiDailyUsageAction[];
}

/** 环境级慢启动状态。 */
export interface UiSlowStartPayload {
  state: 'off' | 'active' | 'graduated';
  day?: number;
  totalDays: number;
  since?: number;
  binding?: boolean;
  eligible: boolean;
  ineligibleReason?:
    | 'platform_unsupported'
    | 'platform_unknown'
    | 'globally_disabled'
    | 'binding_unknown'
    | 'binding_conflict';
}

export interface UiDailyUsagePayload {
  asOf: number;
  quotaLevel?: 'conservative' | 'normal' | 'aggressive';
  totals: UiDailyUsageCounts;
  quotas?: UiDailyUsageCounts;
  saturated?: UiDailyUsageAction[];
  inspirationSummary?: UiDailyUsageInspirationSummary;
  firstPost?: {
    state: 'searching' | 'generating';
    viewed: number;
    target: 20;
    startedAt: number;
    sourceId?: string;
  };
  slowStart?: UiSlowStartPayload;
  windows?: Partial<Record<UiDailyUsageWindow, UiDailyUsageWindowStatus>>;
}
