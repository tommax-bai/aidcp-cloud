/**
 * 诚实人设启动闸 + 账号身份穿透（multi-account-node-support D3/D4）单测。
 * 在 RoleDispatcher 层验证：edge.hello 携 accountId → 设当前账号 → 启动闸（人设 / default 豁免 / 调度开关）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/soul/types.js';
import type { PersonaBinding } from '../../src/config/persona-store.js';

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: ['x'], seed_keywords: ['k'] },
};

function make(opts: {
  personaBinding?: (a: string) => PersonaBinding;
  isDispatchActive?: () => boolean;
}): { d: RoleDispatcher; rejected: { accountId: string; reason: string }[]; commands: EdgeCommand[] } {
  const rejected: { accountId: string; reason: string }[] = [];
  const commands: EdgeCommand[] = [];
  const d = new RoleDispatcher({
    getSoul: () => mockSoul,
    llm: { complete: async () => '-1' },
    sendCommand: (c) => commands.push(c),
    personaBinding: opts.personaBinding,
    isDispatchActive: opts.isDispatchActive,
    onSessionRejected: (accountId, reason) => {
      rejected.push({ accountId, reason });
    },
  });
  d.setup();
  return { d, rejected, commands };
}

test('未绑人设的真实账号握手 → 诚实拒绝：不启动会话、置 needs_persona_setup 告警，绝不偷用默认人设', () => {
  const { d, rejected } = make({ personaBinding: () => 'unbound' });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });
  assert.equal(d.accountId, 'acctX'); // 账号身份已穿透并设入当前账号（不再钉死 default）
  assert.equal(d.active, false); // 未启动浏览循环
  assert.deepEqual(rejected, [{ accountId: 'acctX', reason: 'needs_persona_setup' }]);
  d.endSession();
});

test('评论点赞角色常驻时无人设 XHS/FB 的 dispatcher setup 不提前读取人设，连接可先 welcome 再弹引导', () => {
  const d = new RoleDispatcher({
    getSoul: () => { throw new Error('no_persona'); },
    llm: { complete: async () => '-1' },
    sendCommand: () => {},
    accountPlatform: 'xiaohongshu',
    personaBinding: () => 'unbound',
  });
  assert.doesNotThrow(() => d.setup(), '构造/订阅阶段不得读取人设');
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acct-no-persona', ts: 1 });
  assert.equal(d.active, false, '无人设只阻止业务会话，不破坏 transport');
  d.endSession();
});

test('未绑人设账号：边缘自发上报 page.cards 也不产生任何下发指令（反应链未接线，绝不在默认人设上空跑）', () => {
  const { d, commands } = make({ personaBinding: () => 'unbound' });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 }); // 启动闸拒绝 → 未激活、未接线
  assert.equal(d.active, false);
  // 真实边缘在 loop 起步会自发上报 page.cards；未绑账号的浏览反应链未接线，必须不产生 open_note 等任何指令
  // （回归 multi-account 对抗评审发现的红线：诚实人设闸曾只挡 start，反应链仍在默认人设上空跑）。
  d.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: '测试笔记', likeCount: 100, collectCount: 10, noteId: 'n1' }],
    ts: 2,
  });
  assert.equal(commands.length, 0, '未绑账号绝不因 page.cards 产生任何下发指令');
  d.endSession();
});

test('仅 setup 未启动会话的 dispatcher（如预览实例）：page.cards 不触发任何下发（看门狗/反应链均未接线）', () => {
  const { d, commands } = make({}); // 仅构造
  // 不 emit edge.hello、不 startSession —— 模拟仅供预览 / 从未激活的 dispatcher
  d.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: 'x', likeCount: 1, collectCount: 1, noteId: 'n1' }],
    ts: 1,
  });
  assert.equal(d.active, false);
  assert.equal(commands.length, 0, '未激活 dispatcher 绝不下发指令');
});

test('已绑人设的账号握手 → 照常启动会话', () => {
  const { d, rejected } = make({ personaBinding: () => 'bound' });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctY', ts: 1 });
  assert.equal(d.accountId, 'acctY');
  assert.equal(d.active, true);
  assert.equal(rejected.length, 0);
  d.endSession();
});

test('retire-default-account：default 不再硬豁免 —— 未绑人设一律诚实拒绝（无任何账号例外）', () => {
  const { d, rejected } = make({ personaBinding: () => 'unbound' });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'default', ts: 1 });
  assert.equal(d.accountId, 'default');
  assert.equal(d.active, false); // 不再豁免：未绑人设即拒
  assert.deepEqual(rejected, [{ accountId: 'default', reason: 'needs_persona_setup' }]);
  d.endSession();
});

test('全局调度开关关闭 → 不启动（且非人设拒绝，不发 needs_persona_setup 告警）', () => {
  const { d, rejected } = make({ personaBinding: () => 'bound', isDispatchActive: () => false });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctZ', ts: 1 });
  assert.equal(d.active, false);
  assert.equal(rejected.length, 0); // 调度暂停不是人设问题
  d.endSession();
});

test('未接人设闸（单账号向后兼容）：照常启动', () => {
  const { d } = make({}); // 无 personaBinding
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'whatever', ts: 1 });
  assert.equal(d.active, true);
  d.endSession();
});

// ─── change auto-start-on-persona-bind：绑定人设后云端自动唤醒被闸住的在线节点（无需重连）───

test('绑定人设后 startOnPersonaBound 自动开会话 + 补发 scroll 重驱唤醒干等边端（无需重连）', () => {
  let bound = false;
  const { d, rejected, commands } = make({ personaBinding: () => (bound ? 'bound' : 'unbound') });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 }); // 未绑 → 被闸住、未起
  assert.equal(d.active, false);
  assert.deepEqual(rejected, [{ accountId: 'acctX', reason: 'needs_persona_setup' }]);
  // 后台绑定人设（镜像翻真）→ 注册表按账号调用唤醒：
  bound = true;
  d.startOnPersonaBound();
  assert.equal(d.active, true, '绑定后自动开会话、无需重连');
  const scroll = commands.find((c) => c.action === 'scroll');
  assert.ok(scroll, '补发一条 scroll 重驱唤醒已发过 page.cards 在干等的边端');
  assert.equal((scroll as { reason?: string }).reason, 'resume_redrive');
  d.endSession();
});

test('startOnPersonaBound 对已在跑的会话是 no-op：不重启、不多发重驱滚动', () => {
  const { d, commands } = make({ personaBinding: () => 'bound' });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctY', ts: 1 }); // 已绑 → 正常启动
  assert.equal(d.active, true);
  const before = commands.length;
  d.startOnPersonaBound(); // 已在跑 → 顶部守卫 return
  assert.equal(d.active, true);
  assert.equal(commands.length, before, '不打断在跑会话、不多发重驱滚动');
  d.endSession();
});

test('startOnPersonaBound 人设仍未真绑 → 诚实不起、不发重驱（防御）', () => {
  const { d, commands } = make({ personaBinding: () => 'unbound' });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctZ', ts: 1 });
  assert.equal(d.active, false);
  d.startOnPersonaBound(); // canStartSession 仍 false → 不起
  assert.equal(d.active, false);
  assert.equal(commands.filter((c) => c.action === 'scroll').length, 0, '未起会话 → 不发重驱滚动');
  d.endSession();
});

// ─── 昵称采集：只在完整启动后的首批 page.cards{startupId} 触发；不被人设闸阻断（但绝不浏览，守红线）───

test('未绑人设但库内真名空：首批 startup page.cards 采真名（恰一次 profile_open{direct}），绝不浏览（无 open_note/like/scroll）——红线', () => {
  const { d, commands } = make({ personaBinding: () => 'unbound' });
  d.setCurrentAccountId('acctCap');
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctCap', ts: 1 }); // 启动闸拒绝浏览会话；hello 本身不再武装采集
  assert.equal(d.active, false, '未开浏览会话（不浏览）');
  // 完整启动后的首批 page.cards → 驱动一次本人主页采集；浏览反应链未接线，绝不产生浏览指令
  d.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: '测试笔记', likeCount: 100, collectCount: 10, noteId: 'n1' }],
    startupId: 'startup-1',
    ts: 2,
  });
  const profileOpens = commands.filter((c) => c.action === 'profile_open');
  assert.equal(profileOpens.length, 1, '登录后恰驱动一次本人主页采集');
  assert.equal((profileOpens[0].params as { direct?: boolean }).direct, true, 'direct=true 直驱本人主页');
  assert.equal(commands.filter((c) => c.action !== 'profile_open').length, 0, '红线：未绑人设绝不浏览（无 open_note/like/scroll 等）');
  d.endSession();
});

test('全局调度关闭：未绑人设账号登录也不采真名（运营显式暂停一切，连边端都不驱动）', () => {
  const { d, commands } = make({ personaBinding: () => 'unbound', isDispatchActive: () => false });
  d.setCurrentAccountId('acctCap');
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctCap', ts: 1 });
  d.bus.emit('page.cards.arrived', { cards: [], startupId: 'startup-1', ts: 2 });
  assert.equal(commands.length, 0, '调度全局停 → 连启动期昵称采集也不驱动');
  d.endSession();
});
