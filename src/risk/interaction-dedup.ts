import type { InteractionAction, InteractionStore } from './types.js';

export interface InteractionDedupOptions {
  accountId?: string;
  store: InteractionStore;
  clock?: () => number;
}

export class InteractionDedup {
  private readonly accountId: string;
  private readonly store: InteractionStore;
  private readonly clock: () => number;

  constructor(options: InteractionDedupOptions) {
    this.accountId = options.accountId ?? '__unbound__';
    this.store = options.store;
    this.clock = options.clock ?? Date.now;
  }

  async init(): Promise<void> {
    await this.store.init?.();
  }

  async hasInteracted(noteId: string, action: InteractionAction): Promise<boolean> {
    return this.store.hasInteraction(this.accountId, noteId, action);
  }

  async recordInteraction(noteId: string, action: InteractionAction): Promise<void> {
    await this.store.recordInteraction(this.accountId, noteId, action, this.clock());
  }

  async shouldSkipInteraction(noteId: string, action: InteractionAction): Promise<boolean> {
    return this.hasInteracted(noteId, action);
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }
}