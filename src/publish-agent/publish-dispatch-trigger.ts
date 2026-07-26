/**
 * automation owner 的 publish approval 低延迟 trigger receiver。
 *
 * trigger 只把工作交给 dispatcher 后立即短应答；分钟级 dispatch Promise 不进入 HTTP 生命周期。
 * `publish_approval_decision` + `PublishApproved` outbox + pending scan 才是可靠性承重链。
 */

import { parseDeploymentTarget, type DeploymentTarget } from '../deployment-target.js';
import {
  PUBLISH_DISPATCH_TRIGGER_KINDS,
  PublishDispatchTriggerError,
  type PublishApprovalAuthorityPort,
  type PublishDispatchTriggerAccepted,
  type PublishDispatchTriggerInput,
  type PublishDispatchTriggerPort,
} from '../kernel/publish-approval-contract.js';

export interface PublishDispatchTriggerReceiverDeps {
  executionTarget: DeploymentTarget | null | undefined;
  approvalAuthority: Pick<PublishApprovalAuthorityPort, 'getApproval'>;
  dispatcher: {
    dispatch(
      recordId: number,
      opts?: { humanApproval?: boolean; approvalRevision?: number },
    ): Promise<void>;
  };
  logger?: Pick<Console, 'warn'>;
}

export function createPublishDispatchTriggerReceiver(
  deps: PublishDispatchTriggerReceiverDeps,
): PublishDispatchTriggerPort {
  const localTarget = parseDeploymentTarget(deps.executionTarget);
  const decisionWakeups = new Set<string>();
  const logger = deps.logger ?? console;

  return {
    async triggerApproved(input: PublishDispatchTriggerInput): Promise<PublishDispatchTriggerAccepted> {
      const target = parseDeploymentTarget(input?.executionTarget);
      if (!localTarget || !target || target !== localTarget) {
        throw new PublishDispatchTriggerError(
          'publish_trigger_target_mismatch',
          `publish_trigger_target_mismatch(local=${localTarget ?? 'unset'},request=${String(input?.executionTarget)})`,
        );
      }
      const match = typeof input?.requestId === 'string' ? /^publish-(\d+)$/.exec(input.requestId) : null;
      if (
        !match ||
        !Number.isSafeInteger(input?.revision) ||
        input.revision < 1 ||
        !(PUBLISH_DISPATCH_TRIGGER_KINDS as readonly string[]).includes(input?.kind)
      ) {
        throw new PublishDispatchTriggerError('publish_trigger_invalid_request');
      }

      let approval;
      try {
        approval = await deps.approvalAuthority.getApproval({
          requestId: input.requestId,
          executionTarget: target,
        });
      } catch (err) {
        throw new PublishDispatchTriggerError(
          'publish_trigger_unavailable',
          err instanceof Error ? err.message : String(err),
        );
      }
      if (!approval || !approval.approved) {
        throw new PublishDispatchTriggerError('publish_trigger_approval_not_found');
      }
      if (approval.revision !== input.revision) {
        throw new PublishDispatchTriggerError(
          'publish_trigger_revision_conflict',
          `publish_trigger_revision_conflict(expected=${input.revision},current=${approval.revision})`,
          { currentRevision: approval.revision },
        );
      }

      // 首写 outbox 同一轮次只有一份，稳定去重可贯穿本进程生命周期。
      // human_reconfirm 不能按 requestId+revision 永久去重：同一授权轮次上的后续人工确认仍必须有权清除
      // 后来重新打开的熔断；其副作用由 dispatcher 的幂等清熔断、inFlight 与账号链吸收。
      const key = `${input.requestId}:${input.revision}:${input.kind}`;
      if (input.kind === 'decision_recorded' && decisionWakeups.has(key)) {
        return { accepted: true, disposition: 'duplicate' };
      }
      if (input.kind === 'decision_recorded') decisionWakeups.add(key);

      const recordId = Number(match[1]);
      void deps.dispatcher
        .dispatch(recordId, {
          ...(input.kind === 'human_reconfirm' ? { humanApproval: true } : {}),
          approvalRevision: input.revision,
        })
        .catch((err) => {
          logger.warn(
            `[publish-trigger] dispatcher wake failed requestId=${input.requestId} revision=${input.revision} kind=${input.kind}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      return { accepted: true, disposition: 'queued' };
    },
  };
}
