/**
 * 同步读自举名单的完整性闸（原 monolith-sync-read-bootstrap，事实源翻转后 re-anchor）。
 *
 * **这条是补回归**：批 E-2 步骤 2 新增 `facebook_operation_policy` 后，镜像那边有了第八条、
 * 组装根里那份**手抄的**自举名单还是七条，于是第八条恒 `uninitialized`、
 * 就绪闸判 `not_ready` 直接抛在启动路径上 —— **服务起不来**。
 *
 * 当时 typecheck 与全量测试**全绿**：那份名单写的是
 * `[...] as const satisfies readonly SyncReadStream[]`，而 `satisfies`
 * **只校验写下的每一条合法，不校验有没有写全**。没有任何一条用例问过「这份名单齐不齐」。
 *
 * 单体那版的修法是把名单改成派生的；**派生仓的四份名单全部又是手抄字面量**（各自的
 * `satisfies` 同样只查合法不查写全），且属主仓各自的用例只问「进程取的流 == 自己名单」，
 * 没有一条对着 kernel 流定义问「名单齐不齐」。这个跨仓完整性问题没有别的家，留在本集成仓：
 * 四份手抄名单逐份对 kernel 流定义按属主/消费方算出的应有集合 deepEqual。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYNC_READ_STREAM_DEFINITIONS,
  type SyncReadStream,
} from '@kernel/kernel/sync-read-snapshot.js';
import { makeSyncReadFactEnvelope } from '@kernel/kernel/sync-read-facts.js';
import { RISK_ACTIONS } from '@kernel/kernel/risk-contract.js';
import { AutomationSyncReadMirrors } from '@automation/transport/automation-sync-read-mirrors.js';
import {
  AUTOMATION_SYNC_READ_CONSUMER_STREAMS,
  AUTOMATION_SYNC_READ_OWNER_STREAMS,
} from '@automation/automation-composition-root.js';
import { API_OWNED_SYNC_READ_STREAMS } from '@api/config/api-sync-read-source.js';
import {
  API_SYNC_READ_CONSUMED_STREAMS,
  API_SYNC_READ_OWNED_STREAMS,
} from '@api/server.js';

const streams = Object.keys(SYNC_READ_STREAM_DEFINITIONS) as SyncReadStream[];
const streamsWhere = (pick: (s: SyncReadStream) => boolean) => streams.filter(pick).sort();

const apiOwned = streamsWhere((s) => SYNC_READ_STREAM_DEFINITIONS[s].owner === 'api');

/** 每条流一个最小合法载荷；新增流时这里也会红，且红在「你还没想好它的空态」上。 */
const EMPTY_PAYLOAD: Record<string, unknown> = {
  account_persona: { accounts: [] },
  client_environment_automation: {
    blockedEnvironmentKeys: [],
    slowStartAnchors: [],
  },
  automation_account_projection: { accounts: [] },
  content_schedule: { global: null, accounts: [], facebookGroupCommentPolicy: null },
  hot_lead_config: {
    maxAgeHours: 48,
    velocityMin: 300,
    minLikeFloor: 500,
    floorHours: 1,
  },
  facebook_comment_config: { accounts: [] },
  facebook_group_join_automation_config: { accounts: [] },
  // 空态 = 没有 FB 环境，但慢启动曲线**仍是必填的**：它是逐执行目标一份的全局值。
  facebook_operation_policy: {
    environments: [],
    slowStart: {
      totalDays: 1,
      dailyCaps: [Object.fromEntries(RISK_ACTIONS.map((action) => [action, 1]))],
    },
  },
};

test('喂齐「api 属主」那一组流，自动化镜像就必须到 ready —— 少一条就是进程起不来', () => {
  const mirrors = new AutomationSyncReadMirrors('dev', () => 1_000);
  for (const stream of apiOwned) {
    const applied = mirrors.apply(
      makeSyncReadFactEnvelope({
        executionTarget: 'dev',
        stream,
        cursor: '1',
        asOf: 1_000,
        freshUntil: 61_000,
        value: EMPTY_PAYLOAD[stream] as never,
      }),
      'owner_fetch',
    );
    assert.notEqual(
      applied.outcome,
      'rejected',
      `${stream} 的空态载荷被校验器拒收了 —— 自举时会当场抛`,
    );
  }
  const readiness = mirrors.readiness(1_000);
  assert.deepEqual(
    readiness.blockers.map((blocker) => blocker.stream),
    [],
    '喂齐 api 属主流之后仍有 blocker ⇒ 就绪闸要求的集合比自举的那一组大，进程会起不来',
  );
  assert.equal(readiness.state, 'ready');
});

test('派生仓的四份手抄自举名单 MUST 与 kernel 流定义按属主/消费方逐份相等', () => {
  // automation 进程消费的流 = 定义里 consumer === 'automation' 的全集。
  // 少一条 = 那条流永远 uninitialized、就绪闸永远 not_ready（E-2 的原样复发）；
  // 多一条 = 允许它写一个自己根本不消费的流。
  assert.deepEqual(
    [...AUTOMATION_SYNC_READ_CONSUMER_STREAMS].sort(),
    streamsWhere((s) => SYNC_READ_STREAM_DEFINITIONS[s].consumer === 'automation'),
    'automation 消费名单与 kernel 定义漂开了',
  );
  assert.deepEqual(
    [...AUTOMATION_SYNC_READ_OWNER_STREAMS].sort(),
    streamsWhere((s) => SYNC_READ_STREAM_DEFINITIONS[s].owner === 'automation'),
    'automation 属主（重发）名单与 kernel 定义漂开了',
  );
  assert.deepEqual(
    [...API_SYNC_READ_CONSUMED_STREAMS].sort(),
    streamsWhere((s) => SYNC_READ_STREAM_DEFINITIONS[s].consumer === 'api'),
    'api 消费名单与 kernel 定义漂开了',
  );
  assert.deepEqual(
    [...API_OWNED_SYNC_READ_STREAMS].sort(),
    apiOwned,
    'api 属主源名单与 kernel 定义漂开了 —— 少一条的实测后果是边-云端口不监听、边缘一台都连不上',
  );
  // 路由注册侧按约定从属主源那份取；这里再钉一次引用同源，防「又抄了第二份」。
  assert.equal(API_SYNC_READ_OWNED_STREAMS, API_OWNED_SYNC_READ_STREAMS);
});
