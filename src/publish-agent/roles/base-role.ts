import type { PipelineContext } from '../pipeline-context.js';
import type { PipelineFields } from '../types.js';
import type { PipelineLogSink } from '../publish-pipeline-log-store.js';

export interface RoleConfig {
  name: string;
  watchKeys: (keyof PipelineFields)[];
  waitAll?: boolean;
  timeoutMs?: number;
  fallback?: 'skip' | 'abort' | 'default';
}

export abstract class BasePublishRole<TInput, TOutput> {
  abstract readonly config: RoleConfig;
  protected logger: Pick<Console, 'log' | 'warn' | 'error'>;
  protected clock: () => number;

  constructor(deps?: { logger?: Pick<Console, 'log' | 'warn' | 'error'>; clock?: () => number }) {
    this.logger = deps?.logger ?? console;
    this.clock = deps?.clock ?? Date.now;
  }

  /** 注册到 context 的 watch */
  register(context: PipelineContext<PipelineFields>, opts?: { sink?: PipelineLogSink; runId?: string }): void {
    const { watchKeys, waitAll, name } = this.config;
    const sink = opts?.sink;
    const runId = opts?.runId ?? '';

    const onActivate = async (_value: unknown, ctx: PipelineContext<PipelineFields>) => {
      const startedAt = this.clock();
      this.logger.log(`[${name}] activated`);
      try {
        const snapshot = ctx.snapshot();
        // 检查激活守卫（子类可覆写）
        if (!this.shouldActivate(snapshot)) {
          this.logger.log(`[${name}] skipped (guard condition not met)`);
          return;
        }
        const input = this.extractInput(snapshot);
        const output = await this.executeWithTimeout(input, ctx);
        const duration = this.clock() - startedAt;
        this.logger.log(`[${name}] completed in ${duration}ms`);
        ctx.write(this.outputKey as any, output as any);
        // 角色执行日志（best-effort：不 await、吞错——绝不波及发布主链路）。change publish-pipeline-observability。
        void sink
          ?.append({ runId, roleName: name, triggeredAt: startedAt, completedAt: this.clock(), success: true, errorMessage: null, durationMs: duration })
          .catch(() => {});
      } catch (err) {
        const duration = this.clock() - startedAt;
        this.logger.error(`[${name}] failed after ${duration}ms:`, err);
        void sink
          ?.append({ runId, roleName: name, triggeredAt: startedAt, completedAt: this.clock(), success: false, errorMessage: (err as Error).message, durationMs: duration })
          .catch(() => {});
        await this.handleError(err as Error, context);
      }
    };

    if (waitAll && watchKeys.length > 1) {
      context.watchAll(watchKeys as string[] as any, onActivate, { once: true });
    } else if (watchKeys.length === 1) {
      context.watch(watchKeys[0] as any, onActivate, { once: true });
    }
  }

  /** 核心执行逻辑（子类实现） */
  protected abstract execute(input: TInput, context: PipelineContext<PipelineFields>): Promise<TOutput>;

  /**
   * 当轮账号（change parallel-rewrite-drafts 显式归账）：从黑板 trigger 快照取，供每次 LLM 调用
   * 显式带 accountId 记账。并行生成各轮各归各账——MUST NOT 依赖任何进程级共享槽推断当前账号。
   */
  protected accountIdFrom(context: PipelineContext<PipelineFields>): string {
    return context.snapshot().trigger?.accountId ?? 'default';
  }

  /** 将产出写回 context 的哪个字段 */
  protected abstract readonly outputKey: keyof PipelineFields;

  /** 从 context snapshot 提取自己需要的输入 */
  protected abstract extractInput(snapshot: Partial<PipelineFields>): TInput;

  /** 激活守卫条件（子类可覆写，如 ContentCreator 只在 shouldPublish=true 时激活） */
  protected shouldActivate(_snapshot: Partial<PipelineFields>): boolean {
    return true;
  }

  /** 带超时执行。execute 胜出后必清超时定时器——否则会泄漏一个 timeoutMs 时长的 ref 定时器（拖住进程退出）。 */
  private async executeWithTimeout(input: TInput, context: PipelineContext<PipelineFields>): Promise<TOutput> {
    const timeoutMs = this.config.timeoutMs ?? 30000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.execute(input, context),
        new Promise<TOutput>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`[${this.config.name}] execution timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 错误处理（根据 fallback 配置决定行为） */
  protected async handleError(err: Error, context: PipelineContext<PipelineFields>): Promise<void> {
    const { fallback, name } = this.config;
    if (fallback === 'skip') {
      this.logger.warn(`[${name}] skipping due to error: ${err.message}`);
      const defaultOutput = this.getDefaultOutput();
      if (defaultOutput !== undefined) {
        context.write(this.outputKey as any, defaultOutput as any);
      }
    } else if (fallback === 'abort') {
      // 红线：不派生/不造假输出。但写一个中止信号让编排器**即时**判 failed——
      // 否则下游 waitAll 永远缺这一键，流水线会干等 pipelineTimeoutMs(18min) 才失败（挂死）。
      this.logger.error(`[${name}] aborting pipeline`);
      context.write('pipelineAbort', { role: name, reason: err.message, abortedAt: this.clock() });
    }
    // 'default' - 子类自行处理
  }

  /** 子类可覆写：提供降级默认输出 */
  protected getDefaultOutput(): TOutput | undefined {
    return undefined;
  }
}
