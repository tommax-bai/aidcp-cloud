import type { DeploymentTarget } from '../deployment-target.js';
import {
  API_DIRECT_CONTRACT_VERSION,
  type AccountCommentApprovalMode,
  type AccountPersonaAuthorityPort,
  type AutomationConfigCommandsPort,
  type ClaimPendingMaterializationsInput,
  type ClaimPendingMaterializationsOutcome,
  type CommentApprovalPolicyPort,
  type ContactCommentAttemptAudit,
  type EnvironmentHandshakePort,
  type FirstPostProgress,
  type FirstPostProgressPort,
  type HandshakeEnvironmentObservation,
  type NotificationContactItem,
  type NotificationContactsPort,
  type OffboardAdmissionLedgerPort,
  type ReconcileActiveOffboardSnapshotInput,
  type ReconcileActiveOffboardSnapshotOutcome,
  type RecordMaterializationReceiptInput,
  type ScheduleFeedbackAuthorityPort,
  type RecordMaterializationReceiptOutcome,
  type StructuredNotificationDeliveryInput,
  type StructuredNotificationDeliveryPort,
  type StructuredNotificationDeliveryResult,
} from '../kernel/api-direct-port.js';
import type {
  AccountPersonaGenerateOutcome,
  AccountPersonaGenerateRequest,
  AccountPersonaPersistOutcome,
} from '../kernel/persona-ports.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import {
  ApiDirectHttpError,
  callApiDirectRead,
  callApiDirectWrite,
  isJsonValue,
  isNonNegativeInteger,
  isRecord,
  isVoidAck,
  parseApiDirectEnvelope,
  requireFiniteNumber,
  requireInteger,
  requireRecord,
  requireString,
} from './api-direct-http-common.js';

export const ACCOUNT_PERSONA_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const ENVIRONMENT_HANDSHAKE_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const COMMENT_APPROVAL_POLICY_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const NOTIFICATION_CONTACTS_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const FIRST_POST_PROGRESS_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const AUTOMATION_CONFIG_COMMANDS_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const OFFBOARD_ADMISSION_LEDGER_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const STRUCTURED_NOTIFICATION_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;

export const ACCOUNT_PERSONA_ROUTES = {
  generate: 'api-direct/account-persona/v1/generate',
  persist: 'api-direct/account-persona/v1/persist',
} as const satisfies Record<keyof AccountPersonaAuthorityPort, string>;

export const ENVIRONMENT_HANDSHAKE_ROUTES = {
  registerHandshakeEnvironment:
    'api-direct/environment-handshake/v1/register-handshake-environment',
} as const satisfies Record<keyof EnvironmentHandshakePort, string>;

export const COMMENT_APPROVAL_POLICY_ROUTES = {
  getAccountCommentMode:
    'api-direct/comment-approval-policy/v1/get-account-comment-mode',
} as const satisfies Record<keyof CommentApprovalPolicyPort, string>;

export const SCHEDULE_FEEDBACK_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;

export const SCHEDULE_FEEDBACK_ROUTES = {
  reportScheduledTaskNotStarted:
    'api-direct/schedule-feedback/v1/report-scheduled-task-not-started',
} as const satisfies Record<keyof ScheduleFeedbackAuthorityPort, string>;

export const NOTIFICATION_CONTACTS_ROUTES = {
  appendEvents: 'api-direct/notification-contacts/v1/append-events',
} as const satisfies Record<keyof NotificationContactsPort, string>;

export const FIRST_POST_PROGRESS_ROUTES = {
  getFirstPostProgress: 'api-direct/first-post-progress/v1/get-first-post-progress',
} as const satisfies Record<keyof FirstPostProgressPort, string>;

export const AUTOMATION_CONFIG_COMMANDS_ROUTES = {
  countContactAttemptsToday:
    'api-direct/automation-config/v1/count-contact-attempts-today',
  recordContactCommentAttempt:
    'api-direct/automation-config/v1/record-contact-comment-attempt',
  resolveFacebookContainerName:
    'api-direct/automation-config/v1/resolve-facebook-container-name',
} as const satisfies Record<keyof AutomationConfigCommandsPort, string>;

export const OFFBOARD_ADMISSION_LEDGER_ROUTES = {
  reconcileActiveOffboardSnapshot:
    'api-direct/offboard-admission/v1/reconcile-active-offboard-snapshot',
  claimPendingMaterializations:
    'api-direct/offboard-admission/v1/claim-pending-materializations',
  recordMaterializationReceipt:
    'api-direct/offboard-admission/v1/record-materialization-receipt',
} as const satisfies Record<keyof OffboardAdmissionLedgerPort, string>;

export const STRUCTURED_NOTIFICATION_ROUTES = {
  deliver: 'api-direct/notification/v1/deliver',
} as const satisfies Record<keyof StructuredNotificationDeliveryPort, string>;

function accountIdInput(value: unknown): { accountId: string } {
  const input = requireRecord(value);
  return { accountId: requireString(input.accountId, 'accountId') };
}

function personaPersistInput(value: unknown): {
  accountId: string;
  soulYaml: string;
  updatedBy: string;
} {
  const input = requireRecord(value);
  return {
    accountId: requireString(input.accountId, 'accountId'),
    soulYaml: requireString(input.soulYaml, 'soulYaml'),
    updatedBy: requireString(input.updatedBy, 'updatedBy'),
  };
}

function personaGenerateInput(value: unknown): AccountPersonaGenerateRequest {
  const input = requireRecord(value);
  if (
    input.platform !== undefined &&
    input.platform !== null &&
    typeof input.platform !== 'string'
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'platform must be a string, null, or undefined',
    );
  }
  return {
    accountId: requireString(input.accountId, 'accountId'),
    platform: input.platform as string | null | undefined,
    keywordSelections: input.keywordSelections,
    ...(input.writingLanguage === undefined
      ? {}
      : { writingLanguage: input.writingLanguage }),
    idempotencyKey: requireString(input.idempotencyKey, 'idempotencyKey'),
  };
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

function handshakeInput(value: unknown): HandshakeEnvironmentObservation {
  const input = requireRecord(value);
  return {
    envKey: requireString(input.envKey, 'envKey'),
    label: nullableStringField(input, 'label'),
    platform: nullableStringField(input, 'platform'),
    accountId: nullableStringField(input, 'accountId'),
  };
}

function appendEventsInput(value: unknown): {
  accountId: string;
  items: NotificationContactItem[];
} {
  const input = requireRecord(value);
  if (!Array.isArray(input.items) || !isJsonValue(input.items)) {
    throw new ApiDirectHttpError('api_direct_invalid_request', 'items must be a JSON-safe array');
  }
  return {
    accountId: requireString(input.accountId, 'accountId'),
    items: input.items as NotificationContactItem[],
  };
}

function configAttemptInput(value: unknown): {
  accountId: string;
  audit?: ContactCommentAttemptAudit;
} {
  const input = requireRecord(value);
  if (
    input.audit !== undefined &&
    (!isRecord(input.audit) || !isJsonValue(input.audit))
  ) {
    throw new ApiDirectHttpError('api_direct_invalid_request', 'audit must be JSON-safe');
  }
  return {
    accountId: requireString(input.accountId, 'accountId'),
    ...(isRecord(input.audit) ? { audit: input.audit as ContactCommentAttemptAudit } : {}),
  };
}

function resolveContainerInput(value: unknown): {
  accountId: string;
  url: string;
  name: string;
} {
  const input = requireRecord(value);
  return {
    accountId: requireString(input.accountId, 'accountId'),
    url: requireString(input.url, 'url'),
    name: requireString(input.name, 'name'),
  };
}

function offboardReason(value: unknown, label: string) {
  if (
    value !== 'environment_unbind' &&
    value !== 'customer_terminated' &&
    value !== 'admin_revoked'
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `${label} is invalid`,
    );
  }
  return value;
}

function reconcileOffboardInput(value: unknown): ReconcileActiveOffboardSnapshotInput {
  const input = requireRecord(value);
  if (input.complete !== true) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'offboard snapshot must be explicitly complete',
    );
  }
  if (!Array.isArray(input.rows)) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'offboard snapshot rows must be an array',
    );
  }
  return {
    commandId: requireString(input.commandId, 'commandId'),
    complete: true,
    observedAt: requireFiniteNumber(input.observedAt, 'observedAt'),
    rows: input.rows.map((value, index) => {
      const row = requireRecord(value, `rows[${index}]`);
      return {
        offboardId: requireString(row.offboardId, `rows[${index}].offboardId`),
        envKey: requireString(row.envKey, `rows[${index}].envKey`),
        reason: offboardReason(row.reason, `rows[${index}].reason`),
        requestedAt: requireFiniteNumber(
          row.requestedAt,
          `rows[${index}].requestedAt`,
        ),
      };
    }),
  };
}

function claimOffboardInput(value: unknown): ClaimPendingMaterializationsInput {
  const input = requireRecord(value);
  const leaseMs = requireFiniteNumber(input.leaseMs, 'leaseMs');
  if (leaseMs <= 0) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'leaseMs must be positive',
    );
  }
  return {
    commandId: requireString(input.commandId, 'commandId'),
    workerId: requireString(input.workerId, 'workerId'),
    limit: requireInteger(input.limit, 'limit', 1),
    now: requireFiniteNumber(input.now, 'now'),
    leaseMs,
  };
}

function receiptOffboardInput(value: unknown): RecordMaterializationReceiptInput {
  const input = requireRecord(value);
  const result = requireRecord(input.result, 'result');
  if (result.kind !== 'binding_missing' && result.kind !== 'materialized') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'result.kind is invalid',
    );
  }
  const parsedResult =
    result.kind === 'binding_missing'
      ? { kind: 'binding_missing' as const }
      : {
          kind: 'materialized' as const,
          offboardId: requireString(result.offboardId, 'result.offboardId'),
          materializedAt: requireFiniteNumber(
            result.materializedAt,
            'result.materializedAt',
          ),
        };
  return {
    commandId: requireString(input.commandId, 'commandId'),
    revocationId: requireString(input.revocationId, 'revocationId'),
    claimToken: requireString(input.claimToken, 'claimToken'),
    expectedRevision: requireInteger(
      input.expectedRevision,
      'expectedRevision',
      1,
    ),
    result: parsedResult,
  };
}

function notificationInput(value: unknown): StructuredNotificationDeliveryInput {
  const input = requireRecord(value);
  const notification = requireRecord(input.notification, 'notification');
  if (
    notification.kind !== 'comment_approval' &&
    notification.kind !== 'mandatory_comment_pre_authorization' &&
    notification.kind !== 'mandatory_comment_outcome' &&
    notification.kind !== 'notification_inbox' &&
    notification.kind !== 'command_result' &&
    notification.kind !== 'publish_approval' &&
    notification.kind !== 'operational_text' &&
    notification.kind !== 'alert'
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'notification.kind is invalid',
    );
  }
  if (!isJsonValue(notification)) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'notification must be JSON-safe',
    );
  }
  if (notification.kind === 'notification_inbox') {
    requireString(notification.accountId, 'notification.accountId');
    if (!Array.isArray(notification.items)) {
      throw new ApiDirectHttpError(
        'api_direct_invalid_request',
        'notification.items must be an array',
      );
    }
  } else {
    requireRecord(notification.input, 'notification.input');
  }
  return {
    commandId: requireString(input.commandId, 'commandId'),
    notification: notification as StructuredNotificationDeliveryInput['notification'],
  };
}

function isPersonaGenerateOutcome(value: unknown): value is AccountPersonaGenerateOutcome {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (!value.ok) return typeof value.reason === 'string';
  return typeof value.soulYaml === 'string' && typeof value.identitySummary === 'string';
}

function isPersonaPersistOutcome(value: unknown): value is AccountPersonaPersistOutcome {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  return value.ok
    ? typeof value.firstPostOnboarding === 'boolean'
    : typeof value.reason === 'string';
}

function isFirstPostProgress(value: unknown): value is FirstPostProgress {
  return (
    isRecord(value) &&
    typeof value.accountId === 'string' &&
    (value.state === 'searching' ||
      value.state === 'generating' ||
      value.state === 'generated') &&
    typeof value.startedAt === 'number' &&
    Number.isFinite(value.startedAt) &&
    (value.sourceId === null || typeof value.sourceId === 'string') &&
    (value.lastError === null || typeof value.lastError === 'string') &&
    (value.generatedAt === null ||
      (typeof value.generatedAt === 'number' && Number.isFinite(value.generatedAt)))
  );
}

function isReconcileOutcome(
  value: unknown,
): value is ReconcileActiveOffboardSnapshotOutcome {
  return (
    isRecord(value) &&
    (value.outcome === 'applied' || value.outcome === 'duplicate') &&
    isNonNegativeInteger(value.adopted) &&
    isNonNegativeInteger(value.released)
  );
}

function isClaimOutcome(
  value: unknown,
): value is ClaimPendingMaterializationsOutcome {
  return (
    isRecord(value) &&
    (value.outcome === 'applied' || value.outcome === 'duplicate') &&
    Array.isArray(value.candidates) &&
    value.candidates.every(
      (candidate) =>
        isRecord(candidate) &&
        typeof candidate.revocationId === 'string' &&
        candidate.revocationId.length > 0 &&
        typeof candidate.offboardId === 'string' &&
        candidate.offboardId.length > 0 &&
        typeof candidate.envKey === 'string' &&
        candidate.envKey.length > 0 &&
        (candidate.userId === null ||
          (typeof candidate.userId === 'string' && candidate.userId.length > 0)) &&
        (candidate.reason === 'environment_unbind' ||
          candidate.reason === 'customer_terminated' ||
          candidate.reason === 'admin_revoked') &&
        (candidate.actor === null ||
          (typeof candidate.actor === 'string' && candidate.actor.length > 0)) &&
        typeof candidate.unboundTerminalAllowed === 'boolean' &&
        Number.isSafeInteger(candidate.requestedAt) &&
        Number(candidate.requestedAt) >= 0 &&
        typeof candidate.claimToken === 'string' &&
        candidate.claimToken.length > 0 &&
        Number.isSafeInteger(candidate.revision) &&
        Number(candidate.revision) >= 1 &&
        Number.isSafeInteger(candidate.claimExpiresAt) &&
        Number(candidate.claimExpiresAt) >= 0,
    )
  );
}

function isReceiptOutcome(
  value: unknown,
): value is RecordMaterializationReceiptOutcome {
  return (
    isRecord(value) &&
    (value.outcome === 'applied' ||
      value.outcome === 'duplicate' ||
      value.outcome === 'stale' ||
      value.outcome === 'collision') &&
    isNonNegativeInteger(value.revision)
  );
}

function isDeliveryResult(
  value: unknown,
): value is StructuredNotificationDeliveryResult {
  if (!isRecord(value)) return false;
  if (value.outcome === 'delivered') return typeof value.deliveryId === 'string';
  if (value.outcome === 'unknown') return value.reason === 'delivery_result_unknown';
  return (
    value.outcome === 'not_delivered' &&
    (value.reason === 'no_chat' ||
      value.reason === 'owner_rejected' ||
      value.reason === 'invalid_command')
  );
}

export function registerAccountPersonaRoutes(
  server: InternalHttpServer,
  local: AccountPersonaAuthorityPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(ACCOUNT_PERSONA_ROUTES.generate, callerToken, (args) =>
    local.generate(
      parseApiDirectEnvelope(args, executionTarget, personaGenerateInput),
    ));
  server.registerBearer(ACCOUNT_PERSONA_ROUTES.persist, callerToken, (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, personaPersistInput);
    return local.persist(input.accountId, input.soulYaml, input.updatedBy);
  });
}

export function registerEnvironmentHandshakeRoutes(
  server: InternalHttpServer,
  local: EnvironmentHandshakePort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    ENVIRONMENT_HANDSHAKE_ROUTES.registerHandshakeEnvironment,
    callerToken,
    async (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, (value) =>
        handshakeInput(value));
      await local.registerHandshakeEnvironment(input);
      return { accepted: true };
    },
  );
}

export function registerCommentApprovalPolicyRoutes(
  server: InternalHttpServer,
  local: CommentApprovalPolicyPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    COMMENT_APPROVAL_POLICY_ROUTES.getAccountCommentMode,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, accountIdInput);
      return local.getAccountCommentMode(input.accountId);
    },
  );
}

/**
 * 排期名额回程。服务端就跑在排期器所在的那个进程里 ——
 * **这条口刻意不带幂等键**：属主自己按「这一格是不是我点的火」判，
 * 重复上报在它那边天然是 no-op（第一次已经把那格删了，第二次对不上就回 false）。
 * 在这一层再加一层幂等表反而会造出第二本账，而两本账一定会漂。
 */
export function registerScheduleFeedbackRoutes(
  server: InternalHttpServer,
  local: ScheduleFeedbackAuthorityPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    SCHEDULE_FEEDBACK_ROUTES.reportScheduledTaskNotStarted,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, notStartedInput);
      return local.reportScheduledTaskNotStarted(
        input.accountId,
        input.action,
        input.reason,
      );
    },
  );
}

function notStartedInput(value: unknown): {
  accountId: string;
  action: 'comment' | 'contact_comment';
  reason: string;
} {
  const input = requireRecord(value);
  const action = input.action;
  if (action !== 'comment' && action !== 'contact_comment') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'action must be comment or contact_comment',
    );
  }
  return {
    accountId: requireString(input.accountId, 'accountId'),
    action,
    // 原因是必填：属主要把它写进那条「归还小时格」的日志，缺了就查不出是哪类没起来。
    reason: requireString(input.reason, 'reason'),
  };
}

export function registerNotificationContactsRoutes(
  server: InternalHttpServer,
  local: NotificationContactsPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(NOTIFICATION_CONTACTS_ROUTES.appendEvents, callerToken, async (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, appendEventsInput);
    await local.appendEvents(input.accountId, input.items);
    return { accepted: true };
  });
}

export function registerFirstPostProgressRoutes(
  server: InternalHttpServer,
  local: FirstPostProgressPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    FIRST_POST_PROGRESS_ROUTES.getFirstPostProgress,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, accountIdInput);
      return local.getFirstPostProgress(input.accountId);
    },
  );
}

export function registerAutomationConfigCommandsRoutes(
  server: InternalHttpServer,
  local: AutomationConfigCommandsPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    AUTOMATION_CONFIG_COMMANDS_ROUTES.countContactAttemptsToday,
    callerToken,
    (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, accountIdInput);
      return local.countContactAttemptsToday(input.accountId);
    },
  );
  server.registerBearer(
    AUTOMATION_CONFIG_COMMANDS_ROUTES.recordContactCommentAttempt,
    callerToken,
    async (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, configAttemptInput);
      await local.recordContactCommentAttempt(input.accountId, input.audit);
      return { accepted: true };
    },
  );
  server.registerBearer(
    AUTOMATION_CONFIG_COMMANDS_ROUTES.resolveFacebookContainerName,
    callerToken,
    async (args) => {
      const input = parseApiDirectEnvelope(args, executionTarget, resolveContainerInput);
      await local.resolveFacebookContainerName(input.accountId, input.url, input.name);
      return { accepted: true };
    },
  );
}

export function registerOffboardAdmissionLedgerRoutes(
  server: InternalHttpServer,
  local: OffboardAdmissionLedgerPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    OFFBOARD_ADMISSION_LEDGER_ROUTES.reconcileActiveOffboardSnapshot,
    callerToken,
    (args) =>
      local.reconcileActiveOffboardSnapshot(
        parseApiDirectEnvelope(args, executionTarget, reconcileOffboardInput),
      ),
  );
  server.registerBearer(
    OFFBOARD_ADMISSION_LEDGER_ROUTES.claimPendingMaterializations,
    callerToken,
    (args) =>
      local.claimPendingMaterializations(
        parseApiDirectEnvelope(args, executionTarget, claimOffboardInput),
      ),
  );
  server.registerBearer(
    OFFBOARD_ADMISSION_LEDGER_ROUTES.recordMaterializationReceipt,
    callerToken,
    (args) =>
      local.recordMaterializationReceipt(
        parseApiDirectEnvelope(args, executionTarget, receiptOffboardInput),
      ),
  );
}

export function registerStructuredNotificationRoutes(
  server: InternalHttpServer,
  local: StructuredNotificationDeliveryPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(STRUCTURED_NOTIFICATION_ROUTES.deliver, callerToken, (args) =>
    local.deliver(
      parseApiDirectEnvelope(args, executionTarget, notificationInput),
    ));
}

export class AccountPersonaHttpClient implements AccountPersonaAuthorityPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  generate(input: AccountPersonaGenerateRequest): Promise<AccountPersonaGenerateOutcome> {
    return callApiDirectWrite(
      this.http, ACCOUNT_PERSONA_ROUTES.generate, this.callerToken,
      this.executionTarget, input, isPersonaGenerateOutcome,
    );
  }

  persist(
    accountId: string,
    soulYaml: string,
    updatedBy: string,
  ): Promise<AccountPersonaPersistOutcome> {
    return callApiDirectWrite(
      this.http, ACCOUNT_PERSONA_ROUTES.persist, this.callerToken,
      this.executionTarget, { accountId, soulYaml, updatedBy }, isPersonaPersistOutcome,
    );
  }
}

export class EnvironmentHandshakeHttpClient implements EnvironmentHandshakePort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  async registerHandshakeEnvironment(
    observation: HandshakeEnvironmentObservation,
  ): Promise<void> {
    await callApiDirectWrite(
      this.http, ENVIRONMENT_HANDSHAKE_ROUTES.registerHandshakeEnvironment,
      this.callerToken, this.executionTarget, observation, isVoidAck,
    );
  }
}

export class CommentApprovalPolicyHttpClient implements CommentApprovalPolicyPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  getAccountCommentMode(accountId: string): Promise<AccountCommentApprovalMode> {
    return callApiDirectRead(
      this.http, COMMENT_APPROVAL_POLICY_ROUTES.getAccountCommentMode,
      this.callerToken, this.executionTarget, { accountId },
      (value): value is AccountCommentApprovalMode =>
        value === 'source_rules' || value === 'auto_approve_all',
    );
  }
}

export class ScheduleFeedbackHttpClient implements ScheduleFeedbackAuthorityPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  reportScheduledTaskNotStarted(
    accountId: string,
    action: 'comment' | 'contact_comment',
    reason: string,
  ): Promise<boolean> {
    return callApiDirectWrite(
      this.http,
      SCHEDULE_FEEDBACK_ROUTES.reportScheduledTaskNotStarted,
      this.callerToken,
      this.executionTarget,
      { accountId, action, reason },
      (value): value is boolean => typeof value === 'boolean',
    );
  }
}

export class NotificationContactsHttpClient implements NotificationContactsPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  async appendEvents(accountId: string, items: NotificationContactItem[]): Promise<void> {
    await callApiDirectWrite(
      this.http, NOTIFICATION_CONTACTS_ROUTES.appendEvents, this.callerToken,
      this.executionTarget, { accountId, items }, isVoidAck,
    );
  }
}

export class FirstPostProgressHttpClient implements FirstPostProgressPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  getFirstPostProgress(accountId: string): Promise<FirstPostProgress | null> {
    return callApiDirectRead(
      this.http, FIRST_POST_PROGRESS_ROUTES.getFirstPostProgress, this.callerToken,
      this.executionTarget, { accountId },
      (value): value is FirstPostProgress | null =>
        value === null || isFirstPostProgress(value),
    );
  }
}

export class AutomationConfigCommandsHttpClient implements AutomationConfigCommandsPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  countContactAttemptsToday(accountId: string): Promise<number> {
    return callApiDirectRead(
      this.http, AUTOMATION_CONFIG_COMMANDS_ROUTES.countContactAttemptsToday,
      this.callerToken, this.executionTarget, { accountId }, isNonNegativeInteger,
    );
  }

  async recordContactCommentAttempt(
    accountId: string,
    audit?: ContactCommentAttemptAudit,
  ): Promise<void> {
    await callApiDirectWrite(
      this.http, AUTOMATION_CONFIG_COMMANDS_ROUTES.recordContactCommentAttempt,
      this.callerToken, this.executionTarget, { accountId, audit }, isVoidAck,
    );
  }

  async resolveFacebookContainerName(
    accountId: string,
    url: string,
    name: string,
  ): Promise<void> {
    await callApiDirectWrite(
      this.http, AUTOMATION_CONFIG_COMMANDS_ROUTES.resolveFacebookContainerName,
      this.callerToken, this.executionTarget, { accountId, url, name }, isVoidAck,
    );
  }
}

export class OffboardAdmissionLedgerHttpClient implements OffboardAdmissionLedgerPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  reconcileActiveOffboardSnapshot(
    input: ReconcileActiveOffboardSnapshotInput,
  ): Promise<ReconcileActiveOffboardSnapshotOutcome> {
    return callApiDirectWrite(
      this.http, OFFBOARD_ADMISSION_LEDGER_ROUTES.reconcileActiveOffboardSnapshot,
      this.callerToken, this.executionTarget, input, isReconcileOutcome,
    );
  }

  claimPendingMaterializations(
    input: ClaimPendingMaterializationsInput,
  ): Promise<ClaimPendingMaterializationsOutcome> {
    return callApiDirectWrite(
      this.http, OFFBOARD_ADMISSION_LEDGER_ROUTES.claimPendingMaterializations,
      this.callerToken, this.executionTarget, input, isClaimOutcome,
    );
  }

  recordMaterializationReceipt(
    input: RecordMaterializationReceiptInput,
  ): Promise<RecordMaterializationReceiptOutcome> {
    return callApiDirectWrite(
      this.http, OFFBOARD_ADMISSION_LEDGER_ROUTES.recordMaterializationReceipt,
      this.callerToken, this.executionTarget, input, isReceiptOutcome,
    );
  }
}

export class StructuredNotificationHttpClient
implements StructuredNotificationDeliveryPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  async deliver(
    input: StructuredNotificationDeliveryInput,
  ): Promise<StructuredNotificationDeliveryResult> {
    try {
      return await callApiDirectWrite(
        this.http, STRUCTURED_NOTIFICATION_ROUTES.deliver, this.callerToken,
        this.executionTarget, input, isDeliveryResult,
        'notification_delivery_result_unknown',
      );
    } catch (error) {
      if (
        error instanceof ApiDirectHttpError &&
        error.code === 'notification_delivery_result_unknown'
      ) {
        return { outcome: 'unknown', reason: 'delivery_result_unknown' };
      }
      throw error;
    }
  }
}
