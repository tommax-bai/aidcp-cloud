import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InteractionDedup,
  RISK_SCHEMA_SQL,
  SearchFrequencyLimiter,
  type InteractionAction,
  type InteractionStore,
} from '../src/risk/index.js';

class MockInteractionStore implements InteractionStore {
  readonly interactions = new Map<string, number>();
  initCalled = false;

  async init(): Promise<void> {
    this.initCalled = true;
  }

  async hasInteraction(accountId: string, noteId: string, action: InteractionAction): Promise<boolean> {
    return this.interactions.has(this.key(accountId, noteId, action));
  }

  async recordInteraction(accountId: string, noteId: string, action: InteractionAction, interactedAt: number): Promise<void> {
    this.interactions.set(this.key(accountId, noteId, action), interactedAt);
  }

  private key(accountId: string, noteId: string, action: InteractionAction): string {
    return `${accountId}:${noteId}:${action}`;
  }
}

test('InteractionDedup 按 account/note/action 查重并持久化记录', async () => {
  const store = new MockInteractionStore();
  const dedup = new InteractionDedup({ accountId: 'acct-1', store, clock: () => 1234 });
  await dedup.init();

  assert.equal(store.initCalled, true);
  assert.equal(await dedup.hasInteracted('note-1', 'like'), false);
  assert.equal(await dedup.shouldSkipInteraction('note-1', 'like'), false);

  await dedup.recordInteraction('note-1', 'like');

  assert.equal(await dedup.hasInteracted('note-1', 'like'), true);
  assert.equal(await dedup.shouldSkipInteraction('note-1', 'like'), true);
  assert.equal(await dedup.hasInteracted('note-1', 'collect'), false);
  assert.equal(store.interactions.get('acct-1:note-1:like'), 1234);
});

test('SearchFrequencyLimiter 同一关键词每会话最多 1 次，每日最多 3 次，并维护近期队列', () => {
  let now = 0;
  const limiter = new SearchFrequencyLimiter({ clock: () => now, recentLimit: 2 });

  assert.equal(limiter.recordSearch('  AIDCP  '), true);
  assert.equal(limiter.canSearch('aidcp'), false);
  assert.deepEqual(limiter.explain('aidcp'), { allowed: false, reason: 'session_limit' });

  limiter.resetSession();
  assert.equal(limiter.recordSearch('aidcp'), true);
  limiter.resetSession();
  assert.equal(limiter.recordSearch('aidcp'), true);
  limiter.resetSession();
  assert.equal(limiter.canSearch('aidcp'), false);
  assert.deepEqual(limiter.explain('aidcp'), { allowed: false, reason: 'daily_limit' });

  assert.equal(limiter.recordSearch('小红书'), true);
  assert.deepEqual(limiter.recentSearches(), ['aidcp', '小红书']);

  now = 24 * 60 * 60 * 1000 + 1;
  assert.equal(limiter.canSearch('aidcp'), true);
});

test('RISK_SCHEMA_SQL 含 risk_interactions 幂等建表与索引', () => {
  assert.match(RISK_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS risk_interactions/);
  assert.match(RISK_SCHEMA_SQL, /PRIMARY KEY \(account_id, note_id, action\)/);
  assert.match(RISK_SCHEMA_SQL, /idx_risk_interactions_account_time/);
});