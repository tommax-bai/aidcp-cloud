import {
  INTERACTION_PLATFORM,
  RISK_TAGS,
  type EffectiveCapabilities,
  type InteractionAuthStatusPayload,
  type InteractionChannel,
  type InteractionMessageType,
  type InteractionOffboardResultPayload,
  type InteractionReplyReconcileResultPayload,
  type InteractionReplyResultPayload,
  type InteractionSyncBatchPayload,
  type RiskTag,
  type SyncMessage,
  type SyncThread,
} from './types.js';

const CHANNELS = new Set<InteractionChannel>(['comment', 'dm']);
const MESSAGE_TYPES = new Set<InteractionMessageType>(['text', 'image', 'unknown']);
const RISK_TAG_SET = new Set<RiskTag>(RISK_TAGS);
const AUTH_STATUSES = new Set([
  'login_required', 'authenticating', 'active', 'reauth_required',
  'challenge_required', 'degraded', 'disabled',
]);
const BROWSER_STATES = new Set(['closed', 'opening', 'open', 'closing', 'unavailable']);
const AUTH_REASON_CODES = new Set([
  'WECHAT_AUTH_REQUIRED', 'WECHAT_CHALLENGE_REQUIRED', 'WECHAT_IDENTITY_MISMATCH',
  'WECHAT_RATE_LIMITED', 'WECHAT_PERMISSION_DENIED', 'WECHAT_SCHEMA_CHANGED',
  'INTERACTION_FEATURE_DISABLED', 'INTERACTION_UPSTREAM_UNAVAILABLE',
]);
const ERROR_CATEGORIES = new Set([
  'auth_expired', 'challenge_required', 'identity_mismatch', 'rate_limited', 'permission_denied',
  'schema_changed', 'transient_network', 'unsupported_message_type', 'invalid_scope', 'invalid_command',
  'expired_command', 'platform_rejected', 'verification_failed', 'internal_error',
]);
const ERROR_CODES = new Set([
  'INTERACTION_AUTH_REQUIRED', 'INTERACTION_PERMISSION_DENIED', 'INTERACTION_NOT_FOUND',
  'INTERACTION_SCOPE_MISMATCH', 'INTERACTION_VERSION_CONFLICT', 'INTERACTION_STATE_CONFLICT',
  'INTERACTION_VALIDATION_FAILED', 'INTERACTION_CONFIG_MISSING', 'INTERACTION_APPROVAL_REQUIRED',
  'INTERACTION_SEND_AMBIGUOUS', 'INTERACTION_UNSUPPORTED_MESSAGE_TYPE', 'INTERACTION_FEATURE_DISABLED',
  'INTERACTION_RATE_LIMITED', 'INTERACTION_UPSTREAM_UNAVAILABLE', 'INTERACTION_INTERNAL_ERROR',
  'WECHAT_AUTH_REQUIRED', 'WECHAT_CHALLENGE_REQUIRED', 'WECHAT_IDENTITY_MISMATCH',
  'WECHAT_RATE_LIMITED', 'WECHAT_PERMISSION_DENIED', 'WECHAT_SCHEMA_CHANGED',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => key in value);
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256;
}

function nullableId(value: unknown): value is string | null {
  return value === null || id(value);
}

function nullableText(value: unknown, max = 4096): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= max);
}

function timestamp(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function capabilities(value: unknown): value is EffectiveCapabilities {
  if (!isRecord(value)) return false;
  if (!exactKeys(value, ['commentsRead', 'commentsReply', 'dmRead', 'dmSendText', 'dmSendImage'])) return false;
  return (
    typeof value.commentsRead === 'boolean' &&
    typeof value.commentsReply === 'boolean' &&
    typeof value.dmRead === 'boolean' &&
    typeof value.dmSendText === 'boolean' &&
    value.dmSendImage === false
  );
}

function participant(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || !exactKeys(value, ['externalId', 'displayName', 'avatarUrl'])) return false;
  return id(value.externalId) && nullableText(value.displayName) && nullableText(value.avatarUrl, 2048);
}

function syncThread(value: unknown): value is SyncThread {
  if (!isRecord(value)) return false;
  if (!exactKeys(value, ['externalThreadId', 'sourceExternalId', 'sourceTitle', 'sourceCoverUrl', 'participant', 'updatedAt'])) return false;
  return (
    id(value.externalThreadId) &&
    nullableId(value.sourceExternalId) &&
    nullableText(value.sourceTitle) &&
    nullableText(value.sourceCoverUrl, 2048) &&
    participant(value.participant) &&
    timestamp(value.updatedAt)
  );
}

function attachment(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || !exactKeys(value, ['mimeType', 'width', 'height', 'url'])) return false;
  const dimension = (v: unknown): boolean => v === null || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 50_000);
  return nullableText(value.mimeType) && dimension(value.width) && dimension(value.height) && nullableText(value.url, 2048);
}

function sanitizedMeta(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length > 32) return false;
  return Object.values(value).every(
    (v) => v === null || typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 512),
  );
}

function syncMessage(value: unknown): value is SyncMessage {
  if (!isRecord(value)) return false;
  if (!exactKeys(value, [
    'externalThreadId', 'externalMessageId', 'direction', 'externalParentId', 'externalRootId',
    'messageType', 'contentText', 'attachmentMeta', 'lifecycle', 'platformCreatedAt', 'rawMetaSanitized',
  ])) return false;
  return (
    id(value.externalThreadId) && id(value.externalMessageId) &&
    (value.direction === 'inbound' || value.direction === 'outbound') &&
    nullableId(value.externalParentId) && nullableId(value.externalRootId) &&
    MESSAGE_TYPES.has(value.messageType as InteractionMessageType) &&
    nullableText(value.contentText) && attachment(value.attachmentMeta) &&
    (value.lifecycle === 'active' || value.lifecycle === 'deleted' || value.lifecycle === 'hidden') &&
    timestamp(value.platformCreatedAt) && sanitizedMeta(value.rawMetaSanitized)
  );
}

export function parseSyncBatchPayload(value: unknown): InteractionSyncBatchPayload | null {
  if (!isRecord(value)) return null;
  if (!exactKeys(value, [
    'batchId', 'requestId', 'envKey', 'accountId', 'platform', 'channel', 'scopeExternalId',
    'cursorBefore', 'cursorAfter', 'hasMore', 'threads', 'messages', 'observedAt',
  ])) return null;
  if (
    !id(value.batchId) || !nullableId(value.requestId) || !id(value.envKey) || !id(value.accountId) ||
    value.platform !== INTERACTION_PLATFORM || !CHANNELS.has(value.channel as InteractionChannel) ||
    !nullableId(value.scopeExternalId) || !nullableText(value.cursorBefore) || !nullableText(value.cursorAfter) ||
    typeof value.hasMore !== 'boolean' || !Array.isArray(value.threads) || value.threads.length > 200 ||
    !Array.isArray(value.messages) || value.messages.length > 1000 || !timestamp(value.observedAt) ||
    !value.threads.every(syncThread) || !value.messages.every(syncMessage)
  ) return null;
  const threadIds = new Set(value.threads.map((thread) => thread.externalThreadId));
  if (value.messages.some((message) => !threadIds.has(message.externalThreadId))) return null;
  return value as unknown as InteractionSyncBatchPayload;
}

export function parseAuthStatusPayload(value: unknown): InteractionAuthStatusPayload | null {
  if (!isRecord(value)) return null;
  if (!exactKeys(value, [
    'envKey', 'accountId', 'platform', 'status', 'browserState', 'capabilities',
    'identity', 'checkedAt', 'reasonCode',
  ])) return null;
  if (
    !id(value.envKey) || !id(value.accountId) || value.platform !== INTERACTION_PLATFORM ||
    !AUTH_STATUSES.has(value.status as string) || !BROWSER_STATES.has(value.browserState as string) ||
    !capabilities(value.capabilities) || !timestamp(value.checkedAt) ||
    !(value.reasonCode === null || AUTH_REASON_CODES.has(value.reasonCode as string))
  ) return null;
  if (value.identity !== null) {
    if (!isRecord(value.identity) || !exactKeys(value.identity, ['externalId', 'displayName', 'identityHash'])) return null;
    if (
      !id(value.identity.externalId) || typeof value.identity.displayName !== 'string' ||
      value.identity.displayName.length < 1 || value.identity.displayName.length > 256 ||
      typeof value.identity.identityHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.identity.identityHash)
    ) return null;
  }
  return value as unknown as InteractionAuthStatusPayload;
}

export function parseReplyResultPayload(value: unknown): InteractionReplyResultPayload | null {
  if (!isRecord(value)) return null;
  if (!exactKeys(value, [
    'jobId', 'attemptId', 'idempotencyKey', 'envKey', 'accountId', 'platform', 'channel',
    'status', 'externalMessageId', 'errorCategory', 'errorCode', 'verification', 'retryAfterMs', 'finishedAt',
  ])) return null;
  const status = value.status;
  const verification = value.verification;
  if (
    !id(value.jobId) || !id(value.attemptId) || typeof value.idempotencyKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.idempotencyKey) || !id(value.envKey) || !id(value.accountId) ||
    value.platform !== INTERACTION_PLATFORM || !CHANNELS.has(value.channel as InteractionChannel) ||
    !['confirmed', 'failed', 'ambiguous'].includes(status as string) || !nullableId(value.externalMessageId) ||
    !(value.errorCategory === null || ERROR_CATEGORIES.has(value.errorCategory as string)) ||
    !(value.errorCode === null || ERROR_CODES.has(value.errorCode as string)) ||
    !['platform_ack', 'history_lookup', 'comment_lookup', 'not_verified'].includes(verification as string) ||
    !(value.retryAfterMs === null || timestamp(value.retryAfterMs)) || !timestamp(value.finishedAt)
  ) return null;
  if (status === 'confirmed') {
    if (value.errorCategory !== null || value.errorCode !== null || verification === 'not_verified') return null;
  } else if (value.errorCategory === null || value.errorCode === null) {
    return null;
  }
  return value as unknown as InteractionReplyResultPayload;
}

export function parseReplyReconcileResultPayload(value: unknown): InteractionReplyReconcileResultPayload | null {
  if (!isRecord(value) || !exactKeys(value, ['reconcileId', 'envKey', 'accountId', 'platform', 'attempts', 'finishedAt'])) {
    return null;
  }
  if (!id(value.reconcileId) || !id(value.envKey) || !id(value.accountId) || value.platform !== INTERACTION_PLATFORM ||
      !Array.isArray(value.attempts) || value.attempts.length < 1 || value.attempts.length > 100 ||
      !timestamp(value.finishedAt)) return null;
  for (const item of value.attempts) {
    if (!isRecord(item) || !exactKeys(item, ['jobId', 'attemptId', 'idempotencyKey', 'state', 'observedAt']) ||
        !id(item.jobId) || !id(item.attemptId) || typeof item.idempotencyKey !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.idempotencyKey) ||
        !['result_replayed', 'not_found', 'binding_conflict'].includes(item.state as string) ||
        !timestamp(item.observedAt)) return null;
  }
  return value as unknown as InteractionReplyReconcileResultPayload;
}

export function parseOffboardResultPayload(value: unknown): InteractionOffboardResultPayload | null {
  if (!isRecord(value) || !exactKeys(value,
    ['offboardId', 'envKey', 'accountId', 'platform', 'status', 'errorCode', 'finishedAt'])) return null;
  if (!id(value.offboardId) || !id(value.envKey) || !id(value.accountId) || value.platform !== INTERACTION_PLATFORM ||
      !['cleared', 'already_cleared', 'failed'].includes(value.status as string) ||
      !(value.errorCode === null || ERROR_CODES.has(value.errorCode as string)) || !timestamp(value.finishedAt)) return null;
  if (value.status === 'failed' ? value.errorCode === null : value.errorCode !== null) return null;
  return value as unknown as InteractionOffboardResultPayload;
}

export function isRiskTag(value: unknown): value is RiskTag {
  return typeof value === 'string' && RISK_TAG_SET.has(value as RiskTag);
}
