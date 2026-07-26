/**
 * 4a cross-process contracts.
 *
 * This file is deliberately limited to JSON-safe data, narrow ports, and error
 * code unions. Owner transactions, HTTP, SDKs, SQL, retries, and defaults stay
 * outside the kernel.
 */
import type { DeploymentTarget } from '../deployment-target.js';
import type {
  ClaimExecutionTargetResult,
  ExecutionTargetResolution,
} from './account-ownership-port.js';
import type { AccountIdentityProjectionRow } from './account-projection-types.js';
import type {
  InteractionAuthWriteAuthorization,
  InteractionAuthWriteAuthorizationInput,
  InteractionScopeCheck,
  InteractionScopeCheckInput,
} from './interaction-auth-gate-types.js';
import type { InteractionAuditEventRecord } from './interaction-audit-outbox.js';
import type { EffectiveReplyConfig, ReplyConfigSnapshot } from './interaction-types.js';
import type {
  AccountPersonaGenerateOutcome,
  AccountPersonaGenerateRequest,
  AccountPersonaPersistOutcome,
  PersonaGenerateInput,
  PersonaGenerateOutcome,
} from './persona-ports.js';
import type { PlatformId } from './platform-types.js';
import type {
  DispatchDraft,
  EditDraftResult,
  ScheduledPublishRecord,
  ScheduledReconcileUpdate,
} from './publish-draft-contract.js';
import type {
  PublishMetadata,
  PublishMode,
  PublishStatus,
} from './publish-pipeline-types.js';
import type {
  FacebookGroupImportResult,
  FacebookGroupTargetInput,
  ReplaceFacebookGroupTargetScopesResult,
} from './facebook-group-types.js';
import type { CommentApprovalNoticeInput } from './comment-approval-notice.js';
import type { MandatoryCommentOutcomeNoticeInput } from './mandatory-comment-notice.js';
import type { CommandResult, PublishApprovalCardData } from './feishu-card-contract.js';

export const API_DIRECT_CONTRACT_VERSION = 1 as const;

export type ApiDirectContractVersion = typeof API_DIRECT_CONTRACT_VERSION;

export interface ApiDirectEnvelope<T> {
  version: ApiDirectContractVersion;
  executionTarget: DeploymentTarget;
  input: T;
}

export type ApiDirectReadErrorCode =
  | 'api_direct_invalid_request'
  | 'api_direct_version_unsupported'
  | 'api_direct_target_mismatch'
  | 'api_authority_unavailable'
  | 'api_authority_bad_response';

export type ApiDirectWriteErrorCode =
  | ApiDirectReadErrorCode
  | 'api_authority_result_unknown'
  | 'notification_delivery_result_unknown'
  | 'edge_resume_result_unknown'
  | 'facebook_scope_result_unknown'
  | 'publish_ui_update_result_unknown'
  | 'persona_generation_result_unknown';

export const API_DIRECT_TOKEN_ENV = 'AIDCP_API_INTERNAL_TOKEN' as const;
export const AUTOMATION_COMMAND_TOKEN_ENV = 'AIDCP_AUTOMATION_INTERNAL_TOKEN' as const;
export const CONTENT_COMMAND_TOKEN_ENV = 'AIDCP_CONTENT_INTERNAL_TOKEN' as const;

/* Account authorities. */

export interface AccountRosterAuthorityPort {
  listAccountIdentities(): Promise<readonly AccountIdentityProjectionRow[]>;
}

/** The admitted 4a face intentionally omits the unused claimExecutionTarget. */
export interface AccountOwnershipAuthorityPort {
  getExecutionTarget(accountId: string): Promise<DeploymentTarget | null>;
  resolveExecutionTarget(accountId: string): Promise<ExecutionTargetResolution>;
  setExecutionTarget(
    accountId: string,
    target: DeploymentTarget,
  ): Promise<ClaimExecutionTargetResult>;
}

export type RecordNicknameOutcome =
  | { outcome: 'updated' | 'unchanged'; nickname: string }
  | { outcome: 'ignored_blank' }
  | { outcome: 'account_not_found' };

export interface AccountRuntimeAuthorityPort {
  ensureAccount(accountId: string, platform?: PlatformId): Promise<void>;
  getPlatformOrNull(accountId: string): Promise<PlatformId | null>;
  getContactInfo(accountId: string): Promise<string | null>;
  recordNickname(accountId: string, nickname: string): Promise<RecordNicknameOutcome>;
}

/* Publish log and Edge-originated API commands. */

export interface PublishDraftEditPatch {
  title?: string;
  content?: string;
  visibility?: string;
  topics?: string[];
  images?: string[];
  publishMode?: PublishMode;
  publishTime?: number | null;
}

export interface PendingPublishPreview {
  id: number;
  accountId: string;
  platform: PlatformId;
  kind: 'rewrite' | 'generated';
  title: string | null;
  content: string;
  topics: string[];
  images: string[];
  contentVersion: number;
  updatedAt: number;
  publishMode: PublishMode;
  publishTime: number | null;
  sourceCuratedId?: number | null;
  imageReferenceAudit?: {
    requestedCount: number;
    usableCount: number;
    status: 'none' | 'used' | 'unsupported' | 'unavailable' | 'skipped';
    generatedCount: number;
  };
}

export interface AutomationPublishLogPort {
  loadForDispatch(recordId: number): Promise<DispatchDraft | null>;
  updateStatus(id: number, status: PublishStatus): Promise<void>;
  updatePostId(id: number, postId: string, postUrl?: string | null): Promise<void>;
  markScheduled(
    id: number,
    scheduledAt: number,
    scheduledPlatformId?: string | null,
  ): Promise<void>;
  markImagesAttached(id: number, count: number): Promise<void>;
  listDueScheduled(limit?: number, now?: number): Promise<ScheduledPublishRecord[]>;
  deferScheduledReconcile(
    id: number,
    error: string,
    nextAt: number,
    maxAttempts?: number,
  ): Promise<ScheduledReconcileUpdate | null>;
  confirmScheduledPublished(id: number, postId: string, postUrl: string): Promise<boolean>;
  getMostRecentPublishTime(): Promise<number | null>;
  recentPublishedContents(limit?: number): Promise<string[]>;
  editDraft(
    recordId: number,
    expectedVersion: number,
    patch: PublishDraftEditPatch,
    editor: string,
    expectedAccountId?: string,
  ): Promise<EditDraftResult>;
  rejectPendingApproval(recordId: number): Promise<boolean>;
  pendingApprovalForAccount(accountId: string): Promise<{ id: number; title: string | null } | null>;
  pendingPublishPreviewForAccount(accountId: string): Promise<PendingPublishPreview | null>;
  lastPublishedForAccount(accountId: string): Promise<{ title: string | null; at: number } | null>;
  countPendingForAccount(accountId: string): Promise<number>;
  countPendingAutonomousForAccount(accountId: string): Promise<number>;
  countPublishedTodayForAccount(accountId: string): Promise<number>;
  countPublishedSinceForAccount(accountId: string, since: number): Promise<number>;
}

export interface PublishDraftImageRemoveCommand {
  payload: {
    requestId: string;
    contentVersion: number;
    imageUrl: string;
  };
  session: {
    accountId?: string;
    actor?: string;
  };
}

export interface PublishDraftImageRemoveResult {
  requestId: string;
  ok: boolean;
  images?: string[];
  contentVersion?: number;
  reason?: string;
  currentVersion?: number;
}

export interface PublishApprovalDecisionCommand {
  payload: {
    requestId: string;
    approved: boolean;
    contentVersion?: number;
    publishMode?: 'immediate' | 'scheduled';
    publishTime?: number | null;
  };
  accountId: string;
}

export interface PublishApprovalDecisionResult {
  requestId: string;
  ok: boolean;
  state?: 'approved' | 'rejected';
  alreadyDecided?: boolean;
  reason?: string;
  currentVersion?: number;
  dispatchState?: 'pending_dispatch' | 'dispatching' | 'blocked';
  dispatchBlockedReason?: string;
}

export interface EdgePublishCommandPort {
  removeDraftImage(input: PublishDraftImageRemoveCommand): Promise<PublishDraftImageRemoveResult>;
  decidePublishApproval(input: PublishApprovalDecisionCommand): Promise<PublishApprovalDecisionResult>;
}

/* Interaction and reply configuration. */

export interface InteractionAuthAuthorityPort {
  authorizeAuthStateWrite(
    input: InteractionAuthWriteAuthorizationInput,
  ): Promise<InteractionAuthWriteAuthorization>;
  checkAccountScope(input: InteractionScopeCheckInput): Promise<InteractionScopeCheck>;
}

export interface InteractionApiWritesPort {
  insertAuditEvent(
    record: InteractionAuditEventRecord,
  ): Promise<{ outcome: 'inserted' | 'duplicate' }>;
  purgeReplyConfigForAccount(accountId: string): Promise<{ removedRows: number }>;
  purgeExpiredAuditEvents(now: number): Promise<{ removedRows: number }>;
}

export interface ReplyConfigResolverPort {
  resolve(accountId: string): Promise<EffectiveReplyConfig>;
  getPublished(accountId: string): Promise<ReplyConfigSnapshot | null>;
  getSnapshotForJob(
    accountId: string,
    scopeId: string | null | undefined,
    version: number,
  ): Promise<ReplyConfigSnapshot | null>;
}

/* Persona, environment, policy, onboarding, and configuration. */

export interface AccountPersonaAuthorityPort {
  generate(input: AccountPersonaGenerateRequest): Promise<AccountPersonaGenerateOutcome>;
  persist(
    accountId: string,
    soulYaml: string,
    updatedBy: string,
  ): Promise<AccountPersonaPersistOutcome>;
}

export interface HandshakeEnvironmentObservation {
  envKey: string;
  label: string | null;
  platform: string | null;
  accountId: string | null;
}

export interface EnvironmentHandshakePort {
  registerHandshakeEnvironment(observation: HandshakeEnvironmentObservation): Promise<void>;
}

export type AccountCommentApprovalMode = 'source_rules' | 'auto_approve_all';

export interface CommentApprovalPolicyPort {
  getAccountCommentMode(accountId: string): Promise<AccountCommentApprovalMode>;
}

export interface NotificationContactItem {
  kind: 'comment' | 'mention' | 'like' | 'collect' | 'follow';
  fromUser: string;
  fromUserId?: string;
  content: string;
  noteTitle?: string;
  itemKey?: string;
}

export interface NotificationContactsPort {
  appendEvents(accountId: string, items: NotificationContactItem[]): Promise<void>;
}

export type FirstPostOnboardingState = 'searching' | 'generating' | 'generated';

export interface FirstPostProgress {
  accountId: string;
  state: FirstPostOnboardingState;
  startedAt: number;
  sourceId: string | null;
  lastError: string | null;
  generatedAt: number | null;
}

export interface FirstPostProgressPort {
  getFirstPostProgress(accountId: string): Promise<FirstPostProgress | null>;
}

export interface ContactCommentAttemptAudit {
  source?: string;
  noteId?: string;
  velocity?: number;
  ageHours?: number;
}

export interface AutomationConfigCommandsPort {
  countContactAttemptsToday(accountId: string): Promise<number>;
  recordContactCommentAttempt(
    accountId: string,
    audit?: ContactCommentAttemptAudit,
  ): Promise<void>;
  resolveFacebookContainerName(accountId: string, url: string, name: string): Promise<void>;
}

/* API-owned offboard admission ledger primitives. */

export type OffboardAdmissionReason =
  | 'environment_unbind'
  | 'customer_terminated'
  | 'admin_revoked';

export interface ActiveOffboardSnapshotRow {
  offboardId: string;
  envKey: string;
  reason: OffboardAdmissionReason;
  requestedAt: number;
}

export interface ReconcileActiveOffboardSnapshotInput {
  commandId: string;
  complete: true;
  observedAt: number;
  rows: ActiveOffboardSnapshotRow[];
}

export interface ReconcileActiveOffboardSnapshotOutcome {
  outcome: 'applied' | 'duplicate';
  adopted: number;
  released: number;
}

export interface ClaimPendingMaterializationsInput {
  commandId: string;
  workerId: string;
  limit: number;
  now: number;
  leaseMs: number;
}

export interface OffboardMaterializationCandidate {
  revocationId: string;
  offboardId: string;
  envKey: string;
  userId: string | null;
  reason: OffboardAdmissionReason;
  actor: string | null;
  unboundTerminalAllowed: boolean;
  requestedAt: number;
  claimToken: string;
  revision: number;
  claimExpiresAt: number;
}

export interface ClaimPendingMaterializationsOutcome {
  outcome: 'applied' | 'duplicate';
  candidates: OffboardMaterializationCandidate[];
}

export type OffboardMaterializationReceiptResult =
  | { kind: 'materialized'; offboardId: string; materializedAt: number }
  | { kind: 'binding_missing' };

export interface RecordMaterializationReceiptInput {
  commandId: string;
  revocationId: string;
  claimToken: string;
  expectedRevision: number;
  result: OffboardMaterializationReceiptResult;
}

export interface RecordMaterializationReceiptOutcome {
  outcome: 'applied' | 'duplicate' | 'stale' | 'collision';
  revision: number;
}

export interface OffboardAdmissionLedgerPort {
  reconcileActiveOffboardSnapshot(
    input: ReconcileActiveOffboardSnapshotInput,
  ): Promise<ReconcileActiveOffboardSnapshotOutcome>;
  claimPendingMaterializations(
    input: ClaimPendingMaterializationsInput,
  ): Promise<ClaimPendingMaterializationsOutcome>;
  recordMaterializationReceipt(
    input: RecordMaterializationReceiptInput,
  ): Promise<RecordMaterializationReceiptOutcome>;
}

/* The only cross-owner notification exit. Chat lookup and binding are absent. */

export interface OperationalTextNotification {
  accountId?: string;
  text: string;
  route: 'account' | 'default';
}

export interface AlertNotification {
  severity: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  accountId?: string;
  /** 触发来源会话；仅用于 API owner 的 origin-first 卡片路由。 */
  originChatId?: string;
  detail: string;
  actionText?: string;
  actionUrl?: string;
}

export type StructuredNotificationCommand =
  | { kind: 'comment_approval'; input: CommentApprovalNoticeInput }
  | { kind: 'mandatory_comment_pre_authorization'; input: CommentApprovalNoticeInput }
  | { kind: 'mandatory_comment_outcome'; input: MandatoryCommentOutcomeNoticeInput }
  | { kind: 'notification_inbox'; accountId: string; items: NotificationContactItem[] }
  | { kind: 'command_result'; input: CommandResult }
  | { kind: 'publish_approval'; input: PublishApprovalCardData }
  | { kind: 'operational_text'; input: OperationalTextNotification }
  | { kind: 'alert'; input: AlertNotification };

export interface StructuredNotificationDeliveryInput {
  commandId: string;
  notification: StructuredNotificationCommand;
}

export type StructuredNotificationDeliveryResult =
  | { outcome: 'delivered'; deliveryId: string }
  | {
      outcome: 'not_delivered';
      reason: 'no_chat' | 'owner_rejected' | 'invalid_command';
    }
  | { outcome: 'unknown'; reason: 'delivery_result_unknown' };

export interface StructuredNotificationDeliveryPort {
  deliver(
    input: StructuredNotificationDeliveryInput,
  ): Promise<StructuredNotificationDeliveryResult>;
}

/* API -> automation paired commands. */

export interface EdgeResumeCommandInput {
  commandId: string;
  accountId: string;
}

export type EdgeResumeCommandReceipt =
  | {
      outcome: 'applied' | 'duplicate';
      commandId: string;
      accountId: string;
      resumedEdges: number;
    }
  | { outcome: 'collision'; commandId: string };

export interface EdgeResumeCommandPort {
  resumeEdgesForAccount(input: EdgeResumeCommandInput): Promise<EdgeResumeCommandReceipt>;
}

export interface FacebookImportTargetsCommand {
  commandId: string;
  inputs: FacebookGroupTargetInput[];
  importBatch: string | null;
  options?: {
    accountGroupLabels?: string[];
    updatedBy?: string;
  };
}

export interface FacebookReplaceTargetScopesCommand {
  commandId: string;
  groupUrls: string[];
  accountGroupLabels: string[];
  updatedBy: string;
}

export type FacebookImportTargetsReceipt =
  | {
      outcome: 'applied' | 'duplicate';
      commandId: string;
      result: FacebookGroupImportResult;
    }
  | { outcome: 'collision'; commandId: string };

export type FacebookReplaceTargetScopesReceipt =
  | {
      outcome: 'applied' | 'duplicate';
      commandId: string;
      result: ReplaceFacebookGroupTargetScopesResult;
    }
  | { outcome: 'collision'; commandId: string };

export interface FacebookScopeCommandPort {
  importTargets(input: FacebookImportTargetsCommand): Promise<FacebookImportTargetsReceipt>;
  replaceTargetScopes(
    input: FacebookReplaceTargetScopesCommand,
  ): Promise<FacebookReplaceTargetScopesReceipt>;
}

export type PublishUiUpdateState =
  | 'pending'
  | 'approved'
  | 'submitted'
  | 'rejected'
  | 'failed';

export type PublishUiUpdate =
  | {
      kind: 'preview';
      preview: PendingPublishPreview;
    }
  | {
      kind: 'state';
      recordId: number;
      state: PublishUiUpdateState;
      factVersion: number;
      title?: string | null;
    };

export interface PublishUiUpdateCommandInput {
  commandId: string;
  accountId: string;
  update: PublishUiUpdate;
}

export type PublishUiUpdateCommandReceipt = {
  outcome: 'applied' | 'duplicate' | 'stale' | 'collision';
  commandId: string;
  accountId: string;
};

export interface PublishUiUpdateCommandPort {
  applyPublishUiUpdate(
    input: PublishUiUpdateCommandInput,
  ): Promise<PublishUiUpdateCommandReceipt>;
}

/* API -> content generation command. Persistence remains API-owned. */

export interface PersonaGeneratorCommandInput extends PersonaGenerateInput {
  idempotencyKey: string;
}

export type PersonaGeneratorCommandReceipt =
  | {
      outcome: 'applied' | 'duplicate';
      idempotencyKey: string;
      result: PersonaGenerateOutcome;
    }
  | { outcome: 'collision'; idempotencyKey: string };

export interface PersonaGeneratorAuthorityPort {
  generate(input: PersonaGeneratorCommandInput): Promise<PersonaGeneratorCommandReceipt>;
}

/**
 * Mechanical post-3b census. Keeping the literal method names here makes route
 * and package export tests fail when the admitted surface drifts.
 */
export const API_DIRECT_PORT_INVENTORY = {
  accountRoster: ['listAccountIdentities'],
  accountOwnership: ['getExecutionTarget', 'resolveExecutionTarget', 'setExecutionTarget'],
  accountRuntime: ['ensureAccount', 'getPlatformOrNull', 'getContactInfo', 'recordNickname'],
  publishLog: [
    'loadForDispatch',
    'updateStatus',
    'updatePostId',
    'markScheduled',
    'markImagesAttached',
    'listDueScheduled',
    'deferScheduledReconcile',
    'confirmScheduledPublished',
    'getMostRecentPublishTime',
    'recentPublishedContents',
    'editDraft',
    'rejectPendingApproval',
    'pendingApprovalForAccount',
    'pendingPublishPreviewForAccount',
    'lastPublishedForAccount',
    'countPendingForAccount',
    'countPendingAutonomousForAccount',
    'countPublishedTodayForAccount',
    'countPublishedSinceForAccount',
  ],
  edgePublish: ['removeDraftImage', 'decidePublishApproval'],
  interactionAuth: ['authorizeAuthStateWrite', 'checkAccountScope'],
  interactionApiWrites: [
    'insertAuditEvent',
    'purgeReplyConfigForAccount',
    'purgeExpiredAuditEvents',
  ],
  replyConfig: ['resolve', 'getPublished', 'getSnapshotForJob'],
  accountPersona: ['generate', 'persist'],
  environmentHandshake: ['registerHandshakeEnvironment'],
  commentApprovalPolicy: ['getAccountCommentMode'],
  notificationContacts: ['appendEvents'],
  firstPostProgress: ['getFirstPostProgress'],
  automationConfigCommands: [
    'countContactAttemptsToday',
    'recordContactCommentAttempt',
    'resolveFacebookContainerName',
  ],
  offboardAdmissionLedger: [
    'reconcileActiveOffboardSnapshot',
    'claimPendingMaterializations',
    'recordMaterializationReceipt',
  ],
  notificationDelivery: ['deliver'],
  edgeResumeCommand: ['resumeEdgesForAccount'],
  facebookScopeCommands: ['importTargets', 'replaceTargetScopes'],
  publishUiUpdateCommand: ['applyPublishUiUpdate'],
  personaGenerator: ['generate'],
} as const;

export type ApiDirectPortGroup = keyof typeof API_DIRECT_PORT_INVENTORY;

/** JSON-safe shape reused by publish preview readers. */
export type PublishMetadataSnapshot = PublishMetadata;
