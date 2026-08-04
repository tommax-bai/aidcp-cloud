import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  serviceModeFromEnv,
  RetiredServiceModeError,
  segmentsForMode,
  listenersForMode,
  ownsApiFeishuForMode,
  ownsPublishApprovalAuthorityForMode,
  panelEventTransportForMode,
  outboxRetentionForMode,
  DEFAULT_CONTENT_READ_API_PORT,
  type ServiceMode,
} from '../../src/gateway/service-mode.js';

const ALL_MODES: ServiceMode[] = ['monolith', 'content', 'automation', 'api', 'core'];

/** 取回退役闸抛出的那个错误本体。**不抛就直接判失败** —— 「没抛」正是这道闸失效的样子。 */
function captureRetired(raw: string): RetiredServiceModeError {
  try {
    serviceModeFromEnv({ AIDCP_SERVICE: raw });
  } catch (caught) {
    assert.ok(caught instanceof RetiredServiceModeError, `raw=${raw} 应抛 RetiredServiceModeError`);
    return caught;
  }
  assert.fail(`raw=${raw} 未抛错 —— 退役闸已失效`);
}

describe('service-mode 纯选择器（Block② 2d：env → 段/监听计划，不起进程）', () => {
  it('AIDCP_SERVICE 未设 → monolith（默认安全底线）', () => {
    assert.equal(serviceModeFromEnv({}), 'monolith');
  });

  it('未识别值一律回落 monolith（不静默改变默认行为）', () => {
    for (const raw of ['', 'CONTENT', 'Core', 'API', 'Automation', 'main', ' content', 'content ', 'x']) {
      assert.equal(serviceModeFromEnv({ AIDCP_SERVICE: raw }), 'monolith', `raw=${JSON.stringify(raw)}`);
    }
  });

  // ── 退役闸（2026-08-04，change deploy-derived-services-to-dev task 8.0）──
  // 这四条用例是这道闸**唯一**的存在证明：闸的正确行为是「抛错」，而抛错在
  // 「进程没起来」这个维度上与「起来了但配错了」同形。没有喂违规输入的正向用例，
  // 把 throw 删掉换回 return 一样全绿。
  it('四个已退役的角色名 → fail-closed 抛错，MUST NOT 回落 monolith', () => {
    for (const raw of ['content', 'automation', 'api', 'core']) {
      assert.throws(
        () => serviceModeFromEnv({ AIDCP_SERVICE: raw }),
        (err: unknown) => {
          assert.ok(err instanceof RetiredServiceModeError, `raw=${raw} 应抛具名错误`);
          assert.equal(err.requestedMode, raw);
          assert.ok(err.successor.length > 0, `raw=${raw} 必须说清该去哪`);
          return true;
        },
        `raw=${raw}`,
      );
    }
  });

  it('退役错误必须具名指向去处，而不是只说「不支持」', () => {
    // 折成一句「不支持」等于把「该去 aidcp-automation」这个唯一可执行信息丢掉。
    const caught = captureRetired('automation');
    assert.match(caught.message, /aidcp-automation/);
    assert.match(caught.successor, /aidcp-automation/);

    // core 没有对应派生仓，必须说清这一点，而不是指向一个不存在的仓。
    assert.match(captureRetired('core').successor, /没有对应派生仓/);
  });

  it('自定义 key 生效：退役闸只看被指定的那个 key', () => {
    assert.throws(
      () => serviceModeFromEnv({ MY_SVC: 'core' }, 'MY_SVC'),
      RetiredServiceModeError,
    );
    // 换了 key 之后 AIDCP_SERVICE 就不该再被读到 —— 不抛、回落 monolith。
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

  it('Feishu SDK/card/chat owner 只在 api-containing 模式构造', () => {
    assert.deepEqual(
      ALL_MODES.filter(ownsApiFeishuForMode),
      ['monolith', 'api', 'core'],
    );
    assert.equal(ownsApiFeishuForMode('content'), false);
    assert.equal(ownsApiFeishuForMode('automation'), false);
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
