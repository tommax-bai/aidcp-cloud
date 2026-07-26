/**
 * automation outbox → API sync-read refresh ingress.
 *
 * The wire request deliberately omits executionTarget: the API route injects
 * its deployment target before validation. The route acknowledges only after
 * the injected handler has fetched, applied, and checkpointed the owner
 * snapshot; a thrown handler error therefore keeps the automation outbox event
 * eligible for replay.
 */
import type { DeploymentTarget } from '../deployment-target.js';
import {
  parseSyncReadChangedSignal,
  SYNC_READ_CONTRACT_VERSION,
  type SyncReadChangedSignal,
  type SyncReadChangedStream,
} from '../kernel/sync-read-snapshot.js';
import {
  InternalHttpError,
  type InternalHttpClient,
  type InternalHttpServer,
} from './internal-http.js';

export const SYNC_READ_CHANGED_ROUTE = 'internal/sync-read/changed';

export interface SyncReadChangedIngress {
  handle(signal: SyncReadChangedSignal): Promise<void>;
}

export interface SyncReadChangedDelivery {
  stream: SyncReadChangedStream;
  generation: string;
}

export interface SyncReadChangedDeliveryPort {
  deliver(change: SyncReadChangedDelivery): Promise<void>;
}

interface SyncReadChangedAck extends SyncReadChangedSignal {
  accepted: true;
}

export function registerSyncReadChangedRoute(
  server: InternalHttpServer,
  ingress: SyncReadChangedIngress,
  options: {
    executionTarget: DeploymentTarget;
    bearerToken: string;
  },
): void {
  server.registerBearer(
    SYNC_READ_CHANGED_ROUTE,
    options.bearerToken,
    async (rawRequest) => {
      const signal = parseRequest(rawRequest, options.executionTarget);
      await ingress.handle(signal);
      return {
        ...signal,
        accepted: true,
      } satisfies SyncReadChangedAck;
    },
  );
}

export class SyncReadChangedHttpClient implements SyncReadChangedDeliveryPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly options: {
      executionTarget: DeploymentTarget;
      bearerToken: string;
    },
  ) {}

  async deliver(change: SyncReadChangedDelivery): Promise<void> {
    const signal = parseSyncReadChangedSignal(
      {
        contractVersion: SYNC_READ_CONTRACT_VERSION,
        executionTarget: this.options.executionTarget,
        stream: change.stream,
        generation: change.generation,
      },
      { executionTarget: this.options.executionTarget },
    );
    const rawAck = await this.http.callBearer<unknown>(
      SYNC_READ_CHANGED_ROUTE,
      {
        contractVersion: signal.contractVersion,
        stream: signal.stream,
        generation: signal.generation,
      },
      this.options.bearerToken,
    );
    parseAck(rawAck, signal);
  }
}

function parseRequest(
  input: unknown,
  executionTarget: DeploymentTarget,
): SyncReadChangedSignal {
  if (!isRecord(input)) {
    throw invalidRequest('sync_read.changed request must be an object');
  }
  if (
    !hasExactKeys(input, ['contractVersion', 'stream', 'generation'])
  ) {
    throw invalidRequest(
      'sync_read.changed request contains missing or unknown keys; target is server-injected',
    );
  }
  return parseSignal(
    {
      ...input,
      executionTarget,
    },
    executionTarget,
  );
}

function parseSignal(
  input: unknown,
  executionTarget: DeploymentTarget,
): SyncReadChangedSignal {
  try {
    return parseSyncReadChangedSignal(input, { executionTarget });
  } catch (error) {
    throw invalidRequest(error instanceof Error ? error.message : String(error));
  }
}

function parseAck(
  input: unknown,
  expected: SyncReadChangedSignal,
): SyncReadChangedAck {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'accepted',
      'contractVersion',
      'executionTarget',
      'stream',
      'generation',
    ]) ||
    input.accepted !== true
  ) {
    throw new InternalHttpError(
      'bad_response',
      'sync_read.changed returned a malformed acknowledgement',
    );
  }
  let signal: SyncReadChangedSignal;
  try {
    signal = parseSyncReadChangedSignal(
      {
        contractVersion: input.contractVersion,
        executionTarget: input.executionTarget,
        stream: input.stream,
        generation: input.generation,
      },
      { executionTarget: expected.executionTarget },
    );
  } catch (error) {
    throw new InternalHttpError(
      'bad_response',
      `sync_read.changed returned an invalid acknowledgement: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    signal.stream !== expected.stream ||
    signal.generation !== expected.generation
  ) {
    throw new InternalHttpError(
      'bad_response',
      'sync_read.changed acknowledgement does not match the delivered signal',
    );
  }
  return { ...signal, accepted: true };
}

function invalidRequest(message: string): InternalHttpError {
  return new InternalHttpError('sync_read_changed_request_invalid', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
