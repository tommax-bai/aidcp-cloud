import crypto from 'node:crypto';
import type {
  PersonaGeneratorAuthorityPort,
  PersonaGeneratorCommandInput,
  PersonaGeneratorCommandReceipt,
} from '../kernel/api-direct-port.js';
import type { PersonaGeneratorPort } from '../kernel/persona-ports.js';

const MAX_RECEIPTS = 1_024;

type AppliedReceipt = Omit<
  Exclude<PersonaGeneratorCommandReceipt, { outcome: 'collision' }>,
  'outcome'
> & { outcome: 'applied' };

interface ReceiptEntry {
  payloadHash: string;
  receipt: AppliedReceipt;
}

interface InFlightEntry {
  payloadHash: string;
  promise: Promise<AppliedReceipt>;
}

export class PersonaGeneratorReceiptCapacityError extends Error {
  constructor() {
    super('persona_generator_receipt_capacity_exhausted');
    this.name = 'PersonaGeneratorReceiptCapacityError';
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

function payloadHash(input: PersonaGeneratorCommandInput): string {
  return crypto.createHash('sha256').update(canonicalJson({
    accountId: input.accountId,
    keywordSelections: input.keywordSelections,
    writingLanguage: input.writingLanguage,
    diversitySeed: input.diversitySeed,
  })).digest('hex');
}

/**
 * Content-owned PersonaGenerator command receiver.
 *
 * Only generation is invoked here. Account validation and persistence remain
 * API-owned, and unknown delivery remains a transport/caller decision.
 */
export class PersonaGeneratorCommandReceiver
implements PersonaGeneratorAuthorityPort {
  private readonly receipts = new Map<string, ReceiptEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();

  constructor(private readonly generator: PersonaGeneratorPort) {}

  async generate(
    input: PersonaGeneratorCommandInput,
  ): Promise<PersonaGeneratorCommandReceipt> {
    const hash = payloadHash(input);
    const previous = this.receipts.get(input.idempotencyKey);
    if (previous) {
      return previous.payloadHash === hash
        ? { ...previous.receipt, outcome: 'duplicate' }
        : { outcome: 'collision', idempotencyKey: input.idempotencyKey };
    }

    const running = this.inFlight.get(input.idempotencyKey);
    if (running) {
      if (running.payloadHash !== hash) {
        return { outcome: 'collision', idempotencyKey: input.idempotencyKey };
      }
      const receipt = await running.promise;
      return { ...receipt, outcome: 'duplicate' };
    }

    if (this.receipts.size + this.inFlight.size >= MAX_RECEIPTS) {
      throw new PersonaGeneratorReceiptCapacityError();
    }
    const promise = Promise.resolve().then(() => this.apply(input));
    this.inFlight.set(input.idempotencyKey, { payloadHash: hash, promise });
    try {
      const receipt = await promise;
      this.remember(input.idempotencyKey, hash, receipt);
      return receipt;
    } finally {
      const current = this.inFlight.get(input.idempotencyKey);
      if (current?.promise === promise) this.inFlight.delete(input.idempotencyKey);
    }
  }

  private async apply(input: PersonaGeneratorCommandInput): Promise<AppliedReceipt> {
    const result = await this.generator.generate({
      accountId: input.accountId,
      keywordSelections: input.keywordSelections,
      ...(input.writingLanguage === undefined
        ? {}
        : { writingLanguage: input.writingLanguage }),
      ...(input.diversitySeed === undefined
        ? {}
        : { diversitySeed: input.diversitySeed }),
    });
    return {
      outcome: 'applied',
      idempotencyKey: input.idempotencyKey,
      result,
    };
  }

  private remember(
    idempotencyKey: string,
    hash: string,
    receipt: AppliedReceipt,
  ): void {
    this.receipts.set(idempotencyKey, { payloadHash: hash, receipt });
  }
}
