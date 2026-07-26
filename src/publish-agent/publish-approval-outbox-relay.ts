/**
 * API owner 的 PublishApproved durable outbox relay。
 *
 * 只有 automation trigger 明确短应答后才确认本地 outbox；断链或结果未知时保留原命令，
 * 由后续轮次重投。trigger 受理不代表 dispatch、submit 或 publish 成功。
 */

import { parseDeploymentTarget, type DeploymentTarget } from '../deployment-target.js';
import {
  PublishApprovalAuthorityError,
  PublishDispatchTriggerError,
  type PublishDispatchTriggerPort,
} from '../kernel/publish-approval-contract.js';
import type { PublishApprovedCommand, PublishApprovalStore } from './publish-approval-store.js';

export interface PublishApprovalOutboxRelayDeps {
  executionTarget: DeploymentTarget | null | undefined;
  store: Pick<PublishApprovalStore, 'listPendingApprovedCommands' | 'markApprovedCommandConsumed'>;
  trigger: PublishDispatchTriggerPort;
  logger?: Pick<Console, 'warn'>;
}

export interface PublishApprovalOutboxRelayResult {
  found: number;
  acknowledged: number;
  failed: number;
}

/**
 * 3b 前遗留的 comment approval outbox 识别必须足够窄：
 * requestId 与 candidateRef 两份独立字段都吻合既有 `comment-<opaque>` 编码才可安全退休。
 * 任何 malformed / unknown publish 命令都不得借「非 publish」之名被吞掉。
 */
function isLegacyCommentApprovalCommand(command: PublishApprovedCommand): boolean {
  const prefix = 'comment-';
  if (!command.requestId.startsWith(prefix) || command.requestId.length === prefix.length) return false;
  return command.candidateRef === command.requestId.slice(prefix.length);
}

export class PublishApprovalOutboxRelay {
  private readonly executionTarget: DeploymentTarget | null;
  private readonly logger: Pick<Console, 'warn'>;

  constructor(private readonly deps: PublishApprovalOutboxRelayDeps) {
    this.executionTarget = parseDeploymentTarget(deps.executionTarget);
    this.logger = deps.logger ?? console;
  }

  async runOnce(limit = 20): Promise<PublishApprovalOutboxRelayResult> {
    if (!this.executionTarget) {
      throw new PublishApprovalAuthorityError(
        'approval_target_mismatch',
        'publish_approval_outbox_target_unavailable',
      );
    }
    const commands = await this.deps.store.listPendingApprovedCommands(this.executionTarget, limit);
    let acknowledged = 0;
    let failed = 0;
    for (const command of commands) {
      try {
        await this.relay(command);
        acknowledged += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(
          `[publish-approval-outbox] trigger retained requestId=${command.requestId} revision=${command.revision}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { found: commands.length, acknowledged, failed };
  }

  private async relay(command: PublishApprovedCommand): Promise<void> {
    if (command.executionTarget !== this.executionTarget) {
      throw new PublishDispatchTriggerError('publish_trigger_target_mismatch');
    }
    if (isLegacyCommentApprovalCommand(command)) {
      await this.deps.store.markApprovedCommandConsumed(command);
      this.logger.warn(
        `[publish-approval-outbox] retired legacy comment command without publish trigger ` +
          `requestId=${command.requestId} revision=${command.revision}`,
      );
      return;
    }
    await this.deps.trigger.triggerApproved({
      requestId: command.requestId,
      revision: command.revision,
      executionTarget: command.executionTarget,
      kind: 'decision_recorded',
    });
    await this.deps.store.markApprovedCommandConsumed(command);
  }
}
