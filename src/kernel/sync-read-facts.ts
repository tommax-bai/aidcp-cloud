import type { DeploymentTarget } from '../deployment-target.js';
import type { ConfigMirrorKey } from './config-mirror-bump-types.js';
import {
  FACEBOOK_COMMENT_MODE_WIRE_VALUES,
  type FacebookCommentModeWire,
} from './facebook-comment-config-types.js';
import {
  FACEBOOK_BASE_OPERATION_MODES,
  FACEBOOK_CADENCE_SOURCES,
  FACEBOOK_PRIMARY_BROWSE_SURFACES,
  type FacebookOperationPolicyBaseProjection,
} from './facebook-operation-policy-resolution.js';
import {
  SYNC_READ_CONTRACT_VERSION,
  SYNC_READ_STREAM_DEFINITIONS,
  type SyncReadJson,
  type SyncReadSnapshotEnvelope,
  type SyncReadStream,
} from './sync-read-snapshot.js';

export type SessionConfigGlobalSnapshot = {
  readonly weekActiveMask: string | null;
};

export type EdgePresenceSnapshot = {
  readonly edgeCount: number;
  readonly onlineEdgeCount: number;
  readonly accountEdges: readonly {
    readonly accountId: string;
    readonly edgeId: string;
  }[];
};

export type PublishInFlightSnapshot = {
  readonly recordIds: readonly number[];
};

const CONFIG_MIRROR_KEYS: Readonly<Record<ConfigMirrorKey, true>> = {
  quota_config: true,
  pacing_floor_config: true,
  session_config_global: true,
  resume_config_global: true,
  persona_config: true,
  content_schedule: true,
  model_config: true,
  role_config: true,
  category_config: true,
  hot_lead_config: true,
  facebook_comment_config: true,
  facebook_group_join_automation_config: true,
  facebook_operation_policy: true,
  account_status: true,
  client_environment_slow_start: true,
  client_environment_automation_gate: true,
};

export type CaptchaAvailabilitySnapshot = {
  readonly state: 'disabled' | 'available' | 'unavailable' | 'unknown';
};

export type AutomationConfigMirrorHealthSnapshot = {
  readonly sourceService: 'automation';
  readonly asOf: number;
  readonly enabled: boolean;
  readonly pollMs: number;
  readonly entries: readonly {
    readonly mirrorKey: string;
    readonly tier: 'gate' | 'parameter';
    readonly version: number | null;
    readonly lastComparedAt: number | null;
    readonly lastReloadedAt: number | null;
    readonly reloadFailingSince: number | null;
    readonly state: 'fresh' | 'stale';
    readonly staleMs: number | null;
    readonly observeStaleMs: number;
    readonly haltsOnStale: boolean;
    readonly staleForMs: number;
  }[];
};

export type AccountPersonaSnapshot = {
  readonly accounts: readonly {
    readonly accountId: string;
    readonly personaText: string;
    readonly soul: SyncReadJson | null;
  }[];
};

export type ClientEnvironmentAutomationSnapshot = {
  readonly blockedEnvironmentKeys: readonly string[];
  readonly slowStartAnchors: readonly {
    readonly accountId: string;
    readonly slowStartSince: number | null;
    readonly slowStartCompletedAt: number | null;
    readonly ambiguous: boolean;
  }[];
};

/**
 * Post-4a B4 payload. Display/card fields intentionally stay out: notification
 * rendering is API-owned after 4a. groupLabel survives for automation-local
 * group guards; createdAt/status survive for slow-start and pause gates.
 */
export type AutomationAccountProjectionSnapshot = {
  readonly accounts: readonly {
    readonly accountId: string;
    readonly platform: string;
    readonly groupLabel: string | null;
    readonly createdAt: number | null;
    readonly status: 'active' | 'paused';
  }[];
};

export type ContentScheduleSnapshot = {
  readonly global: {
    readonly contentActiveMask: string | null;
  } | null;
  readonly accounts: readonly {
    readonly accountId: string;
    readonly autoEnabled: boolean;
    readonly postMode: 'off' | 'review' | 'auto_approve';
    readonly postDailyCap: number;
    readonly commentMode: 'off' | 'review' | 'auto_approve';
    readonly commentDailyCap: number;
    readonly contactCommentMode: 'off' | 'review' | 'auto_approve';
    readonly contactCommentDailyCap: number;
    readonly activeWeekMask: string | null;
    readonly contentActiveMask: string | null;
  }[];
};

export type HotLeadConfigSnapshot = {
  readonly maxAgeHours: number;
  readonly velocityMin: number;
  readonly minLikeFloor: number;
  readonly floorHours: number;
};

export type FacebookCommentConfigSnapshot = {
  readonly accounts: readonly {
    readonly accountId: string;
    readonly keywords: readonly string[];
    readonly containers: readonly {
      readonly url: string;
      readonly name?: string;
    }[];
    /**
     * 线缆写法（复数 `templates`），**与领域写法单数 `template` 不同字面量**。
     * 收窄自裸 `string`：跨进程消费方 MUST 经 `facebookCommentModeFromWire` 还原，
     * 直接比较字面量会恒 false，且不报错——只是把模板正文静静换成生成式。
     */
    readonly commentMode: FacebookCommentModeWire;
    readonly commentModeConfigured: boolean;
    readonly commentTemplates: readonly string[];
  }[];
};

/**
 * Facebook 运营基线快照：属主**已合成好的**逐环境基线投影（全局默认 ← 环境覆盖 ← legacy 回落）。
 * 刻意不发三张原始表 —— 合成规则只许有一份，发不出成品就会逼消费方在本进程里再实现一遍。
 * 只含**已配浏览面**的环境；未配的环境在此缺席，消费方据此报具名 blocker，MUST NOT 给默认面。
 */
export type FacebookOperationPolicySnapshot = {
  readonly environments: readonly FacebookOperationPolicyBaseProjection[];
};

export type FacebookGroupJoinAutomationConfigSnapshot = {
  readonly accounts: readonly {
    readonly accountId: string;
    readonly enabled: boolean;
    readonly dailyCap: number;
    readonly weekMask: string | null;
  }[];
};

export type SyncReadPayloadByStream = {
  session_config_global: SessionConfigGlobalSnapshot;
  edge_presence: EdgePresenceSnapshot;
  publish_in_flight: PublishInFlightSnapshot;
  captcha_availability: CaptchaAvailabilitySnapshot;
  automation_config_mirror_health: AutomationConfigMirrorHealthSnapshot;
  account_persona: AccountPersonaSnapshot;
  client_environment_automation: ClientEnvironmentAutomationSnapshot;
  automation_account_projection: AutomationAccountProjectionSnapshot;
  content_schedule: ContentScheduleSnapshot;
  hot_lead_config: HotLeadConfigSnapshot;
  facebook_comment_config: FacebookCommentConfigSnapshot;
  facebook_group_join_automation_config: FacebookGroupJoinAutomationConfigSnapshot;
  facebook_operation_policy: FacebookOperationPolicySnapshot;
};

export interface SyncReadOwnerSnapshotSource {
  snapshot<S extends SyncReadStream>(
    stream: S,
    observedAt?: number,
  ): Promise<SyncReadSnapshotEnvelope<SyncReadPayloadByStream[S]>>;
}

export function makeSyncReadFactEnvelope<S extends SyncReadStream>(input: {
  executionTarget: DeploymentTarget;
  stream: S;
  cursor: string;
  asOf: number;
  freshUntil: number;
  value: SyncReadPayloadByStream[S];
}): SyncReadSnapshotEnvelope<SyncReadPayloadByStream[S]> {
  const definition = SYNC_READ_STREAM_DEFINITIONS[input.stream];
  return {
    contractVersion: SYNC_READ_CONTRACT_VERSION,
    executionTarget: input.executionTarget,
    factScope: definition.factScope,
    stream: input.stream,
    cursor: input.cursor,
    asOf: input.asOf,
    freshUntil: input.freshUntil,
    complete: true,
    value: input.value,
  };
}

export function isSyncReadFactPayload<S extends SyncReadStream>(
  stream: S,
  value: unknown,
): value is SyncReadPayloadByStream[S] {
  switch (stream) {
    case 'session_config_global':
      return (
        isRecord(value) &&
        hasExactKeys(value, ['weekActiveMask']) &&
        isNullableString(value.weekActiveMask)
      );
    case 'edge_presence':
      return (
        isRecord(value) &&
        hasExactKeys(value, [
          'edgeCount',
          'onlineEdgeCount',
          'accountEdges',
        ]) &&
        isNonNegativeInteger(value.edgeCount) &&
        isNonNegativeInteger(value.onlineEdgeCount) &&
        value.onlineEdgeCount <= value.edgeCount &&
        Array.isArray(value.accountEdges) &&
        hasUniqueStrings(value.accountEdges, 'accountId') &&
        value.accountEdges.every(
          (row) =>
            isRecord(row) &&
            hasExactKeys(row, ['accountId', 'edgeId']) &&
            isNonEmptyString(row.accountId) &&
            isNonEmptyString(row.edgeId),
        )
      );
    case 'publish_in_flight':
      return (
        isRecord(value) &&
        hasExactKeys(value, ['recordIds']) &&
        Array.isArray(value.recordIds) &&
        value.recordIds.every(isNonNegativeInteger) &&
        new Set(value.recordIds).size === value.recordIds.length
      );
    case 'captcha_availability':
      return (
        isRecord(value) &&
        hasExactKeys(value, ['state']) &&
        (value.state === 'disabled' ||
          value.state === 'available' ||
          value.state === 'unavailable' ||
          value.state === 'unknown')
      );
    case 'automation_config_mirror_health':
      return (
        isRecord(value) &&
        hasExactKeys(value, [
          'sourceService',
          'asOf',
          'enabled',
          'pollMs',
          'entries',
        ]) &&
        value.sourceService === 'automation' &&
        isNonNegativeInteger(value.asOf) &&
        typeof value.enabled === 'boolean' &&
        isNonNegativeInteger(value.pollMs) &&
        Array.isArray(value.entries) &&
        hasUniqueStrings(value.entries, 'mirrorKey') &&
        value.entries.every(isAutomationHealthEntry)
      );
    case 'account_persona':
      return (
        isRecord(value) &&
        hasExactKeys(value, ['accounts']) &&
        Array.isArray(value.accounts) &&
        hasUniqueStrings(value.accounts, 'accountId') &&
        value.accounts.every(
          (row) =>
            isRecord(row) &&
            hasExactKeys(row, ['accountId', 'personaText', 'soul']) &&
            isNonEmptyString(row.accountId) &&
            isNonBlankString(row.personaText) &&
            (row.soul === null || isJson(row.soul)),
        )
      );
    case 'client_environment_automation':
      return (
        isRecord(value) &&
        hasExactKeys(value, ['blockedEnvironmentKeys', 'slowStartAnchors']) &&
        Array.isArray(value.blockedEnvironmentKeys) &&
        value.blockedEnvironmentKeys.every(isNonEmptyString) &&
        new Set(value.blockedEnvironmentKeys).size ===
          value.blockedEnvironmentKeys.length &&
        Array.isArray(value.slowStartAnchors) &&
        hasUniqueStrings(value.slowStartAnchors, 'accountId') &&
        value.slowStartAnchors.every(
          (row) =>
            isRecord(row) &&
            hasExactKeys(row, [
              'accountId',
              'slowStartSince',
              'slowStartCompletedAt',
              'ambiguous',
            ]) &&
            isNonEmptyString(row.accountId) &&
            (row.slowStartSince === null ||
              isNonNegativeInteger(row.slowStartSince)) &&
            (row.slowStartCompletedAt === null ||
              isNonNegativeInteger(row.slowStartCompletedAt)) &&
            typeof row.ambiguous === 'boolean',
        )
      );
    case 'automation_account_projection':
      return (
        isRecord(value) &&
        hasExactKeys(value, ['accounts']) &&
        Array.isArray(value.accounts) &&
        hasUniqueStrings(value.accounts, 'accountId') &&
        value.accounts.every(
          (row) =>
            isRecord(row) &&
            hasExactKeys(row, [
              'accountId',
              'platform',
              'groupLabel',
              'createdAt',
              'status',
            ]) &&
            isNonEmptyString(row.accountId) &&
            isNonEmptyString(row.platform) &&
            isNullableString(row.groupLabel) &&
            (row.createdAt === null || isNonNegativeInteger(row.createdAt)) &&
            (row.status === 'active' || row.status === 'paused'),
        )
      );
    case 'content_schedule':
      return (
        isRecord(value) &&
        hasExactKeys(value, ['global', 'accounts']) &&
        (value.global === null ||
          (isRecord(value.global) &&
            hasExactKeys(value.global, ['contentActiveMask']) &&
            isNullableString(value.global.contentActiveMask))) &&
        Array.isArray(value.accounts) &&
        hasUniqueStrings(value.accounts, 'accountId') &&
        value.accounts.every(isContentScheduleAccount)
      );
    case 'hot_lead_config':
      return (
        isRecord(value) &&
        hasExactKeys(value, [
          'maxAgeHours',
          'velocityMin',
          'minLikeFloor',
          'floorHours',
        ]) &&
        isFiniteNumber(value.maxAgeHours) &&
        isFiniteNumber(value.velocityMin) &&
        isFiniteNumber(value.minLikeFloor) &&
        isFiniteNumber(value.floorHours)
      );
    case 'facebook_comment_config':
      return (
        isRecord(value) &&
        hasExactKeys(value, ['accounts']) &&
        Array.isArray(value.accounts) &&
        hasUniqueStrings(value.accounts, 'accountId') &&
        value.accounts.every(isFacebookCommentAccount)
      );
    case 'facebook_group_join_automation_config':
      return (
        isRecord(value) &&
        hasExactKeys(value, ['accounts']) &&
        Array.isArray(value.accounts) &&
        hasUniqueStrings(value.accounts, 'accountId') &&
        value.accounts.every(isFacebookGroupJoinAccount)
      );
    case 'facebook_operation_policy':
      return (
        isRecord(value) &&
        hasExactKeys(value, ['environments']) &&
        Array.isArray(value.environments) &&
        hasUniqueStrings(value.environments, 'envKey') &&
        value.environments.every(isFacebookOperationBaseline)
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableNonNegativeInteger(value: unknown): boolean {
  return value === null || isNonNegativeInteger(value);
}

function hasUniqueStrings(rows: readonly unknown[], key: string): boolean {
  const values = rows
    .filter(isRecord)
    .map((row) => row[key])
    .filter((value): value is string => typeof value === 'string');
  return values.length === rows.length && new Set(values).size === values.length;
}

function isAutomationHealthEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      'mirrorKey',
      'tier',
      'version',
      'lastComparedAt',
      'lastReloadedAt',
      'reloadFailingSince',
      'state',
      'staleMs',
      'observeStaleMs',
      'haltsOnStale',
      'staleForMs',
    ]) &&
    typeof value.mirrorKey === 'string' &&
    Object.prototype.hasOwnProperty.call(CONFIG_MIRROR_KEYS, value.mirrorKey) &&
    (value.tier === 'gate' || value.tier === 'parameter') &&
    isNullableNonNegativeInteger(value.version) &&
    isNullableNonNegativeInteger(value.lastComparedAt) &&
    isNullableNonNegativeInteger(value.lastReloadedAt) &&
    isNullableNonNegativeInteger(value.reloadFailingSince) &&
    (value.state === 'fresh' || value.state === 'stale') &&
    isNullableNonNegativeInteger(value.staleMs) &&
    isNonNegativeInteger(value.observeStaleMs) &&
    typeof value.haltsOnStale === 'boolean' &&
    isNonNegativeInteger(value.staleForMs)
  );
}

function isContentScheduleAccount(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      'accountId',
      'autoEnabled',
      'postMode',
      'postDailyCap',
      'commentMode',
      'commentDailyCap',
      'contactCommentMode',
      'contactCommentDailyCap',
      'activeWeekMask',
      'contentActiveMask',
    ]) &&
    isNonEmptyString(value.accountId) &&
    typeof value.autoEnabled === 'boolean' &&
    isActionMode(value.postMode) &&
    isNonNegativeInteger(value.postDailyCap) &&
    isActionMode(value.commentMode) &&
    isNonNegativeInteger(value.commentDailyCap) &&
    isActionMode(value.contactCommentMode) &&
    isNonNegativeInteger(value.contactCommentDailyCap) &&
    isNullableString(value.activeWeekMask) &&
    isNullableString(value.contentActiveMask)
  );
}

function isActionMode(
  value: unknown,
): value is 'off' | 'review' | 'auto_approve' {
  return value === 'off' || value === 'review' || value === 'auto_approve';
}

function isFacebookCommentAccount(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      'accountId',
      'keywords',
      'containers',
      'commentMode',
      'commentModeConfigured',
      'commentTemplates',
    ]) &&
    isNonEmptyString(value.accountId) &&
    Array.isArray(value.keywords) &&
    value.keywords.every(isNonEmptyString) &&
    Array.isArray(value.containers) &&
    value.containers.every(
      (container) =>
        isRecord(container) &&
        hasOnlyKeys(container, ['url', 'name']) &&
        isNonEmptyString(container.url) &&
        (container.name === undefined ||
          typeof container.name === 'string'),
    ) &&
    isFacebookCommentModeWire(value.commentMode) &&
    typeof value.commentModeConfigured === 'boolean' &&
    Array.isArray(value.commentTemplates) &&
    value.commentTemplates.every(isNonEmptyString)
  );
}

/** 线缆写法校验：取 kernel 那一份取值表，MUST NOT 在此另写字面量（写死会与发布方悄悄漂开）。 */
function isFacebookCommentModeWire(
  value: unknown,
): value is FacebookCommentModeWire {
  return (
    typeof value === 'string' &&
    (FACEBOOK_COMMENT_MODE_WIRE_VALUES as readonly string[]).includes(value)
  );
}

/**
 * 基线投影校验。三个枚举一律取 kernel 的取值表，MUST NOT 手抄字面量 ——
 * 手抄一份名单拼错也照样编译过，本 change 已为此咬过两次。
 */
function isFacebookOperationBaseline(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      'envKey',
      'primarySurface',
      'surfaceRevision',
      'baseMode',
      'policyRevision',
      'cadenceSource',
      'rule',
      'consumption',
      'reels',
      'updatedAt',
      'updatedBy',
    ]) &&
    isNonEmptyString(value.envKey) &&
    isOneOf(value.primarySurface, FACEBOOK_PRIMARY_BROWSE_SURFACES) &&
    isNonNegativeInteger(value.surfaceRevision) &&
    isOneOf(value.baseMode, FACEBOOK_BASE_OPERATION_MODES) &&
    isNonNegativeInteger(value.policyRevision) &&
    isOneOf(value.cadenceSource, FACEBOOK_CADENCE_SOURCES) &&
    isNumberRecord(value.rule, ['viewsPerLike', 'joinEveryNRounds']) &&
    isNumberRecord(value.consumption, [
      'viewsPerLike',
      'confirmedLikesPerJoin',
      'confirmedJoinsPerComment',
    ]) &&
    isReelCadence(value.reels) &&
    isNullableString(value.updatedAt) &&
    isNullableString(value.updatedBy)
  );
}

function isReelCadence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, ['persona', 'slowStart', 'rule', 'consumption']) &&
    isNumberRecord(value.persona, ['viewsPerLike', 'viewsPerFollow']) &&
    isNumberRecord(value.slowStart, ['viewsPerFollow']) &&
    isNumberRecord(value.rule, ['viewsPerFollow']) &&
    isNumberRecord(value.consumption, ['viewsPerFollow'])
  );
}

function isNumberRecord(value: unknown, keys: readonly string[]): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, keys) &&
    keys.every((key) => isFiniteNumber(value[key]))
  );
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

function isFacebookGroupJoinAccount(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, ['accountId', 'enabled', 'dailyCap', 'weekMask']) &&
    isNonEmptyString(value.accountId) &&
    typeof value.enabled === 'boolean' &&
    isNonNegativeInteger(value.dailyCap) &&
    isNullableString(value.weekMask)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isJson(value: unknown): value is SyncReadJson {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    isFiniteNumber(value)
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}
