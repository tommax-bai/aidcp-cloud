/** Frozen wechat-channels interaction contract v1 (control commit a678003). */

export const INTERACTION_PLATFORM = 'wechat_channels' as const;
export const INTERACTION_CAPABILITY = 'interaction_inbox_v1' as const;
export const INTERACTION_REPLY_RECOVERY_CAPABILITY = 'interaction_reply_recovery_v1' as const;
export const INTERACTION_OFFBOARDING_CAPABILITY = 'interaction_offboarding_v1' as const;
export const INTERACTION_RUNTIME_CONTROLS_CAPABILITY = 'interaction_runtime_controls_v1' as const;
export const INTERACTION_BROWSER_CONTROL_CAPABILITY = 'interaction_browser_control_v1' as const;
export const INTERACTION_TEST_DATA_RESET_CAPABILITY = 'interaction_test_data_reset_v1' as const;

export type InteractionPlatform = typeof INTERACTION_PLATFORM;
export type InteractionChannel = 'comment' | 'dm';
export type InteractionDirection = 'inbound' | 'outbound';
export type InteractionMessageType = 'text' | 'image' | 'unknown';
export type MessageLifecycle = 'active' | 'deleted' | 'hidden';
export type ThreadStatus = 'open' | 'waiting_review' | 'replied' | 'escalated' | 'closed';
export type ReplyJobState =
  | 'new'
  | 'classifying'
  | 'draft_ready'
  | 'approval_required'
  | 'approved'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'ambiguous'
  | 'ignored'
  | 'escalated';
export type SendAttemptStatus = 'created' | 'dispatched' | 'confirmed' | 'failed' | 'ambiguous';
export type VerificationStatus = 'not_needed' | 'pending' | 'confirmed' | 'not_found';
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';
export type RiskTag =
  | 'order'
  | 'refund'
  | 'after_sales'
  | 'pricing'
  | 'promotion'
  | 'inventory'
  | 'shipping'
  | 'personal_data'
  | 'complaint'
  | 'dispute'
  | 'legal'
  | 'medical'
  | 'safety'
  | 'abuse'
  | 'minor_safety'
  | 'meaning_changed'
  | 'introduced_claim'
  | 'unknown';

export const RISK_TAGS: readonly RiskTag[] = [
  'order', 'refund', 'after_sales', 'pricing', 'promotion', 'inventory', 'shipping',
  'personal_data', 'complaint', 'dispute', 'legal', 'medical', 'safety', 'abuse',
  'minor_safety', 'meaning_changed', 'introduced_claim', 'unknown',
];

export type InteractionErrorCode =
  | 'INTERACTION_AUTH_REQUIRED'
  | 'INTERACTION_BROWSER_PROFILE_IN_USE'
  | 'INTERACTION_PERMISSION_DENIED'
  | 'INTERACTION_NOT_FOUND'
  | 'INTERACTION_SCOPE_MISMATCH'
  | 'INTERACTION_VERSION_CONFLICT'
  | 'INTERACTION_STATE_CONFLICT'
  | 'INTERACTION_VALIDATION_FAILED'
  | 'INTERACTION_CONFIG_MISSING'
  | 'INTERACTION_APPROVAL_REQUIRED'
  | 'INTERACTION_SEND_AMBIGUOUS'
  | 'INTERACTION_UNSUPPORTED_MESSAGE_TYPE'
  | 'INTERACTION_FEATURE_DISABLED'
  | 'INTERACTION_RATE_LIMITED'
  | 'INTERACTION_UPSTREAM_UNAVAILABLE'
  | 'INTERACTION_TEST_RESET_PARTIAL'
  | 'INTERACTION_INTERNAL_ERROR'
  | 'WECHAT_AUTH_REQUIRED'
  | 'WECHAT_CHALLENGE_REQUIRED'
  | 'WECHAT_IDENTITY_MISMATCH'
  | 'WECHAT_RATE_LIMITED'
  | 'WECHAT_PERMISSION_DENIED'
  | 'WECHAT_SCHEMA_CHANGED';

export class InteractionError extends Error {
  constructor(
    public readonly code: InteractionErrorCode,
    message: string,
    public readonly httpStatus: number,
    public readonly retryable = false,
    public readonly details?: {
      currentVersion?: number;
      currentState?: ReplyJobState;
      retryAfterMs?: number;
      issues?: ValidationIssue[];
      reason?: string;
    },
  ) {
    super(message);
    this.name = 'InteractionError';
  }
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface ParticipantSnapshot {
  externalId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface AttachmentMeta {
  mimeType: string | null;
  width: number | null;
  height: number | null;
  url: string | null;
}

export interface SyncThread {
  externalThreadId: string;
  sourceExternalId: string | null;
  sourceTitle: string | null;
  sourceCoverUrl: string | null;
  participant: ParticipantSnapshot | null;
  updatedAt: number;
}

export interface SyncMessage {
  externalThreadId: string;
  externalMessageId: string;
  direction: InteractionDirection;
  externalParentId: string | null;
  externalRootId: string | null;
  messageType: InteractionMessageType;
  contentText: string | null;
  attachmentMeta: AttachmentMeta | null;
  lifecycle: MessageLifecycle;
  platformCreatedAt: number;
  rawMetaSanitized: Record<string, string | number | boolean | null>;
}

export interface InteractionSyncBatchPayload {
  batchId: string;
  requestId: string | null;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  channel: InteractionChannel;
  scopeExternalId: string | null;
  cursorBefore: string | null;
  cursorAfter: string | null;
  hasMore: boolean;
  threads: SyncThread[];
  messages: SyncMessage[];
  observedAt: number;
}

export interface InteractionSyncAckPayload {
  batchId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  channel: InteractionChannel;
  scopeExternalId: string | null;
  status: 'accepted' | 'duplicate' | 'rejected';
  cursorAfter: string | null;
  persisted: { threads: number; messages: number };
  errorCode: InteractionErrorCode | null;
  receivedAt: number;
}

export interface EffectiveCapabilities {
  commentsRead: boolean;
  commentsReply: boolean;
  dmRead: boolean;
  dmSendText: boolean;
  dmSendImage: false;
}

export type InteractionAuthStatus =
  | 'login_required'
  | 'authenticating'
  | 'active'
  | 'reauth_required'
  | 'challenge_required'
  | 'degraded'
  | 'disabled';
export type InteractionBrowserState = 'closed' | 'opening' | 'open' | 'closing' | 'unavailable';

export interface InteractionAuthStatusPayload {
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  status: InteractionAuthStatus;
  browserState: InteractionBrowserState;
  capabilities: EffectiveCapabilities;
  runtimeControlsVersion: number | null;
  identity: { externalId: string; displayName: string; identityHash: string } | null;
  checkedAt: number;
  reasonCode: InteractionErrorCode | null;
}

export interface InteractionSyncRequestPayload {
  requestId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  channel: InteractionChannel;
  scopeExternalId: string | null;
  reason: 'user_requested' | 'resume' | 'scheduled' | 'recovery' | 'test_reset';
  requestedAt: number;
}

export interface InteractionAuthReopenPayload {
  requestId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  reason: 'user_requested' | 'auth_expired' | 'identity_mismatch' | 'challenge_required';
  requestedAt: number;
}

export interface InteractionBrowserControlPayload {
  requestId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  action: 'open' | 'close';
  requestedAt: number;
}

export interface InteractionReplySendPayload {
  jobId: string;
  attemptId: string;
  idempotencyKey: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  channel: InteractionChannel;
  target: {
    threadExternalId: string;
    inboundMessageExternalId: string;
    parentExternalId: string | null;
  };
  content: { type: 'text'; text: string };
  expiresAt: number;
}

export type InteractionReplyErrorCategory =
  | 'auth_expired'
  | 'challenge_required'
  | 'identity_mismatch'
  | 'rate_limited'
  | 'permission_denied'
  | 'schema_changed'
  | 'transient_network'
  | 'unsupported_message_type'
  | 'invalid_scope'
  | 'invalid_command'
  | 'expired_command'
  | 'platform_rejected'
  | 'verification_failed'
  | 'internal_error';

export interface InteractionReplyResultPayload {
  jobId: string;
  attemptId: string;
  idempotencyKey: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  channel: InteractionChannel;
  status: 'confirmed' | 'failed' | 'ambiguous';
  externalMessageId: string | null;
  errorCategory: InteractionReplyErrorCategory | null;
  errorCode: InteractionErrorCode | null;
  verification: 'platform_ack' | 'history_lookup' | 'comment_lookup' | 'not_verified';
  retryAfterMs: number | null;
  finishedAt: number;
}

export interface InteractionReplyResultAckPayload {
  jobId: string;
  attemptId: string;
  idempotencyKey: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  status: 'accepted' | 'duplicate' | 'rejected';
  errorCode: InteractionErrorCode | null;
  receivedAt: number;
}

export interface InteractionReplyReconcilePayload {
  reconcileId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  attempts: Array<{
    cloudStatus: 'created' | 'dispatched' | 'ambiguous';
    command: InteractionReplySendPayload;
  }>;
  requestedAt: number;
}

export interface InteractionReplyReconcileResultPayload {
  reconcileId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  attempts: Array<{
    jobId: string;
    attemptId: string;
    idempotencyKey: string;
    state: 'result_replayed' | 'not_found' | 'binding_conflict';
    observedAt: number;
  }>;
  finishedAt: number;
}

export type InteractionOffboardReason = 'environment_unbind' | 'customer_terminated' | 'admin_revoked';

export interface InteractionOffboardCommandPayload {
  offboardId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  reason: InteractionOffboardReason;
  requestedAt: number;
  expiresAt: number;
}

export interface InteractionOffboardResultPayload {
  offboardId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  status: 'cleared' | 'already_cleared' | 'failed';
  errorCode: InteractionErrorCode | null;
  finishedAt: number;
}

export interface InteractionOffboardAckPayload {
  offboardId: string;
  envKey: string;
  accountId: string;
  platform: InteractionPlatform;
  status: 'accepted' | 'duplicate' | 'rejected';
  errorCode: InteractionErrorCode | null;
  receivedAt: number;
}

export interface ThreadView {
  id: string;
  platform: InteractionPlatform;
  accountId: string;
  envKey: string;
  channel: InteractionChannel;
  externalThreadId: string;
  sourceExternalId: string | null;
  sourceTitle: string | null;
  sourceCoverUrl: string | null;
  participant: ParticipantSnapshot | null;
  status: ThreadStatus;
  lastMessageAt: number;
  lastSyncedAt: number;
}

export interface SyncFreshnessEvidence {
  observedAt: number;
  receivedAt: number;
}

export interface SyncFreshnessProjection {
  comment: SyncFreshnessEvidence | null;
  dm: SyncFreshnessEvidence | null;
}

export interface MessageView {
  id: string;
  threadId: string;
  direction: InteractionDirection;
  externalMessageId: string;
  externalParentId: string | null;
  externalRootId: string | null;
  messageType: InteractionMessageType;
  contentText: string | null;
  attachmentMeta: AttachmentMeta | null;
  lifecycle: MessageLifecycle;
  platformCreatedAt: number;
}

export interface ReplyJobView {
  id: string;
  inboundMessageId: string;
  state: ReplyJobState;
  version: number;
  matchedRuleId: string | null;
  configVersion: number | null;
  configScopeId?: string | null;
  template: { templateId: string | null; templateVersion: number | null };
  renderedText: string | null;
  polishedText: string | null;
  finalText: string | null;
  riskLevel: RiskLevel;
  riskReasons: RiskTag[];
  approvalActor: string | null;
  approvedAt: number | null;
  idempotencyKey: string | null;
  updatedAt: number;
}

export interface SendAttemptView {
  id: string;
  replyJobId: string;
  attemptNo: number;
  idempotencyKey: string;
  status: SendAttemptStatus;
  verificationStatus: VerificationStatus;
  externalMessageId: string | null;
  errorCode: InteractionErrorCode | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface ScopedJobContext {
  job: ReplyJobView & { meaningChanged: boolean; introducedClaims: string[]; lastErrorCode: InteractionErrorCode | null };
  message: MessageView;
  thread: ThreadView;
}

export type ReplyMode = 'draft_only' | 'review_before_send' | 'auto_safe';
export type ReplyConfigScopeType = 'group' | 'default';
export type ReplyConfigResolutionMode = 'scoped';

export interface ReplyConfigSource {
  type: ReplyConfigScopeType;
  groupLabel: string | null;
}

export interface ReplyConfigScopeHead {
  scopeId: string;
  platform: InteractionPlatform;
  source: ReplyConfigSource;
  memberCount: number;
  currentVersion: number;
  draftVersion: number | null;
  publishedVersion: number | null;
  updatedAt: number;
  updatedBy: string;
}

export interface ReplyConfigScopeSummary {
  scopeId: string | null;
  platform: InteractionPlatform;
  source: ReplyConfigSource;
  memberCount: number;
  currentVersion: number;
  draftVersion: number | null;
  publishedVersion: number | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface EffectiveReplyConfig {
  accountId: string;
  mode: ReplyConfigResolutionMode;
  status: 'missing' | 'draft_only' | 'published' | 'unknown';
  reason: 'group_config_missing' | 'default_config_missing' | 'account_not_found' | null;
  source: ReplyConfigSource;
  head: ReplyConfigScopeHead | null;
  snapshot: ReplyConfigSnapshot | null;
}
export interface PolicyChannel {
  enabled: boolean;
  aiPolishEnabled: boolean;
  allowAutoSend: boolean;
}
export interface RateLimits {
  accountPerMinute: number;
  accountPerHour: number;
  accountPerDay: number;
  threadCooldownSeconds: number;
  newLoginCooldownSeconds: number;
  consecutiveFailureLimit: number;
}
export interface ReplyPolicy {
  mode: ReplyMode;
  generateDrafts: boolean;
  sendReplies: boolean;
  channels: Record<InteractionChannel, PolicyChannel>;
  rateLimits: RateLimits;
}

export const TEMPLATE_VARIABLES = ['user_name', 'video_title', 'account_name', 'support_channel'] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export interface ReplyTemplate {
  templateId: string;
  channel: InteractionChannel;
  name: string;
  content: string;
  enabled: boolean;
  archived: boolean;
  templateVersion: number;
  variables: TemplateVariable[];
  updatedAt: number;
  updatedBy: string;
}

export type ReplyIntent =
  | 'gratitude' | 'general_question' | 'product_question' | 'support_request' | 'complaint'
  | 'order' | 'refund' | 'pricing' | 'promotion' | 'inventory' | 'shipping' | 'personal_data'
  | 'medical' | 'legal' | 'abuse' | 'minor_safety' | 'other' | 'unknown';

export interface RuleConditions {
  keywordsAny: string[];
  intentsAny: ReplyIntent[];
  sourceExternalIds: string[];
  messageTypes: InteractionMessageType[];
  workHours: { timezone: string; start: string; end: string } | null;
}
export interface RuleActions {
  templateId: string;
  polish: boolean;
  allowAutoSend: boolean;
  forceHumanTags: RiskTag[];
}
export interface ReplyRule {
  ruleId: string;
  channel: InteractionChannel;
  name: string;
  priority: number;
  enabled: boolean;
  conditions: RuleConditions;
  actions: RuleActions;
  updatedAt: number;
  updatedBy: string;
}

export interface ReplyProfile {
  channel: InteractionChannel;
  selfName: string;
  userAddress: string;
  tone: Array<'professional' | 'friendly' | 'concise'>;
  maxLength: number;
  allowEmoji: boolean;
  allowLinks: boolean;
  blockedPhrases: string[];
  disallowedClaims: string[];
  requiredDisclaimer: string | null;
  /** Optional admin-authored reference text for grounded AI answers. */
  knowledgeDocument?: string | null;
  variableFallbacks: Record<TemplateVariable, string>;
}

export interface ReplyConfigSnapshot {
  accountId: string;
  /** Present for group/default snapshots; legacy account snapshots leave it null/undefined. */
  configScopeId?: string | null;
  configSource?: ReplyConfigSource | null;
  platform: InteractionPlatform;
  configVersion: number;
  state: 'draft' | 'published';
  policy: ReplyPolicy;
  templates: ReplyTemplate[];
  rules: ReplyRule[];
  profiles: ReplyProfile[];
  createdAt: number;
  createdBy: string;
  publishedAt: number | null;
  publishedBy: string | null;
}

export interface ConfigHead {
  accountId: string;
  platform: InteractionPlatform;
  currentVersion: number;
  draftVersion: number | null;
  publishedVersion: number | null;
  updatedAt: number;
  updatedBy: string;
}

export interface RuntimeControls {
  accountId: string;
  platform: InteractionPlatform;
  envKey: string | null;
  version: number;
  commentsReadEnabled: boolean;
  commentsReplyEnabled: boolean;
  dmReadEnabled: boolean;
  dmSendTextEnabled: boolean;
  dmSendImageEnabled: false;
  writePaused: boolean;
  consecutiveFailures: number;
  circuitOpenedAt: number | null;
  lastConfirmedAt: number | null;
  updatedAt: number;
  updatedBy: string;
}

/** Effective Cloud -> Edge projection. Stored controls remain available through admin APIs. */
export interface InteractionRuntimeControlsPayload {
  accountId: string;
  envKey: string;
  version: number;
  commentsReadEnabled: boolean;
  commentsReplyEnabled: boolean;
  dmReadEnabled: boolean;
  dmSendTextEnabled: boolean;
  dmSendImageEnabled: false;
}

export interface MinimalInbound {
  channel: InteractionChannel;
  messageType: InteractionMessageType;
  text: string | null;
  userName: string | null;
  videoTitle: string | null;
  recentMessages: Array<{ direction: InteractionDirection; text: string }>;
}

/**
 * 回复预览生成的**纯结果契约**（原定义在 src/interactions/reply-workflow.ts）。
 * 抬入 kernel 供 api 侧只读预览路径（interaction-internal-api / interaction-scope-internal-api）
 * 经窄注入端口消费预览生成行为，而无需 type-only 依赖 automation 的具体工作流类。字段类型全为本文件既有 kernel 类型。
 */
export interface ReplyPreviewResult {
  matchedRuleId: string | null;
  templateId: string | null;
  templateVersion: number | null;
  renderedText: string | null;
  polishedText: string | null;
  finalText: string | null;
  riskLevel: ReplyJobView['riskLevel'];
  riskReasons: RiskTag[];
  requiresApproval: boolean;
  meaningChanged: boolean;
  introducedClaims: string[];
  reviewReasons: string[];
  fallbacks: { classifier: AiFallback; polisher: AiFallback; reviewer: AiFallback };
}

/**
 * 收件箱只读投影的**纯 DTO 契约**（原定义在 src/interactions/interaction-store.ts）。抬入 kernel 供 api 侧
 * 收件箱读路径（interaction-customer-api / interaction-internal-api）经 InteractionStoreReaderPort 消费，
 * 而无需 type-only 依赖 automation 的具体存储类。字段类型全为本文件既有 kernel 类型；这些 DTO 仅存储类与端口引用。
 */
export interface InteractionTestResetResult {
  channel: InteractionChannel;
  deleted: { threads: number; syncBatches: number; syncCursors: number };
}

export interface ListQuery {
  accountId: string;
  envKey: string;
  asOf: number;
  limit: number;
  channel?: InteractionChannel;
  state?: ReplyJobState | 'pending';
  before?: { lastMessageAt: number; id: string };
}

export interface ListResult {
  items: InteractionListItem[];
  next: { lastMessageAt: number; id: string } | null;
}

export interface ReplyPreviewContext {
  threadId: string;
  messageId: string;
  channel: InteractionChannel;
  messageType: MessageView['messageType'];
  userMessage: string | null;
  userName: string | null;
  videoTitle: string | null;
  receivedAt: number;
}

export interface DetailResult {
  thread: ThreadView;
  messages: MessageView[];
  replyJob: ReplyJobView | null;
  sendAttempt: SendAttemptView | null;
  next: { platformCreatedAt: number; id: string } | null;
}

/**
 * 收件箱存储的**读侧窄面**（consumer-facing reader port）。api 侧收件箱 HTTP 面通过本端口取投影 /
 * 认领幂等请求 / 记审计，而不依赖 automation 的具体存储类。方法签名与返回类型逐字取自 InteractionStore
 * 的对应只读 / 请求账本方法（返回类型全为本文件既有 kernel DTO）。automation 的 InteractionStore
 * 结构兼容并 implements 本端口，由组合根注入其实例；存储类不因此反向依赖 api。
 */
export interface InteractionStoreReaderPort {
  getAuth(accountId: string, envKey: string): Promise<InteractionAuthStatusPayload | null>;
  getSyncFreshness(accountId: string, envKey: string): Promise<SyncFreshnessProjection>;
  listInteractions(query: ListQuery): Promise<ListResult>;
  listReplyPreviewContexts(
    accountId: string,
    channel: InteractionChannel,
    limit: number,
  ): Promise<ReplyPreviewContext[]>;
  getDetail(
    accountId: string,
    envKey: string,
    threadId: string,
    limit: number,
    before?: { platformCreatedAt: number; id: string },
  ): Promise<DetailResult | null>;
  getJobContext(accountId: string, envKey: string, jobId: string): Promise<ScopedJobContext | null>;
  transitionMessageJob(input: {
    accountId: string; envKey: string; messageId: string; expectedVersion: number;
    to: 'ignored' | 'escalated'; actor: string; reason?: string;
  }): Promise<ScopedJobContext['job']>;
  getRuntimeControls(accountId: string): Promise<RuntimeControls>;
  resetTestData(input: {
    accountId: string;
    envKey: string;
    channel: InteractionChannel;
    actor: string;
  }): Promise<InteractionTestResetResult>;
  updateRuntimeControls(input: {
    accountId: string; expectedVersion: number; actor: string;
    commentsReadEnabled: boolean; commentsReplyEnabled: boolean; dmReadEnabled: boolean;
    dmSendTextEnabled: boolean; dmSendImageEnabled: false; writePaused: boolean;
  }): Promise<RuntimeControls>;
  recordAudit(input: {
    accountId: string; envKey: string | null; actor: string; action: string;
    configVersion?: number | null; entityType: string; entityId?: string | null;
    summary: string; labels?: Record<string, unknown>;
  }): Promise<void>;
  claimApiRequest(input: {
    actor: string; action: 'send' | 'sync' | 'auth_reopen' | 'browser_control' | 'test_reset'; idempotencyKey: string;
    accountId: string; envKey: string; resourceId?: string | null;
  }): Promise<{ requestId: string; fresh: boolean; response: unknown | null }>;
  completeApiRequest(requestId: string, response: unknown): Promise<void>;
}

export interface IntentClassifierInput {
  role: 'reply_intent_classifier';
  requestId: string;
  accountId: string;
  inbound: MinimalInbound;
}
export interface IntentClassifierOutput {
  role: 'reply_intent_classifier';
  intent: ReplyIntent;
  confidence: number;
  riskTags: RiskTag[];
  reasons: string[];
}
export interface PolisherInput {
  role: 'reply_polisher';
  requestId: string;
  accountId: string;
  inbound: MinimalInbound;
  intent: ReplyIntent;
  renderedText: string;
  profile: Pick<ReplyProfile, 'tone' | 'maxLength' | 'allowEmoji' | 'allowLinks' | 'blockedPhrases' | 'requiredDisclaimer' | 'knowledgeDocument'>;
}
export interface PolisherOutput {
  role: 'reply_polisher';
  polishedText: string;
  meaningChanged: boolean;
  introducedClaims: string[];
  riskTags: RiskTag[];
}
export interface RiskReviewerInput {
  role: 'reply_risk_reviewer';
  requestId: string;
  accountId: string;
  inbound: MinimalInbound;
  renderedText: string;
  candidateText: string;
  meaningChanged: boolean;
  introducedClaims: string[];
  policy: { mode: ReplyMode; hardRiskTags: RiskTag[] };
}
export interface RiskReviewerOutput {
  role: 'reply_risk_reviewer';
  riskLevel: RiskLevel;
  riskTags: RiskTag[];
  reasons: string[];
  allowAutoSend: boolean;
}

/**
 * 回复生成能力的合同（automation 编排层持有、content 实现并注入）。
 * 编排层 `ReplyWorkflow` 只依赖本接口，不再直 import content 的 `reply-ai.ts`。
 */
export type AiFallback = 'none' | 'timeout' | 'upstream_error' | 'invalid_json' | 'invalid_schema' |
  'too_long' | 'knowledge_answer_missing' | 'candidate_rejected';
export interface AiStepResult<T> { value: T; fallback: AiFallback }

export interface ReplyAiPort {
  classify(input: IntentClassifierInput): Promise<AiStepResult<IntentClassifierOutput>>;
  polish(input: PolisherInput): Promise<AiStepResult<PolisherOutput>>;
  review(input: RiskReviewerInput): Promise<AiStepResult<RiskReviewerOutput>>;
}

export interface InteractionListItem {
  threadId: string;
  messageId: string;
  channel: InteractionChannel;
  participantName: string | null;
  participantAvatarUrl: string | null;
  previewText: string | null;
  sourceTitle: string | null;
  lastMessageAt: number;
  unread: boolean;
  riskLevel: RiskLevel;
  jobState: ReplyJobState;
  jobVersion: number;
}

export const DEFAULT_REPLY_POLICY: ReplyPolicy = {
  mode: 'draft_only',
  generateDrafts: false,
  sendReplies: false,
  channels: {
    comment: { enabled: false, aiPolishEnabled: false, allowAutoSend: false },
    dm: { enabled: false, aiPolishEnabled: false, allowAutoSend: false },
  },
  rateLimits: {
    accountPerMinute: 2,
    accountPerHour: 20,
    accountPerDay: 100,
    threadCooldownSeconds: 60,
    newLoginCooldownSeconds: 600,
    consecutiveFailureLimit: 3,
  },
};

export const HARD_RISK_TAGS: readonly RiskTag[] = [
  'order', 'refund', 'after_sales', 'pricing', 'promotion', 'inventory', 'shipping',
  'personal_data', 'complaint', 'dispute', 'legal', 'medical', 'safety', 'abuse',
  'minor_safety', 'meaning_changed', 'introduced_claim', 'unknown',
];
