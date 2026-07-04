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

import type { PublishSourceReference, TriggerInput } from './types.js';
import type { Soul } from '../soul/types.js';
import type { CuratedContentTypeFilter, CuratedSelectItem } from '../cache/curated-content-store.js';

/** 洗稿参照笔记（change curated-note-actions）：管理后台精选页人工指定，注入创作输入独立参照块。 */
export type ReferenceNote = NonNullable<TriggerInput['generateInput']['referenceNote']>;

/** 参照正文注入上限（字符）：蒸馏注入、防全文直灌撑爆 prompt。 */
export const REFERENCE_BODY_MAX_LEN = 800;

export interface SchedulerConceptStore {
  countNewSince(sinceMs: number): Promise<number>;
  getNewConceptsSince(sinceMs: number, limit?: number): Promise<string[]>;
  /** change curated-inspiration-corpus：带来源笔记标题的概念（可选；缺省回落只取关键词）。 */
  getNewConceptsWithSourceSince?(sinceMs: number, limit?: number): Promise<Array<{ keyword: string; sourceNote: string | null }>>;
}
/** 精选灵感语料召回口（change curated-inspiration-corpus）。 */
export interface SchedulerCuratedStore {
  selectForCreation(accountId: string, contentType: CuratedContentTypeFilter, limit: number): Promise<CuratedSelectItem[]>;
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
  trigger(input: TriggerInput): Promise<{ status: string; reason?: string; runId?: string }>;
}

export interface PublishSchedulerDeps {
  conceptStore: SchedulerConceptStore;
  likedStore: SchedulerLikedStore;
  publishLog: SchedulerPublishLog;
  /** retire-default-account：按真实账号解析风控（替代单租户全局 risk controller）。 */
  resolveRisk: (accountId: string) => Promise<SchedulerRisk>;
  /** 解析「唯一真实账号」：恰好一个真实账号则返回它，0 或多个返回 null（自动 / 无参发布据此 honest-fail，绝不回落 default）。 */
  resolveSingleAccountId: () => Promise<string | null>;
  /**
   * 人设绑定判定（persona-driven-content-pipeline）：注入则发布前闸——未绑人设的账号诚实拒绝，
   * 绝不以打包默认人设（回落 soul）生成内容。缺省（不注入）→ 不闸（向后兼容旧构造 / 测试桩）。
   */
  isPersonaBound?: (accountId: string) => boolean;
  orchestrator: SchedulerOrchestrator;
  /**
   * 人设注入（change account-persona-config）。两种形态，至少给一个：
   * - getSoul：构建发布输入时按目标账号解析（热加载，PUT 人设后即时生效）——生产路径；
   * - soul：构造期人设快照（向后兼容旧构造 / 测试桩）。两者皆给时 getSoul 优先。
   */
  soul?: Soul;
  getSoul?: (accountId?: string) => Soul;
  /** 精选灵感语料（change curated-inspiration-corpus）：发帖创作正向素材来源；缺则回落旧点赞素材。 */
  curatedStore?: SchedulerCuratedStore;
  /** 精选素材选取 Top-K（缺省 8）。 */
  selectTopK?: number;
  /** 概念积累阈值 N（缺省 20）。 */
  conceptThreshold?: number;
  /** 两次发布最小间隔小时（风控窗口扳机，缺省 24）。 */
  minHoursBetween?: number;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export type TriggerOutcome =
  // reason = 触发原因（manual_feishu / concept_threshold(...) / risk_window(...)）；
  // status = 编排终态（pending_approval/published/draft 正常，failed/timeout/skipped 非正常）；
  // failureReason = 编排非正常收敛时的可读原因（来自编排器，供飞书回执 surface「为什么」）。
  | { result: 'triggered'; reason: string; status: string; failureReason?: string }
  | { result: 'skipped'; reason: string }
  | { result: 'blocked'; reason: string };

export interface ManualTriggerOptions {
  referenceNote?: ReferenceNote;
}

const HOUR_MS = 3_600_000;

export class PublishScheduler {
  private readonly d: PublishSchedulerDeps;
  private readonly clock: () => number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly conceptThreshold: number;
  private readonly minHoursBetween: number;
  /** 无发布记录时的基准（进程启动时刻），避免把历史全量概念算成"新"。 */
  private readonly startedAt: number;
  /**
   * 发帖全局忙（change content-schedule-auto-publish）：任一 doTrigger（自动 / 手动 / 排期）进行中即 true。
   * 供 ContentScheduler 全局串行发帖——因 publishAccountRef 是全局可变槽，多账号并发发帖会污染 token 账号归属
   * （对抗评审阻断项）。**load-bearing 不变量：发帖必须全局串行**；禁止未来「按账号并行发帖」优化，除非先消灭全局槽。
   */
  private publishing = false;

  constructor(deps: PublishSchedulerDeps) {
    this.d = deps;
    this.clock = deps.clock ?? Date.now;
    this.logger = deps.logger ?? console;
    this.conceptThreshold = deps.conceptThreshold ?? 20;
    this.minHoursBetween = deps.minHoursBetween ?? 24;
    this.startedAt = this.clock();
  }

  /**
   * 解析目标账号人设（getSoul 取值口优先 → 兼容快照）。persona-driven-content-pipeline：取值口
   * 无默认人设回落——未绑人设账号已被 isPersonaBound 入口闸先行拒绝（needs_persona_setup）；
   * 若此后仍解析不到（如闸后被解绑），getSoul 抛 no_persona 诚实失败，绝不以默认人设生成。
   * soul / getSoul 两者皆缺则抛（构造契约违背，诚实失败不静默）。
   */
  private resolveSoul(accountId?: string): Soul {
    if (this.d.getSoul) return this.d.getSoul(accountId);
    if (this.d.soul) return this.d.soul;
    throw new Error('PublishScheduler 缺少人设注入（soul / getSoul 至少给一个）');
  }

  /** 基准时刻：上次发布时间，无则进程启动时刻。 */
  private async baselineMs(): Promise<number> {
    return (await this.d.publishLog.getMostRecentPublishTime()) ?? this.startedAt;
  }

  /** 聚合 TriggerInput（真概念 + 真点赞 + 最近已发 + 目标账号人设）。 */
  async buildTriggerInput(accountId: string): Promise<TriggerInput> {
    const baseline = await this.baselineMs();
    const selectTopK = this.d.selectTopK ?? 8;
    // 概念带来源笔记标题（change curated-inspiration-corpus）：有富方法用之，否则回落只取关键词。
    const conceptsPromise = this.d.conceptStore.getNewConceptsWithSourceSince
      ? this.d.conceptStore.getNewConceptsWithSourceSince(baseline)
      : this.d.conceptStore
          .getNewConceptsSince(baseline)
          .then((ks) => ks.map((keyword) => ({ keyword, sourceNote: null as string | null })));
    const [conceptsWithSource, liked, recentPublished, newConceptCount, materials, commentItems] = await Promise.all([
      conceptsPromise,
      this.d.likedStore.recentSince(baseline),
      this.d.publishLog.recentPublishedContents(5),
      this.d.conceptStore.countNewSince(baseline),
      this.d.curatedStore
        ? this.d.curatedStore.selectForCreation(accountId, 'source_post', selectTopK)
        : Promise.resolve([] as CuratedSelectItem[]),
      // 精选评论当「读者角度线索」（change curated-inspiration-corpus Phase 2）：少量、次级素材。
      this.d.curatedStore
        ? this.d.curatedStore.selectForCreation(accountId, 'comment', 3)
        : Promise.resolve([] as CuratedSelectItem[]),
    ]);
    const hoursSinceLastPublish = (this.clock() - baseline) / HOUR_MS;
    return {
      metrics: {
        hoursSinceLastPublish,
        newConceptCount,
        likedSinceLastPublish: liked.length,
      },
      generateInput: {
        concepts: conceptsWithSource.map((c) =>
          c.sourceNote ? { keyword: c.keyword, sourceNote: c.sourceNote } : { keyword: c.keyword },
        ),
        // likedContents 保留：供 PublishExecutor 回填 source_liked_ids 血缘（职责不变）。
        likedContents: liked.map((l) => ({ id: l.id, title: l.title, summary: l.summary, author: l.author ?? '' })),
        // materials：精选灵感语料 —— 发帖创作的正向素材来源（change curated-inspiration-corpus）。
        materials: materials.map((m) => ({
          sourceId: m.sourceId,
          title: m.title,
          body: m.body,
          author: m.author,
          topics: m.topics,
          likeCount: m.likeCount,
          collectCount: m.collectCount,
          botLiked: m.botLiked,
          botCollected: m.botCollected,
        })),
        // commentHints：精选评论 —— 读者角度线索（高赞/优质评论反哺写帖选题，change curated-inspiration-corpus Phase 2）。
        commentHints: commentItems.map((c) => ({ text: c.body, author: c.author, sourceNoteTitle: c.title })),
        soul: this.resolveSoul(accountId),
        recentPosts: recentPublished,
      },
      recentPublished,
      // 目标账号贯穿到落库（publish_log.account_id）与命令定向（retire-default-account：调用方已解析为真实账号，绝不 default）。
      accountId,
    };
  }

  /** 自动扳机检查（①概念积累 / ②风控窗口），由 server 定时调用。 */
  async checkAndMaybeTrigger(): Promise<TriggerOutcome> {
    // retire-default-account：自动扳机解析唯一真实账号；0 或多个则 honest-fail 跳过，绝不回落 default。
    const accountId = await this.d.resolveSingleAccountId();
    if (!accountId) {
      this.logger.warn('[PublishScheduler] 自动扳机：无法解析唯一真实账号（0 或多个）— 跳过，绝不回落 default');
      return { result: 'skipped', reason: 'no_single_account' };
    }
    if (this.d.isPersonaBound && !this.d.isPersonaBound(accountId)) {
      this.logger.warn(`[PublishScheduler] 自动扳机：账号 ${accountId} 未绑定人设 — 跳过，绝不以默认人设发布`);
      return { result: 'blocked', reason: 'needs_persona_setup' };
    }
    const baseline = await this.baselineMs();
    const newConceptCount = await this.d.conceptStore.countNewSince(baseline);
    const hoursSince = (this.clock() - baseline) / HOUR_MS;
    const risk = await this.d.resolveRisk(accountId);
    const status = risk.getState().status;

    const byConcept = newConceptCount >= this.conceptThreshold;
    const byWindow = hoursSince >= this.minHoursBetween && status === 'normal';
    if (!byConcept && !byWindow) {
      return { result: 'skipped', reason: `no_trigger(concepts=${newConceptCount}/${this.conceptThreshold}, hours=${hoursSince.toFixed(1)}/${this.minHoursBetween}, status=${status})` };
    }

    // 自动扳机必过风控闸：被拒诚实跳过，不触发（红线：不静默假发布）。
    if (!risk.canDo('publish')) {
      this.logger.warn(`[PublishScheduler] 自动扳机命中但风控拒绝(canDo=false, status=${status})，跳过不触发`);
      return { result: 'blocked', reason: `risk_denied(status=${status})` };
    }

    const reason = byConcept ? `concept_threshold(${newConceptCount})` : `risk_window(${hoursSince.toFixed(1)}h)`;
    const { status: triggeredStatus, failureReason } = await this.doTrigger(reason, false, accountId);
    return { result: 'triggered', reason, status: triggeredStatus, failureReason };
  }

  /**
   * 手动飞书 /publish [accountId]：越过 canDo（人工授权）+ 强制发布（不被 scout「无新素材」否决），但下游人审仍必过（AC-PUB）。
   * accountId 缺省回落 'default'（单账号向后兼容）；指定时以该账号人设生成、落库该账号、命令定向到该账号节点。
   * opts.referenceNote（change curated-note-actions）：管理后台精选页指定的洗稿参照笔记，注入创作输入独立参照块。
   */
  async triggerManual(accountId?: string, opts?: ManualTriggerOptions): Promise<TriggerOutcome> {
    // retire-default-account：账号显式优先，缺省解析唯一真实账号；解析不出（0 或多个）则诚实拒绝、要求显式指定，绝不回落 default。
    const resolved = accountId ?? (await this.d.resolveSingleAccountId());
    if (!resolved) {
      this.logger.warn('[PublishScheduler] 手动 /publish 未指定账号且无法解析唯一真实账号（0 或多个）— 拒绝，需显式指定账号');
      return { result: 'blocked', reason: 'account_required' };
    }
    if (this.d.isPersonaBound && !this.d.isPersonaBound(resolved)) {
      this.logger.warn(`[PublishScheduler] 手动 /publish：账号 ${resolved} 未绑定人设 — 拒绝，绝不以默认人设发布`);
      return { result: 'blocked', reason: 'needs_persona_setup' };
    }
    // 洗稿参照红线（change curated-note-actions）：空正文不得作参照，触发即诚实拒绝。
    if (opts?.referenceNote && !opts.referenceNote.body.trim()) {
      this.logger.warn(`[PublishScheduler] 参照创作：参照笔记正文为空 — 拒绝（empty_body）`);
      return { result: 'blocked', reason: 'empty_body' };
    }
    const reason = opts?.referenceNote ? 'manual_reference' : 'manual_feishu';
    this.logger.log(`[PublishScheduler] 手动发布 account=${resolved} reason=${reason}：越过风控 canDo + 强制发布（人工授权），发布前飞书人审仍生效`);
    const { status, failureReason } = await this.doTrigger(reason, true, resolved, opts?.referenceNote);
    return { result: 'triggered', reason, status, failureReason };
  }

  /**
   * 排期扳机（change content-schedule-auto-publish）：由 ContentScheduler 对显式账号触发。
   * 绕开 checkAndMaybeTrigger 的 resolveSingleAccountId 单账号闸（调度器直接给账号），但仍过
   * persona 绑定 + 风控 status===normal + canDo('publish') + 发布前人审（AC-PUB）。forced=false → ContentScout
   * 可诚实判「无新素材」而跳过（诚实空槽，非硬凑）。触发条件是「时段格 + 错峰命中」（由调度器判），不看概念阈值。
   */
  async triggerScheduled(accountId: string): Promise<TriggerOutcome> {
    if (this.d.isPersonaBound && !this.d.isPersonaBound(accountId)) {
      this.logger.warn(`[PublishScheduler] 排期扳机：账号 ${accountId} 未绑定人设 — 跳过，绝不以默认人设发布`);
      return { result: 'blocked', reason: 'needs_persona_setup' };
    }
    const risk = await this.d.resolveRisk(accountId);
    const status = risk.getState().status;
    if (status !== 'normal') {
      this.logger.warn(`[PublishScheduler] 排期扳机：账号 ${accountId} 风控非 normal(status=${status}) — 跳过`);
      return { result: 'blocked', reason: `risk_status(${status})` };
    }
    if (!risk.canDo('publish')) {
      this.logger.warn(`[PublishScheduler] 排期扳机：账号 ${accountId} 风控拒绝(canDo=false) — 跳过`);
      return { result: 'blocked', reason: `risk_denied(status=${status})` };
    }
    const { status: triggeredStatus, failureReason } = await this.doTrigger('scheduled_window', false, accountId);
    return { result: 'triggered', reason: 'scheduled_window', status: triggeredStatus, failureReason };
  }

  /** 发帖是否全局忙（供 ContentScheduler 全局串行）。任一 doTrigger 进行中即 true。 */
  isBusy(): boolean {
    return this.publishing;
  }

  private freezeReferenceSource(accountId: string, referenceNote: ReferenceNote): PublishSourceReference {
    if (referenceNote.sourceReference) return referenceNote.sourceReference;
    return {
      kind: 'curated_reference',
      curatedContentId: referenceNote.curatedContentId ?? null,
      accountId: referenceNote.accountId ?? accountId,
      sourceId: referenceNote.sourceId,
      title: referenceNote.title || null,
      body: referenceNote.body || null,
      author: referenceNote.author ?? null,
      topics: referenceNote.topics,
      sourceUrl: referenceNote.sourceUrl ?? null,
      capturedAt: referenceNote.capturedAt ?? this.clock(),
    };
  }

  private async doTrigger(
    reason: string,
    forced = false,
    accountId: string,
    referenceNote?: ReferenceNote,
  ): Promise<{ status: string; failureReason?: string }> {
    const base = await this.buildTriggerInput(accountId);
    const input: TriggerInput = referenceNote
      ? {
          ...base,
          forced,
          generateInput: {
            ...base.generateInput,
            // 参照正文有界截断（≤800 字）：控 prompt 规模，避免全文直灌。
            // 展示/审计快照保持触发时原文，避免内容页只能看到 prompt 截断片段。
            referenceNote: {
              ...referenceNote,
              accountId: referenceNote.accountId ?? accountId,
              capturedAt: referenceNote.capturedAt ?? this.clock(),
              body: referenceNote.body.slice(0, REFERENCE_BODY_MAX_LEN),
              sourceReference: this.freezeReferenceSource(accountId, referenceNote),
            },
          },
        }
      : { ...base, forced };
    this.logger.log(`[PublishScheduler] 触发发帖编排 reason=${reason} forced=${forced} account=${input.accountId} newConcepts=${input.metrics.newConceptCount} liked=${input.metrics.likedSinceLastPublish}`);
    this.publishing = true;
    try {
      const res = await this.d.orchestrator.trigger(input);
      return { status: res.status, failureReason: res.reason };
    } finally {
      this.publishing = false;
    }
  }
}
