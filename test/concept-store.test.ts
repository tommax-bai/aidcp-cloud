import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { CONCEPT_SCHEMA_SQL, ConceptStore } from '../src/cache/index.js';

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

/** 捕获 pool 桩：记录每次 query 的 sql/params，按 sql 返回预设 rows。 */
function capturingPool(rowsFor: (sql: string) => unknown[] = () => []) {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: rowsFor(sql) };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

test('CONCEPT_SCHEMA_SQL 定义 concepts 表与 status 枚举约束', () => {
  assert.match(CONCEPT_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS concepts/);
  assert.match(CONCEPT_SCHEMA_SQL, /keyword\s+TEXT NOT NULL UNIQUE/);
  assert.match(CONCEPT_SCHEMA_SQL, /status IN \('candidate','searched','known'\)/);
});

test('getNewConceptsWithSourceSince 带回来源标题，source_note 为空落 null', async () => {
  const { pool, calls } = capturingPool((sql) =>
    /source_note/.test(sql)
      ? [
          { keyword: 'RAG', source_note: '某篇笔记标题' },
          { keyword: 'vLLM', source_note: null },
        ]
      : [],
  );
  const store = new ConceptStore({ pool });

  const result = await store.getNewConceptsWithSourceSince(1000);

  assert.deepEqual(result, [
    { keyword: 'RAG', sourceNote: '某篇笔记标题' },
    { keyword: 'vLLM', sourceNote: null },
  ]);

  const call = calls.find((c) => /source_note/.test(c.sql));
  assert.ok(call, 'should issue a SELECT with source_note');
  assert.match(call!.sql, /source_note/);
  assert.match(call!.sql, /discovered_at > to_timestamp/);
  assert.deepEqual(call!.params, [1000, 20]);
});
