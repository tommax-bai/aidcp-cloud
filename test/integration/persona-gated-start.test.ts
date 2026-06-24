/**
 * 诚实人设启动闸 + 账号身份穿透（multi-account-node-support D3/D4）单测。
 * 在 RoleDispatcher 层验证：edge.hello 携 accountId → 设当前账号 → 启动闸（人设 / default 豁免 / 调度开关）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/soul/types.js';

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: ['x'], seed_keywords: ['k'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] },
};

function make(opts: {
  isPersonaBound?: (a: string) => boolean;
  isDispatchActive?: () => boolean;
}): { d: RoleDispatcher; rejected: { accountId: string; reason: string }[] } {
  const rejected: { accountId: string; reason: string }[] = [];
  const commands: EdgeCommand[] = [];
  const d = new RoleDispatcher({
    getSoul: () => mockSoul,
    llm: { complete: async () => '-1' },
    sendCommand: (c) => commands.push(c),
    isPersonaBound: opts.isPersonaBound,
    isDispatchActive: opts.isDispatchActive,
    onSessionRejected: (accountId, reason) => rejected.push({ accountId, reason }),
  });
  d.setup();
  return { d, rejected };
}

test('未绑人设的真实账号握手 → 诚实拒绝：不启动会话、置 needs_persona_setup 告警，绝不偷用默认人设', () => {
  const { d, rejected } = make({ isPersonaBound: () => false });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });
  assert.equal(d.accountId, 'acctX'); // 账号身份已穿透并设入当前账号（不再钉死 default）
  assert.equal(d.active, false); // 未启动浏览循环
  assert.deepEqual(rejected, [{ accountId: 'acctX', reason: 'needs_persona_setup' }]);
  d.endSession();
});

test('已绑人设的账号握手 → 照常启动会话', () => {
  const { d, rejected } = make({ isPersonaBound: () => true });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctY', ts: 1 });
  assert.equal(d.accountId, 'acctY');
  assert.equal(d.active, true);
  assert.equal(rejected.length, 0);
  d.endSession();
});

test('default 账号硬豁免：即便判定未绑（isPersonaBound=false）也照常启动', () => {
  const { d, rejected } = make({ isPersonaBound: () => false });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'default', ts: 1 });
  assert.equal(d.accountId, 'default');
  assert.equal(d.active, true); // 豁免
  assert.equal(rejected.length, 0); // 不告警
  d.endSession();
});

test('全局调度开关关闭 → 不启动（且非人设拒绝，不发 needs_persona_setup 告警）', () => {
  const { d, rejected } = make({ isPersonaBound: () => true, isDispatchActive: () => false });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctZ', ts: 1 });
  assert.equal(d.active, false);
  assert.equal(rejected.length, 0); // 调度暂停不是人设问题
  d.endSession();
});

test('未接人设闸（单账号向后兼容）：照常启动', () => {
  const { d } = make({}); // 无 isPersonaBound
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'whatever', ts: 1 });
  assert.equal(d.active, true);
  d.endSession();
});
