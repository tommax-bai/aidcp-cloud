import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { InteractionStore } from '../../src/interactions/interaction-store.js';
import {
  classifyInteractionSchema,
  interactionWritesAllowed,
  type InteractionSchemaShape,
} from '../../src/interactions/schema-capability.js';

function storeFor(shape: InteractionSchemaShape, captureSql?: (sql: string) => void): InteractionStore {
  const pool = {
    query: async (sql: string) => {
      captureSql?.(sql);
      return {
        rows: [{
          base_present: shape.basePresent,
          active_attempt_index_present: shape.activeAttemptIndexPresent,
          legacy_retryable_column_present: shape.legacyRetryableColumnPresent,
        }],
      };
    },
  } as unknown as Pool;
  return new InteractionStore({ pool });
}

test('interaction store starts full mode only for the completed migration 0046 shape', async () => {
  const store = storeFor({
    basePresent: true,
    activeAttemptIndexPresent: true,
    legacyRetryableColumnPresent: false,
  });
  assert.equal(await store.init(), 'full');
  assert.equal(interactionWritesAllowed('full', true), true);
  assert.equal(interactionWritesAllowed('full', false), false);
});

test('interaction store starts legacy read-only mode without executing DDL', async () => {
  let inspectedSql = '';
  const store = storeFor({
    basePresent: true,
    activeAttemptIndexPresent: false,
    legacyRetryableColumnPresent: true,
  }, (sql) => { inspectedSql = sql; });

  assert.equal(await store.init(), 'legacy_read_only');
  assert.equal(interactionWritesAllowed('legacy_read_only', true), false);
  assert.match(inspectedSql.trimStart(), /^SELECT\b/);
  assert.doesNotMatch(inspectedSql, /\b(?:ALTER|CREATE|DROP)\b/i);
});

test('legacy writes use the existing global switch only in dev', () => {
  assert.equal(interactionWritesAllowed('legacy_read_only', true, 'dev'), true);
  assert.equal(interactionWritesAllowed('legacy_read_only', false, 'dev'), false);
  assert.equal(interactionWritesAllowed('legacy_read_only', true, 'ol'), false);
  assert.equal(interactionWritesAllowed('legacy_read_only', true), false);
  assert.equal(interactionWritesAllowed(undefined, true, 'dev'), false);
});

test('interaction store rejects a missing base schema', async () => {
  const store = storeFor({
    basePresent: false,
    activeAttemptIndexPresent: false,
    legacyRetryableColumnPresent: true,
  });
  await assert.rejects(store.init(), /interaction_schema_base_incomplete/);
});

// 错误必须点名**缺了哪个对象**。旧文案只写一个迁移号，而基础形状是好几个对象的与 ——
// 2026-08-04 dev 上实际缺的是另一张表，而被点名的那个迁移早就应用了、列也在，
// 于是排查的人先翻迁移账本、再比对列，全程走错方向。**这条用例守的就是「别再那样」。**
test('interaction schema error names the missing objects, not a migration number', () => {
  assert.throws(
    () =>
      classifyInteractionSchema({
        basePresent: false,
        activeAttemptIndexPresent: false,
        legacyRetryableColumnPresent: true,
        missingBaseObjects: ['table interaction_threads', 'column interaction_auth_state.foo'],
      }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /interaction_threads/);
      assert.match(message, /interaction_auth_state\.foo/);
      // 迁移号不该再出现：它答的是「哪一批改的」，不是「现在缺什么」。
      assert.doesNotMatch(message, /run_00\d\d/);
      return true;
    },
  );
});

// 采集不到具体缺失项时**说自己没采集到**，MUST NOT 装作「什么都不缺」。
test('interaction schema error says so when the missing list was not collected', () => {
  assert.throws(
    () =>
      classifyInteractionSchema({
        basePresent: false,
        activeAttemptIndexPresent: false,
        legacyRetryableColumnPresent: true,
      }),
    /未采集具体缺失项/,
  );
});

test('interaction schema classifier rejects both partial migration 0046 shapes', () => {
  assert.throws(() => classifyInteractionSchema({
    basePresent: true,
    activeAttemptIndexPresent: true,
    legacyRetryableColumnPresent: true,
  }), /interaction_schema_inconsistent_run_0046/);
  assert.throws(() => classifyInteractionSchema({
    basePresent: true,
    activeAttemptIndexPresent: false,
    legacyRetryableColumnPresent: false,
  }), /interaction_schema_inconsistent_run_0046/);
});
