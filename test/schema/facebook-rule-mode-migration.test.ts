import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Facebook rule migrations keep API config and target-scoped runtime in separate owner files', async () => {
  const [config, runtime] = await Promise.all([
    readFile(new URL('../../migrations/0092_facebook_rule_mode_config.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../migrations/0093_facebook_rule_mode_runtime.sql', import.meta.url), 'utf8'),
  ]);

  assert.match(config, /aidcp:kind=expand/);
  assert.match(config, /table:facebook_rule_mode_config/);
  assert.doesNotMatch(config, /facebook_rule_progress/);
  assert.match(config, /enabled\s+BOOLEAN NOT NULL DEFAULT false/);
  assert.match(config, /definition_version\s+INTEGER NOT NULL DEFAULT 1/);

  assert.match(runtime, /aidcp:kind=expand/);
  assert.match(runtime, /execution_target\s+TEXT NOT NULL CHECK \(execution_target IN \('dev', 'ol'\)\)/);
  assert.match(runtime, /PRIMARY KEY \(\s*account_id, execution_target, definition_id, definition_version,\s*collecting_sequence, content_key\s*\)/s);
  assert.match(runtime, /UNIQUE \(\s*account_id, execution_target, definition_id, definition_version,\s*source_dedupe_key\s*\)/s);
  assert.match(runtime, /UNIQUE \(account_id, execution_target, definition_id, definition_version, sequence\)/);
  assert.match(runtime, /CHECK \(view_count BETWEEN 0 AND 9\)/);
  assert.match(runtime, /CHECK \(definition_version = 1\)/);
  for (const state of [
    'confirmed',
    'already_satisfied',
    'risk_suppressed',
    'structural_skip',
    'not_started',
    'failed',
    'ambiguous',
    'submitted_unknown',
  ]) {
    assert.match(runtime, new RegExp(`'${state}'`));
  }
});
