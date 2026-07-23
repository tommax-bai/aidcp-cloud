import crypto from 'node:crypto';
import { PipelineContext } from './pipeline-context.js';
import type { BasePublishRole } from './roles/base-role.js';
import type { PipelineLogSink } from '../kernel/pipeline-log-contract.js';
import type {
  PipelineFields,
  PipelineStatus,
  TriggerInput,
  PublishResult,
  OrchestratorDeps,
} from './types.js';

/** 单轮生成的观测摘要（change parallel-rewrite-drafts：run 注册表多轮并发观测）。 */
export interface RunSummary {
  runId: string;
  accountId: string;
  /** rewrite=参照洗稿轮（锚定 sourceId）；autonomous=自主创作轮。 */
  kind: 'rewrite' | 'autonomous';
  sourceId: string | null;
  startedAt: number;
  status: PipelineStatus;
  snapshot: Partial<PipelineFields>;
}

interface RunHandle {
  context: PipelineContext<PipelineFields>;
  accountId: string;
  kind: 'rewrite' | 'autonomous';
  sourceId: string | null;
  startedAt: number;
}

/**
 * PublishOrchestrator（change parallel-rewrite-drafts：run 注册表多轮并发）。
 * 单例引擎 + Map<runId, RunHandle> 簿记：每轮全新 PipelineContext、角色为无状态单例（watcher 挂在各轮
 * context 上），多轮可并发共存、一轮收敛只摘除自己的注册项。并发准入（键控单飞 + 容量帽）不在此层——
 * 由调度器的同步 claim 段负责；本层不再自查 running 拒绝二次 trigger。
 */
export class PublishOrchestrator {
  private roles: BasePublishRole<any, any>[] = [];
  /** run 注册表：在跑轮簿记。一轮收敛（成功/跳过/失败/超时）即摘除自己，绝不影响其他在跑轮。 */
  private readonly runs = new Map<string, RunHandle>();
  /** 最近一次终态（向后兼容观测聚合用）：无 running 轮时旧 status/snapshot 字段取此。 */
  private lastTerminal: { status: PipelineStatus; snapshot: Partial<PipelineFields> } | null = null;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly clock: () => number;
  private readonly idGen: () => string;
  private readonly pipelineTimeoutMs: number;
  /** 角色执行日志写入口（change publish-pipeline-observability）；未注入则不落库、行为不变。 */
  private readonly pipelineLogSink?: PipelineLogSink;

  constructor(deps?: OrchestratorDeps) {
    this.logger = deps?.logger ?? console;
    this.clock = deps?.clock ?? Date.now;
    // runId 抗碰撞（对照 image-generator 的 runToken）：并发多轮下 Math.random 短串有撞键面，换 crypto。
    this.idGen = deps?.idGen ?? (() => crypto.randomBytes(6).toString('hex'));
    // 只覆盖生成候审段（生成终稿 + 落库待审 + 发审批卡）；不再为内联人审放大。
    // change raise-model-call-timeouts-for-thinking-models：兜底默认与 server.ts 生效值对齐（600s），
    // 须 ≥ 关键路径各模型角色预算之和（容器不得小于内容物）。
    this.pipelineTimeoutMs = deps?.pipelineTimeoutMs ?? 600_000;
    this.pipelineLogSink = deps?.pipelineLogSink;
  }

  /** 注册角色 */
  registerRole(role: BasePublishRole<any, any>): void {
    this.roles.push(role);
  }

  /** 触发新一轮发布（多轮可并发；准入闸在调度器 claim 层，本层不拒） */
  async trigger(triggerInput: TriggerInput): Promise<PublishResult & { runId: string }> {
    // runId 注册表防撞：并发在跑键唯一（注入的固定 idGen/理论碰撞下第二轮追加后缀，绝不顶掉在跑轮簿记）。
    let runId = this.idGen();
    for (let n = 1; this.runs.has(runId); n++) runId = `${this.idGen()}-${n}`;
    const referenceNote = triggerInput.generateInput.referenceNote;
    const handle: RunHandle = {
      context: new PipelineContext<PipelineFields>(),
      accountId: triggerInput.accountId ?? 'default',
      kind: referenceNote ? 'rewrite' : 'autonomous',
      sourceId: referenceNote?.sourceId ?? null,
      startedAt: this.clock(),
    };
    this.logger.log(
      `[PublishOrchestrator] starting pipeline run=${runId} account=${handle.accountId} kind=${handle.kind}${handle.sourceId ? ` source=${handle.sourceId}` : ''}（并发在跑 ${this.runs.size + 1} 轮）`,
    );
    this.runs.set(runId, handle);
    const context = handle.context;

    // change decouple-publish-generation-from-dispatch：生成候审段**不让位浏览**。
    // 让位/续场已下放到下发段（PublishDispatcher，由人审授权触发）。此处只生成终稿 + 落库待审 + 发审批卡。

    // 注册所有角色的 watch（带 sink + runId：每角色每次执行 best-effort 落 publish_pipeline_logs 一行）。
    // 角色是无状态单例：同一实例可同时服务多个在跑 context，watcher 挂在各轮 context 上互不串。
    for (const role of this.roles) {
      role.register(context, { sink: this.pipelineLogSink, runId });
    }

    // 写入 trigger 启动链式反应
    context.write('trigger', triggerInput);

    // 等待管道完成或超时
    try {
      const result = await this.awaitCompletion(context);
      this.logger.log(`[PublishOrchestrator] pipeline completed run=${runId}, status=${result.status}`);
      this.lastTerminal = { status: 'completed', snapshot: context.snapshot() };
      return { ...result, runId };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[PublishOrchestrator] pipeline failed run=${runId}: ${errMsg}`);
      this.lastTerminal = { status: 'failed', snapshot: context.snapshot() };
      return {
        recordId: null,
        status: 'failed',
        dispatched: false,
        envelope: null,
        completedAt: this.clock(),
        // 把真实失败原因（中止角色+理由 / 超时 / 异常信息）带出去，不再只落日志——上层飞书回执据此告诉人「为什么」。
        reason: errMsg,
        runId,
      };
    } finally {
      // 僵尸轮拦截（change parallel-rewrite-drafts）：本轮已对外收敛（成功/跳过/失败/超时），给 context
      // 打中止标记——超时后仍在途的角色接力到落库点会被 PublishExecutor 拒绝（绝不产生第二结局、
      // 绝不穿透单飞键与容量帽）。已发生的模型/生图消耗是沉没成本，如实记账。
      context.markAborted();
      // 只摘除自己的注册项，绝不触碰其他在跑轮（修掉旧单槽「先结束轮抹在跑轮」串台点）。
      this.runs.delete(runId);
      // 生成候审段结束。不触碰浏览会话——本段全程未让位；下发与续场由 PublishDispatcher 在人审授权后处理。
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
            reason: decision.reason ? `选题判定不发布：${decision.reason}` : '选题判定不发布',
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

  /**
   * 观测（向后兼容多 run 形状，change parallel-rewrite-drafts）：
   * - 旧字段 status/snapshot 聚合规则显式定义——取**最新启动的 running 轮**；无 running 轮则最近一次终态
   *   （失败态不会被并行 running 轮永久遮蔽：running 清空后终态重新可见）；两者皆无 → idle/null。
   * - 新字段 runs：全部在跑轮摘要（旧版 console 不读它、不白屏）。
   */
  getStatus(): { status: PipelineStatus; snapshot: Partial<PipelineFields> | null; runs: RunSummary[] } {
    const running: RunSummary[] = [...this.runs.entries()].map(([runId, h]) => ({
      runId,
      accountId: h.accountId,
      kind: h.kind,
      sourceId: h.sourceId,
      startedAt: h.startedAt,
      status: 'running' as PipelineStatus,
      snapshot: h.context.snapshot(),
    }));
    if (running.length > 0) {
      const latest = running.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a));
      return { status: 'running', snapshot: latest.snapshot, runs: running };
    }
    if (this.lastTerminal) {
      return { status: this.lastTerminal.status, snapshot: this.lastTerminal.snapshot, runs: [] };
    }
    return { status: 'idle', snapshot: null, runs: [] };
  }

  /** 获取已注册角色列表 */
  getRoles(): string[] {
    return this.roles.map(r => r.config.name);
  }
}
