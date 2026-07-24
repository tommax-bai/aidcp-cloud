/**
 * 「发布生成触发」的跨进程传输（Block② 同步传输承重件之一）。
 *
 * 生成管线默认 600s，远超同步内部 HTTP 的 180s 硬顶（{@link INTERNAL_HTTP_TIMEOUT_CEILING_MS}）。
 * 故不用单发同步 RPC，改「**同步 kick + 分段 long-poll**」：
 *   1. kick（<1s）：POST TriggerInput → content 侧**不 await**地起管线、登记 correlationId、立即回 `{ correlationId }`。
 *   2. poll（分段有界，每段 < 180s）：按 correlationId 对该轮终态做**有界 race**——settled 回 `{ done:true, result }`，
 *      未 settled 回 `{ done:false }`，调用方续发下一段，累计覆盖 ~650s。
 *
 * 范式与两侧共用路由常量照 {@link file://./curated-content-http.ts}。默认 local（组合根注入本体）时本文件不参与。
 *
 * import 约束：kernel 端口 type-only；internal-http type-only（照 curated 文件，不引其运行时值，
 * 结构化错误一律以带 string `code` 的普通对象抛出，由传输骨架的 encodeHandlerError 保真编码）。
 */
import { randomUUID } from 'node:crypto';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type { TriggerInput } from '../kernel/publish-pipeline-types.js';
import type { PublishGenerationPort, SchedulerTriggerResult } from '../kernel/publish-generation-types.js';

/** 每个内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const PUBLISH_GENERATION_ROUTES = {
  kick: 'publish-generation/kick',
  poll: 'publish-generation/poll',
} as const;

/** 单段 long-poll 挂起上限（毫秒）：稳吃 180s 天花板，留足余量给传输往返。 */
export const PUBLISH_GENERATION_POLL_SEGMENT_CEILING_MS = 150_000;
/** 客户端每段默认 long-poll 预算（毫秒）。 */
export const PUBLISH_GENERATION_DEFAULT_POLL_SEGMENT_MS = 150_000;
/** 客户端总预算封顶（毫秒）：pipelineTimeoutMs(600s) + 余量，约 4 段。 */
export const PUBLISH_GENERATION_DEFAULT_TOTAL_BUDGET_MS = 650_000;

/** kick handler 入参。 */
interface KickArgs {
  input: TriggerInput;
}
/** poll handler 入参。 */
interface PollArgs {
  correlationId: string;
  budgetMs?: number;
}
/** poll 线格式返回。 */
type PollResult = { done: true; result: SchedulerTriggerResult } | { done: false };

/** 一轮在跑生成的注册项：promise + 终态快照（settled 后取 result / error）。 */
interface RunEntry {
  promise: Promise<SchedulerTriggerResult>;
  settled: boolean;
  errored: boolean;
  result?: SchedulerTriggerResult;
  error?: unknown;
}

/** 带 string `code` 的结构化抛出物：被 internal-http 的 encodeHandlerError 原样编码进线格式。 */
function structured(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

/** 把生成失败（trigger promise reject）归一为结构化线错误。 */
function toStructuredError(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    const e = error as { code: string; message?: unknown };
    return structured(e.code, typeof e.message === 'string' ? e.message : e.code);
  }
  return structured('generation_error', error instanceof Error ? error.message : String(error));
}

/** 等到该轮 settled 或等满 waitMs（有界 race；不改写、不 reject——终态由 kick 期挂的 handler 记录）。 */
function waitForSettleOrTimeout(entry: RunEntry, waitMs: number): Promise<void> {
  if (entry.settled) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, waitMs));
    // kick 期已挂 .then/.catch 设 settled；此处再挂一对只为唤醒 race，两条订阅按注册序执行，settled 已先置。
    entry.promise.then(finish, finish);
  });
}

/**
 * 把一个本地 {@link PublishGenerationPort} 暴露为 kick / poll 两条内部 HTTP 路由。
 * 内部维护 correlationId → RunEntry 注册表；kick 不 await 地起管线，poll 有界 race 取终态。
 */
export function registerPublishGenerationRoutes(
  server: InternalHttpServer,
  local: PublishGenerationPort,
): void {
  const runs = new Map<string, RunEntry>();

  server.register(PUBLISH_GENERATION_ROUTES.kick, (args) => {
    const a = args as KickArgs;
    const correlationId = randomUUID();
    const entry: RunEntry = { promise: local.trigger(a.input), settled: false, errored: false };
    // 不 await：立即登记，终态由此 handler 落进 entry（同一 promise 后续 race 只读 settled）。
    entry.promise.then(
      (result) => {
        entry.result = result;
        entry.settled = true;
      },
      (error) => {
        entry.error = error;
        entry.errored = true;
        entry.settled = true;
      },
    );
    runs.set(correlationId, entry);
    return Promise.resolve({ correlationId });
  });

  server.register(PUBLISH_GENERATION_ROUTES.poll, async (args): Promise<PollResult> => {
    const a = args as PollArgs;
    const entry = runs.get(a.correlationId);
    if (!entry) {
      throw structured('unknown_correlation', `no generation run for correlationId: ${a.correlationId}`);
    }
    if (!entry.settled) {
      const budget = typeof a.budgetMs === 'number' && Number.isFinite(a.budgetMs) ? a.budgetMs : PUBLISH_GENERATION_POLL_SEGMENT_CEILING_MS;
      const waitMs = Math.min(Math.max(0, budget), PUBLISH_GENERATION_POLL_SEGMENT_CEILING_MS);
      await waitForSettleOrTimeout(entry, waitMs);
    }
    if (!entry.settled) {
      return { done: false };
    }
    // 终态已取走 → 清理注册项（再 poll 同 id 落 unknown_correlation）。
    runs.delete(a.correlationId);
    if (entry.errored) {
      throw toStructuredError(entry.error);
    }
    return { done: true, result: entry.result as SchedulerTriggerResult };
  });
}

/** {@link PublishGenerationHttpClient} 可选参数。 */
export interface PublishGenerationHttpClientOptions {
  /** 每段 long-poll 预算（毫秒），默认 {@link PUBLISH_GENERATION_DEFAULT_POLL_SEGMENT_MS}，硬顶 150s。 */
  pollSegmentMs?: number;
  /** 总预算封顶（毫秒），默认 {@link PUBLISH_GENERATION_DEFAULT_TOTAL_BUDGET_MS}。 */
  totalBudgetMs?: number;
  clock?: () => number;
}

/**
 * {@link PublishGenerationPort} 的 HTTP 实现：先 kick 拿 correlationId，再循环 poll 直到 `done`，
 * 返回同一个 {@link SchedulerTriggerResult}；总预算封顶后抛结构化 timeout。
 *
 * 注：底层 {@link InternalHttpClient} 的单次调用超时必须 **> `pollSegmentMs`**（否则每段 poll 会在
 * 服务端回 `{done:false}` 前先被客户端超时切断）——由组合根用 `timeoutMs: 180_000` 构造该 client。
 */
export class PublishGenerationHttpClient implements PublishGenerationPort {
  private readonly pollSegmentMs: number;
  private readonly totalBudgetMs: number;
  private readonly clock: () => number;

  constructor(
    private readonly http: InternalHttpClient,
    opts: PublishGenerationHttpClientOptions = {},
  ) {
    const seg = opts.pollSegmentMs ?? PUBLISH_GENERATION_DEFAULT_POLL_SEGMENT_MS;
    this.pollSegmentMs = Math.min(Math.max(1, seg), PUBLISH_GENERATION_POLL_SEGMENT_CEILING_MS);
    this.totalBudgetMs = opts.totalBudgetMs ?? PUBLISH_GENERATION_DEFAULT_TOTAL_BUDGET_MS;
    this.clock = opts.clock ?? Date.now;
  }

  async trigger(input: TriggerInput): Promise<SchedulerTriggerResult> {
    const { correlationId } = await this.http.call<{ correlationId: string }>(
      PUBLISH_GENERATION_ROUTES.kick,
      { input },
    );
    const deadline = this.clock() + this.totalBudgetMs;
    for (;;) {
      const res = await this.http.call<PollResult>(PUBLISH_GENERATION_ROUTES.poll, {
        correlationId,
        budgetMs: this.pollSegmentMs,
      });
      if (res.done) return res.result;
      if (this.clock() >= deadline) {
        const err = new Error(
          `publish generation exceeded total budget ${this.totalBudgetMs}ms (correlationId=${correlationId})`,
        );
        (err as { code?: string }).code = 'generation_timeout';
        throw err;
      }
    }
  }
}
