import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';

import { ApiSyncReadSnapshotSource } from '../../src/config/api-sync-read-source.js';

test('facebook comment sync-read preserves explicit-mode provenance and maps template mode', async () => {
  const client = {
    query: async (sql: string) => {
      if (sql.includes('FROM config_mirror_version')) {
        return {
          rows: [{ mirror_key: 'facebook_comment_config', version: '7' }],
        };
      }
      if (sql.includes('FROM account_facebook_comment_config')) {
        assert.match(sql, /comment_mode_configured/);
        return {
          rows: [{
            account_id: 'fb-1',
            keywords: [' coffee '],
            containers: [],
            comment_mode: 'template',
            comment_mode_configured: false,
            comment_templates: [' 区域前的账号模板 '],
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const source = new ApiSyncReadSnapshotSource({
    executionTarget: 'dev',
    pool: { connect: async () => client } as unknown as pg.Pool,
    parseSoul: () => null,
  });

  const snapshot = await source.snapshot('facebook_comment_config', 1234);
  assert.equal(snapshot.cursor, '35');
  assert.deepEqual(snapshot.value, {
    accounts: [{
      accountId: 'fb-1',
      keywords: ['coffee'],
      containers: [],
      commentMode: 'templates',
      commentModeConfigured: false,
      commentTemplates: ['区域前的账号模板'],
    }],
  });
});
