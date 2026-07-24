import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  serviceModeFromEnv,
  segmentsForMode,
  listenersForMode,
  DEFAULT_CONTENT_READ_API_PORT,
  type ServiceMode,
} from '../../src/gateway/service-mode.js';

describe('service-mode 纯选择器（Block② 2d：env → 段/监听计划，不起进程）', () => {
  it('AIDCP_SERVICE 未设 → monolith（默认安全底线）', () => {
    assert.equal(serviceModeFromEnv({}), 'monolith');
  });

  it('未识别值一律回落 monolith（不静默改变默认行为）', () => {
    for (const raw of ['', 'CONTENT', 'Core', 'automation', 'main', ' content', 'content ', 'x']) {
      assert.equal(serviceModeFromEnv({ AIDCP_SERVICE: raw }), 'monolith', `raw=${JSON.stringify(raw)}`);
    }
  });

  it('精确匹配才切模式', () => {
    assert.equal(serviceModeFromEnv({ AIDCP_SERVICE: 'content' }), 'content');
    assert.equal(serviceModeFromEnv({ AIDCP_SERVICE: 'core' }), 'core');
  });

  it('自定义 key 生效', () => {
    assert.equal(serviceModeFromEnv({ MY_SVC: 'core' }, 'MY_SVC'), 'core');
    assert.equal(serviceModeFromEnv({ AIDCP_SERVICE: 'core' }, 'MY_SVC'), 'monolith');
  });

  it('monolith → 四段全跑，无独立读 API 监听（与拆分前一致）', () => {
    assert.deepEqual(segmentsForMode('monolith'), { segA: true, segB: true, segC: true, segD: true });
    assert.deepEqual(listenersForMode('monolith'), { contentReadApi: false, automationAndApi: true });
  });

  it('content → segA+segB，跳 segC/segD，起内部读 API', () => {
    assert.deepEqual(segmentsForMode('content'), { segA: true, segB: true, segC: false, segD: false });
    assert.deepEqual(listenersForMode('content'), { contentReadApi: true, automationAndApi: false });
  });

  it('core → segA+segC+segD，跳 segB，不起读 API（经网关远程取）', () => {
    assert.deepEqual(segmentsForMode('core'), { segA: true, segB: false, segC: true, segD: true });
    assert.deepEqual(listenersForMode('core'), { contentReadApi: false, automationAndApi: true });
  });

  it('segA 在所有模式恒跑', () => {
    for (const mode of ['monolith', 'content', 'core'] as ServiceMode[]) {
      assert.equal(segmentsForMode(mode).segA, true, `mode=${mode}`);
    }
  });

  it('每模式恰有一处承载读端点：monolith 本地 / content 独立 API / core 远程', () => {
    // content 是唯一起独立读 API 的模式；monolith 与 core 都不起（分别为本地直连与网关远程）。
    assert.equal(listenersForMode('content').contentReadApi, true);
    assert.equal(listenersForMode('monolith').contentReadApi, false);
    assert.equal(listenersForMode('core').contentReadApi, false);
  });

  it('默认内部读 API 端口为 8092', () => {
    assert.equal(DEFAULT_CONTENT_READ_API_PORT, 8092);
  });
});
