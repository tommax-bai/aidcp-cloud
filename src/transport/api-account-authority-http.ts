import type { DeploymentTarget } from '../deployment-target.js';
import {
  API_DIRECT_CONTRACT_VERSION,
  type AccountOwnershipAuthorityPort,
  type AccountRosterAuthorityPort,
  type AccountRuntimeAuthorityPort,
  type RecordNicknameOutcome,
} from '../kernel/api-direct-port.js';
import type {
  ClaimExecutionTargetResult,
  ExecutionTargetResolution,
} from '../kernel/account-ownership-port.js';
import type { AccountIdentityProjectionRow } from '../kernel/account-projection-types.js';
import type { PlatformId } from '../kernel/platform-types.js';
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import {
  ApiDirectHttpError,
  callApiDirectRead,
  callApiDirectWrite,
  isNullableString,
  isRecord,
  isVoidAck,
  parseApiDirectEnvelope,
  requireRecord,
  requireString,
} from './api-direct-http-common.js';

export const ACCOUNT_ROSTER_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const ACCOUNT_OWNERSHIP_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;
export const ACCOUNT_RUNTIME_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;

export const ACCOUNT_ROSTER_ROUTES = {
  listAccountIdentities: 'api-direct/account-roster/v1/list-account-identities',
} as const satisfies Record<keyof AccountRosterAuthorityPort, string>;

export const ACCOUNT_OWNERSHIP_ROUTES = {
  getExecutionTarget: 'api-direct/account-ownership/v1/get-execution-target',
  resolveExecutionTarget: 'api-direct/account-ownership/v1/resolve-execution-target',
  setExecutionTarget: 'api-direct/account-ownership/v1/set-execution-target',
} as const satisfies Record<keyof AccountOwnershipAuthorityPort, string>;

export const ACCOUNT_RUNTIME_ROUTES = {
  ensureAccount: 'api-direct/account-runtime/v1/ensure-account',
  getPlatformOrNull: 'api-direct/account-runtime/v1/get-platform-or-null',
  getContactInfo: 'api-direct/account-runtime/v1/get-contact-info',
  recordNickname: 'api-direct/account-runtime/v1/record-nickname',
} as const satisfies Record<keyof AccountRuntimeAuthorityPort, string>;

function accountIdInput(value: unknown): { accountId: string } {
  const input = requireRecord(value);
  return { accountId: requireString(input.accountId, 'accountId') };
}

function setTargetInput(value: unknown): { accountId: string; target: DeploymentTarget } {
  const input = accountIdInput(value);
  const record = value as Record<string, unknown>;
  if (record.target !== 'dev' && record.target !== 'ol') {
    throw new ApiDirectHttpError('api_direct_invalid_request', 'target must be dev or ol');
  }
  return { ...input, target: record.target };
}

function ensureAccountInput(value: unknown): { accountId: string; platform?: PlatformId } {
  const input = accountIdInput(value);
  const record = value as Record<string, unknown>;
  if (record.platform !== undefined && typeof record.platform !== 'string') {
    throw new ApiDirectHttpError('api_direct_invalid_request', 'platform must be a string');
  }
  return {
    ...input,
    ...(typeof record.platform === 'string' ? { platform: record.platform as PlatformId } : {}),
  };
}

function nicknameInput(value: unknown): { accountId: string; nickname: string } {
  const input = accountIdInput(value);
  return {
    ...input,
    nickname: requireString((value as Record<string, unknown>).nickname, 'nickname'),
  };
}

function isTarget(value: unknown): value is DeploymentTarget {
  return value === 'dev' || value === 'ol';
}

function isRoster(value: unknown): value is readonly AccountIdentityProjectionRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        isRecord(row) &&
        typeof row.accountId === 'string' &&
        typeof row.platform === 'string' &&
        isNullableString(row.groupLabel),
    )
  );
}

function isResolution(value: unknown): value is ExecutionTargetResolution {
  if (!isRecord(value)) return false;
  if (value.outcome === 'unowned' || value.outcome === 'account_not_found') return true;
  return value.outcome === 'owned' && isTarget(value.target);
}

function isSetTargetResult(value: unknown): value is ClaimExecutionTargetResult {
  if (!isRecord(value)) return false;
  if (value.outcome === 'account_not_found') return true;
  return (
    (value.outcome === 'claimed' || value.outcome === 'already_owned_by') &&
    isTarget(value.target)
  );
}

function isPlatformOrNull(value: unknown): value is PlatformId | null {
  return value === null || typeof value === 'string';
}

function isNicknameOutcome(value: unknown): value is RecordNicknameOutcome {
  if (!isRecord(value)) return false;
  if (value.outcome === 'ignored_blank' || value.outcome === 'account_not_found') return true;
  return (
    (value.outcome === 'updated' || value.outcome === 'unchanged') &&
    typeof value.nickname === 'string'
  );
}

export function registerAccountRosterRoutes(
  server: InternalHttpServer,
  local: AccountRosterAuthorityPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(
    ACCOUNT_ROSTER_ROUTES.listAccountIdentities,
    callerToken,
    (args) => {
      parseApiDirectEnvelope(args, executionTarget, (input) => {
        const record = requireRecord(input);
        if (Object.keys(record).length !== 0) {
          throw new ApiDirectHttpError(
            'api_direct_invalid_request',
            'account roster input must be empty',
          );
        }
        return record;
      });
      return local.listAccountIdentities();
    },
  );
}

export function registerAccountOwnershipRoutes(
  server: InternalHttpServer,
  local: AccountOwnershipAuthorityPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(ACCOUNT_OWNERSHIP_ROUTES.getExecutionTarget, callerToken, (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, accountIdInput);
    return local.getExecutionTarget(input.accountId);
  });
  server.registerBearer(ACCOUNT_OWNERSHIP_ROUTES.resolveExecutionTarget, callerToken, (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, accountIdInput);
    return local.resolveExecutionTarget(input.accountId);
  });
  server.registerBearer(ACCOUNT_OWNERSHIP_ROUTES.setExecutionTarget, callerToken, (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, setTargetInput);
    if (input.target !== executionTarget) {
      throw new ApiDirectHttpError(
        'api_direct_target_mismatch',
        'input target does not match envelope executionTarget',
      );
    }
    return local.setExecutionTarget(input.accountId, input.target);
  });
}

export function registerAccountRuntimeRoutes(
  server: InternalHttpServer,
  local: AccountRuntimeAuthorityPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(ACCOUNT_RUNTIME_ROUTES.ensureAccount, callerToken, async (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, ensureAccountInput);
    await local.ensureAccount(input.accountId, input.platform);
    return { accepted: true };
  });
  server.registerBearer(ACCOUNT_RUNTIME_ROUTES.getPlatformOrNull, callerToken, (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, accountIdInput);
    return local.getPlatformOrNull(input.accountId);
  });
  server.registerBearer(ACCOUNT_RUNTIME_ROUTES.getContactInfo, callerToken, (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, accountIdInput);
    return local.getContactInfo(input.accountId);
  });
  server.registerBearer(ACCOUNT_RUNTIME_ROUTES.recordNickname, callerToken, (args) => {
    const input = parseApiDirectEnvelope(args, executionTarget, nicknameInput);
    return local.recordNickname(input.accountId, input.nickname);
  });
}

export class AccountRosterHttpClient implements AccountRosterAuthorityPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  listAccountIdentities(): Promise<readonly AccountIdentityProjectionRow[]> {
    return callApiDirectRead(
      this.http,
      ACCOUNT_ROSTER_ROUTES.listAccountIdentities,
      this.callerToken,
      this.executionTarget,
      {},
      isRoster,
    );
  }
}

export class AccountOwnershipHttpClient implements AccountOwnershipAuthorityPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  getExecutionTarget(accountId: string): Promise<DeploymentTarget | null> {
    return callApiDirectRead(
      this.http,
      ACCOUNT_OWNERSHIP_ROUTES.getExecutionTarget,
      this.callerToken,
      this.executionTarget,
      { accountId },
      (value): value is DeploymentTarget | null => value === null || isTarget(value),
    );
  }

  resolveExecutionTarget(accountId: string): Promise<ExecutionTargetResolution> {
    return callApiDirectRead(
      this.http,
      ACCOUNT_OWNERSHIP_ROUTES.resolveExecutionTarget,
      this.callerToken,
      this.executionTarget,
      { accountId },
      isResolution,
    );
  }

  setExecutionTarget(
    accountId: string,
    target: DeploymentTarget,
  ): Promise<ClaimExecutionTargetResult> {
    return callApiDirectWrite(
      this.http,
      ACCOUNT_OWNERSHIP_ROUTES.setExecutionTarget,
      this.callerToken,
      this.executionTarget,
      { accountId, target },
      isSetTargetResult,
    );
  }
}

export class AccountRuntimeHttpClient implements AccountRuntimeAuthorityPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  async ensureAccount(accountId: string, platform?: PlatformId): Promise<void> {
    await callApiDirectWrite(
      this.http,
      ACCOUNT_RUNTIME_ROUTES.ensureAccount,
      this.callerToken,
      this.executionTarget,
      { accountId, ...(platform === undefined ? {} : { platform }) },
      isVoidAck,
    );
  }

  getPlatformOrNull(accountId: string): Promise<PlatformId | null> {
    return callApiDirectRead(
      this.http,
      ACCOUNT_RUNTIME_ROUTES.getPlatformOrNull,
      this.callerToken,
      this.executionTarget,
      { accountId },
      isPlatformOrNull,
    );
  }

  getContactInfo(accountId: string): Promise<string | null> {
    return callApiDirectRead(
      this.http,
      ACCOUNT_RUNTIME_ROUTES.getContactInfo,
      this.callerToken,
      this.executionTarget,
      { accountId },
      isNullableString,
    );
  }

  recordNickname(accountId: string, nickname: string): Promise<RecordNicknameOutcome> {
    return callApiDirectWrite(
      this.http,
      ACCOUNT_RUNTIME_ROUTES.recordNickname,
      this.callerToken,
      this.executionTarget,
      { accountId, nickname },
      isNicknameOutcome,
    );
  }
}
