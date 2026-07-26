/**
 * API-owned publish approval decision writer 的 versioned HTTP route/client。
 * automation 提交完整决定上下文；API 校验 target 后进入唯一持久写出口。
 */
import {
  PUBLISH_APPROVAL_DECISION_WRITER_CONTRACT_VERSION,
  PUBLISH_APPROVAL_DECISION_WRITER_ERROR_CODES,
  PublishApprovalDecisionWriterError,
  type PublishApprovalDecisionWriteInput,
  type PublishApprovalDecisionWriteOutcome,
  type PublishApprovalDecisionWriterErrorCode,
  type PublishApprovalDecisionWriterPort,
} from '../kernel/publish-approval-contract.js';
import {
  InternalHttpError,
  type InternalHttpClient,
  type InternalHttpServer,
} from './internal-http.js';

export const PUBLISH_APPROVAL_DECISION_WRITER_ROUTES = {
  writeDecision: 'publish-approval-decision-writer/v1/write-decision',
} as const;

interface DecisionWriterEnvelope {
  version: typeof PUBLISH_APPROVAL_DECISION_WRITER_CONTRACT_VERSION;
  input: PublishApprovalDecisionWriteInput;
}

function unwrap(args: unknown): PublishApprovalDecisionWriteInput {
  if (!args || typeof args !== 'object') {
    throw new PublishApprovalDecisionWriterError(
      'approval_decision_invalid_request',
      'approval_decision_envelope_invalid',
    );
  }
  const envelope = args as Partial<DecisionWriterEnvelope>;
  if (
    envelope.version !== PUBLISH_APPROVAL_DECISION_WRITER_CONTRACT_VERSION ||
    !envelope.input ||
    typeof envelope.input !== 'object'
  ) {
    throw new PublishApprovalDecisionWriterError(
      'approval_decision_invalid_request',
      'approval_decision_contract_version_unsupported',
    );
  }
  return envelope.input;
}

export function registerPublishApprovalDecisionWriterRoutes(
  server: InternalHttpServer,
  local: PublishApprovalDecisionWriterPort,
  callerToken: string,
): void {
  server.registerBearer(PUBLISH_APPROVAL_DECISION_WRITER_ROUTES.writeDecision, callerToken, (args) =>
    local.writeDecision(unwrap(args)));
}

function isKnownCode(value: string): value is PublishApprovalDecisionWriterErrorCode {
  return (PUBLISH_APPROVAL_DECISION_WRITER_ERROR_CODES as readonly string[]).includes(value);
}

function isOutcome(value: unknown): value is PublishApprovalDecisionWriteOutcome {
  if (!value || typeof value !== 'object') return false;
  const outcome = value as Partial<PublishApprovalDecisionWriteOutcome>;
  return (
    typeof outcome.written === 'boolean' &&
    Number.isInteger(outcome.revision) &&
    Number(outcome.revision) >= 1 &&
    (outcome.alreadyDecided === undefined || typeof outcome.alreadyDecided === 'boolean')
  );
}

export class PublishApprovalDecisionWriterHttpClient implements PublishApprovalDecisionWriterPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
  ) {}

  async writeDecision(
    input: PublishApprovalDecisionWriteInput,
  ): Promise<PublishApprovalDecisionWriteOutcome> {
    try {
      const result = await this.http.callBearer<PublishApprovalDecisionWriteOutcome>(
        PUBLISH_APPROVAL_DECISION_WRITER_ROUTES.writeDecision,
        {
          version: PUBLISH_APPROVAL_DECISION_WRITER_CONTRACT_VERSION,
          input,
        } satisfies DecisionWriterEnvelope,
        this.callerToken,
      );
      if (!isOutcome(result)) {
        throw new InternalHttpError('bad_response', 'malformed approval decision write outcome');
      }
      return result;
    } catch (err) {
      if (err instanceof PublishApprovalDecisionWriterError) throw err;
      if (err instanceof InternalHttpError && isKnownCode(err.code)) {
        throw new PublishApprovalDecisionWriterError(err.code, err.message);
      }
      // 写请求可能已在 API 侧落库；网络或响应失败不能降格成“未写”或安全重试。
      throw new PublishApprovalDecisionWriterError(
        'approval_decision_result_unknown',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
