/**
 * 单体启动自举的那两组流，MUST 与「就绪闸真正要求的集合」严格一致。
 *
 * **这条是补回归**：批 E-2 步骤 2 新增 `facebook_operation_policy` 后，镜像那边有了第八条、
 * 组装根里那份**手抄的**自举名单还是七条，于是第八条恒 `uninitialized`、
 * 就绪闸判 `monolith_sync_read_not_ready` 直接抛在启动路径上 —— **单体起不来**。
 *
 * 当时 typecheck 与全量 4084 条测试**全绿**：那份名单写的是
 * `[...] as const satisfies readonly SyncReadStream[]`，而 `satisfies`
 * **只校验写下的每一条合法，不校验有没有写全**。没有任何一条用例问过「这份名单齐不齐」。
 *
 * 修法是把名单改成从流定义按属主派生；本文件钉住的就是「它得是派生的」+「派生集合确实够用」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYNC_READ_STREAM_DEFINITIONS,
  type SyncReadStream,
} from '../../src/kernel/sync-read-snapshot.js';
import { makeSyncReadFactEnvelope } from '../../src/kernel/sync-read-facts.js';
import { AutomationSyncReadMirrors } from '../../src/transport/automation-sync-read-mirrors.js';

const apiOwned = (Object.keys(SYNC_READ_STREAM_DEFINITIONS) as SyncReadStream[])
  .filter((stream) => SYNC_READ_STREAM_DEFINITIONS[stream].owner === 'api');

/** 每条流一个最小合法载荷；新增流时这里也会红，且红在「你还没想好它的空态」上。 */
const EMPTY_PAYLOAD: Record<string, unknown> = {
  account_persona: { accounts: [] },
  client_environment_automation: {
    blockedEnvironmentKeys: [],
    slowStartAnchors: [],
  },
  automation_account_projection: { accounts: [] },
  content_schedule: { global: null, accounts: [] },
  hot_lead_config: {
    maxAgeHours: 48,
    velocityMin: 300,
    minLikeFloor: 500,
    floorHours: 1,
  },
  facebook_comment_config: { accounts: [] },
  facebook_group_join_automation_config: { accounts: [] },
  facebook_operation_policy: { environments: [] },
};

test('喂齐「api 属主」那一组流，自动化镜像就必须到 ready —— 少一条就是单体起不来', () => {
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
    '喂齐 api 属主流之后仍有 blocker ⇒ 就绪闸要求的集合比自举的那一组大，单体会起不来',
  );
  assert.equal(readiness.state, 'ready');
});

test('组装根的两组自举名单 MUST 是派生的，不是手抄的字面量数组', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../src/server.ts', import.meta.url),
    'utf8',
  );
  for (const name of [
    'API_SYNC_READ_OWNER_STREAMS',
    'AUTOMATION_SYNC_READ_OWNER_STREAMS',
  ]) {
    const declaration = new RegExp(`const ${name} = ([^;]*);`);
    const matched = source.match(declaration);
    assert.ok(matched, `找不到 ${name} 的声明`);
    assert.match(
      matched[1],
      /syncReadStreamsOwnedBy\(/,
      `${name} MUST 由流定义按属主派生。手抄一份的代价实测过：新增流后它不报错、`
        + '不红任何用例，只是单体启动时就绪闸判 not_ready —— 服务直接起不来',
    );
    assert.doesNotMatch(
      matched[1],
      /\[[\s\S]*'[a-z_]+'[\s\S]*\]/,
      `${name} 里出现了字面量流名 —— 那就是又抄了一份`,
    );
  }
  assert.match(
    source,
    /API consumer=\$\{AUTOMATION_SYNC_READ_OWNER_STREAMS\.length\}，automation consumer=\$\{API_SYNC_READ_OWNER_STREAMS\.length\}/,
    '就绪日志里的两类 consumer 数量 MUST 来自各自消费的派生集合，新增流后不能继续报旧数字',
  );
  assert.doesNotMatch(
    source,
    /(?:API|automation) consumer=\d+\b/,
    '就绪日志里的 consumer 数量 MUST NOT 退回硬编码',
  );
});
