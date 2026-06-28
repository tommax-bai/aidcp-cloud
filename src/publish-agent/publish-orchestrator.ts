import { PipelineContext } from './pipeline-context.js';
import type { BasePublishRole } from './roles/base-role.js';
import type {
  PipelineFields,
  PipelineStatus,
  TriggerInput,
  PublishResult,
  OrchestratorDeps,
} from './types.js';

export class PublishOrchestrator {
  private roles: BasePublishRole<any, any>[] = [];
  private activeContext: PipelineContext<PipelineFields> | null = null;
  private status: PipelineStatus = 'idle';
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly clock: () => number;
  private readonly idGen: () => string;
  private readonly pipelineTimeoutMs: number;

  constructor(deps?: OrchestratorDeps) {
    this.logger = deps?.logger ?? console;
    this.clock = deps?.clock ?? Date.now;
    this.idGen = deps?.idGen ?? (() => Math.random().toString(36).slice(2, 10));
    // 只覆盖生成候审段（生成终稿 + 落库待审 + 发审批卡）；不再为内联人审放大。
    this.pipelineTimeoutMs = deps?.pipelineTimeoutMs ?? 120000; // 2分钟默认超时
  }

  /** 注册角色 */
  registerRole(role: BasePublishRole<any, any>): void {
    this.roles.push(role);
  }

  /** 触发新一轮发布 */
  async trigger(triggerInput: TriggerInput): Promise<PublishResult & { runId: string }> {
    if (this.status === 'running') {
      this.logger.warn('[PublishOrchestrator] pipeline already running, ignoring trigger');
      return {
        recordId: null,
        status: 'skipped',
        dispatched: false,
        envelope: null,
        completedAt: this.clock(),
        runId: '',
      };
    }

    const runId = this.idGen();
    this.logger.log(`[PublishOrchestrator] starting pipeline run=${runId}`);
    this.status = 'running';

    // change decouple-publish-generation-from-dispatch：生成候审段**不让位浏览**。
    // 让位/续场已下放到下发段（PublishDispatcher，由人审授权触发）。此处只生成终稿 + 落库待审 + 发审批卡。

    // 创建新的 context
    const context = new PipelineContext<PipelineFields>();
    this.activeContext = context;

    // 注册所有角色的 watch
    for (const role of this.roles) {
      role.register(context);
    }

    // 写入 trigger 启动链式反应
    context.write('trigger', triggerInput);

    // 等待管道完成或超时
    try {
      const result = await this.awaitCompletion(context);
      this.status = 'completed';
      this.logger.log(`[PublishOrchestrator] pipeline completed run=${runId}, status=${result.status}`);
      return { ...result, runId };
    } catch (err) {
      this.status = 'failed';
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[PublishOrchestrator] pipeline failed run=${runId}: ${errMsg}`);
      return {
        recordId: null,
        status: 'failed',
        dispatched: false,
        envelope: null,
        completedAt: this.clock(),
        runId,
      };
    } finally {
      this.activeContext = null;
      // 生成候审段结束（成功/跳过/超时/中止/异常）。不触碰浏览会话——本段全程未让位。
      // 真正的下发与续场由 PublishDispatcher 在人审授权后处理。
    }
  }

  /** 等待管道完成 */
  private async awaitCompletion(context: PipelineContext<PipelineFields>): Promise<PublishResult> {
    // 两种终止条件：
    // 1. publishResult 被写入（正常完成）
    // 2. scoutDecision.shouldPublish = false（早期终止）
    // 3. 超时
    return new Promise<PublishResult>((resolve, reject) => {
      let settled = false;

      // 监听正常完成
      context.watch('publishResult', (result) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      }, { once: true });

      // 监听 scoutDecision 的短路情况
      context.watch('scoutDecision', (decision) => {
        if (!settled && !decision.shouldPublish) {
          settled = true;
          resolve({
            recordId: null,
            status: 'skipped',
            dispatched: false,
            envelope: null,
            completedAt: this.clock(),
          });
        }
      }, { once: true });

      // 监听角色中止信号（任一 fallback:'abort' 角色失败时写入）→ 即时判 failed，不再干等 pipelineTimeoutMs。
      // 由 trigger 的 catch 统一收敛为 status:'failed'（复用既有 reject→failed 路径，无新增结果整形）。
      context.watch('pipelineAbort', (abort) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Pipeline aborted by ${abort.role}: ${abort.reason}`));
        }
      }, { once: true });

      // 超时
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Pipeline timed out after ${this.pipelineTimeoutMs}ms`));
        }
      }, this.pipelineTimeoutMs);
    });
  }

  /** 获取当前管道状态 */
  getStatus(): { status: PipelineStatus; snapshot: Partial<PipelineFields> | null } {
    return {
      status: this.status,
      snapshot: this.activeContext?.snapshot() ?? null,
    };
  }

  /** 获取已注册角色列表 */
  getRoles(): string[] {
    return this.roles.map(r => r.config.name);
  }
}
