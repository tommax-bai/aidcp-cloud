// ── 所有权与写路径收口（change route-usage-writes-through-report；依据 cloud-service-decomposition-proposal §4.6.6 / §5.1）──
// `llm_token_usage` 与 `llm_billing_price_snapshot` 两张表按方案 §4.6.6 / §5.1 归未来的 **aidcp-content**
// （内容服务）所有。其它服务 MUST 经本模块暴露的用量上报接口写入，MUST NOT 直写这两张表。
// 本模块即那**唯一**的写入口 / 上报接口，负责保证三条不变量：
//   · 幂等：幂等键 = bucket + account + role + provider + model（复合主键 + ON CONFLICT 累加）；
//           该表是可交换累加计数器、非业务事实源，MUST NOT 按 Outbox 强一致实现（§4.6.6）。
//   · 批量：add() 先按幂等键在内存合并、定时 flush 成批落库；upsertBillingPrices() 收数组一次批写。
//   · 可丢：用量是可丢的观测数据——add() 纯内存不抛、缺 accountId 丢弃并一次性告警；flush() 逐行 try/catch、
//           失败只累加 droppedFlushes + 限频告警、绝不抛回调用方，MUST NOT 阻塞/拖垮模型调用的业务路径。
// 现役上报接线点（唯一四处，勿在别处直写）：src/server.ts 三处装配（文本 LLM onCall / 视觉 recordVisionCall /
// 图片 usageRecorder）+ src/publish-agent/roles/image-generator.ts 的图片生成出口；保留清理随表主人走（§4.6.5 第 9 项）。
import pg from 'pg';
import { resolveEnvPgConfig } from '../kernel/pg-config.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';

const { Pool } = pg;

const PG_UNDEFINED_TABLE = '42P01';
const BUCKET_MS = 600_000;
const DEFAULT_FLUSH_MS = 15_000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 31;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
const UNKNOWN_PROVIDER = 'unknown';
const DASHSCOPE_PROVIDER = 'dashscope';
const VOLCENGINE_PROVIDER = 'volcengine';

const EFFECTIVE_PROVIDER_SQL = `CASE
  WHEN provider <> 'unknown' THEN provider
  WHEN lower(model) LIKE 'doubao%' OR lower(model) LIKE 'ep-%' THEN 'volcengine'
  WHEN lower(model) LIKE 'qwen%' OR lower(model) LIKE 'deepseek%' THEN 'dashscope'
  ELSE provider
END`;

export const TOKEN_USAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS llm_token_usage (
  bucket_start      TIMESTAMPTZ NOT NULL,
  account_id        TEXT        NOT NULL,
  role              TEXT        NOT NULL,
  provider          TEXT        NOT NULL DEFAULT 'unknown',
  model             TEXT        NOT NULL,
  prompt_tokens     BIGINT      NOT NULL DEFAULT 0,
  completion_tokens BIGINT      NOT NULL DEFAULT 0,
  total_tokens      BIGINT      NOT NULL DEFAULT 0,
  calls             BIGINT      NOT NULL DEFAULT 0,
  ok_calls          BIGINT      NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_start, account_id, role, provider, model)
);

ALTER TABLE llm_token_usage
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'unknown';

DO $$
DECLARE
  pk_name text;
  pk_def text;
BEGIN
  SELECT conname, pg_get_constraintdef(oid)
    INTO pk_name, pk_def
    FROM pg_constraint
   WHERE conrelid = 'llm_token_usage'::regclass
     AND contype = 'p'
   LIMIT 1;

  IF pk_name IS NULL THEN
    ALTER TABLE llm_token_usage
      ADD PRIMARY KEY (bucket_start, account_id, role, provider, model);
  ELSIF pk_def NOT LIKE '%provider%' THEN
    EXECUTE format('ALTER TABLE llm_token_usage DROP CONSTRAINT %I', pk_name);
    ALTER TABLE llm_token_usage
      ADD PRIMARY KEY (bucket_start, account_id, role, provider, model);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_llm_token_usage_account_bucket
  ON llm_token_usage (account_id, bucket_start);
CREATE INDEX IF NOT EXISTS idx_llm_token_usage_bucket
  ON llm_token_usage (bucket_start);
CREATE INDEX IF NOT EXISTS idx_llm_token_usage_provider_model_bucket
  ON llm_token_usage (provider, model, bucket_start);

CREATE TABLE IF NOT EXISTS llm_billing_price_snapshot (
  provider                  TEXT        NOT NULL,
  model                     TEXT        NOT NULL,
  usage_day                 DATE        NOT NULL,
  currency                  TEXT        NOT NULL DEFAULT 'CNY',
  prompt_cost_per_1k        NUMERIC(18, 8),
  completion_cost_per_1k    NUMERIC(18, 8),
  total_cost_per_1k         NUMERIC(18, 8),
  source                    TEXT        NOT NULL,
  source_period             TEXT,
  source_synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model, usage_day),
  CHECK (
    total_cost_per_1k IS NOT NULL
    OR (prompt_cost_per_1k IS NOT NULL AND completion_cost_per_1k IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_llm_billing_price_snapshot_day
  ON llm_billing_price_snapshot (usage_day);
`;

const UPSERT_SQL = `
INSERT INTO llm_token_usage
  (bucket_start, account_id, role, provider, model, prompt_tokens, completion_tokens, total_tokens, calls, ok_calls)
VALUES (to_timestamp($1::bigint / 1000.0), $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (bucket_start, account_id, role, provider, model) DO UPDATE SET
  prompt_tokens     = llm_token_usage.prompt_tokens     + EXCLUDED.prompt_tokens,
  completion_tokens = llm_token_usage.completion_tokens + EXCLUDED.completion_tokens,
  total_tokens      = llm_token_usage.total_tokens      + EXCLUDED.total_tokens,
  calls             = llm_token_usage.calls             + EXCLUDED.calls,
  ok_calls          = llm_token_usage.ok_calls          + EXCLUDED.ok_calls,
  updated_at        = now()
`;

const UPSERT_BILLING_PRICE_SQL = `
INSERT INTO llm_billing_price_snapshot
  (provider, model, usage_day, currency, prompt_cost_per_1k, completion_cost_per_1k,
   total_cost_per_1k, source, source_period, source_synced_at, updated_at)
VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, to_timestamp($10::bigint / 1000.0), now())
ON CONFLICT (provider, model, usage_day) DO UPDATE SET
  currency               = EXCLUDED.currency,
  prompt_cost_per_1k     = EXCLUDED.prompt_cost_per_1k,
  completion_cost_per_1k = EXCLUDED.completion_cost_per_1k,
  total_cost_per_1k      = EXCLUDED.total_cost_per_1k,
  source                 = EXCLUDED.source,
  source_period          = EXCLUDED.source_period,
  source_synced_at       = EXCLUDED.source_synced_at,
  updated_at             = now()
`;

export interface TokenUsageCallInfo {
  role?: string;
  provider?: string;
  model: string;
  accountId?: string;
  ok: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

interface Accum {
  bucketMs: number;
  accountId: string;
  role: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  okCalls: number;
}

export type LlmUsageCostPricingBasis = 'input_output_tokens' | 'total_tokens';

export interface LlmUsageCostEstimate {
  amount: number;
  currency: string;
  source: string;
  sourceDate: string;
  syncedAtMs: number | null;
  pricingBasis: LlmUsageCostPricingBasis;
}

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

export interface LlmUsageBucket {
  bucketMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

export interface LlmUsageQuery {
  fromMs?: number;
  toMs?: number;
  accountId?: string;
  role?: string;
  provider?: string;
  model?: string;
}

export interface LlmUsagePayload {
  rows: LlmUsageRow[];
  buckets: LlmUsageBucket[];
  window: { fromMs: number; toMs: number; clampedToDays: number | null };
}

export interface LlmBillingPriceSnapshotInput {
  provider: string;
  model: string;
  usageDay: string;
  currency?: string;
  promptCostPer1k?: number | null;
  completionCostPer1k?: number | null;
  totalCostPer1k?: number | null;
  source: string;
  sourcePeriod?: string | null;
  sourceSyncedAtMs?: number;
}

export interface LlmBillingPriceTarget {
  usageDay: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TokenUsageStoreOptions {
  pool?: pg.Pool;
  /** schema 保障能力注入端口（必填、无默认）：组合根传 automation 的 ensureCapabilitySchema，本文件只从 kernel 取类型。 */
  schemaEnsurer: SchemaEnsurer;
  flushMs?: number;
}

export class TokenUsageStore {
  private readonly pool: pg.Pool;
  private readonly flushMs: number;
  private buffer = new Map<string, Accum>();
  private timer?: ReturnType<typeof setInterval>;
  private retentionTimer?: ReturnType<typeof setInterval>;
  private flushing = false;
  private droppedFlushes = 0;
  private warnedUntagged = false;
  private warnedNoAccount = false;

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: TokenUsageStoreOptions) {
    this.schemaEnsurer = options.schemaEnsurer;
    this.pool =
      options.pool ??
      new Pool({
        ...resolveEnvPgConfig(),
        max: 4,
      });
    const envFlush = Number(process.env.AIDCP_TOKEN_FLUSH_MS);
    this.flushMs = options.flushMs ?? (Number.isFinite(envFlush) && envFlush > 0 ? envFlush : DEFAULT_FLUSH_MS);
  }

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'llm_token_usage',
      sinceVersion: '0013_llm_token_usage',
      ddl: [TOKEN_USAGE_SCHEMA_SQL],
    });
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.flush().catch(() => {});
      }, this.flushMs);
      this.timer.unref?.();
    }
    // 本地保留清理（change retention-local-purge）：llm_token_usage 归 aidcp-content，由本属主
    // **自驱**日频 purge——不再让面板层 retention-sweeper 跨域伸手进来调（原先的跨界驱动方已撤）。
    // 内联而非抽跨层共享 helper：跨层共享文件会重新引入本 change 正要消除的跨域依赖。默认保留 45 天
    // （覆盖用量页 31 天窗口 + 容错），env AIDCP_RETENTION_TOKEN_DAYS 覆盖；周期 24h、
    // env AIDCP_RETENTION_INTERVAL_MS 覆盖。阈值/周期/删的数据与被取代的 sweeper 逐位一致。
    if (!this.retentionTimer) {
      this.retentionTimer = this.startRetentionTimer();
    }
  }

  /** 本地保留清理定时器（change retention-local-purge）。unref、runOnStart、每轮 try/catch、绝不逃逸。 */
  private startRetentionTimer(): ReturnType<typeof setInterval> {
    const d = Number(process.env.AIDCP_RETENTION_TOKEN_DAYS);
    const days = Number.isFinite(d) && d > 0 ? d : 45;
    const ei = Number(process.env.AIDCP_RETENTION_INTERVAL_MS);
    const intervalMs = Number.isFinite(ei) && ei > 0 ? ei : 24 * 60 * 60 * 1000;
    const runOnce = async (): Promise<void> => {
      try {
        const deleted = await this.purgeOlderThan(days);
        if (deleted > 0) console.log(`[retention] llm_token_usage 保留清理完成：-${deleted}`);
      } catch (err) {
        console.warn(`[retention] llm_token_usage 清理失败（跳过本轮，不拖累其它表）：${(err as Error).message}`);
      }
    };
    void runOnce();
    const timer = setInterval(() => {
      void runOnce();
    }, intervalMs);
    timer.unref?.();
    console.log(`[retention] llm_token_usage 保留清理已启动（周期 ${Math.round(intervalMs / 3_600_000)}h；保留 ${days}d）`);
    return timer;
  }

  add(info: TokenUsageCallInfo): void {
    if (!info.accountId || info.accountId.length === 0) {
      if (!this.warnedNoAccount) {
        this.warnedNoAccount = true;
        console.warn('[token-usage] missing accountId; dropped usage record instead of falling back to default');
      }
      return;
    }
    const bucketMs = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    const accountId = info.accountId;
    const role = info.role && info.role.length > 0 ? info.role : 'untagged';
    if (role === 'untagged' && !this.warnedUntagged) {
      this.warnedUntagged = true;
      console.warn('[token-usage] recorded untagged LLM call');
    }
    const provider = normalizeDim(info.provider, UNKNOWN_PROVIDER);
    const model = normalizeDim(info.model, 'unknown');
    const prompt = info.promptTokens ?? 0;
    const completion = info.completionTokens ?? 0;
    const total = info.totalTokens ?? 0;
    const ok = info.ok ? 1 : 0;
    const key = `${bucketMs}|${accountId}|${role}|${provider}|${model}`;
    const cur = this.buffer.get(key);
    if (cur) {
      cur.promptTokens += prompt;
      cur.completionTokens += completion;
      cur.totalTokens += total;
      cur.calls += 1;
      cur.okCalls += ok;
      return;
    }
    this.buffer.set(key, {
      bucketMs,
      accountId,
      role,
      provider,
      model,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total,
      calls: 1,
      okCalls: ok,
    });
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;
    const snapshot = this.buffer;
    this.buffer = new Map();
    try {
      for (const a of snapshot.values()) {
        try {
          await this.pool.query(UPSERT_SQL, [
            a.bucketMs,
            a.accountId,
            a.role,
            a.provider,
            a.model,
            a.promptTokens,
            a.completionTokens,
            a.totalTokens,
            a.calls,
            a.okCalls,
          ]);
        } catch (err) {
          this.droppedFlushes += 1;
          if (this.droppedFlushes <= 3 || this.droppedFlushes % 50 === 0) {
            console.warn(
              `[token-usage] flush upsert failed; dropped increment ${this.droppedFlushes}:`,
              (err as Error).message,
            );
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = undefined;
    }
    await this.flush();
  }

  async purgeOlderThan(days: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM llm_token_usage WHERE bucket_start < now() - ($1::int * interval '1 day')`,
      [days],
    );
    return res.rowCount ?? 0;
  }

  async upsertBillingPrices(prices: LlmBillingPriceSnapshotInput[]): Promise<number> {
    let written = 0;
    for (const p of prices) {
      const provider = normalizeDim(p.provider, UNKNOWN_PROVIDER);
      const model = normalizeDim(p.model, 'unknown');
      const currency = normalizeDim(p.currency, 'CNY');
      const hasSplit = p.promptCostPer1k != null && p.completionCostPer1k != null;
      const hasTotal = p.totalCostPer1k != null;
      if (!hasSplit && !hasTotal) {
        throw new Error('billing_price_requires_split_or_total_cost');
      }
      await this.pool.query(UPSERT_BILLING_PRICE_SQL, [
        provider,
        model,
        p.usageDay,
        currency,
        p.promptCostPer1k ?? null,
        p.completionCostPer1k ?? null,
        p.totalCostPer1k ?? null,
        p.source,
        p.sourcePeriod ?? null,
        p.sourceSyncedAtMs ?? Date.now(),
      ]);
      written += 1;
    }
    return written;
  }

  async billingPriceTargets(usageDays: string[]): Promise<LlmBillingPriceTarget[]> {
    const days = Array.from(new Set(usageDays.map((d) => d.trim()).filter(Boolean)));
    if (days.length === 0) return [];
    const { rows } = await this.pool.query<{
      usage_day: string;
      provider: string;
      model: string;
      prompt_tokens: string;
      completion_tokens: string;
      total_tokens: string;
    }>(
      `WITH normalized AS (
         SELECT (bucket_start AT TIME ZONE 'Asia/Shanghai')::date AS usage_day,
                ${EFFECTIVE_PROVIDER_SQL} AS provider,
                model,
                prompt_tokens,
                completion_tokens,
                total_tokens
           FROM llm_token_usage
          WHERE (bucket_start AT TIME ZONE 'Asia/Shanghai')::date = ANY($1::date[])
       )
       SELECT usage_day::text AS usage_day,
              provider,
              model,
              SUM(prompt_tokens)::bigint AS prompt_tokens,
              SUM(completion_tokens)::bigint AS completion_tokens,
              SUM(total_tokens)::bigint AS total_tokens
         FROM normalized
        WHERE provider <> 'unknown'
        GROUP BY usage_day, provider, model
        HAVING SUM(total_tokens) > 0
        ORDER BY usage_day DESC, provider, model`,
      [days],
    );
    return rows.map((r) => ({
      usageDay: r.usage_day,
      provider: r.provider,
      model: r.model,
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      totalTokens: Number(r.total_tokens),
    }));
  }

  async usage(q: LlmUsageQuery = {}): Promise<LlmUsagePayload> {
    const nowMs = Date.now();
    let toMs = q.toMs ?? nowMs;
    let fromMs = q.fromMs ?? toMs - DEFAULT_WINDOW_MS;
    if (toMs < fromMs) [fromMs, toMs] = [toMs, fromMs];
    let clampedToDays: number | null = null;
    if (toMs - fromMs > MAX_RANGE_MS) {
      fromMs = toMs - MAX_RANGE_MS;
      clampedToDays = MAX_RANGE_DAYS;
    }
    const window = { fromMs, toMs, clampedToDays };
    try {
      const [rows, buckets] = await Promise.all([
        this.queryRows(fromMs, toMs, q),
        this.queryBuckets(fromMs, toMs, q),
      ]);
      return { rows, buckets, window };
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNDEFINED_TABLE) {
        return { rows: [], buckets: [], window };
      }
      throw err;
    }
  }

  private filterClause(q: LlmUsageQuery, params: unknown[]): string {
    const clauses: string[] = [];
    if (q.accountId) {
      params.push(q.accountId);
      clauses.push(`account_id = $${params.length}`);
    }
    if (q.role) {
      params.push(q.role);
      clauses.push(`role = $${params.length}`);
    }
    if (q.provider) {
      params.push(q.provider);
      clauses.push(`${EFFECTIVE_PROVIDER_SQL} = $${params.length}`);
    }
    if (q.model) {
      params.push(q.model);
      clauses.push(`model = $${params.length}`);
    }
    return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
  }

  private async queryRows(fromMs: number, toMs: number, q: LlmUsageQuery): Promise<LlmUsageRow[]> {
    const params: unknown[] = [fromMs, toMs];
    const filter = this.filterClause(q, params);
    const { rows } = await this.pool.query<{
      day: string;
      usage_day: string;
      account_id: string;
      role: string;
      provider: string;
      model: string;
      prompt_tokens: string;
      completion_tokens: string;
      total_tokens: string;
      calls: string;
      ok_calls: string;
      cost_amount: string | null;
      cost_currency: string | null;
      cost_source: string | null;
      cost_source_date: string | null;
      cost_synced_at_ms: string | null;
      pricing_basis: LlmUsageCostPricingBasis | null;
    }>(
      `WITH usage_rows AS (
         SELECT (bucket_start AT TIME ZONE 'Asia/Shanghai')::date AS usage_day,
                to_char(bucket_start AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
                account_id, role, ${EFFECTIVE_PROVIDER_SQL} AS provider, model,
                SUM(prompt_tokens)::bigint     AS prompt_tokens,
                SUM(completion_tokens)::bigint AS completion_tokens,
                SUM(total_tokens)::bigint      AS total_tokens,
                SUM(calls)::bigint             AS calls,
                SUM(ok_calls)::bigint          AS ok_calls
           FROM llm_token_usage
          WHERE bucket_start >= to_timestamp($1::bigint / 1000.0)
            AND bucket_start <  to_timestamp($2::bigint / 1000.0)${filter}
          GROUP BY usage_day, day, account_id, role, ${EFFECTIVE_PROVIDER_SQL}, model
       )
       SELECT u.day, u.usage_day::text AS usage_day,
              u.account_id, u.role, u.provider, u.model,
              u.prompt_tokens, u.completion_tokens, u.total_tokens, u.calls, u.ok_calls,
              CASE
                WHEN p.prompt_cost_per_1k IS NOT NULL AND p.completion_cost_per_1k IS NOT NULL
                  THEN ((u.prompt_tokens::numeric * p.prompt_cost_per_1k)
                       + (u.completion_tokens::numeric * p.completion_cost_per_1k)) / 1000
                WHEN p.total_cost_per_1k IS NOT NULL
                  THEN (u.total_tokens::numeric * p.total_cost_per_1k) / 1000
                ELSE NULL
              END AS cost_amount,
              p.currency AS cost_currency,
              p.source AS cost_source,
              COALESCE(p.source_period, p.usage_day::text) AS cost_source_date,
              (extract(epoch from p.source_synced_at) * 1000)::bigint AS cost_synced_at_ms,
              CASE
                WHEN p.prompt_cost_per_1k IS NOT NULL AND p.completion_cost_per_1k IS NOT NULL
                  THEN 'input_output_tokens'
                WHEN p.total_cost_per_1k IS NOT NULL
                  THEN 'total_tokens'
                ELSE NULL
              END AS pricing_basis
         FROM usage_rows u
         LEFT JOIN LATERAL (
           SELECT p.*
             FROM llm_billing_price_snapshot p
            WHERE p.provider = u.provider
              AND p.model = u.model
            ORDER BY p.usage_day DESC, p.source_synced_at DESC
            LIMIT 1
         ) p ON true
        ORDER BY u.day DESC, u.total_tokens DESC`,
      params,
    );
    return rows.map((r) => ({
      day: r.day,
      accountId: r.account_id,
      role: r.role,
      provider: r.provider,
      model: r.model,
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      totalTokens: Number(r.total_tokens),
      calls: Number(r.calls),
      okCalls: Number(r.ok_calls),
      costEstimate:
        r.cost_amount != null && r.cost_currency && r.cost_source && r.cost_source_date && r.pricing_basis
          ? {
              amount: Number(r.cost_amount),
              currency: r.cost_currency,
              source: r.cost_source,
              sourceDate: r.cost_source_date,
              syncedAtMs: r.cost_synced_at_ms != null ? Number(r.cost_synced_at_ms) : null,
              pricingBasis: r.pricing_basis,
            }
          : null,
    }));
  }

  private async queryBuckets(fromMs: number, toMs: number, q: LlmUsageQuery): Promise<LlmUsageBucket[]> {
    const params: unknown[] = [fromMs, toMs];
    const filter = this.filterClause(q, params);
    const { rows } = await this.pool.query<{
      bucket_ms: string;
      prompt_tokens: string;
      completion_tokens: string;
      total_tokens: string;
      calls: string;
    }>(
      `SELECT (extract(epoch from bucket_start) * 1000)::bigint AS bucket_ms,
              SUM(prompt_tokens)::bigint     AS prompt_tokens,
              SUM(completion_tokens)::bigint AS completion_tokens,
              SUM(total_tokens)::bigint      AS total_tokens,
              SUM(calls)::bigint             AS calls
         FROM llm_token_usage
        WHERE bucket_start >= to_timestamp($1::bigint / 1000.0)
          AND bucket_start <  to_timestamp($2::bigint / 1000.0)${filter}
        GROUP BY bucket_start
        ORDER BY bucket_start ASC`,
      params,
    );
    return rows.map((r) => ({
      bucketMs: Number(r.bucket_ms),
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      totalTokens: Number(r.total_tokens),
      calls: Number(r.calls),
    }));
  }
}

function normalizeDim(value: string | null | undefined, fallback: string): string {
  const s = value?.trim();
  return s ? s : fallback;
}

export function inferBillingProvider(provider: string | null | undefined, model: string | null | undefined): string {
  const p = normalizeDim(provider, UNKNOWN_PROVIDER);
  if (p !== UNKNOWN_PROVIDER) return p;
  const m = (model ?? '').trim().toLowerCase();
  if (m.startsWith('doubao') || m.startsWith('ep-')) return VOLCENGINE_PROVIDER;
  if (m.startsWith('qwen') || m.startsWith('deepseek')) return DASHSCOPE_PROVIDER;
  return UNKNOWN_PROVIDER;
}
