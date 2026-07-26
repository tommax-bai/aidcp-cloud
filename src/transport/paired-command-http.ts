import type { DeploymentTarget } from '../deployment-target.js';
import {
  API_DIRECT_CONTRACT_VERSION,
  type EdgeResumeCommandInput,
  type EdgeResumeCommandPort,
  type EdgeResumeCommandReceipt,
  type FacebookImportTargetsCommand,
  type FacebookImportTargetsReceipt,
  type FacebookReplaceTargetScopesCommand,
  type FacebookReplaceTargetScopesReceipt,
  type FacebookScopeCommandPort,
  type PendingPublishPreview,
  type PersonaGeneratorAuthorityPort,
  type PersonaGeneratorCommandInput,
  type PersonaGeneratorCommandReceipt,
  type PublishUiUpdate,
  type PublishUiUpdateCommandInput,
  type PublishUiUpdateCommandPort,
  type PublishUiUpdateCommandReceipt,
} from '../kernel/api-direct-port.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import {
  ApiDirectHttpError,
  callApiDirectWrite,
  isJsonValue,
  isNonNegativeInteger,
  isRecord,
  parseApiDirectEnvelope,
  requireInteger,
  requireRecord,
  requireString,
} from './api-direct-http-common.js';

export const EDGE_RESUME_COMMAND_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const FACEBOOK_SCOPE_COMMAND_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const PERSONA_GENERATOR_COMMAND_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const PUBLISH_UI_UPDATE_COMMAND_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;

export const EDGE_RESUME_COMMAND_ROUTES = {
  resumeEdgesForAccount: 'automation-command/edge-resume/v1/resume-edges-for-account',
} as const satisfies Record<keyof EdgeResumeCommandPort, string>;

export const FACEBOOK_SCOPE_COMMAND_ROUTES = {
  importTargets: 'automation-command/facebook-scope/v1/import-targets',
  replaceTargetScopes: 'automation-command/facebook-scope/v1/replace-target-scopes',
} as const satisfies Record<keyof FacebookScopeCommandPort, string>;

export const PERSONA_GENERATOR_COMMAND_ROUTES = {
  generate: 'content-command/persona-generator/v1/generate',
} as const satisfies Record<keyof PersonaGeneratorAuthorityPort, string>;

export const PUBLISH_UI_UPDATE_COMMAND_ROUTES = {
  applyPublishUiUpdate: 'automation-command/publish-ui-update/v1/apply',
} as const satisfies Record<keyof PublishUiUpdateCommandPort, string>;

function jsonObjectInput<T>(value: unknown, label: string): T {
  const input = requireRecord(value, label);
  if (!isJsonValue(input)) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `${label} must be JSON-safe`,
    );
  }
  return input as T;
}

function edgeResumeInput(value: unknown): EdgeResumeCommandInput {
  const input = requireRecord(value);
  return {
    commandId: requireString(input.commandId, 'commandId'),
    accountId: requireString(input.accountId, 'accountId'),
  };
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `${label} must be a string array`,
    );
  }
  return value;
}

function facebookImportInput(value: unknown): FacebookImportTargetsCommand {
  const input = jsonObjectInput<Record<string, unknown>>(
    value,
    'facebook import command',
  );
  if (!Array.isArray(input.inputs)) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'inputs must be an array',
    );
  }
  for (const [index, item] of input.inputs.entries()) {
    const target = requireRecord(item, `inputs[${index}]`);
    requireString(target.url, `inputs[${index}].url`);
  }
  if (input.importBatch !== null && typeof input.importBatch !== 'string') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'importBatch must be a string or null',
    );
  }
  if (input.options !== undefined) {
    const options = requireRecord(input.options, 'options');
    if (options.accountGroupLabels !== undefined) {
      stringArray(options.accountGroupLabels, 'options.accountGroupLabels');
    }
    if (options.updatedBy !== undefined) requireString(options.updatedBy, 'options.updatedBy');
  }
  return {
    commandId: requireString(input.commandId, 'commandId'),
    inputs: input.inputs as FacebookImportTargetsCommand['inputs'],
    importBatch: input.importBatch as string | null,
    ...(input.options === undefined
      ? {}
      : { options: input.options as FacebookImportTargetsCommand['options'] }),
  };
}

function facebookReplaceInput(value: unknown): FacebookReplaceTargetScopesCommand {
  const input = jsonObjectInput<Record<string, unknown>>(
    value,
    'facebook replace command',
  );
  return {
    commandId: requireString(input.commandId, 'commandId'),
    groupUrls: stringArray(input.groupUrls, 'groupUrls'),
    accountGroupLabels: stringArray(input.accountGroupLabels, 'accountGroupLabels'),
    updatedBy: requireString(input.updatedBy, 'updatedBy'),
  };
}

function personaGeneratorInput(value: unknown): PersonaGeneratorCommandInput {
  const input = jsonObjectInput<Record<string, unknown>>(
    value,
    'persona generator command',
  );
  const keywordSelections = stringArray(input.keywordSelections, 'keywordSelections');
  if (input.diversitySeed !== undefined) requireString(input.diversitySeed, 'diversitySeed');
  if (input.writingLanguage !== undefined && typeof input.writingLanguage !== 'string') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'writingLanguage must be a string',
    );
  }
  return {
    idempotencyKey: requireString(input.idempotencyKey, 'idempotencyKey'),
    accountId: requireString(input.accountId, 'accountId'),
    keywordSelections,
    ...(typeof input.diversitySeed === 'string'
      ? { diversitySeed: input.diversitySeed }
      : {}),
    ...(typeof input.writingLanguage === 'string'
      ? { writingLanguage: input.writingLanguage as PersonaGeneratorCommandInput['writingLanguage'] }
      : {}),
  };
}

function plainString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `${label} must be a string`,
    );
  }
  return value;
}

function pendingPublishPreview(value: unknown): PendingPublishPreview {
  const preview = jsonObjectInput<Record<string, unknown>>(
    value,
    'publish UI preview',
  );
  if (
    preview.platform !== 'xiaohongshu' &&
    preview.platform !== 'facebook' &&
    preview.platform !== 'wechat_channels'
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'preview.platform is invalid',
    );
  }
  if (preview.kind !== 'rewrite' && preview.kind !== 'generated') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'preview.kind is invalid',
    );
  }
  if (preview.title !== null && typeof preview.title !== 'string') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'preview.title must be a string or null',
    );
  }
  if (
    preview.publishMode !== 'immediate' &&
    preview.publishMode !== 'draft' &&
    preview.publishMode !== 'scheduled'
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'preview.publishMode is invalid',
    );
  }
  if (
    preview.publishTime !== null &&
    (typeof preview.publishTime !== 'number' || !Number.isFinite(preview.publishTime))
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'preview.publishTime must be a finite epoch or null',
    );
  }
  if (
    preview.sourceCuratedId !== undefined &&
    preview.sourceCuratedId !== null &&
    (!Number.isInteger(preview.sourceCuratedId) || Number(preview.sourceCuratedId) < 1)
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'preview.sourceCuratedId must be an integer >= 1 or null',
    );
  }
  let imageReferenceAudit: PendingPublishPreview['imageReferenceAudit'];
  if (preview.imageReferenceAudit !== undefined) {
    const audit = requireRecord(
      preview.imageReferenceAudit,
      'preview.imageReferenceAudit',
    );
    if (
      audit.status !== 'none' &&
      audit.status !== 'used' &&
      audit.status !== 'unsupported' &&
      audit.status !== 'unavailable' &&
      audit.status !== 'skipped'
    ) {
      throw new ApiDirectHttpError(
        'api_direct_invalid_request',
        'preview.imageReferenceAudit.status is invalid',
      );
    }
    imageReferenceAudit = {
      requestedCount: requireInteger(
        audit.requestedCount,
        'preview.imageReferenceAudit.requestedCount',
      ),
      usableCount: requireInteger(
        audit.usableCount,
        'preview.imageReferenceAudit.usableCount',
      ),
      generatedCount: requireInteger(
        audit.generatedCount,
        'preview.imageReferenceAudit.generatedCount',
      ),
      status: audit.status,
    };
  }
  return {
    id: requireInteger(preview.id, 'preview.id', 1),
    accountId: requireString(preview.accountId, 'preview.accountId'),
    platform: preview.platform,
    kind: preview.kind,
    title: preview.title,
    content: plainString(preview.content, 'preview.content'),
    topics: stringArray(preview.topics, 'preview.topics'),
    images: stringArray(preview.images, 'preview.images'),
    contentVersion: requireInteger(preview.contentVersion, 'preview.contentVersion'),
    updatedAt: requireInteger(preview.updatedAt, 'preview.updatedAt'),
    publishMode: preview.publishMode,
    publishTime: preview.publishTime,
    ...(preview.sourceCuratedId === undefined
      ? {}
      : { sourceCuratedId: preview.sourceCuratedId as number | null }),
    ...(imageReferenceAudit ? { imageReferenceAudit } : {}),
  };
}

function publishUiUpdate(value: unknown): PublishUiUpdate {
  const update = requireRecord(value, 'publish UI update');
  if (update.kind === 'preview') {
    return {
      kind: 'preview',
      preview: pendingPublishPreview(update.preview),
    };
  }
  if (update.kind !== 'state') {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'publish UI update kind is invalid',
    );
  }
  if (
    update.state !== 'pending' &&
    update.state !== 'approved' &&
    update.state !== 'submitted' &&
    update.state !== 'rejected' &&
    update.state !== 'failed'
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'publish UI state is invalid',
    );
  }
  if (
    update.title !== undefined &&
    update.title !== null &&
    typeof update.title !== 'string'
  ) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'publish UI title must be a string or null',
    );
  }
  return {
    kind: 'state',
    recordId: requireInteger(update.recordId, 'recordId', 1),
    state: update.state,
    factVersion: requireInteger(update.factVersion, 'factVersion'),
    ...(update.title === undefined
      ? {}
      : { title: update.title as string | null }),
  };
}

function publishUiUpdateInput(value: unknown): PublishUiUpdateCommandInput {
  const input = jsonObjectInput<Record<string, unknown>>(
    value,
    'publish UI update command',
  );
  const accountId = requireString(input.accountId, 'accountId');
  const update = publishUiUpdate(input.update);
  if (update.kind === 'preview' && update.preview.accountId !== accountId) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      'preview.accountId must match command accountId',
    );
  }
  return {
    commandId: requireString(input.commandId, 'commandId'),
    accountId,
    update,
  };
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFacebookTargetRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.groupUrl === 'string' &&
    nullableString(value.groupName) &&
    nullableString(value.region) &&
    nullableString(value.park) &&
    nullableString(value.direction) &&
    (
      value.joinGating === 'unknown' ||
      value.joinGating === 'instant' ||
      value.joinGating === 'gated'
    ) &&
    Number.isInteger(value.priority) &&
    typeof value.enabled === 'boolean' &&
    nullableString(value.importBatch) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    isStringArray(value.accountGroupLabels)
  );
}

function edgeReceiptFor(
  input: EdgeResumeCommandInput,
): (value: unknown) => value is EdgeResumeCommandReceipt {
  return (value: unknown): value is EdgeResumeCommandReceipt => {
    if (!isRecord(value) || value.commandId !== input.commandId) return false;
    if (value.outcome === 'collision') return true;
    return (
      (value.outcome === 'applied' || value.outcome === 'duplicate') &&
      value.accountId === input.accountId &&
      isNonNegativeInteger(value.resumedEdges)
    );
  };
}

function facebookImportReceiptFor(
  input: FacebookImportTargetsCommand,
): (value: unknown) => value is FacebookImportTargetsReceipt {
  return (value: unknown): value is FacebookImportTargetsReceipt => {
    if (!isRecord(value) || value.commandId !== input.commandId) return false;
    if (value.outcome === 'collision') return true;
    return (
      (value.outcome === 'applied' || value.outcome === 'duplicate') &&
      isRecord(value.result) &&
      isNonNegativeInteger(value.result.imported) &&
      isNonNegativeInteger(value.result.updated) &&
      isNonNegativeInteger(value.result.duplicate) &&
      isNonNegativeInteger(value.result.invalid) &&
      Array.isArray(value.result.rows) &&
      value.result.rows.every(isFacebookTargetRow)
    );
  };
}

function isFacebookScopeWriteRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.groupUrl === 'string' &&
    isStringArray(value.accountGroupLabels) &&
    typeof value.updatedAt === 'string' &&
    typeof value.updatedBy === 'string'
  );
}

function isFacebookReplaceResult(value: unknown): boolean {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  return value.ok
    ? Array.isArray(value.items) && value.items.every(isFacebookScopeWriteRow)
    : (
        value.reason === 'no_targets' ||
        value.reason === 'invalid_target' ||
        value.reason === 'invalid_account_group'
      );
}

function facebookReplaceReceiptFor(
  input: FacebookReplaceTargetScopesCommand,
): (value: unknown) => value is FacebookReplaceTargetScopesReceipt {
  return (value: unknown): value is FacebookReplaceTargetScopesReceipt => (
    isRecord(value) &&
    value.commandId === input.commandId &&
    (
      value.outcome === 'collision' ||
      (
        (value.outcome === 'applied' || value.outcome === 'duplicate') &&
        isFacebookReplaceResult(value.result)
      )
    )
  );
}

function isPersonaResult(value: unknown): boolean {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  return value.ok
    ? (
        typeof value.soulYaml === 'string' &&
        typeof value.identitySummary === 'string'
      )
    : (
        value.reason === 'no_keywords' ||
        value.reason === 'generation_failed' ||
        value.reason === 'persona_invalid'
      );
}

function personaReceiptFor(
  input: PersonaGeneratorCommandInput,
): (value: unknown) => value is PersonaGeneratorCommandReceipt {
  return (value: unknown): value is PersonaGeneratorCommandReceipt => (
    isRecord(value) &&
    value.idempotencyKey === input.idempotencyKey &&
    (
      value.outcome === 'collision' ||
      (
        (value.outcome === 'applied' || value.outcome === 'duplicate') &&
        isPersonaResult(value.result)
      )
    )
  );
}

function publishUiUpdateReceiptFor(
  input: PublishUiUpdateCommandInput,
): (value: unknown) => value is PublishUiUpdateCommandReceipt {
  return (value: unknown): value is PublishUiUpdateCommandReceipt => (
    isRecord(value) &&
    value.commandId === input.commandId &&
    value.accountId === input.accountId &&
    (
      value.outcome === 'applied' ||
      value.outcome === 'duplicate' ||
      value.outcome === 'stale' ||
      value.outcome === 'collision'
    )
  );
}

export function registerEdgeResumeCommandRoutes(
  server: InternalHttpServer,
  local: EdgeResumeCommandPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(EDGE_RESUME_COMMAND_ROUTES.resumeEdgesForAccount, callerToken, (args) =>
    local.resumeEdgesForAccount(
      parseApiDirectEnvelope(args, executionTarget, edgeResumeInput),
    ));
}

export function registerFacebookScopeCommandRoutes(
  server: InternalHttpServer,
  local: FacebookScopeCommandPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(FACEBOOK_SCOPE_COMMAND_ROUTES.importTargets, callerToken, (args) =>
    local.importTargets(
      parseApiDirectEnvelope(args, executionTarget, facebookImportInput),
    ));
  server.registerBearer(FACEBOOK_SCOPE_COMMAND_ROUTES.replaceTargetScopes, callerToken, (args) =>
    local.replaceTargetScopes(
      parseApiDirectEnvelope(args, executionTarget, facebookReplaceInput),
    ));
}

export function registerPersonaGeneratorCommandRoutes(
  server: InternalHttpServer,
  local: PersonaGeneratorAuthorityPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(PERSONA_GENERATOR_COMMAND_ROUTES.generate, callerToken, (args) =>
    local.generate(
      parseApiDirectEnvelope(args, executionTarget, personaGeneratorInput),
    ));
}

export function registerPublishUiUpdateCommandRoutes(
  server: InternalHttpServer,
  local: PublishUiUpdateCommandPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    PUBLISH_UI_UPDATE_COMMAND_ROUTES.applyPublishUiUpdate,
    callerToken,
    (args) => local.applyPublishUiUpdate(
      parseApiDirectEnvelope(args, executionTarget, publishUiUpdateInput),
    ),
  );
}

export class EdgeResumeCommandHttpClient implements EdgeResumeCommandPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  resumeEdgesForAccount(input: EdgeResumeCommandInput): Promise<EdgeResumeCommandReceipt> {
    return callApiDirectWrite(
      this.http, EDGE_RESUME_COMMAND_ROUTES.resumeEdgesForAccount, this.callerToken,
      this.executionTarget, input, edgeReceiptFor(input), 'edge_resume_result_unknown',
    );
  }
}

export class FacebookScopeCommandHttpClient implements FacebookScopeCommandPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  importTargets(input: FacebookImportTargetsCommand): Promise<FacebookImportTargetsReceipt> {
    return callApiDirectWrite(
      this.http, FACEBOOK_SCOPE_COMMAND_ROUTES.importTargets, this.callerToken,
      this.executionTarget, input, facebookImportReceiptFor(input), 'facebook_scope_result_unknown',
    );
  }

  replaceTargetScopes(
    input: FacebookReplaceTargetScopesCommand,
  ): Promise<FacebookReplaceTargetScopesReceipt> {
    return callApiDirectWrite(
      this.http, FACEBOOK_SCOPE_COMMAND_ROUTES.replaceTargetScopes, this.callerToken,
      this.executionTarget, input, facebookReplaceReceiptFor(input), 'facebook_scope_result_unknown',
    );
  }
}

export class PersonaGeneratorCommandHttpClient
implements PersonaGeneratorAuthorityPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  generate(input: PersonaGeneratorCommandInput): Promise<PersonaGeneratorCommandReceipt> {
    return callApiDirectWrite(
      this.http, PERSONA_GENERATOR_COMMAND_ROUTES.generate, this.callerToken,
      this.executionTarget, input, personaReceiptFor(input), 'persona_generation_result_unknown',
    );
  }
}

export class PublishUiUpdateCommandHttpClient implements PublishUiUpdateCommandPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  applyPublishUiUpdate(
    input: PublishUiUpdateCommandInput,
  ): Promise<PublishUiUpdateCommandReceipt> {
    return callApiDirectWrite(
      this.http,
      PUBLISH_UI_UPDATE_COMMAND_ROUTES.applyPublishUiUpdate,
      this.callerToken,
      this.executionTarget,
      input,
      publishUiUpdateReceiptFor(input),
      'publish_ui_update_result_unknown',
    );
  }
}
