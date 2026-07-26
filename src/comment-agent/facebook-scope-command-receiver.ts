import crypto from 'node:crypto';
import type {
  FacebookImportTargetsCommand,
  FacebookImportTargetsReceipt,
  FacebookReplaceTargetScopesCommand,
  FacebookReplaceTargetScopesReceipt,
  FacebookScopeCommandPort,
} from '../kernel/api-direct-port.js';
import { FacebookGroupScopeError } from '../kernel/facebook-group-types.js';
import type {
  FacebookGroupImportResult,
  ReplaceFacebookGroupTargetScopesResult,
} from '../kernel/facebook-group-types.js';
import type { AccountProjectionRefreshResult } from '../transport/account-projection-store.js';

const MAX_RECEIPTS = 1_024;

type FacebookCapability = 'importTargets' | 'replaceTargetScopes';
type AppliedImportReceipt = Omit<
  Exclude<FacebookImportTargetsReceipt, { outcome: 'collision' }>,
  'outcome'
> & { outcome: 'applied' };
type AppliedReplaceReceipt = Omit<
  Exclude<FacebookReplaceTargetScopesReceipt, { outcome: 'collision' }>,
  'outcome'
> & { outcome: 'applied' };
type AppliedReceipt = AppliedImportReceipt | AppliedReplaceReceipt;

interface ReceiptEntry {
  payloadHash: string;
  receipt: AppliedReceipt;
}

interface InFlightEntry {
  payloadHash: string;
  promise: Promise<AppliedReceipt>;
}

export interface FacebookScopeCommandOwner {
  importTargets(
    inputs: FacebookImportTargetsCommand['inputs'],
    importBatch: string | null,
    options?: FacebookImportTargetsCommand['options'],
  ): Promise<FacebookGroupImportResult>;
  replaceTargetScopes(
    groupUrls: string[],
    accountGroupLabels: string[],
    updatedBy: string,
  ): Promise<ReplaceFacebookGroupTargetScopesResult>;
}

export interface FacebookScopeCommandReceiverDeps {
  owner: FacebookScopeCommandOwner;
  refreshAccountProjection(): Promise<AccountProjectionRefreshResult>;
}

export class FacebookRosterRefreshError extends Error {
  constructor(
    readonly reason: AccountProjectionRefreshResult extends infer Result
      ? Result extends { ok: false; reason: infer Reason } ? Reason : never
      : never,
  ) {
    super(`facebook_account_roster_${reason}`);
    this.name = 'FacebookRosterRefreshError';
  }
}

export class FacebookScopeReceiptCapacityError extends Error {
  constructor() {
    super('facebook_scope_receipt_capacity_exhausted');
    this.name = 'FacebookScopeReceiptCapacityError';
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

function payloadHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function scopedLabels(
  input: FacebookImportTargetsCommand | FacebookReplaceTargetScopesCommand,
): string[] | undefined {
  return 'inputs' in input
    ? input.options?.accountGroupLabels
    : input.accountGroupLabels;
}

function isInitialScopeRejection(error: unknown, labels: string[] | undefined): boolean {
  return (labels?.length ?? 0) > 0
    && error instanceof FacebookGroupScopeError
    && error.reason === 'invalid_account_group';
}

/**
 * Paired automation owner for the two Facebook scope writes.
 *
 * The owner store performs its guard before target/scope writes. On the first
 * guard rejection this adapter waits for that owner transaction to roll back,
 * refreshes the local projection, and invokes the same owner method once more.
 * It never holds an owner transaction while AccountRoster is fetched.
 */
export class FacebookScopeCommandReceiver implements FacebookScopeCommandPort {
  private readonly receipts = new Map<string, ReceiptEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();

  constructor(private readonly deps: FacebookScopeCommandReceiverDeps) {}

  async importTargets(
    input: FacebookImportTargetsCommand,
  ): Promise<FacebookImportTargetsReceipt> {
    return this.runCommand(
      'importTargets',
      input.commandId,
      payloadHash({
        inputs: input.inputs,
        importBatch: input.importBatch,
        options: input.options,
      }),
      async () => ({
        outcome: 'applied',
        commandId: input.commandId,
        result: await this.withRosterRefresh(
          input,
          () => this.deps.owner.importTargets(
            input.inputs,
            input.importBatch,
            input.options,
          ),
        ),
      }),
    ) as Promise<FacebookImportTargetsReceipt>;
  }

  async replaceTargetScopes(
    input: FacebookReplaceTargetScopesCommand,
  ): Promise<FacebookReplaceTargetScopesReceipt> {
    return this.runCommand(
      'replaceTargetScopes',
      input.commandId,
      payloadHash({
        groupUrls: input.groupUrls,
        accountGroupLabels: input.accountGroupLabels,
        updatedBy: input.updatedBy,
      }),
      async () => ({
        outcome: 'applied',
        commandId: input.commandId,
        result: await this.withRosterRefresh(
          input,
          () => this.deps.owner.replaceTargetScopes(
            input.groupUrls,
            input.accountGroupLabels,
            input.updatedBy,
          ),
        ),
      }),
    ) as Promise<FacebookReplaceTargetScopesReceipt>;
  }

  private async withRosterRefresh<T>(
    input: FacebookImportTargetsCommand | FacebookReplaceTargetScopesCommand,
    ownerWrite: () => Promise<T>,
  ): Promise<T> {
    try {
      return await ownerWrite();
    } catch (error) {
      if (!isInitialScopeRejection(error, scopedLabels(input))) throw error;
    }

    const refreshed = await this.deps.refreshAccountProjection();
    if (!refreshed.ok) throw new FacebookRosterRefreshError(refreshed.reason);
    return ownerWrite();
  }

  private async runCommand(
    capability: FacebookCapability,
    commandId: string,
    hash: string,
    apply: () => Promise<AppliedReceipt>,
  ): Promise<FacebookImportTargetsReceipt | FacebookReplaceTargetScopesReceipt> {
    const key = `${capability}:${commandId}`;
    const previous = this.receipts.get(key);
    if (previous) {
      return previous.payloadHash === hash
        ? { ...previous.receipt, outcome: 'duplicate' }
        : { outcome: 'collision', commandId };
    }

    const running = this.inFlight.get(key);
    if (running) {
      if (running.payloadHash !== hash) return { outcome: 'collision', commandId };
      const receipt = await running.promise;
      return { ...receipt, outcome: 'duplicate' };
    }

    if (this.receipts.size + this.inFlight.size >= MAX_RECEIPTS) {
      throw new FacebookScopeReceiptCapacityError();
    }
    const promise = Promise.resolve().then(apply);
    this.inFlight.set(key, { payloadHash: hash, promise });
    try {
      const receipt = await promise;
      this.remember(key, hash, receipt);
      return receipt;
    } finally {
      const current = this.inFlight.get(key);
      if (current?.promise === promise) this.inFlight.delete(key);
    }
  }

  private remember(key: string, hash: string, receipt: AppliedReceipt): void {
    this.receipts.set(key, { payloadHash: hash, receipt });
  }
}
