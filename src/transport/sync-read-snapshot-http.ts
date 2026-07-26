import type { DeploymentTarget } from '../deployment-target.js';
import {
  isSyncReadStream,
  parseSyncReadSnapshotEnvelope,
  SYNC_READ_STREAM_DEFINITIONS,
  type SyncReadJson,
  type SyncReadSnapshotEnvelope,
  type SyncReadStream,
} from '../kernel/sync-read-snapshot.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from './internal-http.js';

export const SYNC_READ_SNAPSHOT_ROUTE = 'internal/sync-read/snapshot';

export interface SyncReadSnapshotProvider {
  snapshotFor(input: {
    stream: SyncReadStream;
    executionTarget: DeploymentTarget;
  }): Promise<unknown>;
}

export function registerSyncReadSnapshotRoute(
  server: InternalHttpServer,
  provider: SyncReadSnapshotProvider,
  options: {
    owner: 'api' | 'automation';
    executionTarget: DeploymentTarget;
    bearerToken: string;
    streams: readonly SyncReadStream[];
  },
): void {
  if (options.streams.length === 0) {
    throw new InternalHttpError(
      'sync_read_stream_allowlist_empty',
      'snapshot owner must declare a non-empty stream allowlist',
    );
  }
  const foreignStreams = options.streams.filter(
    (stream) => SYNC_READ_STREAM_DEFINITIONS[stream].owner !== options.owner,
  );
  if (foreignStreams.length > 0) {
    throw new InternalHttpError(
      'sync_read_stream_owner_mismatch',
      `${options.owner} cannot serve streams owned by another service: ${foreignStreams.join(',')}`,
    );
  }
  const allowed = new Set(options.streams);
  server.registerBearer(
    SYNC_READ_SNAPSHOT_ROUTE,
    options.bearerToken,
    async (rawRequest) => {
      const stream = parseRequest(rawRequest);
      if (!allowed.has(stream)) {
        throw new InternalHttpError(
          'sync_read_stream_not_owned',
          `snapshot stream is not served by this owner: ${stream}`,
        );
      }
      const rawEnvelope = await provider.snapshotFor({
        stream,
        executionTarget: options.executionTarget,
      });
      return parseSyncReadSnapshotEnvelope(rawEnvelope, {
        executionTarget: options.executionTarget,
        stream,
        factScope: SYNC_READ_STREAM_DEFINITIONS[stream].factScope,
      });
    },
  );
}

export class SyncReadSnapshotHttpClient {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly options: {
      executionTarget: DeploymentTarget;
      bearerToken: string;
    },
  ) {}

  async fetch<T extends SyncReadJson = SyncReadJson>(
    stream: SyncReadStream,
    validateValue?: (value: unknown) => value is T,
  ): Promise<SyncReadSnapshotEnvelope<T>> {
    const raw = await this.http.callBearer<unknown>(
      SYNC_READ_SNAPSHOT_ROUTE,
      { stream },
      this.options.bearerToken,
    );
    return parseSyncReadSnapshotEnvelope(raw, {
      executionTarget: this.options.executionTarget,
      stream,
      factScope: SYNC_READ_STREAM_DEFINITIONS[stream].factScope,
      validateValue,
    });
  }
}

function parseRequest(input: unknown): SyncReadStream {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InternalHttpError(
      'sync_read_request_invalid',
      'snapshot request must be an object',
    );
  }
  const request = input as Record<string, unknown>;
  if ('executionTarget' in request || 'target' in request) {
    throw new InternalHttpError(
      'sync_read_caller_target_forbidden',
      'snapshot target is injected by the server and cannot be selected by the caller',
    );
  }
  if (!isSyncReadStream(request.stream)) {
    throw new InternalHttpError(
      'sync_read_stream_invalid',
      `unknown snapshot stream: ${String(request.stream)}`,
    );
  }
  const extraKeys = Object.keys(request).filter((key) => key !== 'stream');
  if (extraKeys.length > 0) {
    throw new InternalHttpError(
      'sync_read_request_invalid',
      `snapshot request contains unsupported fields: ${extraKeys.join(',')}`,
    );
  }
  return request.stream;
}
