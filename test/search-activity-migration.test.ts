import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readMigration } from './helpers/migration-union.js';

test('0055 admits search only to account risk counters and initializes safe quotas', async () => {
  const sql = await readMigration('0055_first_class_search_activity.sql');
  assert.match(sql, /risk_counters_action_check[\s\S]*'search'/);
  assert.match(sql, /\('conservative', 'search', 5, 1, 4/);
  assert.match(sql, /\('normal',\s+'search', 10, 1, 4/);
  assert.match(sql, /\('aggressive',\s+'search', 20, 1, 4/);
  assert.doesNotMatch(sql, /ALTER TABLE risk_interactions|interaction_feed/);
});
