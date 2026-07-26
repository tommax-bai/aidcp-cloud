import crypto from 'node:crypto';
import type {
  PendingPublishPreview,
  PublishUiUpdateCommandInput,
  PublishUiUpdateCommandPort,
  PublishUiUpdateCommandReceipt,
} from '../kernel/api-direct-port.js';
import type { UiPublishPreviewPayload } from './protocol.js';
import type { UiSnapshotService } from './ui-snapshot.js';

const MAX_RECEIPTS = 1_024;

type StableReceipt = PublishUiUpdateCommandReceipt & {
  outcome: 'applied' | 'stale';
};

interface ReceiptEntry {
  payloadHash: string;
  receipt: StableReceipt;
}

interface InFlightEntry {
  payloadHash: string;
  promise: Promise<StableReceipt>;
}

export interface PublishUiUpdateCommandReceiverDeps {
  uiSnapshot: Pick<UiSnapshotService, 'pushPublishPreview' | 'pushPublishState'>;
}

export class PublishUiUpdateReceiptCapacityError extends Error {
  constructor() {
    super('publish_ui_update_receipt_capacity_exhausted');
    this.name = 'PublishUiUpdateReceiptCapacityError';
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(input: PublishUiUpdateCommandInput): string {
  return crypto.createHash('sha256').update(canonicalJson({
    accountId: input.accountId,
    update: input.update,
  })).digest('hex');
}

function toUiPublishPreview(preview: PendingPublishPreview): UiPublishPreviewPayload {
  return {
    recordId: preview.id,
    code: `#${preview.id}`,
    kind: preview.kind,
    title: preview.title ?? '',
    content: preview.content,
    topics: preview.topics,
    images: preview.images,
    contentVersion: preview.contentVersion,
    updatedAt: preview.updatedAt,
    ...(preview.imageReferenceAudit
      ? { imageReferenceAudit: preview.imageReferenceAudit }
      : {}),
  };
}

/**
 * Automation owner for API-originated publish UI updates.
 *
 * Receipts are intentionally process-local because UiSnapshotService pushes to
 * process-local Edge connections. The exact bounded ledger never evicts an old
 * receipt: once full, new command ids fail closed instead of becoming replayable.
 */
export class PublishUiUpdateCommandReceiver implements PublishUiUpdateCommandPort {
  private readonly receipts = new Map<string, ReceiptEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly latestFactVersions = new Map<string, number>();

  constructor(private readonly deps: PublishUiUpdateCommandReceiverDeps) {}

  async applyPublishUiUpdate(
    input: PublishUiUpdateCommandInput,
  ): Promise<PublishUiUpdateCommandReceipt> {
    const hash = payloadHash(input);
    const previous = this.receipts.get(input.commandId);
    if (previous) {
      return previous.payloadHash === hash
        ? { ...previous.receipt, outcome: 'duplicate' }
        : {
            outcome: 'collision',
            commandId: input.commandId,
            accountId: input.accountId,
          };
    }

    const running = this.inFlight.get(input.commandId);
    if (running) {
      if (running.payloadHash !== hash) {
        return {
          outcome: 'collision',
          commandId: input.commandId,
          accountId: input.accountId,
        };
      }
      const receipt = await running.promise;
      return { ...receipt, outcome: 'duplicate' };
    }

    if (this.receipts.size + this.inFlight.size >= MAX_RECEIPTS) {
      throw new PublishUiUpdateReceiptCapacityError();
    }

    const promise = Promise.resolve().then(() => this.apply(input));
    this.inFlight.set(input.commandId, { payloadHash: hash, promise });
    try {
      const receipt = await promise;
      this.receipts.set(input.commandId, { payloadHash: hash, receipt });
      return receipt;
    } finally {
      const current = this.inFlight.get(input.commandId);
      if (current?.promise === promise) this.inFlight.delete(input.commandId);
    }
  }

  private async apply(input: PublishUiUpdateCommandInput): Promise<StableReceipt> {
    if (
      input.update.kind === 'preview' &&
      input.update.preview.accountId !== input.accountId
    ) {
      throw new Error('publish_ui_update_account_mismatch');
    }

    const recordId = input.update.kind === 'preview'
      ? input.update.preview.id
      : input.update.recordId;
    const factVersion = input.update.kind === 'preview'
      ? input.update.preview.contentVersion
      : input.update.factVersion;
    const factKey = canonicalJson([input.accountId, recordId]);
    const latestFactVersion = this.latestFactVersions.get(factKey);
    if (latestFactVersion !== undefined && factVersion < latestFactVersion) {
      return {
        outcome: 'stale',
        commandId: input.commandId,
        accountId: input.accountId,
      };
    }

    if (input.update.kind === 'preview') {
      this.deps.uiSnapshot.pushPublishPreview(
        input.accountId,
        toUiPublishPreview(input.update.preview),
      );
    } else {
      this.deps.uiSnapshot.pushPublishState(
        input.accountId,
        input.update.recordId,
        input.update.state,
        input.update.title,
      );
    }
    this.latestFactVersions.set(factKey, factVersion);
    return {
      outcome: 'applied',
      commandId: input.commandId,
      accountId: input.accountId,
    };
  }
}
