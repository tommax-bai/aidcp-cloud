import type { PanelPublish } from './panel-store.js';

export const PUBLISH_STAGE_KEYS = [
  'source',
  'content',
  'text_quality',
  'visual_plan',
  'image_review',
  'package',
  'approval',
  'dispatch',
] as const;

export type PublishStageKey = (typeof PUBLISH_STAGE_KEYS)[number];
export type PublishStageState =
  | 'pending'
  | 'running'
  | 'retrying'
  | 'waiting_human'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'skipped';

export interface PublishStageView {
  key: PublishStageKey;
  label: string;
  state: PublishStageState;
  summary: string;
  facts: string[];
  progress?: { current: number; total: number };
}

export type PublishJourneyStatus =
  | 'generating'
  | 'waiting_approval'
  | 'dispatching'
  | 'scheduled'
  | 'published'
  | 'submitted'
  | 'failed'
  | 'rejected'
  | 'draft'
  | 'skipped';

/**
 * 授权的下发进度（change publish-approval-signal-to-database，task 4.5 / 4.6）。
 *
 * 它来自**持久授权记录**，不是进程内在途集合——进程重启或执行侧不可达时，「已批准·待下发」
 * 这个区分必须依然成立。这正是本 change 要消灭的那种静默停滞：运营点了通过、界面却和「还没人批」
 * 长得一模一样。
 */
export interface ApprovalDispatchProjection {
  approved: boolean;
  dispatchState: 'pending_dispatch' | 'dispatching' | 'consumed' | 'void';
  dispatchBlockedReason: string | null;
  decidedAt: number;
}

/** 阻塞原因 → 运营看得懂的中文（未知原因原样透出，绝不吞成「无」）。 */
const DISPATCH_BLOCKED_LABELS: Record<string, string> = {
  edge_offline_waiting: '客户端核心离线，等待恢复',
  browser_slot_waiting: '浏览器在等本机可用槽位',
  breaker_open: '该账号下发熔断中，待人工确认',
  captcha_paused: '账号处于验证码/风控暂停',
  approval_unreadable: '授权状态暂不可读（不下发、不烧稿）',
};

export function describeDispatchBlockedReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return DISPATCH_BLOCKED_LABELS[reason] ?? reason;
}

export interface PublishJourneyView {
  journeyId: string;
  runId: string | null;
  recordId: number | null;
  accountId: string;
  title: string;
  sourceTitle: string | null;
  kind: 'rewrite' | 'autonomous' | 'persisted';
  startedAt: number;
  active: boolean;
  status: PublishJourneyStatus;
  statusSummary: string;
  stages: PublishStageView[];
  snapshot: unknown | null;
  /**
   * 授权下发进度增量字段（缺省 = 服务端尚未接线 / 该稿无活跃授权）。前端 MUST 在缺省时回落既有呈现，
   * MUST NOT 白屏或报错（console ↔ cloud 枚举漂移纪律）。
   */
  dispatchState?: 'pending_dispatch' | 'dispatching' | 'consumed' | 'void';
  dispatchBlockedReason?: string | null;
  decidedAt?: number;
  /** 自决策起已等待的毫秒数（只在尚未下发完成时有意义）。 */
  waitingMs?: number;
}

export interface PublishLifecycleProjection {
  status: 'idle' | 'running' | 'waiting_human';
  active: PublishJourneyView[];
  recent: PublishJourneyView[];
}

export interface QueueRunLike {
  runId: string;
  accountId: string;
  kind: 'rewrite' | 'autonomous';
  sourceId: string | null;
  startedAt: number;
  status: string;
  snapshot: unknown;
}

export interface QueueStatusLike {
  status: string;
  snapshot: unknown | null;
  runs?: QueueRunLike[];
}

const STAGE_LABELS: Record<PublishStageKey, string> = {
  source: '触发与选题',
  content: '正文生成',
  text_quality: '文本质检',
  visual_plan: '视觉策划',
  image_review: '出图复核',
  package: '成稿封装',
  approval: '人工审批',
  dispatch: '平台下发',
};

const ROLE_STAGE: Record<string, PublishStageKey> = {
  ContentScout: 'source',
  ReferenceAnalyzer: 'content',
  FaithfulRewritePlanner: 'content',
  FaithfulDraftWriter: 'content',
  ContentCreator: 'content',
  FidelityAuditor: 'text_quality',
  ContentCleaner: 'text_quality',
  AiFlavorScorer: 'text_quality',
  QualityScorer: 'text_quality',
  CategoryClassifier: 'visual_plan',
  VisualReferenceAnalyzer: 'visual_plan',
  ImageSetPlanner: 'visual_plan',
  CoverCardWriter: 'visual_plan',
  ImagePromptComposer: 'visual_plan',
  ImageGenerator: 'image_review',
  ContentAssembler: 'package',
  TitleCreator: 'package',
  TopicGenerator: 'package',
  TopicEvaluator: 'package',
  MetadataAggregator: 'package',
  ApprovalGatekeeper: 'package',
  PublishExecutor: 'package',
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function present(snapshot: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(snapshot, key) && snapshot[key] != null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nested(snapshot: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return record(snapshot[key]);
}

function referenceNote(snapshot: Record<string, unknown>): Record<string, unknown> | null {
  return record(record(record(snapshot.trigger)?.generateInput)?.referenceNote);
}

function draftTitle(snapshot: Record<string, unknown>): string {
  const source = referenceNote(snapshot);
  return text(nested(snapshot, 'titleSelection')?.title)
    ?? text(nested(snapshot, 'faithfulDraft')?.title)
    ?? text(nested(snapshot, 'createdContent')?.title)
    ?? text(source?.title)
    ?? '进行中稿件';
}

function sourceTitle(snapshot: Record<string, unknown>): string | null {
  return text(referenceNote(snapshot)?.title);
}

function stage(
  key: PublishStageKey,
  state: PublishStageState,
  summary: string,
  facts: string[] = [],
  progress?: { current: number; total: number },
): PublishStageView {
  return { key, label: STAGE_LABELS[key], state, summary, facts, ...(progress ? { progress } : {}) };
}

function contentLength(snapshot: Record<string, unknown>): number | null {
  const value = text(nested(snapshot, 'faithfulDraft')?.content) ?? text(nested(snapshot, 'createdContent')?.content);
  return value?.length ?? null;
}

function imageFacts(snapshot: Record<string, unknown>): { planned: number | null; generated: number | null; attempts: number | null } {
  const imageSetPlan = nested(snapshot, 'imageSetPlan');
  const imagePlan = nested(snapshot, 'imagePlan');
  const directive = nested(snapshot, 'imageDirective');
  const urls = directive?.imageUrls;
  const audit = record(directive?.visualReferenceAudit);
  const slots = Array.isArray(audit?.slots) ? audit.slots : [];
  const attempts = slots.reduce((sum, item) => {
    const slot = record(item);
    return sum + (Array.isArray(slot?.attempts) ? slot.attempts.length : 0);
  }, 0);
  return {
    planned: number(imagePlan?.imageCount) ?? number(imageSetPlan?.imageCount),
    generated: Array.isArray(urls) ? urls.length : null,
    attempts: attempts > 0 ? attempts : null,
  };
}

function runStages(snapshot: Record<string, unknown>, status: string): PublishStageView[] {
  const scout = nested(snapshot, 'scoutDecision');
  const shouldPublish = typeof scout?.shouldPublish === 'boolean' ? scout.shouldPublish : null;
  const sourceDone = present(snapshot, 'scoutDecision');
  const contentDone = present(snapshot, 'faithfulDraft') || present(snapshot, 'createdContent');
  const textDone = ['cleanedContent', 'aiFlavorScore', 'qualityReport'].every((key) => present(snapshot, key));
  const visualDone = ['postCategory', 'imageSetPlan', 'imagePlan'].every((key) => present(snapshot, key));
  const imageDone = present(snapshot, 'imageDirective');
  const packageDone = ['assembledContent', 'titleSelection', 'publishMetadata', 'gateDecision', 'publishResult']
    .every((key) => present(snapshot, key));
  const images = imageFacts(snapshot);
  const quality = nested(snapshot, 'qualityReport');
  const aiFlavor = nested(snapshot, 'aiFlavorScore');
  const retrySignal = nested(snapshot, 'retrySignal');
  const result = nested(snapshot, 'publishResult');

  if (sourceDone && shouldPublish === false) {
    return [
      stage('source', 'completed', text(scout?.reason) ?? '选题判定不发布'),
      ...PUBLISH_STAGE_KEYS.slice(1).map((key) => stage(key, 'skipped', '本轮已在选题阶段结束')),
    ];
  }

  const stages: PublishStageView[] = [
    stage('source', sourceDone ? 'completed' : 'running', sourceDone ? '触发已接收，选题判断完成' : '正在判断是否进入发布链'),
    stage(
      'content',
      contentDone ? 'completed' : sourceDone ? 'running' : 'pending',
      contentDone ? '正文草稿已产出' : sourceDone ? '正在生成正文草稿' : '等待选题判断',
      [contentLength(snapshot) != null ? `正文 ${contentLength(snapshot)} 字` : null].filter((v): v is string => Boolean(v)),
    ),
    stage(
      'text_quality',
      textDone ? 'completed' : retrySignal ? 'retrying' : contentDone ? 'running' : 'pending',
      textDone
        ? '清洗、质量与 AI 味检查已收敛'
        : retrySignal
          ? text(retrySignal.reason) ?? '文本质检正在重试'
          : contentDone
            ? '正在并行执行文本质检'
            : '等待正文',
      [
        number(quality?.qualityScore) != null ? `质量 ${number(quality?.qualityScore)}` : null,
        number(aiFlavor?.aiScore) != null ? `AI 味 ${number(aiFlavor?.aiScore)}` : null,
      ].filter((v): v is string => Boolean(v)),
    ),
    stage(
      'visual_plan',
      visualDone ? 'completed' : contentDone ? 'running' : 'pending',
      visualDone ? '配图品类与整组计划已确定' : contentDone ? '正在并行规划配图' : '等待正文',
      [images.planned != null ? `计划 ${images.planned} 张` : null].filter((v): v is string => Boolean(v)),
    ),
    stage(
      'image_review',
      imageDone ? 'completed' : visualDone ? 'running' : 'pending',
      imageDone ? '出图与视觉复核已收敛' : visualDone ? '正在生成并复核图片' : '等待视觉策划',
      [
        images.generated != null ? `有效图片 ${images.generated} 张` : null,
        images.attempts != null ? `审计尝试 ${images.attempts} 次` : null,
      ].filter((v): v is string => Boolean(v)),
      images.generated != null && images.planned != null ? { current: images.generated, total: images.planned } : undefined,
    ),
    stage(
      'package',
      packageDone ? 'completed' : textDone && imageDone ? 'running' : 'pending',
      packageDone ? '终稿、元数据与审批记录已封装' : textDone && imageDone ? '正在封装最终发布稿' : '等待文本与图片分支',
      [
        number(result?.recordId) != null ? `记录 #${number(result?.recordId)}` : null,
        text(result?.status) ? `结果 ${text(result?.status)}` : null,
      ].filter((v): v is string => Boolean(v)),
    ),
    stage('approval', 'pending', '等待成稿落库'),
    stage('dispatch', 'pending', '等待人工审批'),
  ];

  const abort = nested(snapshot, 'pipelineAbort');
  const failed = status === 'failed' || status === 'timeout' || abort !== null;
  if (failed) {
    const failedKey = ROLE_STAGE[text(abort?.role) ?? '']
      ?? stages.find((item) => item.state === 'running')?.key
      ?? 'package';
    const failedIndex = stages.findIndex((item) => item.key === failedKey);
    stages[failedIndex] = stage(failedKey, 'failed', text(abort?.reason) ?? '本阶段执行失败');
    for (let index = failedIndex + 1; index < stages.length; index += 1) {
      if (stages[index].state !== 'completed') {
        stages[index] = stage(stages[index].key, 'pending', '上游失败，未执行');
      }
    }
  }
  return stages;
}

function resultRecordId(snapshot: unknown): number | null {
  const value = number(record(record(snapshot)?.publishResult)?.recordId);
  return value == null ? null : value;
}

function journeyFromRun(run: QueueRunLike, active: boolean): PublishJourneyView {
  const snapshot = record(run.snapshot) ?? {};
  const stages = runStages(snapshot, run.status);
  const result = nested(snapshot, 'publishResult');
  const resultStatus = text(result?.status);
  const isFailed = stages.some((item) => item.state === 'failed') || run.status === 'failed' || run.status === 'timeout';
  const isSkipped = resultStatus === 'skipped' || nested(snapshot, 'scoutDecision')?.shouldPublish === false;
  return {
    journeyId: `run:${run.runId}`,
    runId: run.runId,
    recordId: resultRecordId(snapshot),
    accountId: run.accountId,
    title: draftTitle(snapshot),
    sourceTitle: sourceTitle(snapshot),
    kind: run.kind,
    startedAt: run.startedAt,
    active,
    status: isFailed ? 'failed' : isSkipped ? 'skipped' : 'generating',
    statusSummary: isFailed ? '生成链路失败，未进入平台发布' : isSkipped ? '选题判定结束，本轮未发布' : '正在生成候审稿',
    stages,
    snapshot,
  };
}

function persistedStages(
  row: PanelPublish,
  approvedForDispatch: boolean,
  dispatch: ApprovalDispatchProjection | null,
  snapshot: Record<string, unknown> | null,
  now: number,
): PublishStageView[] {
  const generated = row.images.length;
  const base = snapshot
    ? runStages(snapshot, 'completed').slice(0, 6).map((item) => ({ ...item, state: 'completed' as const }))
    : [
        stage('source', 'completed', '发布记录已落库'),
        stage('content', 'completed', '正文已落库', row.content ? [`正文 ${row.content.length} 字`] : []),
        stage('text_quality', 'completed', '文本已通过生成链路收口'),
        stage('visual_plan', 'completed', '视觉方案已写入终稿'),
        stage('image_review', 'completed', '图片结果已写入终稿', [`有效图片 ${generated} 张`], { current: generated, total: generated }),
        stage('package', 'completed', '终稿已落库', [`记录 #${row.id}`]),
      ];

  if (row.status === 'pending_approval') {
    if (!approvedForDispatch) {
      return [...base, stage('approval', 'waiting_human', '等待人工审批'), stage('dispatch', 'pending', '审批通过后下发')];
    }
    // 已批准但尚未真正开始下发：**必须**与「等待人工审批」可区分，并给出原因与等待时长。
    if (dispatch && dispatch.dispatchState === 'pending_dispatch') {
      const blocked = describeDispatchBlockedReason(dispatch.dispatchBlockedReason);
      const facts = [`已等待 ${Math.max(0, Math.round((now - dispatch.decidedAt) / 60_000))} 分钟`];
      if (blocked) facts.push(`阻塞原因：${blocked}`);
      return [
        ...base,
        stage('approval', 'completed', '人工审批已通过'),
        stage('dispatch', 'pending', blocked ? `已批准·待下发（${blocked}）` : '已批准·待下发', facts),
      ];
    }
    return [
      ...base,
      stage('approval', 'completed', '人工审批已通过'),
      stage('dispatch', 'running', '正在向平台下发', [`图片已附着 ${row.imagesAttachedCount}/${generated}`], { current: row.imagesAttachedCount, total: generated }),
    ];
  }
  if (row.status === 'needs_review') {
    return [...base, stage('approval', 'failed', '人工已驳回'), stage('dispatch', 'skipped', '未向平台下发')];
  }
  if (row.status === 'draft') {
    return [...base, stage('approval', 'skipped', '本稿仅保存为草稿'), stage('dispatch', 'skipped', '未向平台下发')];
  }

  const dispatchFacts = [`图片已附着 ${row.imagesAttachedCount}/${generated}`];
  if (row.status === 'published') {
    return [...base, stage('approval', 'completed', '发布授权已确认'), stage('dispatch', 'completed', '平台发布已确认', dispatchFacts)];
  }
  if (row.status === 'scheduled') {
    const target = row.publishTime === null ? '平台定时任务已确认' : `计划 ${new Date(row.publishTime).toLocaleString('zh-CN')} 公开`;
    return [...base, stage('approval', 'completed', '发布授权已确认'), stage('dispatch', 'partial', target, dispatchFacts)];
  }
  if (row.status === 'submitted') {
    return [...base, stage('approval', 'completed', '发布授权已确认'), stage('dispatch', 'partial', '已提交，待链接确认', dispatchFacts)];
  }
  return [...base, stage('approval', 'completed', '发布授权已确认'), stage('dispatch', 'failed', '平台下发失败，未确认发布', dispatchFacts)];
}

function journeyFromPublish(
  row: PanelPublish,
  inFlight: boolean,
  snapshot: Record<string, unknown> | null,
  dispatch: ApprovalDispatchProjection | null,
  now: number,
): PublishJourneyView {
  // 判据优先取**持久授权记录**：进程内在途集合重启即清空，用它做区分会让「已批准·待下发」在重启后
  // 退回「待审批」。持久记录缺省（未接线 / 无活跃授权）时才回落到既有在途集合，零回归。
  const approvedForDispatch = dispatch ? dispatch.approved && dispatch.dispatchState !== 'void' : inFlight;
  const status: PublishJourneyStatus = row.status === 'pending_approval'
    ? approvedForDispatch ? 'dispatching' : 'waiting_approval'
    : row.status === 'published'
      ? 'published'
      : row.status === 'scheduled'
        ? 'scheduled'
      : row.status === 'submitted'
        ? 'submitted'
        : row.status === 'needs_review'
          ? 'rejected'
          : row.status === 'draft'
            ? 'draft'
            : 'failed';
  const summaries: Record<PublishJourneyStatus, string> = {
    generating: '正在生成候审稿',
    waiting_approval: '候审稿已完成，等待人工审批',
    dispatching: '审批已通过，正在向平台下发',
    scheduled: '平台定时任务已确认，等待公开后对账',
    published: '平台发布已确认',
    submitted: '已提交平台，帖子链接尚未确认',
    failed: '平台下发失败，未确认发布',
    rejected: '人工已驳回，未向平台下发',
    draft: '已保存为草稿，未向平台下发',
    skipped: '本轮未进入发布',
  };
  // 「已批准·待下发」与「正在下发」在同一个 status 下用增量字段细分：给 status 加新取值会让尚未升级的
  // 前端落进 default 分支（枚举漂移 → 整页白屏），而增量可选字段被旧前端安全忽略。
  const blockedLabel = describeDispatchBlockedReason(dispatch?.dispatchBlockedReason);
  const statusSummary =
    status === 'dispatching' && dispatch?.dispatchState === 'pending_dispatch'
      ? blockedLabel
        ? `已批准·待下发（${blockedLabel}）`
        : '已批准·待下发'
      : summaries[status];
  return {
    journeyId: `publish:${row.id}`,
    runId: null,
    recordId: row.id,
    accountId: row.accountId,
    title: row.title ?? '未命名稿件',
    sourceTitle: row.sourceReference?.title ?? null,
    kind: 'persisted',
    startedAt: row.publishedAt,
    active: status === 'waiting_approval' || status === 'dispatching',
    status,
    statusSummary,
    stages: persistedStages(row, approvedForDispatch, dispatch, snapshot, now),
    snapshot,
    ...(dispatch
      ? {
          dispatchState: dispatch.dispatchState,
          dispatchBlockedReason: dispatch.dispatchBlockedReason,
          decidedAt: dispatch.decidedAt,
          waitingMs: Math.max(0, now - dispatch.decidedAt),
        }
      : {}),
  };
}

export function buildPublishLifecycle(input: {
  queue: QueueStatusLike;
  pending: PanelPublish[];
  recent: PanelPublish[];
  inFlightRecordIds?: Iterable<number>;
  /**
   * 持久授权记录的下发进度（按 recordId）。缺省 → 回落既有进程内在途集合（零回归）。
   * 这是「已批准·待下发」在进程重启后仍成立的唯一来源。
   */
  approvalDispatch?: ReadonlyMap<number, ApprovalDispatchProjection>;
  recentLimit?: number;
  now?: number;
}): PublishLifecycleProjection {
  const inFlight = new Set(input.inFlightRecordIds ?? []);
  const approvalDispatch = input.approvalDispatch;
  const now = input.now ?? Date.now();
  const aggregateSnapshot = record(input.queue.snapshot);
  const aggregateRecordId = resultRecordId(aggregateSnapshot);
  // panelStore 的正式实现会按 status 过滤；这里仍 fail-closed 再核一次，避免旧实现/测试桩把终态塞进 active。
  const pendingRows = input.pending.filter((row) => row.status === 'pending_approval');
  const pendingIds = new Set(pendingRows.map((row) => row.id));
  const running = (input.queue.runs ?? [])
    .filter((run) => {
      const recordId = resultRecordId(run.snapshot);
      return recordId == null || !pendingIds.has(recordId);
    })
    .map((run) => journeyFromRun(run, true));
  const pending = pendingRows.map((row) => journeyFromPublish(
    row,
    inFlight.has(row.id),
    aggregateRecordId === row.id ? aggregateSnapshot : null,
    approvalDispatch?.get(row.id) ?? null,
    now,
  ));
  const active = [...running, ...pending].sort((a, b) => b.startedAt - a.startedAt);

  const recentLimit = Math.max(1, input.recentLimit ?? 5);
  const recent = input.recent
    .filter((row) => row.status !== 'pending_approval')
    .slice(0, recentLimit)
    .map((row) => journeyFromPublish(
      row,
      false,
      aggregateRecordId === row.id ? aggregateSnapshot : null,
      approvalDispatch?.get(row.id) ?? null,
      now,
    ));

  if (
    input.queue.status !== 'idle'
    && input.queue.status !== 'running'
    && aggregateSnapshot
    && aggregateRecordId == null
    && recent.every((item) => item.snapshot !== aggregateSnapshot)
  ) {
    const terminalRun: QueueRunLike = {
      runId: 'latest-terminal',
      accountId: text(record(aggregateSnapshot.trigger)?.accountId) ?? 'default',
      kind: referenceNote(aggregateSnapshot) ? 'rewrite' : 'autonomous',
      sourceId: text(referenceNote(aggregateSnapshot)?.sourceId),
      startedAt: number(nested(aggregateSnapshot, 'pipelineAbort')?.abortedAt) ?? Date.now(),
      status: input.queue.status,
      snapshot: aggregateSnapshot,
    };
    recent.unshift(journeyFromRun(terminalRun, false));
    recent.splice(recentLimit);
  }

  return {
    status: active.some((item) => item.status === 'generating' || item.status === 'dispatching')
      ? 'running'
      : active.length > 0
        ? 'waiting_human'
        : 'idle',
    active,
    recent,
  };
}
