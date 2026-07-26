import type {
  EdgeResumeCommandInput,
  EdgeResumeCommandPort,
  EdgeResumeCommandReceipt,
} from '../kernel/api-direct-port.js';

const MAX_RECEIPTS = 1_024;

type AppliedReceipt = Omit<
  Exclude<EdgeResumeCommandReceipt, { outcome: 'collision' }>,
  'outcome'
> & { outcome: 'applied' };

interface StoredReceipt {
  accountId: string;
  receipt: AppliedReceipt;
}

interface InFlightReceipt {
  accountId: string;
  promise: Promise<AppliedReceipt>;
}

export interface EdgeResumeCommandReceiverDeps {
  wsServer: {
    resumeEdgesForAccount(accountId: string): number;
  } | null | undefined;
}

export class EdgeResumeReceiptCapacityError extends Error {
  constructor() {
    super('edge_resume_receipt_capacity_exhausted');
    this.name = 'EdgeResumeReceiptCapacityError';
  }
}

/**
 * Automation-owned command receiver for the process-local paused Edge set.
 *
 * The receipt cache is intentionally process-local: pausedEdges is also
 * process-local, so this adapter must not imply durable exactly-once behavior.
 */
export class EdgeResumeCommandReceiver implements EdgeResumeCommandPort {
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly inFlight = new Map<string, InFlightReceipt>();

  constructor(private readonly deps: EdgeResumeCommandReceiverDeps) {}

  async resumeEdgesForAccount(
    input: EdgeResumeCommandInput,
  ): Promise<EdgeResumeCommandReceipt> {
    const previous = this.receipts.get(input.commandId);
    if (previous) {
      return previous.accountId === input.accountId
        ? { ...previous.receipt, outcome: 'duplicate' }
        : { outcome: 'collision', commandId: input.commandId };
    }

    const running = this.inFlight.get(input.commandId);
    if (running) {
      if (running.accountId !== input.accountId) {
        return { outcome: 'collision', commandId: input.commandId };
      }
      const receipt = await running.promise;
      return { ...receipt, outcome: 'duplicate' };
    }

    if (this.receipts.size + this.inFlight.size >= MAX_RECEIPTS) {
      throw new EdgeResumeReceiptCapacityError();
    }
    const promise = Promise.resolve().then(() => this.apply(input));
    this.inFlight.set(input.commandId, { accountId: input.accountId, promise });
    try {
      const receipt = await promise;
      this.remember(input.commandId, input.accountId, receipt);
      return receipt;
    } finally {
      const current = this.inFlight.get(input.commandId);
      if (current?.promise === promise) this.inFlight.delete(input.commandId);
    }
  }

  private async apply(input: EdgeResumeCommandInput): Promise<AppliedReceipt> {
    const wsServer = this.deps.wsServer;
    if (!wsServer) throw new Error('edge_resume_owner_unavailable');
    const resumedEdges = await Promise.resolve(
      wsServer.resumeEdgesForAccount(input.accountId),
    );
    if (!Number.isInteger(resumedEdges) || resumedEdges < 0) {
      throw new Error('edge_resume_owner_invalid_count');
    }
    return {
      outcome: 'applied',
      commandId: input.commandId,
      accountId: input.accountId,
      resumedEdges,
    };
  }

  private remember(
    commandId: string,
    accountId: string,
    receipt: AppliedReceipt,
  ): void {
    this.receipts.set(commandId, { accountId, receipt });
  }
}
