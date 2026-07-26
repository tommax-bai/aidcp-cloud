import type { DeploymentTarget } from '../deployment-target.js';
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
    readonly commentMode: string;
    readonly commentTemplates: readonly string[];
  }[];
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
      return isRecord(value) && isNullableString(value.weekActiveMask);
    case 'edge_presence':
      return (
        isRecord(value) &&
        isNonNegativeInteger(value.edgeCount) &&
        isNonNegativeInteger(value.onlineEdgeCount) &&
        value.onlineEdgeCount <= value.edgeCount &&
        Array.isArray(value.accountEdges) &&
        hasUniqueStrings(value.accountEdges, 'accountId') &&
        value.accountEdges.every(
          (row) =>
            isRecord(row) &&
            isNonEmptyString(row.accountId) &&
            isNonEmptyString(row.edgeId),
        )
      );
    case 'publish_in_flight':
      return (
        isRecord(value) &&
        Array.isArray(value.recordIds) &&
        value.recordIds.every(isNonNegativeInteger) &&
        new Set(value.recordIds).size === value.recordIds.length
      );
    case 'captcha_availability':
      return (
        isRecord(value) &&
        ['disabled', 'available', 'unavailable', 'unknown'].includes(
          String(value.state),
        )
      );
    case 'automation_config_mirror_health':
      return (
        isRecord(value) &&
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
        Array.isArray(value.accounts) &&
        hasUniqueStrings(value.accounts, 'accountId') &&
        value.accounts.every(
          (row) =>
            isRecord(row) &&
            isNonEmptyString(row.accountId) &&
            typeof row.personaText === 'string' &&
            (row.soul === null || isJson(row.soul)),
        )
      );
    case 'client_environment_automation':
      return (
        isRecord(value) &&
        Array.isArray(value.blockedEnvironmentKeys) &&
        value.blockedEnvironmentKeys.every(isNonEmptyString) &&
        new Set(value.blockedEnvironmentKeys).size ===
          value.blockedEnvironmentKeys.length &&
        Array.isArray(value.slowStartAnchors) &&
        hasUniqueStrings(value.slowStartAnchors, 'accountId') &&
        value.slowStartAnchors.every(
          (row) =>
            isRecord(row) &&
            isNonEmptyString(row.accountId) &&
            (row.slowStartSince === null ||
              isNonNegativeInteger(row.slowStartSince)) &&
            typeof row.ambiguous === 'boolean',
        )
      );
    case 'automation_account_projection':
      return (
        isRecord(value) &&
        Array.isArray(value.accounts) &&
        hasUniqueStrings(value.accounts, 'accountId') &&
        value.accounts.every(
          (row) =>
            isRecord(row) &&
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
        (value.global === null ||
          (isRecord(value.global) &&
            isNullableString(value.global.contentActiveMask))) &&
        Array.isArray(value.accounts) &&
        hasUniqueStrings(value.accounts, 'accountId') &&
        value.accounts.every(isContentScheduleAccount)
      );
    case 'hot_lead_config':
      return (
        isRecord(value) &&
        isFiniteNumber(value.maxAgeHours) &&
        isFiniteNumber(value.velocityMin) &&
        isFiniteNumber(value.minLikeFloor) &&
        isFiniteNumber(value.floorHours)
      );
    case 'facebook_comment_config':
      return (
        isRecord(value) &&
        Array.isArray(value.accounts) &&
        hasUniqueStrings(value.accounts, 'accountId') &&
        value.accounts.every(isFacebookCommentAccount)
      );
    case 'facebook_group_join_automation_config':
      return (
        isRecord(value) &&
        Array.isArray(value.accounts) &&
        hasUniqueStrings(value.accounts, 'accountId') &&
        value.accounts.every(isFacebookGroupJoinAccount)
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
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
    isNonEmptyString(value.mirrorKey) &&
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
    isNonEmptyString(value.accountId) &&
    Array.isArray(value.keywords) &&
    value.keywords.every(isNonEmptyString) &&
    Array.isArray(value.containers) &&
    value.containers.every(
      (container) =>
        isRecord(container) &&
        isNonEmptyString(container.url) &&
        (container.name === undefined ||
          typeof container.name === 'string'),
    ) &&
    (value.commentMode === 'generated' ||
      value.commentMode === 'templates') &&
    Array.isArray(value.commentTemplates) &&
    value.commentTemplates.every(isNonEmptyString)
  );
}

function isFacebookGroupJoinAccount(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.accountId) &&
    typeof value.enabled === 'boolean' &&
    isNonNegativeInteger(value.dailyCap) &&
    isNullableString(value.weekMask)
  );
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
