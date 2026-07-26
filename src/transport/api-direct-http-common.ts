import type { DeploymentTarget } from '../deployment-target.js';
import {
  API_DIRECT_CONTRACT_VERSION,
  type ApiDirectEnvelope,
  type ApiDirectReadErrorCode,
  type ApiDirectWriteErrorCode,
} from '../kernel/api-direct-port.js';
import { InternalHttpError, type InternalHttpClient } from './internal-http.js';

export type ApiDirectHttpErrorCode =
  | ApiDirectReadErrorCode
  | ApiDirectWriteErrorCode
  | 'internal_http_unauthorized';

export class ApiDirectHttpError extends Error {
  constructor(
    readonly code: ApiDirectHttpErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiDirectHttpError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, label = 'input'): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ApiDirectHttpError('api_direct_invalid_request', `${label} must be an object`);
  }
  return value;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiDirectHttpError('api_direct_invalid_request', `${label} must be a non-empty string`);
  }
  return value;
}

export function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiDirectHttpError('api_direct_invalid_request', `${label} must be a finite number`);
  }
  return value;
}

export function requireInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new ApiDirectHttpError(
      'api_direct_invalid_request',
      `${label} must be an integer >= ${minimum}`,
    );
  }
  return Number(value);
}

export function parseApiDirectEnvelope<T>(
  args: unknown,
  expectedTarget: DeploymentTarget,
  parseInput: (value: unknown) => T,
): T {
  const envelope = requireRecord(args, 'envelope');
  if (envelope.version !== API_DIRECT_CONTRACT_VERSION) {
    throw new ApiDirectHttpError(
      'api_direct_version_unsupported',
      `unsupported api direct contract version=${String(envelope.version)}`,
    );
  }
  if (envelope.executionTarget !== expectedTarget) {
    throw new ApiDirectHttpError(
      'api_direct_target_mismatch',
      `request target=${String(envelope.executionTarget)} does not match receiver target=${expectedTarget}`,
    );
  }
  return parseInput(envelope.input);
}

export function apiDirectEnvelope<T>(
  executionTarget: DeploymentTarget,
  input: T,
): ApiDirectEnvelope<T> {
  return {
    version: API_DIRECT_CONTRACT_VERSION,
    executionTarget,
    input,
  };
}

function translateReadFailure(error: unknown): never {
  if (error instanceof ApiDirectHttpError) throw error;
  if (error instanceof InternalHttpError) {
    if (
      error.code === 'api_direct_invalid_request' ||
      error.code === 'api_direct_version_unsupported' ||
      error.code === 'api_direct_target_mismatch' ||
      error.code === 'internal_http_unauthorized'
    ) {
      throw new ApiDirectHttpError(error.code, error.message, error.details);
    }
    if (error.code === 'bad_response') {
      throw new ApiDirectHttpError('api_authority_bad_response', error.message, error.details);
    }
    if (error.code !== 'timeout' && error.code !== 'transport_error' && error.code !== 'handler_error') {
      throw error;
    }
  }
  throw new ApiDirectHttpError(
    'api_authority_unavailable',
    error instanceof Error ? error.message : String(error),
  );
}

function translateWriteFailure(error: unknown, unknownCode: ApiDirectWriteErrorCode): never {
  if (error instanceof ApiDirectHttpError) throw error;
  if (error instanceof InternalHttpError) {
    if (
      error.code === 'api_direct_invalid_request' ||
      error.code === 'api_direct_version_unsupported' ||
      error.code === 'api_direct_target_mismatch' ||
      error.code === 'internal_http_unauthorized'
    ) {
      throw new ApiDirectHttpError(error.code, error.message, error.details);
    }
    if (
      error.code !== 'timeout' &&
      error.code !== 'transport_error' &&
      error.code !== 'bad_response' &&
      error.code !== 'handler_error'
    ) {
      throw error;
    }
  }
  throw new ApiDirectHttpError(
    unknownCode,
    error instanceof Error ? error.message : String(error),
  );
}

export async function callApiDirectRead<T>(
  http: InternalHttpClient,
  route: string,
  token: string,
  executionTarget: DeploymentTarget,
  input: unknown,
  validate: (value: unknown) => value is T,
): Promise<T> {
  try {
    const result = await http.callBearer<unknown>(
      route,
      apiDirectEnvelope(executionTarget, input),
      token,
    );
    if (!validate(result)) {
      throw new InternalHttpError('bad_response', `malformed response from ${route}`);
    }
    return result;
  } catch (error) {
    return translateReadFailure(error);
  }
}

export async function callApiDirectWrite<T>(
  http: InternalHttpClient,
  route: string,
  token: string,
  executionTarget: DeploymentTarget,
  input: unknown,
  validate: (value: unknown) => value is T,
  unknownCode: ApiDirectWriteErrorCode = 'api_authority_result_unknown',
): Promise<T> {
  try {
    const result = await http.callBearer<unknown>(
      route,
      apiDirectEnvelope(executionTarget, input),
      token,
    );
    if (!validate(result)) {
      throw new InternalHttpError('bad_response', `malformed response from ${route}`);
    }
    return result;
  } catch (error) {
    return translateWriteFailure(error, unknownCode);
  }
}

export function isVoidAck(value: unknown): value is { accepted: true } {
  return isRecord(value) && value.accepted === true;
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

export function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
