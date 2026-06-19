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

  function makeCoordinator(cooldownMs?: number) {
    return new CaptchaCoordinator({
      riskController: risk,
      messenger,
      resolveChatId: async () => 'chat-1',
      logger: silentLogger,
      clock: () => now,
      cooldownMs,
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
    const c = makeCoordinator();
    await c.onDetected({ edgeId: 'edge-1', kind: 'unknown' }, makeSession(), pusher);

    assert.equal(risk.getState().status, 'warned');
    const headerTitle = (messenger.sent[0].card.header?.title as { content: string }).content;
    assert.match(headerTitle, /P1/);
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
});
