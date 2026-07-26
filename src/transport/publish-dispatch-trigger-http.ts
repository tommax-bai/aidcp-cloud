/** API → automation publish trigger 的版本化短应答 HTTP route/client。 */

import {
  PUBLISH_DISPATCH_TRIGGER_CONTRACT_VERSION,
  PUBLISH_DISPATCH_TRIGGER_ERROR_CODES,
  PublishDispatchTriggerError,
  type PublishDispatchTriggerAccepted,
  type PublishDispatchTriggerErrorCode,
  type PublishDispatchTriggerInput,
  type PublishDispatchTriggerPort,
} from '../kernel/publish-approval-contract.js';
import {
  InternalHttpError,
  type InternalHttpClient,
  type InternalHttpServer,
} from './internal-http.js';

export const PUBLISH_DISPATCH_TRIGGER_ROUTES = {
  triggerApproved: 'publish-dispatch-trigger/v1/trigger-approved',
} as const;

interface TriggerEnvelope {
  version: typeof PUBLISH_DISPATCH_TRIGGER_CONTRACT_VERSION;
  input: PublishDispatchTriggerInput;
}

function unwrap(args: unknown): PublishDispatchTriggerInput {
  if (!args || typeof args !== 'object') {
    throw new PublishDispatchTriggerError('publish_trigger_invalid_request');
  }
  const envelope = args as Partial<TriggerEnvelope>;
  if (envelope.version !== PUBLISH_DISPATCH_TRIGGER_CONTRACT_VERSION || !envelope.input) {
    throw new PublishDispatchTriggerError(
      'publish_trigger_invalid_request',
      'publish_trigger_contract_version_unsupported',
    );
  }
  return envelope.input;
}

export function registerPublishDispatchTriggerRoutes(
  server: InternalHttpServer,
  local: PublishDispatchTriggerPort,
  callerToken: string,
): void {
  server.registerBearer(PUBLISH_DISPATCH_TRIGGER_ROUTES.triggerApproved, callerToken, (args) =>
    local.triggerApproved(unwrap(args)));
}

function isTriggerCode(value: string): value is PublishDispatchTriggerErrorCode {
  return (PUBLISH_DISPATCH_TRIGGER_ERROR_CODES as readonly string[]).includes(value);
}

export class PublishDispatchTriggerHttpClient implements PublishDispatchTriggerPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
  ) {}

  async triggerApproved(input: PublishDispatchTriggerInput): Promise<PublishDispatchTriggerAccepted> {
    try {
      const result = await this.http.callBearer<PublishDispatchTriggerAccepted>(
        PUBLISH_DISPATCH_TRIGGER_ROUTES.triggerApproved,
        { version: PUBLISH_DISPATCH_TRIGGER_CONTRACT_VERSION, input } satisfies TriggerEnvelope,
        this.callerToken,
      );
      if (
        !result ||
        result.accepted !== true ||
        (result.disposition !== 'queued' && result.disposition !== 'duplicate') ||
        Object.keys(result).some((key) =>
          key === 'dispatchState' || key === 'submitted' || key === 'published' || key === 'platformResult')
      ) {
        throw new InternalHttpError('bad_response', 'malformed publish trigger response');
      }
      return result;
    } catch (err) {
      if (err instanceof PublishDispatchTriggerError) throw err;
      if (err instanceof InternalHttpError && isTriggerCode(err.code)) {
        const details =
          err.details && typeof err.details === 'object'
            ? (err.details as { currentRevision?: number })
            : undefined;
        throw new PublishDispatchTriggerError(err.code, err.message, details);
      }
      // trigger 是写式受理：断链/超时无法知道远端是否已排入唤醒，必须保持 result_unknown。
      throw new PublishDispatchTriggerError(
        'publish_trigger_result_unknown',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
