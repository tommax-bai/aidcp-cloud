import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';

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
  flushMs?: number;
}

export class TokenUsageStore {
  private readonly pool: pg.Pool;
  private readonly flushMs: number;
  private buffer = new Map<string, Accum>();
  private timer?: ReturnType<typeof setInterval>;
  private flushing = false;
  private droppedFlushes = 0;
  private warnedUntagged = false;
  private warnedNoAccount = false;

  constructor(options: TokenUsageStoreOptions = {}) {
    this.pool =
      options.pool ??
      new Pool({
        host: DEFAULT_PG_CONFIG.host,
        port: DEFAULT_PG_CONFIG.port,
        database: DEFAULT_PG_CONFIG.database,
        user: DEFAULT_PG_CONFIG.user,
        password: DEFAULT_PG_CONFIG.password,
        max: 4,
      });
    const envFlush = Number(process.env.AIDCP_TOKEN_FLUSH_MS);
    this.flushMs = options.flushMs ?? (Number.isFinite(envFlush) && envFlush > 0 ? envFlush : DEFAULT_FLUSH_MS);
  }

  async init(): Promise<void> {
    await this.pool.query(TOKEN_USAGE_SCHEMA_SQL);
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.flush().catch(() => {});
      }, this.flushMs);
      this.timer.unref?.();
    }
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
