import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runRetentionSweep,
  retentionConfigFromEnv,
  DEFAULT_RETENTION,
} from '../src/panel/retention-sweeper.js';

const silent = { log: () => {}, warn: () => {} };

test('runRetentionSweep 用配置天数调各 store purge、回传删除计数', async () => {
  const seen: Record<string, number> = {};
  const targets = {
    riskStore: { purgeCountersOlderThan: async (d: number) => { seen.risk = d; return 3; } },
    interactionFeedStore: { purgeOlderThan: async (d: number) => { seen.feed = d; return 5; } },
    tokenUsageStore: { purgeOlderThan: async (d: number) => { seen.token = d; return 7; } },
  };
  const res = await runRetentionSweep(
    targets,
    { riskCounterDays: 7, interactionFeedDays: 30, tokenUsageDays: 45 },
    silent,
  );
  assert.deepEqual(seen, { risk: 7, feed: 30, token: 45 });
  assert.deepEqual(res, { riskCounters: 3, interactionFeed: 5, tokenUsage: 7 });
});

test('单表清理失败不拖累其它（失败项 null，其它照常删）', async () => {
  const targets = {
    riskStore: { purgeCountersOlderThan: async () => { throw new Error('pg down'); } },
    interactionFeedStore: { purgeOlderThan: async () => 5 },
    tokenUsageStore: { purgeOlderThan: async () => 7 },
  };
  const res = await runRetentionSweep(targets, DEFAULT_RETENTION, silent);
  assert.equal(res.riskCounters, null);
  assert.equal(res.interactionFeed, 5);
  assert.equal(res.tokenUsage, 7);
});

test('缺某 store 时该项跳过为 null、不抛', async () => {
  const res = await runRetentionSweep(
    { tokenUsageStore: { purgeOlderThan: async () => 2 } },
    DEFAULT_RETENTION,
    silent,
  );
  assert.deepEqual(res, { riskCounters: null, interactionFeed: null, tokenUsage: 2 });
});

test('retentionConfigFromEnv 读 env、非法值回落默认', () => {
  const cfg = retentionConfigFromEnv({
    AIDCP_RETENTION_RISK_DAYS: '14',
    AIDCP_RETENTION_FEED_DAYS: 'x',
    AIDCP_RETENTION_TOKEN_DAYS: '-3',
  });
  assert.equal(cfg.riskCounterDays, 14);
  assert.equal(cfg.interactionFeedDays, DEFAULT_RETENTION.interactionFeedDays);
  assert.equal(cfg.tokenUsageDays, DEFAULT_RETENTION.tokenUsageDays);
});

test('DEFAULT_RETENTION 满足风控回读 1d、用量页 31d 窗口', () => {
  assert.ok(DEFAULT_RETENTION.riskCounterDays >= 1);
  assert.ok(DEFAULT_RETENTION.tokenUsageDays >= 31);
});
