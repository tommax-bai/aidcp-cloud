import type { DeploymentTarget } from '../deployment-target.js';
import {
  API_DIRECT_CONTRACT_VERSION,
  type AutomationPublishLogPort,
  type EdgePublishCommandPort,
  type InteractionApiWritesPort,
  type InteractionAuthAuthorityPort,
  type PendingPublishPreview,
  type PublishApprovalDecisionCommand,
  type PublishApprovalDecisionResult,
  type PublishDraftEditPatch,
  type PublishDraftImageRemoveCommand,
  type PublishDraftImageRemoveResult,
  type ReplyConfigResolverPort,
} from '../kernel/api-direct-port.js';
import type {
  InteractionAuthWriteAuthorization,
  InteractionAuthWriteAuthorizationInput,
  InteractionScopeCheck,
  InteractionScopeCheckInput,
} from '../kernel/interaction-auth-gate-types.js';
import type { InteractionAuditEventRecord } from '../kernel/interaction-audit-outbox.js';
import type { EffectiveReplyConfig, ReplyConfigSnapshot } from '../kernel/interaction-types.js';
import type {
  DispatchDraft,
  EditDraftResult,
  ScheduledPublishRecord,
  ScheduledReconcileUpdate,
} from '../kernel/publish-draft-contract.js';
import type { PublishStatus } from '../kernel/publish-pipeline-types.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import {
  ApiDirectHttpError,
  callApiDirectRead,
  callApiDirectWrite,
  isJsonValue,
  isNonNegativeInteger,
  isNullableString,
  isRecord,
  parseApiDirectEnvelope,
  requireFiniteNumber,
  requireInteger,
  requireRecord,
  requireString,
  isVoidAck,
} from './api-direct-http-common.js';

export const AUTOMATION_PUBLISH_LOG_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const EDGE_PUBLISH_COMMAND_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const INTERACTION_AUTH_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const INTERACTION_API_WRITES_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const REPLY_CONFIG_RESOLVER_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;

export const AUTOMATION_PUBLISH_LOG_ROUTES = {
  loadForDispatch: 'api-direct/publish-log/v1/load-for-dispatch',
  updateStatus: 'api-direct/publish-log/v1/update-status',
  updatePostId: 'api-direct/publish-log/v1/update-post-id',
  markScheduled: 'api-direct/publish-log/v1/mark-scheduled',
  markImagesAttached: 'api-direct/publish-log/v1/mark-images-attached',
  listDueScheduled: 'api-direct/publish-log/v1/list-due-scheduled',
  deferScheduledReconcile: 'api-direct/publish-log/v1/defer-scheduled-reconcile',
  confirmScheduledPublished:
    'api-direct/publish-log/v1/confirm-scheduled-published',
  getMostRecentPublishTime:
    'api-direct/publish-log/v1/get-most-recent-publish-time',
  recentPublishedContents:
    'api-direct/publish-log/v1/recent-published-contents',
  editDraft: 'api-direct/publish-log/v1/edit-draft',
  rejectPendingApproval: 'api-direct/publish-log/v1/reject-pending-approval',
  pendingApprovalForAccount: 'api-direct/publish-log/v1/pending-approval-for-account',
  pendingPublishPreviewForAccount:
    'api-direct/publish-log/v1/pending-publish-preview-for-account',
  lastPublishedForAccount: 'api-direct/publish-log/v1/last-published-for-account',
  countPendingForAccount: 'api-direct/publish-log/v1/count-pending-for-account',
  countPendingAutonomousForAccount:
    'api-direct/publish-log/v1/count-pending-autonomous-for-account',
  countPublishedTodayForAccount:
    'api-direct/publish-log/v1/count-published-today-for-account',
  countPublishedSinceForAccount:
    'api-direct/publish-log/v1/count-published-since-for-account',
} as const satisfies Record<keyof AutomationPublishLogPort, string>;

export const EDGE_PUBLISH_COMMAND_ROUTES = {
  removeDraftImage: 'api-direct/edge-publish/v1/remove-draft-image',
  decidePublishApproval: 'api-direct/edge-publish/v1/decide-publish-approval',
} as const satisfies Record<keyof EdgePublishCommandPort, string>;

export const INTERACTION_AUTH_ROUTES = {
  authorizeAuthStateWrite: 'api-direct/interaction-auth/v1/authorize-auth-state-write',
  checkAccountScope: 'api-direct/interaction-auth/v1/check-account-scope',
} as const satisfies Record<keyof InteractionAuthAuthorityPort, string>;

export const INTERACTION_API_WRITES_ROUTES = {
  insertAuditEvent: 'api-direct/interaction-api-writes/v1/insert-audit-event',
  purgeReplyConfigForAccount:
    'api-direct/interaction-api-writes/v1/purge-reply-config-for-account',
  purgeExpiredAuditEvents:
    'api-direct/interaction-api-writes/v1/purge-expired-audit-events',
} as const satisfies Record<keyof InteractionApiWritesPort, string>;

export const REPLY_CONFIG_RESOLVER_ROUTES = {
  resolve: 'api-direct/reply-config/v1/resolve',
  getPublished: 'api-direct/reply-config/v1/get-published',
  getSnapshotForJob: 'api-direct/reply-config/v1/get-snapshot-for-job',
} as const satisfies Record<keyof ReplyConfigResolverPort, string>;

function accountIdInput(value: unknown): { accountId: string } {
  const input = requireRecord(value);
  return { accountId: requireString(input.accountId, 'accountId') };
}

function recordIdInput(value: unknown): { recordId: number } {
  const input = requireRecord(value);
  return { recordId: requireInteger(input.recordId, 'recordId', 1) };
}

const PUBLISH_STATUSES: readonly PublishStatus[] = [
  'draft',
  'pending_approval',
  'scheduled',
  'submitted',
  'published',
  'failed',
  'needs_review',
];

function requirePublishStatus(value: unknown, label: string): PublishStatus {
  if (
    typeof value !== 'string'
    || !PUBLISH_STATUSES.includes(value as PublishStatus)
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `${label} is invalid`,
    );
  }
  return value as PublishStatus;
}

function optionalNullableStringField(
  input: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = input[field];
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `${field} must be a string, null, or undefined`,
    );
  }
  return value as string | null | undefined;
}

function updateStatusInput(value: unknown): {
  id: number;
  status: PublishStatus;
} {
  const input = requireRecord(value);
  return {
    id: requireInteger(input.id, 'id', 1),
    status: requirePublishStatus(input.status, 'status'),
  };
}

function updatePostIdInput(value: unknown): {
  id: number;
  postId: string;
  postUrl?: string | null;
} {
  const input = requireRecord(value);
  const postUrl = optionalNullableStringField(input, 'postUrl');
  return {
    id: requireInteger(input.id, 'id', 1),
    postId: requireString(input.postId, 'postId'),
    ...(postUrl === undefined ? {} : { postUrl }),
  };
}

function markScheduledInput(value: unknown): {
  id: number;
  scheduledAt: number;
  scheduledPlatformId?: string | null;
} {
  const input = requireRecord(value);
  const scheduledPlatformId = optionalNullableStringField(
    input,
    'scheduledPlatformId',
  );
  return {
    id: requireInteger(input.id, 'id', 1),
    scheduledAt: requireFiniteNumber(input.scheduledAt, 'scheduledAt'),
    ...(scheduledPlatformId === undefined ? {} : { scheduledPlatformId }),
  };
}

function markImagesAttachedInput(value: unknown): {
  id: number;
  count: number;
} {
  const input = requireRecord(value);
  return {
    id: requireInteger(input.id, 'id', 1),
    count: requireInteger(input.count, 'count'),
  };
}

function optionalPositiveIntegerField(
  input: Record<string, unknown>,
  field: string,
): number | undefined {
  if (input[field] === undefined) return undefined;
  return requireInteger(input[field], field, 1);
}

function optionalFiniteNumberField(
  input: Record<string, unknown>,
  field: string,
): number | undefined {
  if (input[field] === undefined) return undefined;
  return requireFiniteNumber(input[field], field);
}

function listDueScheduledInput(value: unknown): {
  limit?: number;
  now?: number;
} {
  const input = requireRecord(value);
  const limit = optionalPositiveIntegerField(input, 'limit');
  const now = optionalFiniteNumberField(input, 'now');
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(now === undefined ? {} : { now }),
  };
}

function deferScheduledReconcileInput(value: unknown): {
  id: number;
  error: string;
  nextAt: number;
  maxAttempts?: number;
} {
  const input = requireRecord(value);
  if (typeof input.error !== 'string') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'error must be a string',
    );
  }
  const maxAttempts = optionalPositiveIntegerField(input, 'maxAttempts');
  return {
    id: requireInteger(input.id, 'id', 1),
    error: input.error,
    nextAt: requireFiniteNumber(input.nextAt, 'nextAt'),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  };
}

function confirmScheduledPublishedInput(value: unknown): {
  id: number;
  postId: string;
  postUrl: string;
} {
  const input = requireRecord(value);
  return {
    id: requireInteger(input.id, 'id', 1),
    postId: requireString(input.postId, 'postId'),
    postUrl: requireString(input.postUrl, 'postUrl'),
  };
}

function recentPublishedContentsInput(value: unknown): { limit?: number } {
  const input = requireRecord(value);
  const limit = optionalPositiveIntegerField(input, 'limit');
  return limit === undefined ? {} : { limit };
}

function editDraftInput(value: unknown): {
  recordId: number;
  expectedVersion: number;
  patch: PublishDraftEditPatch;
  editor: string;
  expectedAccountId?: string;
} {
  const input = requireRecord(value);
  const patchRecord = requireRecord(input.patch, 'patch');
  for (const field of ['title', 'content', 'visibility'] as const) {
    if (patchRecord[field] !== undefined && typeof patchRecord[field] !== 'string') {
      throw new ApiDirectHttpError(
        'api_direct_invalid_request',
        `patch.${field} must be a string`,
      );
    }
  }
  for (const field of ['topics', 'images'] as const) {
    const item = patchRecord[field];
    if (
      item !== undefined &&
      (!Array.isArray(item) || item.some((entry) => typeof entry !== 'string'))
    ) {
      throw new ApiDirectHttpError(
        'api_direct_invalid_request',
        `patch.${field} must be a string array`,
      );
    }
  }
  if (
    patchRecord.publishMode !== undefined &&
    patchRecord.publishMode !== 'immediate' &&
    patchRecord.publishMode !== 'draft' &&
    patchRecord.publishMode !== 'scheduled'
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'patch.publishMode is invalid',
    );
  }
  if (
    patchRecord.publishTime !== undefined &&
    patchRecord.publishTime !== null &&
    (typeof patchRecord.publishTime !== 'number' ||
      !Number.isFinite(patchRecord.publishTime))
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'patch.publishTime must be a finite epoch or null',
    );
  }
  const patch = patchRecord as PublishDraftEditPatch;
  if (!isJsonValue(patch)) {
    throw new ApiDirectHttpError('api_direct_invalid_request', 'patch must be JSON-safe');
  }
  if (input.expectedAccountId !== undefined && typeof input.expectedAccountId !== 'string') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'expectedAccountId must be a string',
    );
  }
  return {
    recordId: requireInteger(input.recordId, 'recordId', 1),
    expectedVersion: requireInteger(input.expectedVersion, 'expectedVersion'),
    patch,
    editor: requireString(input.editor, 'editor'),
    ...(typeof input.expectedAccountId === 'string'
      ? { expectedAccountId: input.expectedAccountId }
      : {}),
  };
}

function optionalStringField(
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = input[field];
  if (value !== undefined && typeof value !== 'string') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `${field} must be a string`,
    );
  }
  return typeof value === 'string' ? value : undefined;
}

function nullableStringField(
  input: Record<string, unknown>,
  field: string,
): string | null {
  const value = input[field];
  if (value !== null && typeof value !== 'string') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `${field} must be a string or null`,
    );
  }
  return value as string | null;
}

function removeDraftImageInput(value: unknown): PublishDraftImageRemoveCommand {
  const input = requireRecord(value);
  const payload = requireRecord(input.payload, 'payload');
  const session = requireRecord(input.session, 'session');
  const accountId = optionalStringField(session, 'accountId');
  const actor = optionalStringField(session, 'actor');
  return {
    payload: {
      requestId: requireString(payload.requestId, 'payload.requestId'),
      contentVersion: requireInteger(
        payload.contentVersion,
        'payload.contentVersion',
      ),
      imageUrl: requireString(payload.imageUrl, 'payload.imageUrl'),
    },
    session: {
      ...(accountId === undefined ? {} : { accountId }),
      ...(actor === undefined ? {} : { actor }),
    },
  };
}

function approvalDecisionInput(value: unknown): PublishApprovalDecisionCommand {
  const input = requireRecord(value);
  const payload = requireRecord(input.payload, 'payload');
  if (typeof payload.approved !== 'boolean') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'payload.approved must be a boolean',
    );
  }
  if (
    payload.contentVersion !== undefined &&
    !isNonNegativeInteger(payload.contentVersion)
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'payload.contentVersion must be a non-negative integer',
    );
  }
  if (
    payload.publishMode !== undefined &&
    payload.publishMode !== 'immediate' &&
    payload.publishMode !== 'scheduled'
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'payload.publishMode is invalid',
    );
  }
  if (
    payload.publishTime !== undefined &&
    payload.publishTime !== null &&
    (typeof payload.publishTime !== 'number' ||
      !Number.isFinite(payload.publishTime))
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'payload.publishTime must be a finite epoch or null',
    );
  }
  return {
    accountId: requireString(input.accountId, 'accountId'),
    payload: {
      requestId: requireString(payload.requestId, 'payload.requestId'),
      approved: payload.approved,
      ...(payload.contentVersion === undefined
        ? {}
        : { contentVersion: Number(payload.contentVersion) }),
      ...(payload.publishMode === undefined
        ? {}
        : { publishMode: payload.publishMode }),
      ...(payload.publishTime === undefined
        ? {}
        : { publishTime: payload.publishTime as number | null }),
    },
  };
}

function authWriteInput(value: unknown): InteractionAuthWriteAuthorizationInput {
  const input = requireRecord(value);
  const ttlMs = requireFiniteNumber(input.ttlMs, 'ttlMs');
  if (ttlMs <= 0) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'ttlMs must be positive',
    );
  }
  return {
    platform: requireString(input.platform, 'platform'),
    accountId: requireString(input.accountId, 'accountId'),
    envKey: requireString(input.envKey, 'envKey'),
    now: requireFiniteNumber(input.now, 'now'),
    ttlMs,
  };
}

function scopeCheckInput(value: unknown): InteractionScopeCheckInput {
  const input = requireRecord(value);
  return {
    platform: requireString(input.platform, 'platform'),
    accountId: requireString(input.accountId, 'accountId'),
    envKey: requireString(input.envKey, 'envKey'),
  };
}

function auditEventInput(value: unknown): InteractionAuditEventRecord {
  const input = requireRecord(value);
  const configVersion =
    input.configVersion === null
      ? null
      : requireInteger(input.configVersion, 'configVersion');
  const labels = requireRecord(input.labels, 'labels');
  if (!isJsonValue(labels)) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'labels must be JSON-safe',
    );
  }
  return {
    eventId: requireString(input.eventId, 'eventId'),
    platform: requireString(input.platform, 'platform'),
    accountId: requireString(input.accountId, 'accountId'),
    envKey: nullableStringField(input, 'envKey'),
    actor: requireString(input.actor, 'actor'),
    action: requireString(input.action, 'action'),
    configVersion,
    entityType: requireString(input.entityType, 'entityType'),
    entityId: nullableStringField(input, 'entityId'),
    summary: requireString(input.summary, 'summary'),
    labels,
    createdAt: requireFiniteNumber(input.createdAt, 'createdAt'),
  };
}

function accountSinceInput(value: unknown): { accountId: string; since: number } {
  const input = accountIdInput(value);
  return {
    ...input,
    since: requireFiniteNumber((value as Record<string, unknown>).since, 'since'),
  };
}

function jobConfigInput(value: unknown): {
  accountId: string;
  scopeId: string | null | undefined;
  version: number;
} {
  const input = requireRecord(value);
  if (
    input.scopeId !== undefined &&
    input.scopeId !== null &&
    typeof input.scopeId !== 'string'
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'scopeId must be a string, null, or undefined',
    );
  }
  return {
    accountId: requireString(input.accountId, 'accountId'),
    scopeId: input.scopeId as string | null | undefined,
    version: requireInteger(input.version, 'version', 1),
  };
}

function isDispatchDraft(value: unknown): value is DispatchDraft {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.recordId) &&
    typeof value.accountId === 'string' &&
    (value.title === null || typeof value.title === 'string') &&
    typeof value.content === 'string' &&
    Array.isArray(value.imageUrls) &&
    value.imageUrls.every((item) => typeof item === 'string') &&
    isNonNegativeInteger(value.contentVersion)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
}

function isScheduledPublishRecord(
  value: unknown,
): value is ScheduledPublishRecord {
  return (
    isRecord(value)
    && isPositiveInteger(value.recordId)
    && typeof value.accountId === 'string'
    && value.accountId.length > 0
    && typeof value.title === 'string'
    && typeof value.scheduledAt === 'number'
    && Number.isFinite(value.scheduledAt)
    && isNullableString(value.scheduledPlatformId)
    && isNonNegativeInteger(value.reconcileAttempts)
  );
}

function isScheduledReconcileUpdate(
  value: unknown,
): value is ScheduledReconcileUpdate {
  return (
    isRecord(value)
    && (value.status === 'scheduled' || value.status === 'needs_review')
    && isNonNegativeInteger(value.attempts)
  );
}

/**
 * 导出给 `./draft-refinement-http.ts` 复用：精修写口的结果类型是本类型的超集
 * （多两个 `reason`，成功分支逐字相同）。**刻意不在那边另写一份**——两份结构校验
 * 各自编译通过、各自测试通过，漂开的那天没有任何东西会说出来，而它守的正是
 * 「写后真态回读」那一格：判宽了会把畸形响应当成功、把错的版本号写回客户端。
 */
export function isEditDraftResult(value: unknown): value is EditDraftResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (!value.ok) return typeof value.reason === 'string';
  return (
    isNonNegativeInteger(value.contentVersion) &&
    (value.title === null || typeof value.title === 'string') &&
    typeof value.content === 'string' &&
    Array.isArray(value.images) &&
    value.images.every((item) => typeof item === 'string')
  );
}

function isPendingPreview(value: unknown): value is PendingPublishPreview {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.id) &&
    typeof value.accountId === 'string' &&
    typeof value.platform === 'string' &&
    (value.kind === 'rewrite' || value.kind === 'generated') &&
    isNonNegativeInteger(value.contentVersion) &&
    Array.isArray(value.images) &&
    value.images.every((item) => typeof item === 'string')
  );
}

function isPendingApproval(
  value: unknown,
): value is { id: number; title: string | null } {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.id) &&
    isNullableString(value.title)
  );
}

function isLastPublished(
  value: unknown,
): value is { title: string | null; at: number } {
  return (
    isRecord(value) &&
    isNullableString(value.title) &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at)
  );
}

function isImageRemoveResult(value: unknown): value is PublishDraftImageRemoveResult {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    typeof value.ok === 'boolean' &&
    (value.images === undefined ||
      (Array.isArray(value.images) && value.images.every((item) => typeof item === 'string')))
  );
}

function isApprovalDecisionResult(
  value: unknown,
): value is PublishApprovalDecisionResult {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    typeof value.ok === 'boolean'
  );
}

function isAuthAuthorization(
  value: unknown,
): value is InteractionAuthWriteAuthorization {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (!value.ok) return typeof value.reason === 'string';
  return isRecord(value.receipt) && isJsonValue(value.receipt);
}

function isScopeCheck(value: unknown): value is InteractionScopeCheck {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  return value.ok || typeof value.reason === 'string';
}

function isAuditOutcome(
  value: unknown,
): value is { outcome: 'inserted' | 'duplicate' } {
  return (
    isRecord(value) &&
    (value.outcome === 'inserted' || value.outcome === 'duplicate')
  );
}

function isRemovedRows(value: unknown): value is { removedRows: number } {
  return isRecord(value) && isNonNegativeInteger(value.removedRows);
}

function isEffectiveReply(value: unknown): value is EffectiveReplyConfig {
  return (
    isRecord(value) &&
    typeof value.accountId === 'string' &&
    typeof value.mode === 'string' &&
    typeof value.status === 'string' &&
    'snapshot' in value &&
    isJsonValue(value)
  );
}

function isReplySnapshot(value: unknown): value is ReplyConfigSnapshot {
  return (
    isRecord(value) &&
    typeof value.accountId === 'string' &&
    typeof value.platform === 'string' &&
    isNonNegativeInteger(value.configVersion) &&
    (value.state === 'draft' || value.state === 'published') &&
    isJsonValue(value)
  );
}

export function registerAutomationPublishLogRoutes(
  server: InternalHttpServer,
  local: AutomationPublishLogPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(AUTOMATION_PUBLISH_LOG_ROUTES.loadForDispatch, callerToken, (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, recordIdInput);
    return local.loadForDispatch(input.recordId);
  });
  server.registerBearer(
    AUTOMATION_PUBLISH_LOG_ROUTES.updateStatus,
    callerToken,
    async (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, updateStatusInput);
      await local.updateStatus(input.id, input.status);
      return { accepted: true };
    },
  );
  server.registerBearer(
    AUTOMATION_PUBLISH_LOG_ROUTES.updatePostId,
    callerToken,
    async (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, updatePostIdInput);
      await local.updatePostId(input.id, input.postId, input.postUrl);
      return { accepted: true };
    },
  );
  server.registerBearer(
    AUTOMATION_PUBLISH_LOG_ROUTES.markScheduled,
    callerToken,
    async (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, markScheduledInput);
      await local.markScheduled(
        input.id,
        input.scheduledAt,
        input.scheduledPlatformId,
      );
      return { accepted: true };
    },
  );
  server.registerBearer(
    AUTOMATION_PUBLISH_LOG_ROUTES.markImagesAttached,
    callerToken,
    async (args) => {
      const input = parseApiDirectEnvelope(
        args,
        executionTarget,
        markImagesAttachedInput,
      );
      await local.markImagesAttached(input.id, input.count);
      return { accepted: true };
    },
  );
  server.registerBearer(
    AUTOMATION_PUBLISH_LOG_ROUTES.listDueScheduled,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(
        args,
        executionTarget,
        listDueScheduledInput,
      );
      return local.listDueScheduled(input.limit, input.now);
    },
  );
  server.registerBearer(
    AUTOMATION_PUBLISH_LOG_ROUTES.deferScheduledReconcile,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(
        args,
        executionTarget,
        deferScheduledReconcileInput,
      );
      return local.deferScheduledReconcile(
        input.id,
        input.error,
        input.nextAt,
        input.maxAttempts,
      );
    },
  );
  server.registerBearer(
    AUTOMATION_PUBLISH_LOG_ROUTES.confirmScheduledPublished,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(
        args,
        executionTarget,
        confirmScheduledPublishedInput,
      );
      return local.confirmScheduledPublished(
        input.id,
        input.postId,
        input.postUrl,
      );
    },
  );
  server.registerBearer(
    AUTOMATION_PUBLISH_LOG_ROUTES.getMostRecentPublishTime,
    callerToken,
    (args) => {
      parseApiDirectEnvelope(args, executionTarget, requireRecord);
      return local.getMostRecentPublishTime();
    },
  );
  server.registerBearer(
    AUTOMATION_PUBLISH_LOG_ROUTES.recentPublishedContents,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(
        args,
        executionTarget,
        recentPublishedContentsInput,
      );
      return local.recentPublishedContents(input.limit);
    },
  );
  server.registerBearer(AUTOMATION_PUBLISH_LOG_ROUTES.editDraft, callerToken, (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, editDraftInput);
    return local.editDraft(
      input.recordId,
      input.expectedVersion,
      input.patch,
      input.editor,
      input.expectedAccountId,
    );
  });
  server.registerBearer(
    AUTOMATION_PUBLISH_LOG_ROUTES.rejectPendingApproval,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, recordIdInput);
      return local.rejectPendingApproval(input.recordId);
    },
  );
  for (const [route, method] of [
    [
      AUTOMATION_PUBLISH_LOG_ROUTES.pendingApprovalForAccount,
      local.pendingApprovalForAccount.bind(local),
    ],
    [
      AUTOMATION_PUBLISH_LOG_ROUTES.pendingPublishPreviewForAccount,
      local.pendingPublishPreviewForAccount.bind(local),
    ],
    [
      AUTOMATION_PUBLISH_LOG_ROUTES.lastPublishedForAccount,
      local.lastPublishedForAccount.bind(local),
    ],
    [
      AUTOMATION_PUBLISH_LOG_ROUTES.countPendingForAccount,
      local.countPendingForAccount.bind(local),
    ],
    [
      AUTOMATION_PUBLISH_LOG_ROUTES.countPendingAutonomousForAccount,
      local.countPendingAutonomousForAccount.bind(local),
    ],
    [
      AUTOMATION_PUBLISH_LOG_ROUTES.countPublishedTodayForAccount,
      local.countPublishedTodayForAccount.bind(local),
    ],
  ] as const) {
    server.registerBearer(route, callerToken, (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, accountIdInput);
      return method(input.accountId);
    });
  }
  server.registerBearer(
    AUTOMATION_PUBLISH_LOG_ROUTES.countPublishedSinceForAccount,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, accountSinceInput);
      return local.countPublishedSinceForAccount(input.accountId, input.since);
    },
  );
}

export function registerEdgePublishCommandRoutes(
  server: InternalHttpServer,
  local: EdgePublishCommandPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(EDGE_PUBLISH_COMMAND_ROUTES.removeDraftImage, callerToken, (args) =>
    local.removeDraftImage(
      parseApiDirectEnvelope(args, executionTarget, removeDraftImageInput),
    ));
  server.registerBearer(EDGE_PUBLISH_COMMAND_ROUTES.decidePublishApproval, callerToken, (args) =>
    local.decidePublishApproval(
      parseApiDirectEnvelope(args, executionTarget, approvalDecisionInput),
    ));
}

export function registerInteractionAuthRoutes(
  server: InternalHttpServer,
  local: InteractionAuthAuthorityPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(INTERACTION_AUTH_ROUTES.authorizeAuthStateWrite, callerToken, (args) =>
    local.authorizeAuthStateWrite(
      parseApiDirectEnvelope(args, executionTarget, authWriteInput),
    ));
  server.registerBearer(INTERACTION_AUTH_ROUTES.checkAccountScope, callerToken, (args) =>
    local.checkAccountScope(
      parseApiDirectEnvelope(args, executionTarget, scopeCheckInput),
    ));
}

export function registerInteractionApiWritesRoutes(
  server: InternalHttpServer,
  local: InteractionApiWritesPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(INTERACTION_API_WRITES_ROUTES.insertAuditEvent, callerToken, (args) =>
    local.insertAuditEvent(
      parseApiDirectEnvelope(args, executionTarget, auditEventInput),
    ));
  server.registerBearer(
    INTERACTION_API_WRITES_ROUTES.purgeReplyConfigForAccount,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, accountIdInput);
      return local.purgeReplyConfigForAccount(input.accountId);
    },
  );
  server.registerBearer(
    INTERACTION_API_WRITES_ROUTES.purgeExpiredAuditEvents,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, (value) => {
        const record = requireRecord(value);
        return { now: requireFiniteNumber(record.now, 'now') };
      });
      return local.purgeExpiredAuditEvents(input.now);
    },
  );
}

export function registerReplyConfigResolverRoutes(
  server: InternalHttpServer,
  local: ReplyConfigResolverPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(REPLY_CONFIG_RESOLVER_ROUTES.resolve, callerToken, (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, accountIdInput);
    return local.resolve(input.accountId);
  });
  server.registerBearer(REPLY_CONFIG_RESOLVER_ROUTES.getPublished, callerToken, (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, accountIdInput);
    return local.getPublished(input.accountId);
  });
  server.registerBearer(REPLY_CONFIG_RESOLVER_ROUTES.getSnapshotForJob, callerToken, (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, jobConfigInput);
    return local.getSnapshotForJob(input.accountId, input.scopeId, input.version);
  });
}

export class AutomationPublishLogHttpClient implements AutomationPublishLogPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  loadForDispatch(recordId: number): Promise<DispatchDraft | null> {
    return callApiDirectRead(
      this.http, AUTOMATION_PUBLISH_LOG_ROUTES.loadForDispatch, this.callerToken,
      this.executionTarget, { recordId },
      (value): value is DispatchDraft | null => value === null || isDispatchDraft(value),
    );
  }

  async updateStatus(id: number, status: PublishStatus): Promise<void> {
    await callApiDirectWrite(
      this.http,
      AUTOMATION_PUBLISH_LOG_ROUTES.updateStatus,
      this.callerToken,
      this.executionTarget,
      { id, status },
      isVoidAck,
    );
  }

  async updatePostId(
    id: number,
    postId: string,
    postUrl?: string | null,
  ): Promise<void> {
    await callApiDirectWrite(
      this.http,
      AUTOMATION_PUBLISH_LOG_ROUTES.updatePostId,
      this.callerToken,
      this.executionTarget,
      { id, postId, ...(postUrl === undefined ? {} : { postUrl }) },
      isVoidAck,
    );
  }

  async markScheduled(
    id: number,
    scheduledAt: number,
    scheduledPlatformId?: string | null,
  ): Promise<void> {
    await callApiDirectWrite(
      this.http,
      AUTOMATION_PUBLISH_LOG_ROUTES.markScheduled,
      this.callerToken,
      this.executionTarget,
      {
        id,
        scheduledAt,
        ...(scheduledPlatformId === undefined ? {} : { scheduledPlatformId }),
      },
      isVoidAck,
    );
  }

  async markImagesAttached(id: number, count: number): Promise<void> {
    await callApiDirectWrite(
      this.http,
      AUTOMATION_PUBLISH_LOG_ROUTES.markImagesAttached,
      this.callerToken,
      this.executionTarget,
      { id, count },
      isVoidAck,
    );
  }

  listDueScheduled(
    limit?: number,
    now?: number,
  ): Promise<ScheduledPublishRecord[]> {
    return callApiDirectRead(
      this.http,
      AUTOMATION_PUBLISH_LOG_ROUTES.listDueScheduled,
      this.callerToken,
      this.executionTarget,
      {
        ...(limit === undefined ? {} : { limit }),
        ...(now === undefined ? {} : { now }),
      },
      (value): value is ScheduledPublishRecord[] =>
        Array.isArray(value) && value.every(isScheduledPublishRecord),
    );
  }

  deferScheduledReconcile(
    id: number,
    error: string,
    nextAt: number,
    maxAttempts?: number,
  ): Promise<ScheduledReconcileUpdate | null> {
    return callApiDirectWrite(
      this.http,
      AUTOMATION_PUBLISH_LOG_ROUTES.deferScheduledReconcile,
      this.callerToken,
      this.executionTarget,
      {
        id,
        error,
        nextAt,
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
      },
      (value): value is ScheduledReconcileUpdate | null =>
        value === null || isScheduledReconcileUpdate(value),
    );
  }

  confirmScheduledPublished(
    id: number,
    postId: string,
    postUrl: string,
  ): Promise<boolean> {
    return callApiDirectWrite(
      this.http,
      AUTOMATION_PUBLISH_LOG_ROUTES.confirmScheduledPublished,
      this.callerToken,
      this.executionTarget,
      { id, postId, postUrl },
      (value): value is boolean => typeof value === 'boolean',
    );
  }

  getMostRecentPublishTime(): Promise<number | null> {
    return callApiDirectRead(
      this.http,
      AUTOMATION_PUBLISH_LOG_ROUTES.getMostRecentPublishTime,
      this.callerToken,
      this.executionTarget,
      {},
      (value): value is number | null =>
        value === null || (typeof value === 'number' && Number.isFinite(value)),
    );
  }

  recentPublishedContents(limit?: number): Promise<string[]> {
    return callApiDirectRead(
      this.http,
      AUTOMATION_PUBLISH_LOG_ROUTES.recentPublishedContents,
      this.callerToken,
      this.executionTarget,
      limit === undefined ? {} : { limit },
      (value): value is string[] =>
        Array.isArray(value) && value.every((item) => typeof item === 'string'),
    );
  }

  editDraft(
    recordId: number,
    expectedVersion: number,
    patch: PublishDraftEditPatch,
    editor: string,
    expectedAccountId?: string,
  ): Promise<EditDraftResult> {
    return callApiDirectWrite(
      this.http, AUTOMATION_PUBLISH_LOG_ROUTES.editDraft, this.callerToken,
      this.executionTarget,
      { recordId, expectedVersion, patch, editor, ...(expectedAccountId ? { expectedAccountId } : {}) },
      isEditDraftResult,
    );
  }

  rejectPendingApproval(recordId: number): Promise<boolean> {
    return callApiDirectWrite(
      this.http, AUTOMATION_PUBLISH_LOG_ROUTES.rejectPendingApproval, this.callerToken,
      this.executionTarget, { recordId },
      (value): value is boolean => typeof value === 'boolean',
    );
  }

  pendingApprovalForAccount(
    accountId: string,
  ): Promise<{ id: number; title: string | null } | null> {
    return callApiDirectRead(
      this.http, AUTOMATION_PUBLISH_LOG_ROUTES.pendingApprovalForAccount, this.callerToken,
      this.executionTarget, { accountId },
      (value): value is { id: number; title: string | null } | null =>
        value === null || isPendingApproval(value),
    );
  }

  pendingPublishPreviewForAccount(accountId: string): Promise<PendingPublishPreview | null> {
    return callApiDirectRead(
      this.http, AUTOMATION_PUBLISH_LOG_ROUTES.pendingPublishPreviewForAccount, this.callerToken,
      this.executionTarget, { accountId },
      (value): value is PendingPublishPreview | null => value === null || isPendingPreview(value),
    );
  }

  lastPublishedForAccount(
    accountId: string,
  ): Promise<{ title: string | null; at: number } | null> {
    return callApiDirectRead(
      this.http, AUTOMATION_PUBLISH_LOG_ROUTES.lastPublishedForAccount, this.callerToken,
      this.executionTarget, { accountId },
      (value): value is { title: string | null; at: number } | null =>
        value === null || isLastPublished(value),
    );
  }

  countPendingForAccount(accountId: string): Promise<number> {
    return this.count(AUTOMATION_PUBLISH_LOG_ROUTES.countPendingForAccount, accountId);
  }

  countPendingAutonomousForAccount(accountId: string): Promise<number> {
    return this.count(AUTOMATION_PUBLISH_LOG_ROUTES.countPendingAutonomousForAccount, accountId);
  }

  countPublishedTodayForAccount(accountId: string): Promise<number> {
    return this.count(AUTOMATION_PUBLISH_LOG_ROUTES.countPublishedTodayForAccount, accountId);
  }

  countPublishedSinceForAccount(accountId: string, since: number): Promise<number> {
    return callApiDirectRead(
      this.http, AUTOMATION_PUBLISH_LOG_ROUTES.countPublishedSinceForAccount, this.callerToken,
      this.executionTarget, { accountId, since }, isNonNegativeInteger,
    );
  }

  private count(route: string, accountId: string): Promise<number> {
    return callApiDirectRead(
      this.http, route, this.callerToken, this.executionTarget, { accountId },
      isNonNegativeInteger,
    );
  }
}

export class EdgePublishCommandHttpClient implements EdgePublishCommandPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  removeDraftImage(
    input: PublishDraftImageRemoveCommand,
  ): Promise<PublishDraftImageRemoveResult> {
    return callApiDirectWrite(
      this.http, EDGE_PUBLISH_COMMAND_ROUTES.removeDraftImage, this.callerToken,
      this.executionTarget, input, isImageRemoveResult,
    );
  }

  decidePublishApproval(
    input: PublishApprovalDecisionCommand,
  ): Promise<PublishApprovalDecisionResult> {
    return callApiDirectWrite(
      this.http, EDGE_PUBLISH_COMMAND_ROUTES.decidePublishApproval, this.callerToken,
      this.executionTarget, input, isApprovalDecisionResult,
    );
  }
}

export class InteractionAuthHttpClient implements InteractionAuthAuthorityPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  authorizeAuthStateWrite(
    input: InteractionAuthWriteAuthorizationInput,
  ): Promise<InteractionAuthWriteAuthorization> {
    return callApiDirectRead(
      this.http, INTERACTION_AUTH_ROUTES.authorizeAuthStateWrite, this.callerToken,
      this.executionTarget, input, isAuthAuthorization,
    );
  }

  checkAccountScope(input: InteractionScopeCheckInput): Promise<InteractionScopeCheck> {
    return callApiDirectRead(
      this.http, INTERACTION_AUTH_ROUTES.checkAccountScope, this.callerToken,
      this.executionTarget, input, isScopeCheck,
    );
  }
}

export class InteractionApiWritesHttpClient implements InteractionApiWritesPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  insertAuditEvent(
    record: InteractionAuditEventRecord,
  ): Promise<{ outcome: 'inserted' | 'duplicate' }> {
    return callApiDirectWrite(
      this.http, INTERACTION_API_WRITES_ROUTES.insertAuditEvent, this.callerToken,
      this.executionTarget, record, isAuditOutcome,
    );
  }

  purgeReplyConfigForAccount(accountId: string): Promise<{ removedRows: number }> {
    return callApiDirectWrite(
      this.http, INTERACTION_API_WRITES_ROUTES.purgeReplyConfigForAccount, this.callerToken,
      this.executionTarget, { accountId }, isRemovedRows,
    );
  }

  purgeExpiredAuditEvents(now: number): Promise<{ removedRows: number }> {
    return callApiDirectWrite(
      this.http, INTERACTION_API_WRITES_ROUTES.purgeExpiredAuditEvents, this.callerToken,
      this.executionTarget, { now }, isRemovedRows,
    );
  }
}

export class ReplyConfigResolverHttpClient implements ReplyConfigResolverPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  resolve(accountId: string): Promise<EffectiveReplyConfig> {
    return callApiDirectRead(
      this.http, REPLY_CONFIG_RESOLVER_ROUTES.resolve, this.callerToken,
      this.executionTarget, { accountId }, isEffectiveReply,
    );
  }

  getPublished(accountId: string): Promise<ReplyConfigSnapshot | null> {
    return callApiDirectRead(
      this.http, REPLY_CONFIG_RESOLVER_ROUTES.getPublished, this.callerToken,
      this.executionTarget, { accountId },
      (value): value is ReplyConfigSnapshot | null => value === null || isReplySnapshot(value),
    );
  }

  getSnapshotForJob(
    accountId: string,
    scopeId: string | null | undefined,
    version: number,
  ): Promise<ReplyConfigSnapshot | null> {
    return callApiDirectRead(
      this.http, REPLY_CONFIG_RESOLVER_ROUTES.getSnapshotForJob, this.callerToken,
      this.executionTarget, { accountId, scopeId, version },
      (value): value is ReplyConfigSnapshot | null => value === null || isReplySnapshot(value),
    );
  }
}
