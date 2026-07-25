/**
 * 账单价刷新的**回执纯类型**（kernel 段）。
 *
 * 面板（api）经注入端口 `billingPriceRefresh.refresh()` 触发一次对账并展示回执，
 * 需要的只是回执形状；真正的刷新实现（读厂商账单 / 落价快照）留
 * src/metrics/billing-price-refresh.ts（content 属主），并从本文件等值再导出。
 *
 * **有意止步于回执四型**：BillingPriceRefreshTokenUsage / Credentials / Options
 * 都是实现侧的注入契约，其中 TokenUsage 传递依赖 content 的用量写侧形状
 * （LlmBillingPriceTarget / LlmBillingPriceSnapshotInput），抬进来会把 kernel 反手拽回业务层；
 * 且面板从不构造它们。
 *
 * 诚实口径：跳过的目标 MUST 逐条带 reason 出现在 skipped[] 里，
 * MUST NOT 静默从 written 计数里消失冒充「没什么可写」。
 *
 * kernel 门禁（§4.7）：零 import、纯类型；无库访问 / 无 HTTP 路由 / 无模型或厂商调用 / 无进程内活状态。
 */

/** 某个「厂商 × 模型 × 用量日」这次没能取到价的原因。 */
export type BillingPriceRefreshSkipReason =
  | 'missing_credentials'
  | 'unsupported_provider'
  | 'no_local_usage'
  | 'no_billing_sample'
  | 'billing_api_error';

/** 一条被跳过的目标（诚实回报，绝不静默吞）。 */
export interface BillingPriceRefreshSkip {
  provider: string;
  model: string;
  usageDay: string;
  reason: BillingPriceRefreshSkipReason;
}

/** 一条真的写进价快照的记录。 */
export interface BillingPriceRefreshWritten {
  provider: string;
  model: string;
  usageDay: string;
  currency: string;
  pricingBasis: 'input_output_tokens' | 'total_tokens';
  source: string;
  sourcePeriod: string | null;
}

/** 一次刷新的完整回执：查了哪些天、有多少目标、真写了几条、跳过了什么、缺哪些凭据。 */
export interface BillingPriceRefreshResult {
  ok: true;
  checkedDays: string[];
  targetCount: number;
  written: number;
  prices: BillingPriceRefreshWritten[];
  skipped: BillingPriceRefreshSkip[];
  missingCredentials: string[];
}
