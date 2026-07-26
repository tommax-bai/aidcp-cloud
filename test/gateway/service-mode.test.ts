import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  serviceModeFromEnv,
  segmentsForMode,
  listenersForMode,
  ownsPublishApprovalAuthorityForMode,
  panelEventTransportForMode,
  outboxRetentionForMode,
  DEFAULT_CONTENT_READ_API_PORT,
  type ServiceMode,
} from '../../src/gateway/service-mode.js';

const ALL_MODES: ServiceMode[] = ['monolith', 'content', 'automation', 'api', 'core'];

describe('service-mode 纯选择器（Block② 2d：env → 段/监听计划，不起进程）', () => {
  it('AIDCP_SERVICE 未设 → monolith（默认安全底线）', () => {
    assert.equal(serviceModeFromEnv({}), 'monolith');
  });

  it('未识别值一律回落 monolith（不静默改变默认行为）', () => {
    for (const raw of ['', 'CONTENT', 'Core', 'API', 'Automation', 'main', ' content', 'content ', 'x']) {
      assert.equal(serviceModeFromEnv({ AIDCP_SERVICE: raw }), 'monolith', `raw=${JSON.stringify(raw)}`);
    }
  });

  it('精确匹配才切模式', () => {
    assert.equal(serviceModeFromEnv({ AIDCP_SERVICE: 'content' }), 'content');
    assert.equal(serviceModeFromEnv({ AIDCP_SERVICE: 'automation' }), 'automation');
    assert.equal(serviceModeFromEnv({ AIDCP_SERVICE: 'api' }), 'api');
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

  it('automation → segA+segC，跳 segB/segD，不起读 API（生成经端口远程触发 content）', () => {
    assert.deepEqual(segmentsForMode('automation'), { segA: true, segB: false, segC: true, segD: false });
    assert.deepEqual(listenersForMode('automation'), { contentReadApi: false, automationAndApi: true });
  });

  it('api → segA+segD，跳 segB/segC，不起读 API（content 读经网关 HTTP）', () => {
    assert.deepEqual(segmentsForMode('api'), { segA: true, segB: false, segC: false, segD: true });
    assert.deepEqual(listenersForMode('api'), { contentReadApi: false, automationAndApi: true });
  });

  it('core → segA+segC+segD，跳 segB，不起读 API（automation+api 合进程的过渡形态）', () => {
    assert.deepEqual(segmentsForMode('core'), { segA: true, segB: false, segC: true, segD: true });
    assert.deepEqual(listenersForMode('core'), { contentReadApi: false, automationAndApi: true });
  });

  it('automation 与 api 的段计划并起来 = core（切分不漏段）', () => {
    const a = segmentsForMode('automation');
    const p = segmentsForMode('api');
    const core = segmentsForMode('core');
    assert.equal(a.segC && !a.segD, true);
    assert.equal(p.segD && !p.segC, true);
    assert.deepEqual(
      { segA: a.segA || p.segA, segB: a.segB || p.segB, segC: a.segC || p.segC, segD: a.segD || p.segD },
      core,
    );
  });

  it('segA 在所有模式恒跑', () => {
    for (const mode of ['monolith', 'content', 'automation', 'api', 'core'] as ServiceMode[]) {
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

  it('publish approval 持久权威只在 api-containing 模式构造', () => {
    assert.deepEqual(
      ALL_MODES.filter(ownsPublishApprovalAuthorityForMode),
      ['monolith', 'api', 'core'],
    );
    assert.equal(ownsPublishApprovalAuthorityForMode('content'), false);
    assert.equal(ownsPublishApprovalAuthorityForMode('automation'), false);
  });
});

describe('面板事件旁路的模式门禁（哪种模式写 outbox、哪种模式不写）', () => {
  it('只有 automation 写（面板确实在另一个进程）', () => {
    const teeing = ALL_MODES.filter((m) => panelEventTransportForMode(m).tee);
    assert.deepEqual(teeing, ['automation']);
  });

  it('只有 automation 从 owner outbox 回放并主动推送 api ingress', () => {
    const replaying = ALL_MODES.filter((m) => panelEventTransportForMode(m).replay);
    assert.deepEqual(replaying, ['automation']);
  });

  it('core：面板与产生端同进程 ⇒ 既不写也不回放（此前无消费者地满速率写生产库）', () => {
    assert.deepEqual(panelEventTransportForMode('core'), { tee: false, replay: false });
  });

  it('automation 同时负责 tee 与 owner cursor replay；api 只接 ingress', () => {
    for (const mode of ALL_MODES) {
      const plan = panelEventTransportForMode(mode);
      assert.equal(plan.tee, plan.replay, `mode=${mode} 的 owner producer/relay 必须同属 automation`);
    }
    assert.deepEqual(panelEventTransportForMode('api'), { tee: false, replay: false });
  });
});

describe('event_outbox 保留期计划（谁剪、等谁追平）', () => {
  it('剪裁只在跑了 segC 的模式做（event_outbox 属 automation）', () => {
    for (const mode of ALL_MODES) {
      assert.equal(outboxRetentionForMode(mode).prune, segmentsForMode(mode).segC, `mode=${mode}`);
    }
  });

  it('没有消费者的模式必须照剪不误——否则永久拒绝剪裁 + 永久告警', () => {
    // core：面板同进程直连 ⇒ panel.event 永远不会有回放游标行；剪裁 MUST NOT 因此卡死。
    assert.deepEqual(outboxRetentionForMode('core'), {
      prune: true,
      panelEventConsumed: false,
      riskCommandConsumed: true,
    });
    // monolith：两条通道都不接线，仍负责剪掉历史遗留行。
    assert.deepEqual(outboxRetentionForMode('monolith'), {
      prune: true,
      panelEventConsumed: false,
      riskCommandConsumed: false,
    });
  });

  it('automation：两个主题都真有消费者 ⇒ 剪裁必须等进度', () => {
    assert.deepEqual(outboxRetentionForMode('automation'), {
      prune: true,
      panelEventConsumed: true,
      riskCommandConsumed: true,
    });
  });

  it('「等 panel.event 消费者」当且仅当本模式真的 tee 了（写方与守卫同源）', () => {
    for (const mode of ALL_MODES) {
      assert.equal(
        outboxRetentionForMode(mode).panelEventConsumed,
        panelEventTransportForMode(mode).tee,
        `mode=${mode}`,
      );
    }
  });
});
