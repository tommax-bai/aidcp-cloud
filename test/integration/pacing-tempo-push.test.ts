/**
 * 中途风控档位传播（change pacing-fallback-hardening）。
 *
 * 验证统一命令出口 sendCommand 顶端的 maybePushTempo：
 * - normal 期间：不推 pacing_update（构造期基线 = tempoForStatus(normal)=1.0）。
 * - 升档 warned：下一次 sendCommand 前先经 rawSendCommand 推一条 pacing_update{tempo:1.3}，且**先于**实际命令。
 * - 同档再触发：不重复推（去抖）。
 * - pacing_update 经 command-bridge 产出 pacing.update envelope，透传数值 tempo。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import { edgeCommandToEnvelope } from '../../src/comm/command-bridge.js';
import { EventBus } from '../../src/event-bus/index.js';
import type { Soul } from '../../src/kernel/soul-types.js';
import type { RiskStatus, RiskQuotaLevel } from '../../src/risk/types.js';

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: ['x'], seed_keywords: ['k'] },
};
const mockLlm = { complete: async () => 'pass' };

function setup(getRiskStatus: () => RiskStatus, getQuotaLevel?: () => RiskQuotaLevel) {
  const commands: EdgeCommand[] = [];
  const bus = new EventBus();
  const d = new RoleDispatcher({
    soul: mockSoul,
    llm: mockLlm,
    eventBus: bus,
    sendCommand: (c) => commands.push(c),
    getRiskStatus,
    getQuotaLevel,
    clock: () => 0,
  });
  d.setup();
  d.startSession();
  return { bus, commands };
}

// feed.scrolled 可靠地经统一出口下发一次 scroll（<5 次不转搜索）→ 借它触发 maybePushTempo。
const triggerSend = (bus: EventBus) => bus.emit('feed.scrolled', { pageType: 'feed', scrollCount: 1, ts: 0 });

describe('中途风控档位传播（pacing.update）', () => {
  it('normal 期间不推 pacing_update（基线去抖）', () => {
    const { bus, commands } = setup(() => 'normal');
    triggerSend(bus);
    assert.ok(commands.length > 0, 'feed.scrolled 应触发一次下发');
    assert.ok(!commands.some((c) => c.action === 'pacing_update'), 'normal 期间不应推 pacing_update');
  });

  it('升档 warned → 下一次下发前先推 pacing_update{1.3}，先于实际命令；同档不再重复', () => {
    let status: RiskStatus = 'normal';
    const { bus, commands } = setup(() => status);

    triggerSend(bus); // normal：无 pacing_update
    assert.ok(!commands.some((c) => c.action === 'pacing_update'), 'normal 期不推');

    status = 'warned';
    const before = commands.length;
    triggerSend(bus);
    const after = commands.slice(before);
    const puIdx = after.findIndex((c) => c.action === 'pacing_update');
    assert.ok(puIdx >= 0, '升档后应推一条 pacing_update');
    assert.equal((after[puIdx].params as { tempo: number }).tempo, 1.3, 'tempo 应为 warned 档 1.3');
    const cmdIdx = after.findIndex((c) => c.action !== 'pacing_update');
    assert.ok(cmdIdx === -1 || puIdx < cmdIdx, 'pacing_update 应先于实际命令下发');

    const before2 = commands.length;
    triggerSend(bus); // 同档 warned：去抖，不再推
    assert.ok(!commands.slice(before2).some((c) => c.action === 'pacing_update'), '同档不应重复推（去抖）');
  });

  it('后台改配额档 normal→conservative → 下一次下发前推 pacing_update{1.3}（quota→tempo）', () => {
    let quota: RiskQuotaLevel = 'normal';
    const { bus, commands } = setup(() => 'normal', () => quota);
    triggerSend(bus); // normal 状态 + normal 配额 → 生效 tempo 1.0，无 pacing_update
    assert.ok(!commands.some((c) => c.action === 'pacing_update'), 'normal 期不推');

    quota = 'conservative'; // 运营后台把配额档改保守
    const before = commands.length;
    triggerSend(bus);
    const pu = commands.slice(before).find((c) => c.action === 'pacing_update');
    assert.ok(pu, '配额档升保守后应推 pacing_update（生效 tempo 1.0→1.3）');
    assert.equal((pu!.params as { tempo: number }).tempo, 1.3, '生效 tempo 取配额档 1.3');
  });

  it('pacing_update 经 command-bridge 产出 pacing.update envelope，透传数值 tempo', () => {
    const env = edgeCommandToEnvelope({ action: 'pacing_update', params: { tempo: 1.6 } });
    assert.equal(env.type, 'pacing.update');
    assert.equal((env.payload as { tempo: number }).tempo, 1.6);
  });
});
