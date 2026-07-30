/**
 * 诚实人设启动闸 + 账号身份穿透（multi-account-node-support D3/D4）单测。
 * 在 RoleDispatcher 层验证：edge.hello 携 accountId → 设当前账号 → 启动闸（人设 / default 豁免 / 调度开关）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/kernel/soul-types.js';
import type { PersonaBinding } from '../../src/kernel/persona-binding.js';

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
    accountPlatform: 'xiaohongshu',
    hasIdentityReadSelfProfile: () => true,
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

test('未绑人设但库内真名空：首批 startup page.cards 采真名（恰一次 identity_read_self_profile），绝不浏览', () => {
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
  const identityReads = commands.filter((c) => c.action === 'identity_read_self_profile');
  assert.equal(identityReads.length, 1, '登录后恰驱动一次绑定账号本人主页采集');
  assert.equal(commands.filter((c) => c.action !== 'identity_read_self_profile').length, 0, '红线：未绑人设绝不浏览（无 open_note/like/scroll 等）');
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

// ─── change facebook-rule-mode-without-persona：启动闸的唯一一处人设豁免 ───────────────────

function makeFb(opts: {
  personaBinding?: (a: string) => PersonaBinding;
  facebookRuleModeEnabled?: (a: string) => boolean;
  platform?: 'facebook' | 'xiaohongshu';
}): { d: RoleDispatcher; rejected: { accountId: string; reason: string }[] } {
  const rejected: { accountId: string; reason: string }[] = [];
  const d = new RoleDispatcher({
    getSoul: () => { throw new Error('no_persona'); }, // 未绑人设：解析器诚实抛，绝不返回替代人设
    llm: { complete: async () => '-1' },
    sendCommand: () => {},
    accountPlatform: opts.platform ?? 'facebook',
    personaBinding: opts.personaBinding,
    // 启动闸与浏览裁决读取同一个 operation-mode 决策，不再另接一条 rule bool 旁路。
    facebookRuleModeDecision: (accountId) => {
      if (!opts.facebookRuleModeEnabled) {
        return { mode: 'blocked', blocker: 'facebook_operation_policy_unavailable' };
      }
      return opts.facebookRuleModeEnabled(accountId)
        ? { mode: 'facebook_rule', blocker: null }
        : { mode: 'persona', blocker: null };
    },
    onSessionRejected: (accountId, reason) => { rejected.push({ accountId, reason }); },
  });
  d.setup();
  return { d, rejected };
}

test('未绑人设 + Facebook + 规则模式启用 → 正常起会话：不短路、不置 needs_persona_setup、不告警', () => {
  const { d, rejected } = makeFb({
    personaBinding: () => 'unbound',
    facebookRuleModeEnabled: () => true,
  });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'fb-rule', ts: 1 });
  assert.equal(d.active, true, '规则模式豁免 → 会话正常启动');
  assert.deepEqual(rejected, [], '不置 needs_persona_setup、不发运营告警');
  d.endSession();
});

test('未绑人设 + 规则模式关闭 → 仍短路为 needs_persona_setup（例外只在规则模式成立）', () => {
  const { d, rejected } = makeFb({
    personaBinding: () => 'unbound',
    facebookRuleModeEnabled: () => false,
  });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'fb-off', ts: 1 });
  assert.equal(d.active, false);
  assert.deepEqual(rejected, [{ accountId: 'fb-off', reason: 'needs_persona_setup' }]);
  d.endSession();
});

test('规则模式配置读失败 / 未接线 → fail-closed，未绑人设仍被短路（绝不猜成已启用）', () => {
  const throwing = makeFb({
    personaBinding: () => 'unbound',
    facebookRuleModeEnabled: () => { throw new Error('mirror unavailable'); },
  });
  throwing.d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'fb-throw', ts: 1 });
  assert.equal(throwing.d.active, false);
  assert.deepEqual(throwing.rejected, [{ accountId: 'fb-throw', reason: 'needs_persona_setup' }]);
  throwing.d.endSession();

  const unwired = makeFb({ personaBinding: () => 'unbound' }); // 权威入口未注入
  unwired.d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'fb-unwired', ts: 1 });
  assert.equal(unwired.d.active, false);
  assert.deepEqual(unwired.rejected, [{ accountId: 'fb-unwired', reason: 'needs_persona_setup' }]);
  unwired.d.endSession();
});

test('平台未确认为 Facebook → 不豁免，未绑人设仍被短路（例外不外溢到其它平台）', () => {
  const { d, rejected } = makeFb({
    personaBinding: () => 'unbound',
    facebookRuleModeEnabled: () => true,
    platform: 'xiaohongshu',
  });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'xhs-rule', ts: 1 });
  assert.equal(d.active, false);
  assert.deepEqual(rejected, [{ accountId: 'xhs-rule', reason: 'needs_persona_setup' }]);
  d.endSession();
});

test('豁免只解除启动闸：会话中途裁决不再是规则模式 → 未绑人设账号不评估、不下发，诚实收尾', () => {
  const commands: { action: string }[] = [];
  let mode: 'facebook_rule' | 'slow_start' = 'facebook_rule';
  const d = new RoleDispatcher({
    getSoul: () => { throw new Error('no_persona'); },
    llm: { complete: async () => { throw new Error('persona loop must not run'); } },
    sendCommand: (c) => commands.push(c),
    accountPlatform: 'facebook',
    personaBinding: () => 'unbound',
    facebookRuleModeDecision: () => mode === 'facebook_rule'
      ? { mode: 'facebook_rule', blocker: null }
      : { mode: 'slow_start', blocker: 'slow_start_active' },
  });
  d.setup();
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'fb-rule', ts: 1 });
  assert.equal(d.active, true, '规则模式豁免 → 会话起来了');
  // 慢启动接管（或落到活跃周之外）→ 此刻不是规则模式；未绑人设的账号绝不接着跑人设浏览闭环。
  mode = 'slow_start';
  commands.length = 0;
  d.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: 'x', likeCount: 1, collectCount: 1, noteId: 'https://www.facebook.com/posts/p1' }],
    listKind: 'feed',
    ts: 2,
  });
  assert.equal(commands.length, 0, '非规则模式 + 未绑人设 → 不下发任何浏览指令');
  assert.equal(d.active, false, '诚实收尾，不留一个空转会话');
  d.endSession();
});

test('绑定不可解析（人设副本陈旧）+ 规则模式启用 → 仍走 persona_unavailable，不被豁免、也不误报未绑', () => {
  const { d, rejected } = makeFb({
    personaBinding: () => 'unknown',
    facebookRuleModeEnabled: () => true,
  });
  d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'fb-stale', ts: 1 });
  assert.equal(d.active, false);
  assert.deepEqual(rejected, [{ accountId: 'fb-stale', reason: 'persona_unavailable' }]);
  d.endSession();
});
