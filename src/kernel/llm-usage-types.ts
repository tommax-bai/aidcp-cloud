/**
 * 模型用量与成本读侧的**纯载荷类型**（kernel 段）。
 *
 * 面板（api）经注入端口 `tokenUsage.usage(query)` 只读用量聚合，需要的只是
 * 「查询条件」与「返回载荷」两个形状；用量表的写入、SQL、连接池与计价对账
 * 留 src/metrics/token-usage-store.ts（content 属主），并从本文件等值再导出。
 *
 * 传递依赖已一并抬入：LlmUsagePayload → LlmUsageRow / LlmUsageBucket
 * → LlmUsageCostEstimate → LlmUsageCostPricingBasis。少抬一个即编译不过。
 * **有意不抬** LlmBillingPriceSnapshotInput / LlmBillingPriceTarget：那是写侧计价对账的形状，
 * 面板不需要，抬进来只会把 content 的写侧语义泄进 kernel。
 *
 * kernel 门禁（§4.7）：零 import、纯类型；无库访问 / 无 HTTP 路由 / 无模型调用 / 无进程内活状态。
 * 金额一律以 amount + currency 成对表达，绝不裸浮点。
 */

/** 计价口径：按输入/输出分别计价，还是按总 token 单价计价。 */
export type LlmUsageCostPricingBasis = 'input_output_tokens' | 'total_tokens';

/** 一行用量的成本估算。source/sourceDate 记录这笔价来自哪份账单快照，syncedAtMs 为 epoch ms。 */
export interface LlmUsageCostEstimate {
  amount: number;
  currency: string;
  source: string;
  sourceDate: string;
  syncedAtMs: number | null;
  pricingBasis: LlmUsageCostPricingBasis;
}

/** 按天 × 账号 × 角色 × 厂商 × 模型聚合的一行用量。costEstimate 无价可算时为 null，绝不填 0 冒充。 */
export interface LlmUsageRow {
  day: string;
  accountId: string;
  role: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  okCalls: number;
  costEstimate: LlmUsageCostEstimate | null;
}

/** 时间桶聚合（画趋势用）。bucketMs 为桶起点 epoch ms。 */
export interface LlmUsageBucket {
  bucketMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

/** 用量查询条件；全部可选，缺省即不按该维过滤。fromMs / toMs 为 epoch ms。 */
export interface LlmUsageQuery {
  fromMs?: number;
  toMs?: number;
  accountId?: string;
  role?: string;
  provider?: string;
  model?: string;
}

/** 用量读出载荷。window 回报**实际生效**的窗口与是否被夹过天数，绝不假装按请求窗口返回。 */
export interface LlmUsagePayload {
  rows: LlmUsageRow[];
  buckets: LlmUsageBucket[];
  window: { fromMs: number; toMs: number; clampedToDays: number | null };
}
