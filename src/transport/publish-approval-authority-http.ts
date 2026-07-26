/**
 * API-owned publish approval authority 的真实内部 HTTP route/client。
 * route 与 envelope 都带 v1；automation client 不接触 API 数据库。
 */

import {
  PUBLISH_APPROVAL_AUTHORITY_CONTRACT_VERSION,
  PUBLISH_APPROVAL_AUTHORITY_ERROR_CODES,
  PublishApprovalAuthorityError,
  type PublishApprovalAuthorityErrorCode,
  type PublishApprovalAuthorityPort,
  type PublishApprovalListInput,
  type PublishApprovalReadInput,
  type PublishApprovalRevisionInput,
  type PublishApprovalView,
  type ReleasePublishApprovalInput,
  type SetPublishApprovalBlockedReasonInput,
  type VoidPublishApprovalInput,
} from '../kernel/publish-approval-contract.js';
import {
  InternalHttpError,
  type InternalHttpClient,
  type InternalHttpServer,
} from './internal-http.js';

export const PUBLISH_APPROVAL_AUTHORITY_ROUTES = {
  getApproval: 'publish-approval-authority/v1/get-approval',
  listPendingDispatch: 'publish-approval-authority/v1/list-pending-dispatch',
  voidApproval: 'publish-approval-authority/v1/void-approval',
  markDispatching: 'publish-approval-authority/v1/mark-dispatching',
  markConsumed: 'publish-approval-authority/v1/mark-consumed',
  releaseToPending: 'publish-approval-authority/v1/release-to-pending',
  setBlockedReason: 'publish-approval-authority/v1/set-blocked-reason',
} as const;

interface AuthorityEnvelope<T> {
  version: typeof PUBLISH_APPROVAL_AUTHORITY_CONTRACT_VERSION;
  input: T;
}

function unwrap<T>(args: unknown): T {
  if (!args || typeof args !== 'object') {
    throw new PublishApprovalAuthorityError('approval_invalid_request', 'approval_envelope_invalid');
  }
  const envelope = args as Partial<AuthorityEnvelope<T>>;
  if (envelope.version !== PUBLISH_APPROVAL_AUTHORITY_CONTRACT_VERSION || !envelope.input) {
    throw new PublishApprovalAuthorityError('approval_invalid_request', 'approval_contract_version_unsupported');
  }
  return envelope.input;
}

export function registerPublishApprovalAuthorityRoutes(
  server: InternalHttpServer,
  local: PublishApprovalAuthorityPort,
  callerToken: string,
): void {
  server.registerBearer(PUBLISH_APPROVAL_AUTHORITY_ROUTES.getApproval, callerToken, (args) =>
    local.getApproval(unwrap<PublishApprovalReadInput>(args)));
  server.registerBearer(PUBLISH_APPROVAL_AUTHORITY_ROUTES.listPendingDispatch, callerToken, (args) =>
    local.listPendingDispatch(unwrap<PublishApprovalListInput>(args)));
  server.registerBearer(PUBLISH_APPROVAL_AUTHORITY_ROUTES.voidApproval, callerToken, (args) =>
    local.voidApproval(unwrap<VoidPublishApprovalInput>(args)));
  server.registerBearer(PUBLISH_APPROVAL_AUTHORITY_ROUTES.markDispatching, callerToken, (args) =>
    local.markDispatching(unwrap<PublishApprovalRevisionInput>(args)));
  server.registerBearer(PUBLISH_APPROVAL_AUTHORITY_ROUTES.markConsumed, callerToken, (args) =>
    local.markConsumed(unwrap<PublishApprovalRevisionInput>(args)));
  server.registerBearer(PUBLISH_APPROVAL_AUTHORITY_ROUTES.releaseToPending, callerToken, (args) =>
    local.releaseToPending(unwrap<ReleasePublishApprovalInput>(args)));
  server.registerBearer(PUBLISH_APPROVAL_AUTHORITY_ROUTES.setBlockedReason, callerToken, (args) =>
    local.setBlockedReason(unwrap<SetPublishApprovalBlockedReasonInput>(args)));
}

function envelope<T>(input: T): AuthorityEnvelope<T> {
  return { version: PUBLISH_APPROVAL_AUTHORITY_CONTRACT_VERSION, input };
}

function isKnownAuthorityCode(value: string): value is PublishApprovalAuthorityErrorCode {
  return (PUBLISH_APPROVAL_AUTHORITY_ERROR_CODES as readonly string[]).includes(value);
}

function translateFailure(err: unknown, mutation: boolean): never {
  if (err instanceof PublishApprovalAuthorityError) throw err;
  if (err instanceof InternalHttpError && isKnownAuthorityCode(err.code)) {
    const details =
      err.details && typeof err.details === 'object'
        ? (err.details as { currentRevision?: number; currentState?: PublishApprovalView['dispatchState'] })
        : undefined;
    throw new PublishApprovalAuthorityError(err.code, err.message, details);
  }
  throw new PublishApprovalAuthorityError(
    mutation ? 'approval_authority_result_unknown' : 'approval_authority_unavailable',
    err instanceof Error ? err.message : String(err),
  );
}

function isApprovalView(value: unknown): value is PublishApprovalView {
  if (!value || typeof value !== 'object') return false;
  const view = value as Partial<PublishApprovalView>;
  return (
    typeof view.requestId === 'string' &&
    Number.isInteger(view.revision) &&
    typeof view.approved === 'boolean' &&
    Number.isInteger(view.contentVersion) &&
    (view.executionTarget === 'dev' || view.executionTarget === 'ol') &&
    (view.dispatchState === 'pending_dispatch' ||
      view.dispatchState === 'dispatching' ||
      view.dispatchState === 'consumed' ||
      view.dispatchState === 'void')
  );
}

export class PublishApprovalAuthorityHttpClient implements PublishApprovalAuthorityPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
  ) {}

  async getApproval(input: PublishApprovalReadInput): Promise<PublishApprovalView | null> {
    try {
      const result = await this.http.callBearer<PublishApprovalView | null>(
        PUBLISH_APPROVAL_AUTHORITY_ROUTES.getApproval,
        envelope(input),
        this.callerToken,
      );
      if (result !== null && !isApprovalView(result)) {
        throw new InternalHttpError('bad_response', 'malformed approval view');
      }
      return result;
    } catch (err) {
      return translateFailure(err, false);
    }
  }

  async listPendingDispatch(input: PublishApprovalListInput): Promise<PublishApprovalView[]> {
    try {
      const result = await this.http.callBearer<PublishApprovalView[]>(
        PUBLISH_APPROVAL_AUTHORITY_ROUTES.listPendingDispatch,
        envelope(input),
        this.callerToken,
      );
      if (!Array.isArray(result) || result.some((item) => !isApprovalView(item))) {
        throw new InternalHttpError('bad_response', 'malformed approval list');
      }
      return result;
    } catch (err) {
      return translateFailure(err, false);
    }
  }

  voidApproval(input: VoidPublishApprovalInput): Promise<PublishApprovalView> {
    return this.mutate(PUBLISH_APPROVAL_AUTHORITY_ROUTES.voidApproval, input);
  }

  markDispatching(input: PublishApprovalRevisionInput): Promise<PublishApprovalView> {
    return this.mutate(PUBLISH_APPROVAL_AUTHORITY_ROUTES.markDispatching, input);
  }

  markConsumed(input: PublishApprovalRevisionInput): Promise<PublishApprovalView> {
    return this.mutate(PUBLISH_APPROVAL_AUTHORITY_ROUTES.markConsumed, input);
  }

  releaseToPending(input: ReleasePublishApprovalInput): Promise<PublishApprovalView> {
    return this.mutate(PUBLISH_APPROVAL_AUTHORITY_ROUTES.releaseToPending, input);
  }

  setBlockedReason(input: SetPublishApprovalBlockedReasonInput): Promise<PublishApprovalView> {
    return this.mutate(PUBLISH_APPROVAL_AUTHORITY_ROUTES.setBlockedReason, input);
  }

  private async mutate<T>(route: string, input: T): Promise<PublishApprovalView> {
    try {
      const result = await this.http.callBearer<PublishApprovalView>(
        route,
        envelope(input),
        this.callerToken,
      );
      if (!isApprovalView(result)) {
        throw new InternalHttpError('bad_response', 'malformed approval mutation result');
      }
      return result;
    } catch (err) {
      return translateFailure(err, true);
    }
  }
}
