import { createHash } from 'node:crypto';
import type { PlatformId, DelegatedActionSupport } from '../platform/index.js';
import { delegatedActionSupportForPlatform } from '../platform/index.js';
import { parseDelegatedText, type ParsedDelegatedRequest } from './parser.js';
import type { DelegatedTaskCreate, DelegatedTaskListFilter, DelegatedTaskStore } from './store.js';
import type { DelegatedTask, DelegatedTaskIntent, JsonValue, TaskConstraints } from './types.js';
import { validateDelegatedTaskIntent } from './types.js';
// DelegatedTaskConfirmationSummary（纯投影摘要）、DelegatedTaskServiceError（typed error）、
// DelegatedTaskServicePort（读写窄面）已抬入 kernel，供 api 侧消费方跨边界共导；这里等值再导出，
// 让既有 `from '../delegated-task/service'` 的导入面（automation 内部消费方）逐字不变。
import type { DelegatedTaskConfirmationSummary, DelegatedTaskServicePort } from '../kernel/delegated-task-types.js';
import { DelegatedTaskServiceError } from '../kernel/delegated-task-types.js';
export type { DelegatedTaskConfirmationSummary };
export { DelegatedTaskServiceError };

export interface DelegatedAccountCandidate {
  accountId: string;
  /** Cloud 统一解析器产出的首选可读名。 */
  displayName?: string | null;
  /** 运营别名、平台昵称、运营标签候选；不含机器 ID。 */
  names?: string[];
  /** @deprecated 兼容既有注入夹具；新调用使用 displayName + names。 */
  nickname?: string | null;
  platform: PlatformId;
  status?: 'active' | 'paused';
}

export interface DelegatedTaskServiceDeps {
  store: DelegatedTaskStore;
  listAccounts: () => Promise<DelegatedAccountCandidate[]>;
  capabilityFor?: (platform: PlatformId, action: DelegatedTask['action']) => DelegatedActionSupport;
  /** Resolve immutable target snapshots (candidate version, curated note identity) before the confirmation card is created. */
  prepareTarget?: (
    intent: DelegatedTaskIntent,
    account: DelegatedAccountCandidate,
  ) => Promise<{ ok: true; targetConstraints?: TaskConstraints } | { ok: false; code: string; message: string }>;
  validateTarget?: (task: DelegatedTask) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  now?: () => number;
}

const ACTION_LABELS: Record<DelegatedTask['action'], string> = {
  comment_batch: '完成有效评论',
  publish_post: '发布一篇稿件',
  publish_from_inspiration: '参考今日灵感发布',
  comment_curated: '评论指定精选内容',
  generate_candidates: '生成候选稿（暂不发布）',
  approve_candidate: '批准候选稿',
  reject_candidate: '驳回候选稿',
  modify_candidate: '修改候选稿',
  facebook_group_comment: 'Facebook 群组评论任务',
};

function stable(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}

export function delegatedTaskDedupeKey(input: {
  accountId: string;
  action: DelegatedTask['action'];
  source: DelegatedTask['source'];
  sourceRef?: string;
  deadlineAt: number;
  targetConstraints?: TaskConstraints;
  sourceConstraints?: TaskConstraints;
}): string {
  const bucket = Math.floor(input.deadlineAt / 60_000);
  const canonical = [
    input.accountId,
    input.action,
    input.source,
    input.sourceRef ?? '',
    String(bucket),
    stable((input.targetConstraints ?? {}) as JsonValue),
    stable((input.sourceConstraints ?? {}) as JsonValue),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

function platformLabel(platform: PlatformId): string {
  return platform === 'facebook' ? 'Facebook' : platform === 'wechat_channels' ? '微信视频号' : '小红书';
}

function constraintRows(task: DelegatedTask): string[] {
  const rows: string[] = [];
  const add = (prefix: string, constraints: TaskConstraints) => {
    for (const [key, value] of Object.entries(constraints)) {
      if (key === 'manualSingle') continue;
      rows.push(`${prefix}${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    }
  };
  add('来源：', task.sourceConstraints);
  add('目标：', task.targetConstraints);
  return rows;
}

export function buildDelegatedTaskConfirmation(task: DelegatedTask, support: DelegatedActionSupport): DelegatedTaskConfirmationSummary {
  const schedule = task.executionWindow.mode === 'next_safe_slot'
    ? `下一安全空档（截止 ${new Date(task.deadlineAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`
    : task.executionWindow.mode === 'at_time'
      ? `指定时间 ${new Date(task.notBefore).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
      : `确认后排队（截止 ${new Date(task.deadlineAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`;
  return {
    taskId: task.id,
    version: task.version,
    title: '请确认用户委托任务',
    accountName: task.accountName,
    platformLabel: platformLabel(task.platform),
    actionLabel: ACTION_LABELS[task.action],
    target: `${task.targetSuccessCount} 个验证成功结果`,
    attempts: `最多 ${task.maxAttempts} 次尝试`,
    schedule,
    approval: task.approvalMode === 'review' ? '公开写操作保留人审' : task.approvalMode === 'draft_only' ? '只生成候选，不发布' : '按既有受控免审配置',
    priority: task.priority === 'high' ? '委托队列内优先（边缘仍为 automatic）' : '普通',
    constraints: constraintRows(task),
    capability: support.level === 'beta' ? 'beta' : 'supported',
    ...(support.level === 'beta' ? { capabilityReason: support.reason } : {}),
  };
}

export class DelegatedTaskService implements DelegatedTaskServicePort {
  private readonly now: () => number;

  constructor(private readonly deps: DelegatedTaskServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async createFromText(text: string, opts?: { sourceRef?: string; originChatId?: string }): Promise<
    | { kind: 'task'; task: DelegatedTask; confirmation: DelegatedTaskConfirmationSummary; created: boolean; autoQueued: boolean }
    | { kind: 'control'; request: Extract<ParsedDelegatedRequest, { ok: true; kind: 'control' }> }
  > {
    const parsed = parseDelegatedText(text, { now: this.now(), source: 'feishu', sourceRef: opts?.sourceRef, originChatId: opts?.originChatId });
    if (!parsed.ok) throw new DelegatedTaskServiceError(parsed.code, parsed.message);
    if (parsed.kind === 'control') return { kind: 'control', request: parsed };
    // Auto-confirm vs confirmation card is decided inside createDraft by `source`: only natural language
    // (`feishu`) keeps the confirmation card; `legacy_command` slash commands auto-queue. createFromText
    // only ever produces 'feishu' or 'legacy_command' intents, so this just passes the decision through.
    const created = await this.createDraft({ ...parsed.intent, accountName: parsed.nickname });
    return { kind: 'task', ...created };
  }

  async createDraft(intent: DelegatedTaskIntent): Promise<{
    task: DelegatedTask;
    confirmation: DelegatedTaskConfirmationSummary;
    created: boolean;
    autoQueued: boolean;
  }> {
    const errors = validateDelegatedTaskIntent(intent, this.now());
    if (errors.length > 0) throw new DelegatedTaskServiceError(errors[0], `任务参数不完整：${errors.join(', ')}`);
    const account = await this.resolveAccount(intent);
    if (intent.platform && intent.platform !== account.platform) {
      throw new DelegatedTaskServiceError('platform_mismatch', `账号平台事实为 ${platformLabel(account.platform)}，与请求不一致。`, 409);
    }
    if (account.status === 'paused') {
      throw new DelegatedTaskServiceError('account_paused', `账号「${account.displayName ?? account.nickname ?? '（未获取昵称）'}」当前已暂停。`, 409);
    }
    let preparedIntent = intent;
    if (this.deps.prepareTarget) {
      const prepared = await this.deps.prepareTarget(intent, account);
      if (!prepared.ok) throw new DelegatedTaskServiceError(prepared.code, prepared.message, 409);
      if (prepared.targetConstraints) preparedIntent = { ...intent, targetConstraints: prepared.targetConstraints };
    }
    // The inbox-only platform deliberately has no delegated execution path or
    // delegated_tasks persistence value. Keep that domain boundary explicit.
    if (account.platform === 'wechat_channels') {
      throw new DelegatedTaskServiceError('unsupported_action', '微信视频号仅支持入站互动回复工作流。', 422);
    }
    const support = this.capability(account.platform, preparedIntent.action);
    if (support.level === 'unsupported') {
      throw new DelegatedTaskServiceError('unsupported_action', `${platformLabel(account.platform)} 暂不支持该委托：${support.reason}`, 422);
    }
    if (
      account.platform === 'facebook' &&
      (preparedIntent.action === 'comment_batch' || preparedIntent.action === 'comment_curated') &&
      typeof preparedIntent.targetConstraints?.url === 'string'
    ) {
      throw new DelegatedTaskServiceError('unsupported_target_scope', 'Facebook Beta 不支持任意帖子 URL 评论，只能使用已有配置目标范围。', 422);
    }
    const accountName = account.displayName?.trim() || account.nickname?.trim() || intent.accountName?.trim();
    if (!accountName) throw new DelegatedTaskServiceError('account_name_required', '账号缺少可读昵称，请先完成昵称采集。', 409);
    const create: DelegatedTaskCreate = {
      ...preparedIntent,
      accountId: account.accountId,
      accountName,
      platform: account.platform,
      dedupeKey: delegatedTaskDedupeKey({
        accountId: account.accountId,
        action: preparedIntent.action,
        source: preparedIntent.source,
        sourceRef: preparedIntent.sourceRef,
        deadlineAt: preparedIntent.deadlineAt,
        targetConstraints: preparedIntent.targetConstraints,
        sourceConstraints: preparedIntent.sourceConstraints,
      }),
    };
    const result = await this.deps.store.createDraft(create);
    const confirmation = buildDelegatedTaskConfirmation(result.task, support);
    // 确认卡只服务于自然语言（`feishu`）入口——账号 / 数量 / 截止 / 尝试均为从散文**推断**、可能解析错，
    // 需要人过目确认。其余都是结构化精确入口（console 行级动作 / edge 快捷入口 / api / legacy slash），
    // 参数已显式给定、无可推断歧义 → 直接确认入队、不出确认卡。人审不受影响：仍在下游内容 / 评论审批处，
    // 昵称歧义仍在 resolveAccount 处 fail-closed。
    if (intent.source !== 'feishu') {
      const task = result.task.status === 'awaiting_confirmation'
        ? await this.confirm(result.task.id, result.task.version)
        : result.task;
      return { task, confirmation, created: result.created, autoQueued: true };
    }
    return { task: result.task, confirmation, created: result.created, autoQueued: false };
  }

  async confirm(taskId: string, version: number): Promise<DelegatedTask> {
    const before = await this.requireTask(taskId);
    if (before.status !== 'awaiting_confirmation') return before;
    if (before.version !== version) throw new DelegatedTaskServiceError('version_conflict', '确认卡已过期，请刷新任务当前状态。', 409);
    const accounts = await this.deps.listAccounts();
    const account = accounts.find((a) => a.accountId === before.accountId);
    if (!account) throw new DelegatedTaskServiceError('account_not_found', '账号已不存在，任务不能确认。', 404);
    if (account.platform !== before.platform) throw new DelegatedTaskServiceError('platform_changed', '账号平台已变化，旧任务不能继续执行。', 409);
    const support = this.capability(before.platform, before.action);
    if (support.level === 'unsupported') throw new DelegatedTaskServiceError('unsupported_action', support.reason, 422);
    if (this.deps.validateTarget) {
      const valid = await this.deps.validateTarget(before);
      if (!valid.ok) throw new DelegatedTaskServiceError(valid.code, valid.message, 409);
    }
    const confirmed = await this.deps.store.confirm(taskId, version);
    if (!confirmed) throw new DelegatedTaskServiceError('task_not_found', '任务不存在。', 404);
    return confirmed;
  }

  async pause(taskId: string, version?: number): Promise<DelegatedTask> {
    await this.assertVersion(taskId, version);
    const task = await this.deps.store.requestPause(taskId, version);
    if (!task) throw new DelegatedTaskServiceError('task_not_found', '任务不存在。', 404);
    return task;
  }

  async resume(taskId: string, version?: number): Promise<DelegatedTask> {
    await this.assertVersion(taskId, version);
    const task = await this.deps.store.resume(taskId, version);
    if (!task) throw new DelegatedTaskServiceError('task_not_found', '任务不存在。', 404);
    return task;
  }

  async cancel(taskId: string, version?: number): Promise<DelegatedTask> {
    await this.assertVersion(taskId, version);
    const task = await this.deps.store.requestCancel(taskId, version);
    if (!task) throw new DelegatedTaskServiceError('task_not_found', '任务不存在。', 404);
    return task;
  }

  async get(taskId: string): Promise<DelegatedTask> {
    return this.requireTask(taskId);
  }

  list(filter?: DelegatedTaskListFilter): Promise<DelegatedTask[]> {
    return this.deps.store.list(filter);
  }

  private capability(platform: PlatformId, action: DelegatedTask['action']): DelegatedActionSupport {
    return this.deps.capabilityFor?.(platform, action) ?? delegatedActionSupportForPlatform(platform, action);
  }

  private async resolveAccount(intent: DelegatedTaskIntent): Promise<DelegatedAccountCandidate> {
    const accounts = await this.deps.listAccounts();
    if (intent.accountId) {
      const hit = accounts.find((a) => a.accountId === intent.accountId);
      if (!hit) throw new DelegatedTaskServiceError('account_not_found', '指定环境对应账号不存在。', 404);
      return hit;
    }
    const nickname = intent.accountName?.trim().toLocaleLowerCase();
    if (!nickname) throw new DelegatedTaskServiceError('account_name_required', '请提供账号昵称。');
    const hits = accounts.filter((a) => {
      const names = a.names?.length ? a.names : [a.nickname ?? a.displayName ?? ''];
      return names.some((name) => name.trim().toLocaleLowerCase() === nickname);
    });
    if (hits.length === 0) {
      const available = accounts.map((a) => a.displayName ?? a.nickname).filter(Boolean).join('、') || '无可用昵称';
      throw new DelegatedTaskServiceError('account_not_found', `找不到昵称「${intent.accountName}」；可用昵称：${available}`, 404);
    }
    if (hits.length > 1) throw new DelegatedTaskServiceError('account_ambiguous', `昵称「${intent.accountName}」不唯一，请先消除重名。`, 409);
    return hits[0];
  }

  private async requireTask(id: string): Promise<DelegatedTask> {
    const task = await this.deps.store.get(id);
    if (!task) throw new DelegatedTaskServiceError('task_not_found', '任务不存在。', 404);
    return task;
  }

  private async assertVersion(id: string, version?: number): Promise<void> {
    if (version === undefined) return;
    const task = await this.requireTask(id);
    if (task.version !== version) throw new DelegatedTaskServiceError('version_conflict', '任务卡已过期，请刷新当前状态。', 409);
  }
}
