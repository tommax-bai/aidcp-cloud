/**
 * 文本 LLM token 用量记账（llm_token_usage 表，PostgreSQL）。
 *
 * change llm-token-usage-stats：把 QwenClient 出口 onCall 回报的 token 用量按
 * (10 分钟桶, 账号, 角色, 模型) 预聚合落库，供后台「用量」页出表格 + 10 分钟曲线。
 *
 * 热路径隔离（红线，design D2）：
 * - add() 只做纯内存 Map 累加（同步、不触 PG）；调用方（server.ts onCall 钩子）须 try/catch 包裹，
 *   记账的任何慢/失败/异常绝不阻塞、抛进或拖垮 LLM 调用路径。
 * - 持久化走定时 flush（与每次调用解耦）+ 专用小连接池（与热路径/边-云池隔离）。
 * - flush 失败：丢弃当窗增量 + 计数告警，MUST NOT 重试累加（加法 upsert 非幂等，重试会二次累加造假）。
 *
 * token 与 ok 解耦（红线）：token 量取自响应体 usage，即使 ok=false 也带真实已计费 token；
 * 真没拿到 usage 才为 0。account 缺省 'default'、role 缺省 'untagged'、探活 'system:model_probe'。
 *
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0013_llm_token_usage.sql 同源。
 * 只读写 llm_token_usage；绝不碰风控状态单写路径 / 发布链 / edge。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';

const { Pool } = pg;

const PG_UNDEFINED_TABLE = '42P01';
const BUCKET_MS = 600_000; // 10 分钟
const DEFAULT_FLUSH_MS = 15_000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 曲线缺省窗 = 近 24h（144 桶）
const MAX_RANGE_DAYS = 31;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

/** 与迁移 0013 同源的内嵌 DDL（幂等）。 */
export const TOKEN_USAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS llm_token_usage (
  bucket_start      TIMESTAMPTZ NOT NULL,
  account_id        TEXT        NOT NULL,
  role              TEXT        NOT NULL,
  model             TEXT        NOT NULL,
  prompt_tokens     BIGINT      NOT NULL DEFAULT 0,
  completion_tokens BIGINT      NOT NULL DEFAULT 0,
  total_tokens      BIGINT      NOT NULL DEFAULT 0,
  calls             BIGINT      NOT NULL DEFAULT 0,
  ok_calls          BIGINT      NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_start, account_id, role, model)
);
CREATE INDEX IF NOT EXISTS idx_llm_token_usage_account_bucket
  ON llm_token_usage (account_id, bucket_start);
`;

const UPSERT_SQL = `
INSERT INTO llm_token_usage
  (bucket_start, account_id, role, model, prompt_tokens, completion_tokens, total_tokens, calls, ok_calls)
VALUES (to_timestamp($1::bigint / 1000.0), $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (bucket_start, account_id, role, model) DO UPDATE SET
  prompt_tokens     = llm_token_usage.prompt_tokens     + EXCLUDED.prompt_tokens,
  completion_tokens = llm_token_usage.completion_tokens + EXCLUDED.completion_tokens,
  total_tokens      = llm_token_usage.total_tokens      + EXCLUDED.total_tokens,
  calls             = llm_token_usage.calls             + EXCLUDED.calls,
  ok_calls          = llm_token_usage.ok_calls          + EXCLUDED.ok_calls,
  updated_at        = now()
`;

/** QwenClient onCall 回报的形状（token 与 ok 解耦）。 */
export interface TokenUsageCallInfo {
  role?: string;
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
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  okCalls: number;
}

/** 表格一行（按北京日期 × 四维聚合）。token 量为 BIGINT 求和后按数值返回。 */
export interface LlmUsageRow {
  day: string; // 'YYYY-MM-DD'（Asia/Shanghai）
  accountId: string;
  role: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  okCalls: number;
}

/** 曲线一点（10 分钟桶；bucketMs 为 UTC epoch ms）。 */
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
  model?: string;
}

export interface LlmUsagePayload {
  rows: LlmUsageRow[];
  buckets: LlmUsageBucket[];
  window: { fromMs: number; toMs: number; clampedToDays: number | null };
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

  constructor(options: TokenUsageStoreOptions = {}) {
    // 专用小连接池（热路径隔离）：与边-云/风控/面板池物理分开。
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

  /** 建表（与迁移同源）+ 起定时 flush。须早于开始接受 LLM 调用/探活。 */
  async init(): Promise<void> {
    await this.pool.query(TOKEN_USAGE_SCHEMA_SQL);
    if (!this.timer) {
      this.timer = setInterval(() => {
        // 永不让定时 flush 的 rejection 逃逸成 unhandledRejection（崩进程）。
        this.flush().catch(() => {});
      }, this.flushMs);
      this.timer.unref?.();
    }
  }

  /**
   * 纯内存累加（同步、不触 PG、不抛实际异常）。调用方仍须 try/catch 包裹——记账绝不进 LLM 路径。
   * account/role 缺省为保留诚实标签（不静默丢用量）；token 缺失即 0（不伪造）。
   */
  add(info: TokenUsageCallInfo): void {
    const bucketMs = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    const accountId = info.accountId && info.accountId.length > 0 ? info.accountId : 'default';
    const role = info.role && info.role.length > 0 ? info.role : 'untagged';
    if (role === 'untagged' && !this.warnedUntagged) {
      this.warnedUntagged = true;
      // warn-once：legacy/工具路径（PostProcessor / v1 planner / v1 selector）无 tag 属预期；
      // 若某真实角色丢了 tag 而落到这里，这条告警让回归可见、不被静默吸收。
      console.warn(
        '[token-usage] 记到 untagged 调用（无角色 tag）。legacy/工具路径预期内；若某真实角色应有 tag 却落此，请排查。',
      );
    }
    const model = info.model && info.model.length > 0 ? info.model : 'unknown';
    const prompt = info.promptTokens ?? 0;
    const completion = info.completionTokens ?? 0;
    const total = info.totalTokens ?? 0;
    const ok = info.ok ? 1 : 0;
    const key = `${bucketMs}|${accountId}|${role}|${model}`;
    const cur = this.buffer.get(key);
    if (cur) {
      cur.promptTokens += prompt;
      cur.completionTokens += completion;
      cur.totalTokens += total;
      cur.calls += 1;
      cur.okCalls += ok;
    } else {
      this.buffer.set(key, {
        bucketMs,
        accountId,
        role,
        model,
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total,
        calls: 1,
        okCalls: ok,
      });
    }
  }

  /** 把内存累计增量 upsert 到 PG。失败丢弃 + 计数，绝不重试累加。 */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;
    const snapshot = this.buffer;
    this.buffer = new Map(); // 立即换新 buffer：flush 期间新调用进新 map，不阻塞 add()
    try {
      for (const a of snapshot.values()) {
        try {
          await this.pool.query(UPSERT_SQL, [
            a.bucketMs,
            a.accountId,
            a.role,
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
              `[token-usage] flush upsert 失败（丢弃该增量、不重试累加；累计丢 ${this.droppedFlushes}）：`,
              (err as Error).message,
            );
          }
          // 不 re-add：加法 upsert 非幂等，重试可能二次累加。诚实丢一窗 + 计数。
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** 停定时器 + 末次 flush（进程退出前调）。 */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  /** 留存口径：删早于 N 天的桶（本流不接调度，多账号上线时再接）。 */
  async purgeOlderThan(days: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM llm_token_usage WHERE bucket_start < now() - ($1::int * interval '1 day')`,
      [days],
    );
    return res.rowCount ?? 0;
  }

  /** 面板查询：一次返回表格行（北京日期×四维）+ 10 分钟曲线桶。缺表回落空。 */
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
      account_id: string;
      role: string;
      model: string;
      prompt_tokens: string;
      completion_tokens: string;
      total_tokens: string;
      calls: string;
      ok_calls: string;
    }>(
      `SELECT to_char(bucket_start AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
              account_id, role, model,
              SUM(prompt_tokens)::bigint     AS prompt_tokens,
              SUM(completion_tokens)::bigint AS completion_tokens,
              SUM(total_tokens)::bigint      AS total_tokens,
              SUM(calls)::bigint             AS calls,
              SUM(ok_calls)::bigint          AS ok_calls
         FROM llm_token_usage
        WHERE bucket_start >= to_timestamp($1::bigint / 1000.0)
          AND bucket_start <  to_timestamp($2::bigint / 1000.0)${filter}
        GROUP BY day, account_id, role, model
        ORDER BY day DESC, total_tokens DESC`,
      params,
    );
    return rows.map((r) => ({
      day: r.day,
      accountId: r.account_id,
      role: r.role,
      model: r.model,
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      totalTokens: Number(r.total_tokens),
      calls: Number(r.calls),
      okCalls: Number(r.ok_calls),
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
