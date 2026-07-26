import type {
  PendingPublishPreview,
  PublishUiUpdateCommandPort,
  PublishUiUpdateCommandReceipt,
  PublishUiUpdateState,
} from '../kernel/api-direct-port.js';

export type PublishUiPreviewDeliveryResult =
  | { outcome: 'no_record'; recordId: number }
  | PublishUiUpdateCommandReceipt;

export interface PublishUiUpdateProducer {
  pushPreview(recordId: number): Promise<PublishUiPreviewDeliveryResult>;
  pushState(
    accountId: string,
    recordId: number,
    state: PublishUiUpdateState,
    factVersion: number,
    title?: string | null,
  ): Promise<PublishUiUpdateCommandReceipt>;
}

export class PublishUiUpdateProducerError extends Error {
  constructor(
    readonly code: 'publish_ui_update_command_collision',
    message: string,
  ) {
    super(message);
    this.name = 'PublishUiUpdateProducerError';
  }
}

export function createPublishUiUpdateProducer(deps: {
  loadPreview(recordId: number): Promise<PendingPublishPreview | null>;
  command: PublishUiUpdateCommandPort;
}): PublishUiUpdateProducer {
  const deliver = async (
    input: Parameters<PublishUiUpdateCommandPort['applyPublishUiUpdate']>[0],
  ): Promise<PublishUiUpdateCommandReceipt> => {
    const receipt = await deps.command.applyPublishUiUpdate(input);
    if (receipt.outcome === 'collision') {
      throw new PublishUiUpdateProducerError(
        'publish_ui_update_command_collision',
        `publish_ui_update_command_collision:${input.commandId}`,
      );
    }
    return receipt;
  };

  return {
    async pushPreview(recordId) {
      const preview = await deps.loadPreview(recordId);
      if (!preview) return { outcome: 'no_record', recordId };
      return deliver({
        commandId: `publish-ui:preview:${recordId}:${preview.contentVersion}`,
        accountId: preview.accountId,
        update: { kind: 'preview', preview },
      });
    },

    pushState(accountId, recordId, state, factVersion, title) {
      return deliver({
        commandId: `publish-ui:state:${recordId}:${state}:${factVersion}`,
        accountId,
        update: {
          kind: 'state',
          recordId,
          state,
          factVersion,
          ...(title !== undefined ? { title } : {}),
        },
      });
    },
  };
}
