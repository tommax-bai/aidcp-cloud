/**
 * CaptchaCoordinator 单测 — 验证码事件协调器（captcha-incident-handling spec 的可测场景）。
 *
 * 覆盖：captcha→restricted / unknown→warned 的风控态迁移、按 edge 暂停/恢复、
 * 去重冷却、清除不自动回滚状态、发卡失败不抛出（红线：记录不静默吞）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CaptchaCoordinator } from '../../src/comm/captcha-coordinator.js';
import type { EdgePusher, EdgeSession } from '../../src/comm/ws-server.js';
import type { Envelope } from '../../src/comm/protocol.js';
import { RiskController } from '../../src/risk/index.js';
import type { FeishuCard } from '../../src/feishu/types.js';

class FakePusher implements EdgePusher {
  readonly paused: string[] = [];
  readonly resumed: string[] = [];
  pushToEdges(_env: Envelope, _edgeId?: string): number {
    return 0;
  }
  edgeCount(): number {
    return 1;
  }
  onlineEdgeCount(): number {
    return 1;
  }
  pauseEdge(edgeId: string): void {
    this.paused.push(edgeId);
  }
  resumeEdge(edgeId: string): void {
    this.resumed.push(edgeId);
  }
}

class FakeMessenger {
  readonly sent: { chatId: string; card: FeishuCard }[] = [];
  shouldThrow = false;
  async sendCard(chatId: string, card: FeishuCard): Promise<void> {
    if (this.shouldThrow) throw new Error('feishu down');
    this.sent.push({ chatId, card });
  }
}

const silentLogger = { error() {}, warn() {}, log() {} };

function makeSession(over: Partial<EdgeSession> = {}): EdgeSession {
  return { sessionId: 's1', edgeId: 'edge-1', accountId: 'acc-1', machineLabel: 'win-aliyun-3', remoteAddr: 'rdp://1.2.3.4', ...over };
}

describe('CaptchaCoordinator', () => {
  let risk: RiskController;
  let pusher: FakePusher;
  let messenger: FakeMessenger;
  let now: number;

  beforeEach(() => {
    risk = new RiskController();
    pusher = new FakePusher();
    messenger = new FakeMessenger();
    now = 1_000_000;
  });

  function makeCoordinator(cooldownMs?: number, getAccountName?: (accountId: string) => string | null | undefined) {
    return new CaptchaCoordinator({
      resolveController: async () => risk,
      messenger,
      resolveChatId: async () => 'chat-1',
      logger: silentLogger,
      clock: () => now,
      cooldownMs,
      getAccountName,
    });
  }

  it('captcha → 账号置 restricted + 暂停 edge + 发卡(P0)', async () => {
    const c = makeCoordinator();
    await c.onDetected({ edgeId: 'edge-1', kind: 'captcha', url: 'https://x' }, makeSession(), pusher);

    assert.equal(risk.getState().status, 'restricted');
    assert.deepEqual(pusher.paused, ['edge-1']);
    assert.equal(messenger.sent.length, 1);
    const card = messenger.sent[0].card;
    const headerTitle = (card.header?.title as { content: string }).content;
    assert.match(headerTitle, /P0/);
    assert.match(headerTitle, /验证码弹出/);
    // detail 含机器与远程地址，便于人工定位
    const detail = (card.elements[0] as { text: { content: string } }).text.content;
    assert.match(detail, /win-aliyun-3/);
    assert.match(detail, /rdp:\/\/1\.2\.3\.4/);
  });

  it('unknown → 账号置 warned（更温和）+ 发卡(P1)', async () => {
    const c = makeCoordinator(undefined, (accountId) => (accountId === 'acc-1' ? '工程师大白' : null));
    await c.onDetected({ edgeId: 'edge-1', kind: 'unknown' }, makeSession(), pusher);

    assert.equal(risk.getState().status, 'warned');
    const headerTitle = (messenger.sent[0].card.header?.title as { content: string }).content;
    assert.match(headerTitle, /P1/);
    assert.match(headerTitle, /工程师大白/);
    assert.doesNotMatch(headerTitle, /acc-1/);
  });

  it('detected alert detail includes overlay text, DOM features, and first URL', async () => {
    const c = makeCoordinator();
    await c.onDetected(
      {
        edgeId: 'edge-1',
        kind: 'unknown',
        url: 'https://later.example/explore',
        overlay: {
          kind: 'unknown',
          firstDetectedUrl: 'https://first.example/explore',
          capturedAt: 123,
          text: 'content unavailable',
          dom: {
            tag: 'div',
            className: 'global-mask',
            rect: { x: 0, y: 0, width: 1280, height: 720 },
            hasIframe: false,
            hasClose: false,
            matchReasons: ['large_rect', 'fixed_or_absolute', 'no_close_control'],
          },
          candidates: [{ tag: 'div', text: 'content unavailable' }],
        },
      },
      makeSession(),
      pusher,
    );

    const detail = (messenger.sent[0].card.elements[0] as { text: { content: string } }).text.content;
    assert.match(detail, /https:\/\/first\.example\/explore/);
    assert.match(detail, /https:\/\/later\.example\/explore/);
    assert.match(detail, /content unavailable/);
    assert.match(detail, /tag=div/);
    assert.match(detail, /class=global-mask/);
    assert.match(detail, /match=large_rect,fixed_or_absolute,no_close_control/);
  });

  it('冷却窗内重复 detected 只发一张卡', async () => {
    const c = makeCoordinator(10 * 60_000);
    await c.onDetected({ edgeId: 'edge-1', kind: 'captcha' }, makeSession(), pusher);
    now += 60_000; // 1min < 10min 冷却
    await c.onDetected({ edgeId: 'edge-1', kind: 'captcha' }, makeSession(), pusher);
    assert.equal(messenger.sent.length, 1, '冷却窗内不应重复发卡');
    // 但每次都暂停（幂等）
    assert.deepEqual(pusher.paused, ['edge-1', 'edge-1']);
  });

  it('cleared → 恢复 edge，但风控态不自动回滚', async () => {
    const c = makeCoordinator();
    await c.onDetected({ edgeId: 'edge-1', kind: 'captcha' }, makeSession(), pusher);
    assert.equal(risk.getState().status, 'restricted');

    await c.onCleared({ edgeId: 'edge-1' }, makeSession(), pusher);
    assert.deepEqual(pusher.resumed, ['edge-1']);
    assert.equal(risk.getState().status, 'restricted', '清除不应自动解除 restricted');
  });

  it('cleared 清掉冷却：清除后再来验证码可立即再次发卡', async () => {
    const c = makeCoordinator(10 * 60_000);
    await c.onDetected({ edgeId: 'edge-1', kind: 'captcha' }, makeSession(), pusher);
    await c.onCleared({ edgeId: 'edge-1' }, makeSession(), pusher);
    now += 1000; // 远小于冷却窗
    await c.onDetected({ edgeId: 'edge-1', kind: 'captcha' }, makeSession(), pusher);
    assert.equal(messenger.sent.length, 2, '清除后新验证码不应被旧冷却压住');
  });

  it('发卡失败不抛出（红线：记录不静默吞），状态迁移与暂停仍生效', async () => {
    messenger.shouldThrow = true;
    const c = makeCoordinator();
    await c.onDetected({ edgeId: 'edge-1', kind: 'captcha' }, makeSession(), pusher);
    // 不抛出即通过；副作用仍发生
    assert.equal(risk.getState().status, 'restricted');
    assert.deepEqual(pusher.paused, ['edge-1']);
  });

  it('payload 无 edgeId 时回退 session.edgeId', async () => {
    const c = makeCoordinator();
    await c.onDetected({ kind: 'captcha' }, makeSession({ edgeId: 'edge-fallback' }), pusher);
    assert.deepEqual(pusher.paused, ['edge-fallback']);
  });

  it('alertStore：detected 落库告警(P0/captcha)，cleared 按 edge 解决（V1 9.5）', async () => {
    const raised: { severity: string; type: string; edgeId?: string; accountId?: string }[] = [];
    const resolvedEdges: string[] = [];
    const alertStore = {
      raise: async (input: { severity: string; type: string; edgeId?: string; accountId?: string }) => {
        raised.push(input);
        return { alertId: raised.length };
      },
      resolveByEdge: async (edgeId: string) => {
        resolvedEdges.push(edgeId);
        return 1;
      },
    };
    const c = new CaptchaCoordinator({
      resolveController: async () => risk,
      messenger,
      resolveChatId: async () => 'chat-1',
      logger: silentLogger,
      clock: () => now,
      alertStore,
    });
    await c.onDetected({ edgeId: 'edge-1', kind: 'captcha', url: 'https://x' }, makeSession(), pusher);
    assert.equal(raised.length, 1);
    assert.equal(raised[0].severity, 'P0');
    assert.equal(raised[0].type, 'captcha');
    assert.equal(raised[0].edgeId, 'edge-1');
    assert.equal(raised[0].accountId, 'acc-1');

    await c.onCleared({ edgeId: 'edge-1' }, makeSession(), pusher);
    assert.deepEqual(resolvedEdges, ['edge-1']);
  });

  it('alertStore：冷却窗内不重复落库（与发卡同闸）', async () => {
    let raisedCount = 0;
    const alertStore = {
      raise: async () => {
        raisedCount += 1;
        return { alertId: raisedCount };
      },
      resolveByEdge: async () => 0,
    };
    const c = new CaptchaCoordinator({
      resolveController: async () => risk,
      messenger,
      resolveChatId: async () => 'chat-1',
      logger: silentLogger,
      clock: () => now,
      cooldownMs: 10 * 60_000,
      alertStore,
    });
    await c.onDetected({ edgeId: 'edge-1', kind: 'captcha' }, makeSession(), pusher);
    now += 60_000;
    await c.onDetected({ edgeId: 'edge-1', kind: 'captcha' }, makeSession(), pusher);
    assert.equal(raisedCount, 1, '冷却窗内不应重复落库');
  });

  // AC-ALERT-5（change alert-resolution-by-id）：手动 by-id 解决与协调器去重冷却相互独立。
  // 手动勾销走面板 resolveById、不经 onCleared，故不清协调器 per-edge 冷却——窗内同 edge 再报仍被压制。
  // 固化为已知语义（活状况如实复现，非 bug）。
  it('手动 by-id 解决不走 onCleared、不清协调器冷却：窗内同 edge 再报仍被压制', async () => {
    let raisedCount = 0;
    const resolvedIds: number[] = [];
    const alertStore = {
      raise: async () => {
        raisedCount += 1;
        return { alertId: raisedCount };
      },
      resolveByEdge: async () => 0,
      // 面板手动勾销走 by-id，与协调器完全解耦，绝不经 onCleared。
      resolveById: async (id: number) => {
        resolvedIds.push(id);
        return 1;
      },
    };
    const c = new CaptchaCoordinator({
      resolveController: async () => risk,
      messenger,
      resolveChatId: async () => 'chat-1',
      logger: silentLogger,
      clock: () => now,
      cooldownMs: 10 * 60_000,
      alertStore,
    });
    await c.onDetected({ edgeId: 'edge-1', kind: 'captcha' }, makeSession(), pusher);
    assert.equal(raisedCount, 1);

    // 运营在面板按 alert_id 手动勾销该告警（模拟 POST /api/alerts/:id/resolve → resolveById），不经 onCleared。
    await alertStore.resolveById(1);
    assert.deepEqual(resolvedIds, [1]);

    now += 60_000; // 1min < 10min 冷却窗
    await c.onDetected({ edgeId: 'edge-1', kind: 'captcha' }, makeSession(), pusher);
    assert.equal(raisedCount, 1, '手动解决不清协调器冷却，窗内不应重复落库');
    assert.equal(messenger.sent.length, 1, '同理窗内不重复发卡');
  });
});
