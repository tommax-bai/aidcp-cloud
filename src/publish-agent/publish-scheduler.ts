/**
 * PublishScheduler — A 阶段4 发帖触发器。
 *
 * 三扳机任一触发 PublishOrchestrator.trigger()：
 *  ① 概念积累阈值：自上次发布以来新概念数 ≥ N。
 *  ② 风控允许窗口：距上次发布 ≥ minHours 且风控态 normal。
 *  ③ 手动飞书 /publish。
 * 自动两扳机(①②)MUST 过 riskController.canDo('publish')，被拒诚实跳过、不触发。
 * 手动 /publish MAY 越过 canDo（人工授权），但下游 PublishExecutor 的发布前飞书人审仍铁定生效（AC-PUB）。
 *
 * 编排端不持久化决策——只读 ConceptStore/LikedNoteStore/PublishLogStore 聚合 TriggerInput；
 * 复用 server 注入的 RiskController/各 Store 单例。
 */

import type { TriggerInput } from './types.js';
import type { Soul } from '../soul/types.js';

export interface SchedulerConceptStore {
  countNewSince(sinceMs: number): Promise<number>;
  getNewConceptsSince(sinceMs: number, limit?: number): Promise<string[]>;
}
export interface SchedulerLikedStore {
  countSince(sinceMs: number): Promise<number>;
  recentSince(sinceMs: number, limit?: number): Promise<Array<{ id: number; title: string; summary: string; author?: string }>>;
}
export interface SchedulerPublishLog {
  getMostRecentPublishTime(): Promise<number | null>;
  recentPublishedContents(limit?: number): Promise<string[]>;
}
export interface SchedulerRisk {
  canDo(action: 'publish'): boolean;
  getState(): { status: string };
}
export interface SchedulerOrchestrator {
  trigger(input: TriggerInput): Promise<{ status: string; runId?: string }>;
}

export interface PublishSchedulerDeps {
  conceptStore: SchedulerConceptStore;
  likedStore: SchedulerLikedStore;
  publishLog: SchedulerPublishLog;
  risk: SchedulerRisk;
  orchestrator: SchedulerOrchestrator;
  soul: Soul;
  /** 概念积累阈值 N（缺省 20）。 */
  conceptThreshold?: number;
  /** 两次发布最小间隔小时（风控窗口扳机，缺省 24）。 */
  minHoursBetween?: number;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export type TriggerOutcome =
  | { result: 'triggered'; reason: string; status: string }
  | { result: 'skipped'; reason: string }
  | { result: 'blocked'; reason: string };

const HOUR_MS = 3_600_000;

export class PublishScheduler {
  private readonly d: PublishSchedulerDeps;
  private readonly clock: () => number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly conceptThreshold: number;
  private readonly minHoursBetween: number;
  /** 无发布记录时的基准（进程启动时刻），避免把历史全量概念算成"新"。 */
  private readonly startedAt: number;

  constructor(deps: PublishSchedulerDeps) {
    this.d = deps;
    this.clock = deps.clock ?? Date.now;
    this.logger = deps.logger ?? console;
    this.conceptThreshold = deps.conceptThreshold ?? 20;
    this.minHoursBetween = deps.minHoursBetween ?? 24;
    this.startedAt = this.clock();
  }

  /** 基准时刻：上次发布时间，无则进程启动时刻。 */
  private async baselineMs(): Promise<number> {
    return (await this.d.publishLog.getMostRecentPublishTime()) ?? this.startedAt;
  }

  /** 聚合 TriggerInput（真概念 + 真点赞 + 最近已发 + 人设）。 */
  async buildTriggerInput(): Promise<TriggerInput> {
    const baseline = await this.baselineMs();
    const [conceptKeywords, liked, recentPublished, newConceptCount] = await Promise.all([
      this.d.conceptStore.getNewConceptsSince(baseline),
      this.d.likedStore.recentSince(baseline),
      this.d.publishLog.recentPublishedContents(5),
      this.d.conceptStore.countNewSince(baseline),
    ]);
    const hoursSinceLastPublish = (this.clock() - baseline) / HOUR_MS;
    return {
      metrics: {
        hoursSinceLastPublish,
        newConceptCount,
        likedSinceLastPublish: liked.length,
      },
      generateInput: {
        concepts: conceptKeywords.map((keyword) => ({ keyword })),
        likedContents: liked.map((l) => ({ id: l.id, title: l.title, summary: l.summary, author: l.author ?? '' })),
        soul: this.d.soul,
        recentPosts: recentPublished,
      },
      recentPublished,
    };
  }

  /** 自动扳机检查（①概念积累 / ②风控窗口），由 server 定时调用。 */
  async checkAndMaybeTrigger(): Promise<TriggerOutcome> {
    const baseline = await this.baselineMs();
    const newConceptCount = await this.d.conceptStore.countNewSince(baseline);
    const hoursSince = (this.clock() - baseline) / HOUR_MS;
    const status = this.d.risk.getState().status;

    const byConcept = newConceptCount >= this.conceptThreshold;
    const byWindow = hoursSince >= this.minHoursBetween && status === 'normal';
    if (!byConcept && !byWindow) {
      return { result: 'skipped', reason: `no_trigger(concepts=${newConceptCount}/${this.conceptThreshold}, hours=${hoursSince.toFixed(1)}/${this.minHoursBetween}, status=${status})` };
    }

    // 自动扳机必过风控闸：被拒诚实跳过，不触发（红线：不静默假发布）。
    if (!this.d.risk.canDo('publish')) {
      this.logger.warn(`[PublishScheduler] 自动扳机命中但风控拒绝(canDo=false, status=${status})，跳过不触发`);
      return { result: 'blocked', reason: `risk_denied(status=${status})` };
    }

    const reason = byConcept ? `concept_threshold(${newConceptCount})` : `risk_window(${hoursSince.toFixed(1)}h)`;
    const status2 = await this.doTrigger(reason);
    return { result: 'triggered', reason, status: status2 };
  }

  /** 手动飞书 /publish：越过 canDo（人工授权），但下游人审仍必过（AC-PUB）。 */
  async triggerManual(): Promise<TriggerOutcome> {
    this.logger.log('[PublishScheduler] 手动 /publish：越过风控 canDo（人工授权），发布前飞书人审仍生效');
    const status = await this.doTrigger('manual_feishu');
    return { result: 'triggered', reason: 'manual_feishu', status };
  }

  private async doTrigger(reason: string): Promise<string> {
    const input = await this.buildTriggerInput();
    this.logger.log(`[PublishScheduler] 触发发帖编排 reason=${reason} newConcepts=${input.metrics.newConceptCount} liked=${input.metrics.likedSinceLastPublish}`);
    const res = await this.d.orchestrator.trigger(input);
    return res.status;
  }
}
