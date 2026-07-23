import type {
  PublishJourneyStatus,
  PublishLifecycleProjection,
  PublishStageState,
  PublishStageView,
} from '../panel/publish-stage-lifecycle.js';
import type { DelegatedTask, DelegatedTaskStatus } from '../kernel/delegated-task-types.js';

export const CLIENT_PUBLISH_QUEUE_TASK_STATUSES = ['queued', 'planning', 'deferred'] as const;
export type ClientPublishQueueTaskStatus = (typeof CLIENT_PUBLISH_QUEUE_TASK_STATUSES)[number];

export interface ClientPublishQueueStage {
  key: 'source' | 'content' | 'approval' | 'dispatch';
  label: '开始创作' | '正文与配图' | '发布确认' | '发布结果';
  state: PublishStageState;
  summary: string;
  progress?: { current: number; total: number };
}

export interface ClientPublishQueueTask {
  id: string;
  title: string;
  action: string;
  status: ClientPublishQueueTaskStatus;
  statusLabel: string;
  cancelRequested: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  notBefore: number;
}

export interface ClientPublishQueueJourney {
  id: string;
  recordId: number | null;
  title: string;
  sourceTitle: string | null;
  kind: 'rewrite' | 'autonomous' | 'persisted';
  startedAt: number;
  status: PublishJourneyStatus;
  statusLabel: string;
  stages: ClientPublishQueueStage[];
}

export interface ClientPublishQueueView {
  summary: {
    inProgress: number;
    waitingForYou: number;
    cancellable: number;
  };
  tasks: ClientPublishQueueTask[];
  active: ClientPublishQueueJourney[];
  recent: ClientPublishQueueJourney[];
}

export interface ClientPublishQueueCancelReceipt {
  id: string;
  status: DelegatedTaskStatus;
  cancelRequested: boolean;
  version: number;
  terminal: boolean;
}

const TASK_STATUS_SET = new Set<string>(CLIENT_PUBLISH_QUEUE_TASK_STATUSES);
const TERMINAL_TASK_STATUSES = new Set<DelegatedTaskStatus>([
  'partially_completed',
  'completed',
  'cancelled',
  'failed',
]);

const STAGE_GROUPS: ReadonlyArray<{
  key: ClientPublishQueueStage['key'];
  label: ClientPublishQueueStage['label'];
  sourceKeys: PublishStageView['key'][];
}> = [
  { key: 'source', label: '开始创作', sourceKeys: ['source'] },
  {
    key: 'content',
    label: '正文与配图',
    sourceKeys: ['content', 'text_quality', 'visual_plan', 'image_review', 'package'],
  },
  { key: 'approval', label: '发布确认', sourceKeys: ['approval'] },
  { key: 'dispatch', label: '发布结果', sourceKeys: ['dispatch'] },
];

const JOURNEY_STATUS_LABELS: Record<PublishJourneyStatus, string> = {
  generating: '创作中',
  waiting_approval: '等待你确认',
  dispatching: '正在发布',
  scheduled: '已安排发布',
  published: '已发布',
  submitted: '平台确认中，请勿重复操作',
  failed: '未完成',
  rejected: '已暂不发布',
  draft: '已保存为草稿',
  skipped: '本次未发布',
};

const ACTION_LABELS: Record<string, string> = {
  publish_post: '发布笔记',
  publish_from_inspiration: '参考创作',
  generate_candidates: '生成候选笔记',
};

function safeTaskTitle(task: DelegatedTask): string {
  const value = task.sourceConstraints.title;
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);
  return ACTION_LABELS[task.action] ?? 'AI 创作任务';
}

function taskStatusLabel(task: DelegatedTask): string {
  if (task.cancelRequested) return '取消中，将在安全边界停止';
  if (task.status === 'planning') return '正在准备创作';
  if (task.status === 'deferred') return '暂缓中';
  return '排队中';
}

function projectTask(task: DelegatedTask): ClientPublishQueueTask | null {
  if (task.platform !== 'xiaohongshu'
      || task.actionFamily !== 'publish'
      || !TASK_STATUS_SET.has(task.status)) return null;
  return {
    id: task.id,
    title: safeTaskTitle(task),
    action: ACTION_LABELS[task.action] ?? 'AI 创作任务',
    status: task.status as ClientPublishQueueTaskStatus,
    statusLabel: taskStatusLabel(task),
    cancelRequested: task.cancelRequested,
    version: task.version,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    notBefore: task.notBefore,
  };
}

function aggregateState(stages: PublishStageView[]): PublishStageState {
  if (stages.length === 0) return 'pending';
  const states = stages.map((stage) => stage.state);
  if (states.includes('failed')) return 'failed';
  if (states.includes('waiting_human')) return 'waiting_human';
  if (states.includes('retrying')) return 'retrying';
  if (states.includes('running')) return 'running';
  if (states.includes('partial')) return 'partial';
  if (states.every((state) => state === 'completed' || state === 'skipped')) {
    return states.includes('completed') ? 'completed' : 'skipped';
  }
  return 'pending';
}

function stageSummary(
  key: ClientPublishQueueStage['key'],
  label: ClientPublishQueueStage['label'],
  state: PublishStageState,
): string {
  if (key === 'approval') {
    const approvalSuffix: Partial<Record<PublishStageState, string>> = {
      pending: '尚未开始',
      waiting_human: '待你确认',
      completed: '已确认',
    };
    if (approvalSuffix[state]) return `${label}：${approvalSuffix[state]}`;
  }
  if (key === 'dispatch' && state === 'pending') return `${label}：等待发布`;
  const suffix: Record<PublishStageState, string> = {
    pending: '未开始',
    running: '进行中',
    retrying: '正在重试',
    waiting_human: '等待你的确认',
    completed: '已完成',
    partial: '部分完成',
    failed: '未完成',
    skipped: '本次跳过',
  };
  return `${label}：${suffix[state]}`;
}

function projectStageGroup(
  journeyStages: PublishStageView[],
  group: (typeof STAGE_GROUPS)[number],
): ClientPublishQueueStage {
  const sourceStages = journeyStages.filter((stage) => group.sourceKeys.includes(stage.key));
  const state = aggregateState(sourceStages);
  const withProgress = sourceStages.find(
    (stage) => stage.progress && stage.progress.total > 0 && stage.progress.current >= 0,
  );
  return {
    key: group.key,
    label: group.label,
    state,
    summary: stageSummary(group.key, group.label, state),
    ...(withProgress?.progress ? { progress: { ...withProgress.progress } } : {}),
  };
}

function projectJourney(
  journey: PublishLifecycleProjection['active'][number],
): ClientPublishQueueJourney {
  return {
    id: journey.journeyId,
    recordId: journey.recordId,
    title: journey.title,
    sourceTitle: journey.sourceTitle,
    kind: journey.kind,
    startedAt: journey.startedAt,
    status: journey.status,
    statusLabel: JOURNEY_STATUS_LABELS[journey.status],
    stages: STAGE_GROUPS.map((group) => projectStageGroup(journey.stages, group)),
  };
}

export function projectClientPublishQueue(input: {
  accountId: string;
  lifecycle: PublishLifecycleProjection;
  tasks: DelegatedTask[];
}): ClientPublishQueueView {
  const tasks = input.tasks
    .filter((task) => task.accountId === input.accountId)
    .map(projectTask)
    .filter((task): task is ClientPublishQueueTask => task !== null)
    .sort((a, b) => a.createdAt - b.createdAt);
  const active = input.lifecycle.active
    .filter((journey) => journey.accountId === input.accountId)
    .map(projectJourney);
  const recent = input.lifecycle.recent
    .filter((journey) => journey.accountId === input.accountId)
    .map(projectJourney);

  return {
    summary: {
      inProgress: tasks.length + active.length,
      waitingForYou: active.filter((journey) => journey.status === 'waiting_approval').length,
      cancellable: tasks.filter((task) => !task.cancelRequested).length,
    },
    tasks,
    active,
    recent,
  };
}

export function projectClientPublishQueueCancelReceipt(task: DelegatedTask): ClientPublishQueueCancelReceipt {
  return {
    id: task.id,
    status: task.status,
    cancelRequested: task.cancelRequested,
    version: task.version,
    terminal: TERMINAL_TASK_STATUSES.has(task.status),
  };
}
