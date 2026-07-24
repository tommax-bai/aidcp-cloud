import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataGateway, gatewayModeFromEnv } from '../../src/gateway/data-gateway.js';
import type { CuratedContentReader } from '../../src/kernel/curated-content-types.js';
import type { DelegatedTaskServicePort } from '../../src/kernel/delegated-task-types.js';
import type { InteractionStoreReaderPort } from '../../src/kernel/interaction-types.js';

// 桩：只需引用同一性，方法体不被调用。
const curatedLocal = { tag: 'curated-local' } as unknown as CuratedContentReader;
const delegatedLocal = { tag: 'delegated-local' } as unknown as DelegatedTaskServicePort;
const interactionLocal = { tag: 'interaction-local' } as unknown as InteractionStoreReaderPort;

test('默认 mode=local：三个 getter 返回的就是传入的本地实例本身（===），零行为变更', () => {
  const gw = new DataGateway({
    curatedContentLocal: curatedLocal,
    delegatedTaskLocal: delegatedLocal,
    interactionReaderLocal: interactionLocal,
  });
  assert.equal(gw.mode, 'local');
  assert.strictEqual(gw.curatedContentReader, curatedLocal);
  assert.strictEqual(gw.delegatedTaskService, delegatedLocal);
  assert.strictEqual(gw.interactionReader, interactionLocal);
});

test('mode=local：remote thunk 即便提供也**绝不被调用**（不构造 client、不碰网络）', () => {
  let called = 0;
  const gw = new DataGateway({
    curatedContentLocal: curatedLocal,
    mode: 'local',
    remote: {
      curatedContentReader: () => {
        called += 1;
        return { tag: 'remote' } as unknown as CuratedContentReader;
      },
    },
  });
  assert.strictEqual(gw.curatedContentReader, curatedLocal);
  assert.equal(called, 0);
});

test('本地实例缺省（上游未就绪）：getter 透传 undefined，不抛', () => {
  const gw = new DataGateway({});
  assert.equal(gw.curatedContentReader, undefined);
  assert.equal(gw.delegatedTaskService, undefined);
  assert.equal(gw.interactionReader, undefined);
});

test('mode=http：getter 走 remote thunk 构造出的 client（非本地实例）', () => {
  const remoteCurated = { tag: 'curated-remote' } as unknown as CuratedContentReader;
  let built = 0;
  const gw = new DataGateway({
    curatedContentLocal: curatedLocal,
    delegatedTaskLocal: delegatedLocal,
    mode: 'http',
    remote: {
      curatedContentReader: () => {
        built += 1;
        return remoteCurated;
      },
    },
  });
  assert.equal(gw.mode, 'http');
  assert.strictEqual(gw.curatedContentReader, remoteCurated);
  assert.equal(built, 1);
  // http 但该端口未提供 remote thunk → 回落本地实例（不硬崩）。
  assert.strictEqual(gw.delegatedTaskService, delegatedLocal);
});

test('gatewayModeFromEnv：仅显式 http 才切远端，其余一律 local（默认安全）', () => {
  assert.equal(gatewayModeFromEnv({}), 'local');
  assert.equal(gatewayModeFromEnv({ AIDCP_GATEWAY_MODE: 'http' }), 'http');
  assert.equal(gatewayModeFromEnv({ AIDCP_GATEWAY_MODE: 'HTTP' }), 'local');
  assert.equal(gatewayModeFromEnv({ AIDCP_GATEWAY_MODE: 'local' }), 'local');
  assert.equal(gatewayModeFromEnv({ AIDCP_GATEWAY_MODE: '' }), 'local');
});
