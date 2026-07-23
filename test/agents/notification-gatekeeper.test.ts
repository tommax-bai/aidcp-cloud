import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { SessionContext } from '../../src/agents/session-context.js';
import { NotificationGatekeeper } from '../../src/agents/notification-gatekeeper.js';
import type { Soul } from '../../src/kernel/soul-types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
};

function setup(opts: { isHardPaused?: (edgeId?: string) => boolean } = {}) {
  const bus = new EventBus();
  const ctx = new SessionContext();
  const role = new NotificationGatekeeper(
    { eventBus: bus, soul: mockSoul, ...(opts.isHardPaused ? { isHardPaused: opts.isHardPaused } : {}) },
    ctx,
  );
  role.subscribe();
  const requested: { epoch: number }[] = [];
  bus.on('excursion.requested', (p) => { requested.push(p); });
  return { bus, ctx, requested };
}

function detected(bus: EventBus, epoch = 1): void {
  bus.emit('notification.detected.arrived', { epoch, unreadCount: 3, ts: Date.now() });
}

describe('NotificationGatekeeper（通知巡视准入）', () => {
  it('正常未读 → 准入开巡视（excursion.requested）', () => {
    const h = setup();
    detected(h.bus, 1);
    assert.equal(h.requested.length, 1, '应开一次巡视');
    assert.equal(h.ctx.excursionActive, true);
  });

  it('本人昵称采集在途 → 巡视让位（不准入）', () => {
    const h = setup();
    h.ctx.setSelfCaptureInFlight(true); // 采集在途
    detected(h.bus, 1);
    assert.equal(h.requested.length, 0, '采集在途时绝不开巡视（让位，避免争用边缘）');
    assert.equal(h.ctx.excursionActive, false);
  });

  it('采集收尾后 → 下一次未读检测正常准入', () => {
    const h = setup();
    h.ctx.setSelfCaptureInFlight(true);
    detected(h.bus, 1);
    assert.equal(h.requested.length, 0, '在途让位');
    h.ctx.setSelfCaptureInFlight(false); // 采集收尾（成功/超时）
    detected(h.bus, 2);
    assert.equal(h.requested.length, 1, '收尾后下一次检测正常准入');
    assert.equal(h.ctx.excursionActive, true);
  });

  it('已有巡视在跑 → 忽略重入', () => {
    const h = setup();
    detected(h.bus, 1);
    detected(h.bus, 2);
    assert.equal(h.requested.length, 1, '已有巡视在跑时忽略后续检测');
  });

  it('硬暂停中 → 放弃巡视', () => {
    const h = setup({ isHardPaused: () => true });
    detected(h.bus, 1);
    assert.equal(h.requested.length, 0, '硬暂停期不开巡视');
  });
});
