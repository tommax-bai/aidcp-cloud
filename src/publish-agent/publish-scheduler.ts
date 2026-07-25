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

import type { PublishResult, PublishSourceReference, ReferenceImageSnapshot, TriggerInput } from '../kernel/publish-pipeline-types.js';
import type { Soul } from '../kernel/soul-types.js';
import type { CuratedContentTypeFilter, CuratedSelectItem } from '../kernel/curated-content-types.js';
import type { ContentScheduleApprovalMode } from '../kernel/content-schedule-mode.js';
import type { PersonaBinding } from '../kernel/persona-binding.js';
import { PERSONA_UNAVAILABLE_REASON } from '../config/mirror-stop-work.js';
import type { PlatformId } from '../kernel/platform-types.js';
import { referenceImagesForGeneration, REFERENCE_IMAGE_MAX_COUNT } from '../kernel/reference-image-guidance.js';
import { shanghaiDayStartMs } from '../time/shanghai-day.js';

/** 洗稿参照笔记（change curated-note-actions）：管理后台精选页人工指定，注入创作输入独立参照块。 */
export type ReferenceNote = NonNullable<TriggerInput['generateInput']['referenceNote']>;

/** 参照正文注入上限（字符）：保真改写需要足够上下文，同时防超长全文撑爆 prompt。 */
export const REFERENCE_BODY_MAX_LEN = 6000;
export { REFERENCE_IMAGE_MAX_COUNT };

export interface SchedulerConceptStore {
  countNewSince(sinceMs: number): Promise<number>;
  getNewConceptsSince(sinceMs: number, limit?: number): Promise<string[]>;
  /** change curated-inspiration-corpus：带来源笔记标题的概念（可选；缺省回落只取关键词）。 */
  getNewConceptsWithSourceSince?(sinceMs: number, limit?: number): Promise<Array<{ keyword: string; sourceNote: string | null }>>;
}
/** 精选灵感语料召回口（change curated-inspiration-corpus）。 */
export interface SchedulerCuratedStore {
  selectForCreation(
    accountId: string,
    contentType: CuratedContentTypeFilter,
    limit: number,
    opts?: { updatedSinceMs?: number },
  ): Promise<CuratedSelectItem[]>;
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
  explain(action: 'publish'): {
    allowed: boolean;
    reason?: string;
    quota?: { window: 'minute' | 'hour' | 'day'; used: number; limit: number };
  };
  getState(): { status: string; quotaLevel: string };
}
export type SchedulerApprovalCardResult = NonNullable<PublishResult['approvalCard']>;
export type SchedulerTriggerResult = {
  status: string;
  reason?: string;
  runId?: string;
  recordId?: number | null;
  approvalCard?: SchedulerApprovalCardResult;
};
export interface SchedulerOrchestrator {
  trigger(input: TriggerInput): Promise<SchedulerTriggerResult>;
}

/**
 * 把生成端口的**抛出物**归一为稳定可读的失败原因码。
 *
 * 进程内编排本体从不 reject——它把管线异常自收敛成 `status:'failed' + reason`。但拆进程后这个端口可能是
 * 跨服务 HTTP 客户端，传输层会 reject（结构化错误带 string `code`：`timeout` / `transport_error` /
 * `generation_timeout` / `unknown_correlation` …）。这里保码 + 保原文，`timeout` 归一成语义更明确的
 * `generation_timeout`（「这一轮生成超时了」，而非某个含糊的网络码）。
 */
export function describeGenerationFailure(err: unknown): string {
  const raw =
    err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : 'generation_error';
  const code = raw === 'timeout' ? 'generation_timeout' : raw;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return message ? `${code}:${message}` : code;
}

/** claim 拒绝原因（change parallel-rewrite-drafts）：同键在途 / 自主单飞 / 账号在途帽满 / 全局并发帽满。 */
export type ClaimRejectReason = 'duplicate_source' | 'already_running' | 'publish_capacity' | 'publish_busy';

/** console 洗稿同步触发结果：started=false 时 reason 供 HTTP 回执直译；started=true 时 outcome 在本轮收敛时 settle。 */
export type BeginRewriteResult =
  | { started: true; outcome: Promise<TriggerOutcome> }
  | { started: false; reason: ClaimRejectReason };

export interface PublishSchedulerDeps {
  conceptStore: SchedulerConceptStore;
  likedStore: SchedulerLikedStore;
  publishLog: SchedulerPublishLog;
  /**
   * 账号在途帽的 DB 待审计数口（change parallel-rewrite-drafts）：claim 前 await 取好、同步段内与在途
   * claim 数相加对帽（claim 数精确防并发穿透，DB 数允许轻微滞后）。缺省（测试桩）→ 只按 claim 数对帽。
   */
  countPendingForAccount?: (accountId: string) => Promise<number>;
  /** 每账号在途帽：生成中 claim + 落库待审之和（默认 20；覆盖全部触发入口，防排期小时格结构性击穿堆稿）。 */
  pendingCapPerAccount?: number;
  /** 全局并发生成帽（默认 3；保护 LLM/生图供应商——文本重试盲退避不识 429、生图零重试）。 */
  maxConcurrentRuns?: number;
  /** retire-default-account：按真实账号解析风控（替代单租户全局 risk controller）。 */
  resolveRisk: (accountId: string) => Promise<SchedulerRisk>;
  /** 解析「唯一真实账号」：恰好一个真实账号则返回它，0 或多个返回 null（自动 / 无参发布据此 honest-fail，绝不回落 default）。 */
  resolveSingleAccountId: () => Promise<string | null>;
  /** 账号平台事实源；缺省 xiaohongshu。 */
  getPlatform?: (accountId: string) => PlatformId | Promise<PlatformId>;
  /**
   * 人设绑定判定（persona-driven-content-pipeline）：注入则发布前闸——未绑人设的账号诚实拒绝，
   * 绝不以打包默认人设（回落 soul）生成内容。缺省（不注入）→ 不闸（向后兼容旧构造 / 测试桩）。
   *
   * **三态**（change config-mirror-cross-process-invalidation task 4.4）：
   * `unbound` → 保持既有 `needs_persona_setup`（非重试终态）；`unknown` → 独立的
   * `persona_unavailable`，由委托任务侧判为**可重试延后**，MUST NOT 落非重试终态。
   */
  personaBinding?: (accountId: string) => PersonaBinding;
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
  | { result: 'triggered'; reason: string; status: string; recordId?: number | null; failureReason?: string; approvalCard?: SchedulerApprovalCardResult }
  | { result: 'skipped'; reason: string }
  | { result: 'blocked'; reason: string };

export interface ManualTriggerOptions {
  referenceNote?: ReferenceNote;
  /** Feishu conversation that triggered manual publish; approval card should prefer it. */
  manualApprovalChatId?: string;
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
   * 键控 claim 注册表（change parallel-rewrite-drafts，取代原 publishing 全局布尔）。
   * **load-bearing 不变量（重写）**：归账已逐调用显式（全局槽已消灭），全局串行的旧理由不复存在；新不变量：
   * ① 洗稿按 (accountId, sourceId) 单飞、跨参照稿可并行（含同账号）；② 自主创作按账号单飞（输入确定性、
   * 并发必相似）；③ claim 的检查与置位在零 await 同步段完成（tryClaim）、释放在覆盖 buildTriggerInput
   * 全程的 finally（任何 DB 瞬错不得让键永久卡死）。键：rewrite:<accountId>:<sourceId> / auto:<accountId>。
   */
  private readonly claims = new Map<string, { kind: 'rewrite' | 'autonomous'; accountId: string; startedAt: number }>();
  private readonly pendingCapPerAccount: number;
  private readonly maxConcurrentRuns: number;

  constructor(deps: PublishSchedulerDeps) {
    this.d = deps;
    this.clock = deps.clock ?? Date.now;
    this.logger = deps.logger ?? console;
    this.conceptThreshold = deps.conceptThreshold ?? 20;
    this.minHoursBetween = deps.minHoursBetween ?? 24;
    this.pendingCapPerAccount = Math.max(1, deps.pendingCapPerAccount ?? 20);
    this.maxConcurrentRuns = Math.max(1, deps.maxConcurrentRuns ?? 3);
    this.startedAt = this.clock();
  }

  /**
   * 同步原子 claim：检查（同键 / 全局帽 / 账号在途帽）与置位之间零 await——关掉旧 publishing 迟置位的
   * TOCTOU。账号帽 = 在途 claim 数（精确）+ 调用方预取的 DB 待审数（允许轻微滞后）。
   */
  private tryClaim(
    key: string,
    kind: 'rewrite' | 'autonomous',
    accountId: string,
    dbPendingCount: number,
  ): { ok: true } | { ok: false; reason: ClaimRejectReason } {
    if (this.claims.has(key)) return { ok: false, reason: kind === 'rewrite' ? 'duplicate_source' : 'already_running' };
    let accountInFlight = 0;
    for (const c of this.claims.values()) if (c.accountId === accountId) accountInFlight++;
    if (accountInFlight + dbPendingCount >= this.pendingCapPerAccount) return { ok: false, reason: 'publish_capacity' };
    if (this.claims.size >= this.maxConcurrentRuns) return { ok: false, reason: 'publish_busy' };
    this.claims.set(key, { kind, accountId, startedAt: this.clock() });
    return { ok: true };
  }

  /** 账号在途帽的 DB 待审计数（claim 前预取；未注入=0，只按 claim 数对帽）。 */
  private async dbPendingCount(accountId: string): Promise<number> {
    if (!this.d.countPendingForAccount) return 0;
    return this.d.countPendingForAccount(accountId);
  }

  /**
   * 人设入口闸（**三态**，change config-mirror-cross-process-invalidation task 4.4）。
   * 返回 null = 放行；返回 TriggerOutcome = 拒绝，且两种拒绝的原因码严格可区分：
   *
   * - `needs_persona_setup`：权威确认该账号**确实**没有人设行 → 既有的非重试终态，行为零回归。
   * - `persona_unavailable`：人设副本陈旧、云端读不到 → 委托任务侧 MUST 判**可重试延后**。
   *   把它压回 `needs_persona_setup` 会把用户的委托任务**永久判死**，并回一句「该账号未配置人设」
   *   ——而账号可能早已配好，只是云端此刻读不到。
   */
  private personaGate(accountId: string, where: string): TriggerOutcome | null {
    const binding = this.d.personaBinding?.(accountId) ?? 'bound';
    if (binding === 'bound') return null;
    if (binding === 'unbound') {
      this.logger.warn(`[PublishScheduler] ${where}：账号 ${accountId} 未绑定人设 — 拒绝，绝不以默认人设发布`);
      return { result: 'blocked', reason: 'needs_persona_setup' };
    }
    this.logger.warn(
      `[PublishScheduler] ${where}：账号 ${accountId} 人设副本陈旧 — 拒绝（${PERSONA_UNAVAILABLE_REASON}），可重试，绝不判成「未配置人设」`,
    );
    return { result: 'blocked', reason: PERSONA_UNAVAILABLE_REASON };
  }

  /**
   * 解析目标账号人设（getSoul 取值口优先 → 兼容快照）。persona-driven-content-pipeline：取值口
   * 无默认人设回落——未绑人设账号已被人设入口闸先行拒绝（needs_persona_setup）；
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
  async buildTriggerInput(accountId: string, opts?: { inspirationSinceMs?: number }): Promise<TriggerInput> {
    const baseline = Math.max(await this.baselineMs(), opts?.inspirationSinceMs ?? Number.NEGATIVE_INFINITY);
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
        ? this.d.curatedStore.selectForCreation(accountId, 'source_post', selectTopK,
            opts?.inspirationSinceMs === undefined ? undefined : { updatedSinceMs: opts.inspirationSinceMs })
        : Promise.resolve([] as CuratedSelectItem[]),
      // 精选评论当「读者角度线索」（change curated-inspiration-corpus Phase 2）：少量、次级素材。
      this.d.curatedStore
        ? this.d.curatedStore.selectForCreation(accountId, 'comment', 3,
            opts?.inspirationSinceMs === undefined ? undefined : { updatedSinceMs: opts.inspirationSinceMs })
        : Promise.resolve([] as CuratedSelectItem[]),
    ]);
    const platform = this.d.getPlatform ? await this.d.getPlatform(accountId) : 'xiaohongshu';
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
      platform,
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
    const autoBinding = this.personaGate(accountId, '自动扳机');
    if (autoBinding) return autoBinding;
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
    const { status: triggeredStatus, recordId, failureReason, approvalCard } = await this.doTrigger(reason, false, accountId);
    return { result: 'triggered', reason, status: triggeredStatus, recordId, failureReason, approvalCard };
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
    const manualBinding = this.personaGate(resolved, '手动 /publish');
    if (manualBinding) return manualBinding;
    // 洗稿参照红线（change curated-note-actions）：空正文不得作参照，触发即诚实拒绝。
    if (opts?.referenceNote && !opts.referenceNote.body.trim()) {
      this.logger.warn(`[PublishScheduler] 参照创作：参照笔记正文为空 — 拒绝（empty_body）`);
      return { result: 'blocked', reason: 'empty_body' };
    }
    const reason = opts?.referenceNote ? 'manual_reference' : 'manual_feishu';
    this.logger.log(`[PublishScheduler] 手动发布 account=${resolved} reason=${reason}：越过风控 canDo + 强制发布（人工授权），发布前飞书人审仍生效`);
    const { status, recordId, failureReason, approvalCard } = await this.doTrigger(reason, true, resolved, opts?.referenceNote, opts?.manualApprovalChatId);
    return { result: 'triggered', reason, status, recordId, failureReason, approvalCard };
  }

  /**
   * 排期扳机（change content-schedule-auto-publish）：由 ContentScheduler 对显式账号触发。
   * 绕开 checkAndMaybeTrigger 的 resolveSingleAccountId 单账号闸（调度器直接给账号），但仍过
   * persona 绑定 + 风控 status===normal + canDo('publish') + 发布前人审（AC-PUB）。forced=false → ContentScout
   * 可诚实判「无新素材」而跳过（诚实空槽，非硬凑）。触发条件是「时段格 + 错峰命中」（由调度器判），不看概念阈值。
   */
  async triggerScheduled(
    accountId: string,
    approvalMode: ContentScheduleApprovalMode,
    scheduleExecution: NonNullable<TriggerInput['scheduleExecution']>,
  ): Promise<TriggerOutcome> {
    const scheduledBinding = this.personaGate(accountId, '排期扳机');
    if (scheduledBinding) return scheduledBinding;
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
    const { status: triggeredStatus, recordId, failureReason, approvalCard } = await this.doTrigger(
      'scheduled_window',
      false,
      accountId,
      undefined,
      undefined,
      approvalMode,
      undefined,
      undefined,
      scheduleExecution,
    );
    return { result: 'triggered', reason: 'scheduled_window', status: triggeredStatus, recordId, failureReason, approvalCard };
  }

  /**
   * User-delegated publish. 默认 governed：受管路径，非 normal / canDo 拒发时诚实 blocked（自然语言目标、
   * 结构化 edge/console/api 草稿走这条，风控闸不放）。
   * operatorOverride=true（仅 executor 白名单认定的操作员主动单次指令）：越过风控 status/canDo，等价老 triggerManual——
   * 但**发布前飞书人审（AC-PUB）仍强制**，越权只越风控/配额、绝不越人审。scope 由调用方（executor）限定为
   * 精确 slash 或服务端可信人工精选洗稿，绝不扩到自然语言 / 通用结构化发帖。
   * Pending approval is a persisted candidate, not a verified platform publish.
   */
  async triggerDelegated(
    accountId: string,
    opts: {
      action: 'publish_post' | 'publish_from_inspiration' | 'generate_candidates';
      approvalMode?: NonNullable<TriggerInput['approvalMode']>;
      referenceNote?: ReferenceNote;
      /**
       * change restore-delegated-command-card-origin-chat：命令来源会话 → 审批卡目标（manual_source）。
       * 缺省（自动 / 无来源会话）→ 审批卡回落默认审批群，既有行为逐字不变。
       */
      manualApprovalChatId?: string;
      /** 操作员主动单次指令置 true：越风控/配额但保人审；普通结构化任务不得置位。 */
      operatorOverride?: boolean;
      /** 精确手工 /publish 才可置 human；与配额 override 分离，避免可信自动洗稿被抬档。 */
      edgeLeasePriority?: 'human';
    },
  ): Promise<TriggerOutcome> {
    const referenceBinding = this.personaGate(accountId, '参照创作');
    if (referenceBinding) return referenceBinding;
    const risk = await this.d.resolveRisk(accountId);
    const state = risk.getState();
    const status = state.status;
    const tier = state.quotaLevel;
    if (opts.operatorOverride) {
      this.logger.log(`[PublishScheduler] 委托手动发布 account=${accountId}：越过风控 canDo（操作员主动授权），发布前飞书人审仍生效`);
    } else {
      if (status !== 'normal') {
        return { result: 'blocked', reason: `risk_status(status=${status},tier=${tier})` };
      }
      const decision = risk.explain('publish');
      if (!decision.allowed) {
        const detail = decision.quota
          ? `cause=quota:${decision.quota.window},used=${decision.quota.used},limit=${decision.quota.limit}`
          : `cause=${decision.reason ?? 'unknown'}`;
        return { result: 'blocked', reason: `risk_denied(status=${status},tier=${tier},${detail})` };
      }
    }
    const reason = `delegated_${opts.action}`;
    const inspirationSinceMs = opts.action === 'publish_from_inspiration' ? shanghaiDayStartMs(this.clock()) : undefined;
    const out = await this.doTrigger(
      reason,
      true,
      accountId,
      opts.referenceNote,
      opts.manualApprovalChatId,
      opts.approvalMode ?? 'review',
      inspirationSinceMs,
      opts.edgeLeasePriority,
    );
    return {
      result: 'triggered',
      reason,
      status: out.status,
      recordId: out.recordId,
      failureReason: out.failureReason,
      approvalCard: out.approvalCard,
    };
  }

  /**
   * 自主忙判定（change parallel-rewrite-drafts：语义收窄）：仅计**自主创作轮**在跑——洗稿在途不再让
   * 排期槽（原让位动机=防槽污染，槽已消灭；放任让位会让活跃客户账号被持续饿槽）。
   * 带 accountId = 该账号自主轮在跑；缺省 = 任一账号自主轮在跑（旧单账号调用面兼容）。
   */
  isBusy(accountId?: string): boolean {
    for (const c of this.claims.values()) {
      if (c.kind !== 'autonomous') continue;
      if (!accountId || c.accountId === accountId) return true;
    }
    return false;
  }

  /**
   * console 洗稿同步触发入口（change parallel-rewrite-drafts）：同步 claim（零 await 原子段），
   * 失败即回稳定原因码（HTTP 回执可见，绝不落到只有飞书卡才知道）；成功即内部发起异步管线并返回
   * outcome——调用方把既有 fire-and-forget 结果卡链挂在 outcome 上（skipped/failed 有人补卡）。
   * dbPendingCount 由调用方在预检段 await 预取后传入（保持本方法同步）。
   * 前置校验（persona / 空正文）由调用方入口闸负责——本方法只管并发准入与执行。
   */
  tryBeginRewrite(
    accountId: string,
    referenceNote: ReferenceNote,
    opts?: { manualApprovalChatId?: string; dbPendingCount?: number },
  ): BeginRewriteResult {
    const key = `rewrite:${accountId}:${referenceNote.sourceId}`;
    const claim = this.tryClaim(key, 'rewrite', accountId, opts?.dbPendingCount ?? 0);
    if (!claim.ok) {
      this.logger.warn(`[PublishScheduler] 洗稿触发被拒 account=${accountId} source=${referenceNote.sourceId} reason=${claim.reason}`);
      return { started: false, reason: claim.reason };
    }
    this.logger.log(`[PublishScheduler] 洗稿并行触发 account=${accountId} source=${referenceNote.sourceId}（在途 claim ${this.claims.size}/${this.maxConcurrentRuns}）`);
    const outcome = (async (): Promise<TriggerOutcome> => {
      const { status, recordId, failureReason, approvalCard } = await this.runClaimed(
        key,
        'manual_reference',
        true,
        accountId,
        referenceNote,
        opts?.manualApprovalChatId,
      );
      return { result: 'triggered', reason: 'manual_reference', status, recordId, failureReason, approvalCard };
    })();
    return { started: true, outcome };
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

  private prepareReferenceImages(referenceNote: ReferenceNote): ReferenceImageSnapshot[] {
    return referenceImagesForGeneration(referenceNote.images ?? []);
  }

  /**
   * 统一触发漏斗（自动 / 手动飞书 / 排期 / 手动参照）：预取 DB 待审数 → 同步 claim → 执行。
   * claim 被拒 → 诚实 skipped + 稳定原因（飞书黄卡照旧显示「已有一轮…」语义；洗稿键被拒=同源在途）。
   */
  private async doTrigger(
    reason: string,
    forced = false,
    accountId: string,
    referenceNote?: ReferenceNote,
    manualApprovalChatId?: string,
    approvalMode?: NonNullable<TriggerInput['approvalMode']>,
    inspirationSinceMs?: number,
    edgeLeasePriority?: 'human',
    scheduleExecution?: NonNullable<TriggerInput['scheduleExecution']>,
  ): Promise<{ status: string; recordId?: number | null; failureReason?: string; approvalCard?: SchedulerApprovalCardResult }> {
    const dbPending = await this.dbPendingCount(accountId);
    const kind = referenceNote ? ('rewrite' as const) : ('autonomous' as const);
    const key = referenceNote ? `rewrite:${accountId}:${referenceNote.sourceId}` : `auto:${accountId}`;
    const claim = this.tryClaim(key, kind, accountId, dbPending);
    if (!claim.ok) {
      const text =
        claim.reason === 'already_running'
          ? '已有一轮发帖编排在运行中，本次未触发'
          : claim.reason === 'duplicate_source'
            ? '该参照稿已有一轮生成在途，本次未触发'
            : claim.reason === 'publish_capacity'
              ? '该账号在途待审草稿已达上限，本次未触发'
              : '生成并发已满，本次未触发';
      this.logger.warn(`[PublishScheduler] 触发被 claim 拒绝 account=${accountId} key=${key} reason=${claim.reason}`);
      return { status: 'skipped', failureReason: `${text}（${claim.reason}）` };
    }
    return this.runClaimed(
      key,
      reason,
      forced,
      accountId,
      referenceNote,
      manualApprovalChatId,
      approvalMode,
      inspirationSinceMs,
      edgeLeasePriority,
      scheduleExecution,
    );
  }

  /** claim 已持有的执行段：finally 覆盖含 buildTriggerInput 在内全程释放键（DB 瞬错不卡键）。 */
  private async runClaimed(
    key: string,
    reason: string,
    forced: boolean,
    accountId: string,
    referenceNote?: ReferenceNote,
    manualApprovalChatId?: string,
    approvalMode?: NonNullable<TriggerInput['approvalMode']>,
    inspirationSinceMs?: number,
    edgeLeasePriority?: 'human',
    scheduleExecution?: NonNullable<TriggerInput['scheduleExecution']>,
  ): Promise<{ status: string; recordId?: number | null; failureReason?: string; approvalCard?: SchedulerApprovalCardResult }> {
    try {
    const base = await this.buildTriggerInput(accountId, { inspirationSinceMs });
    if (inspirationSinceMs !== undefined) {
      const hasTodayInspiration =
        base.generateInput.concepts.length > 0 ||
        base.generateInput.likedContents.length > 0 ||
        (base.generateInput.materials?.length ?? 0) > 0 ||
        (base.generateInput.commentHints?.length ?? 0) > 0;
      if (!hasTodayInspiration) {
        return { status: 'skipped', failureReason: 'today_inspiration_unavailable' };
      }
    }
    const referenceImages = referenceNote ? this.prepareReferenceImages(referenceNote) : [];
    let referenceNoteWithoutImages: Omit<ReferenceNote, 'images'> | undefined;
    if (referenceNote) {
      const { images: _rawReferenceImages, ...rest } = referenceNote;
      referenceNoteWithoutImages = rest;
    }
    const input: TriggerInput = referenceNote
      ? {
          ...base,
          forced,
          generateInput: {
            ...base.generateInput,
            // 参照正文有界截断：保真改写需要足够上下文；展示/审计快照保持触发时原文。
            referenceNote: {
              ...referenceNoteWithoutImages!,
              accountId: referenceNote.accountId ?? accountId,
              capturedAt: referenceNote.capturedAt ?? this.clock(),
              body: referenceNote.body.slice(0, REFERENCE_BODY_MAX_LEN),
              sourceReference: this.freezeReferenceSource(accountId, referenceNote),
              ...(referenceImages.length > 0 ? { images: referenceImages } : {}),
            },
          },
        }
      : { ...base, forced };
    if (manualApprovalChatId?.trim()) {
      input.manualApprovalChatId = manualApprovalChatId.trim();
    }
    if (approvalMode) {
      input.approvalMode = approvalMode;
    }
    if (edgeLeasePriority === 'human') {
      input.edgeLeasePriority = 'human';
    }
    if (scheduleExecution) {
      input.scheduleExecution = { ...scheduleExecution };
    }
    this.logger.log(`[PublishScheduler] 触发发帖编排 reason=${reason} forced=${forced} account=${input.accountId} newConcepts=${input.metrics.newConceptCount} liked=${input.metrics.likedSinceLastPublish}`);
    let res: SchedulerTriggerResult;
    try {
      res = await this.d.orchestrator.trigger(input);
    } catch (err) {
      // 生成端口的**传输层失败**（拆进程后端口可能是跨服务 HTTP 客户端：单次调用超时 / 连接断 /
      // 未知 correlation）。本进程内的编排从不走到这里（它自收敛成 status:'failed'）。
      // 归一到同一条诚实终态，红线两头都不许踩：
      //   · 绝不静默假成功——不回 pending_approval / published，也不压成 skipped 让上层当「本槽没事发生」；
      //   · 也绝不让 reject 穿透调用链——洗稿 fire-and-forget 链等路径上没有兜底 catch，
      //     未捕获拒绝会打崩整个云端进程。
      const detail = describeGenerationFailure(err);
      this.logger.error(
        `[PublishScheduler] 生成端口调用失败 account=${input.accountId} reason=${reason} detail=${detail}`,
      );
      return { status: 'failed', recordId: null, failureReason: detail };
    }
    return { status: res.status, recordId: res.recordId, failureReason: res.reason, approvalCard: res.approvalCard };
    } finally {
      // 释放 claim：finally 覆盖 buildTriggerInput + 编排全程——任何 DB 瞬错/管线异常都不得让键永久卡死。
      this.claims.delete(key);
    }
  }
}
