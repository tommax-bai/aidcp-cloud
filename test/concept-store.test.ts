import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONCEPT_SCHEMA_SQL } from '../src/cache/index.js';

test('CONCEPT_SCHEMA_SQL 定义 concepts 表与 status 枚举约束', () => {
  assert.match(CONCEPT_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS concepts/);
  assert.match(CONCEPT_SCHEMA_SQL, /keyword\s+TEXT NOT NULL UNIQUE/);
  assert.match(CONCEPT_SCHEMA_SQL, /status IN \('candidate','searched','known'\)/);
});
