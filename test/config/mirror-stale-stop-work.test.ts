/**
 * 闸门镜像陈旧 → 停手的行为断言（change config-mirror-cross-process-invalidation §4 / §7）。
 *
 * 三条最容易写反的不变量各一组用例：
 *  ① 停手 = 不放行**新的**平台动作；已在跑的会话 MUST NOT 被就地 kill。
 *  ② 「未知」MUST NOT 被压成「否」——人设不下发 `personaBound` 字段、暂停态不判 active。
 *  ③ 权威未答的委托任务 MUST 判可重试延后，MUST NOT 落非重试终态。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/kernel/soul-types.js';
import {
  installConfigMirrorFreshnessSource,
  type ConfigMirrorKey,
  type MirrorReadState,
} from '../../src/config-mirror-freshness.js';
import { AccountStateManager } from '../../src/account-state.js';
import type { AccountRecord, AccountStore } from '../../src/account-store.js';
import { UiSnapshotService } from '../../src/comm/ui-snapshot.js';
import { AccountPersonaService } from '../../src/config/account-persona-service.js';
import { allowsTransportWhenGateUnknown } from '../../src/config/mirror-stop-work.js';
import { automationOperationDescriptorFor } from '../../src/comm/operation-registry.js';
import { RiskController } from '../../src/risk/risk-controller.js';

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: ['x'], seed_keywords: ['k'] },
};

/** 安装一个「全部闸门镜像都陈旧」的事实源，并记录每次因陈旧的拒绝。 */
function installStaleMirrors(): { refusals: ConfigMirrorKey[] } {
  const refusals: ConfigMirrorKey[] = [];
  installConfigMirrorFreshnessSource({
    stateOf: (): MirrorReadState => 'stale',
    noteStaleRefusal: (key) => refusals.push(key),
  });
  return { refusals };
}

function makeDispatcher(): { d: RoleDispatcher; commands: EdgeCommand[]; rejected: { accountId: string; reason: string }[] } {
  const commands: EdgeCommand[] = [];
  const rejected: { accountId: string; reason: string }[] = [];
  const d = new RoleDispatcher({
    getSoul: () => mockSoul,
    llm: { complete: async () => '-1' },
    sendCommand: (c) => { commands.push(c); },
    personaBinding: () => 'bound',
    onSessionRejected: (accountId, reason) => { rejected.push({ accountId, reason }); },
  });
  d.setup();
  return { d, commands, rejected };
}

test('7.2 闸门镜像陈旧 → 新会话不启动，拒绝原因是 config_mirror_stale（不复用 needs_persona_setup）', () => {
  const { d, rejected } = makeDispatcher();
  const { refusals } = installStaleMirrors();
  try {
    d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });
    assert.equal(d.active, false, '闸门镜像陈旧时不启动新会话');
    assert.deepEqual(rejected, [{ accountId: 'acctX', reason: 'config_mirror_stale' }]);
    assert.ok(refusals.length > 0, '因陈旧的拒绝必须可计量');
  } finally {
    installConfigMirrorFreshnessSource(null);
    d.endSession();
  }
});

/**
 * 命令是**异步**产生的（角色链走 microtask + LLM 回调）。同步断言「命令数没变」在新鲜态下同样成立，
 * 证不出任何东西——必须先把事件循环让出去再比，且必须有一条新鲜态对照证明这条输入本来会产命令。
 */
function settle(ms = 400): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

test('7.2 对照组（新鲜态）：同一条上报**会**产生新的平台动作命令', async () => {
  const { d, commands } = makeDispatcher();
  try {
    d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });
    assert.equal(d.active, true, '前置：会话已在跑');
    const before = commands.length;
    d.bus.emit('page.cards.arrived', {
      cards: [{ index: 0, title: '测试笔记', likeCount: 100, collectCount: 10, noteId: 'n1' }],
      ts: 2,
    });
    await settle();
    assert.ok(
      commands.length > before,
      '对照组必须真的产出命令——否则下面那条「陈旧不产命令」就是空断言（同样的输入本来就不产命令）',
    );
  } finally {
    d.endSession();
  }
});

test('7.2 陈旧不得终结在跑会话：会话仍活着，只是不再下发新的平台动作', async () => {
  const { d, commands } = makeDispatcher();
  try {
    // 先在新鲜状态下把会话跑起来。
    d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });
    assert.equal(d.active, true, '前置：会话已在跑');

    installStaleMirrors();
    const before = commands.length;
    // 边缘继续上报 → 若照旧决策就会产生新的 open_note / scroll 等平台动作命令（见上一条对照组）。
    d.bus.emit('page.cards.arrived', {
      cards: [{ index: 0, title: '测试笔记', likeCount: 100, collectCount: 10, noteId: 'n1' }],
      ts: 2,
    });
    await settle();
    assert.equal(commands.length, before, '陈旧期间 MUST NOT 下发新的平台动作命令');
    assert.equal(d.active, true, '已在跑的会话 MUST NOT 被就地 kill（走既有自然结束路径收敛）');
  } finally {
    installConfigMirrorFreshnessSource(null);
    d.endSession();
  }
});

test('7.3 未知不下发绑定字段：人设副本陈旧时快照不带 personaBound（边缘据此保持未知、不弹向导）', () => {
  const sent: Array<Record<string, unknown>> = [];
  const service = new UiSnapshotService({
    push: (_accountId: string, _edgeId: string, payload: Record<string, unknown>) => {
      sent.push(payload);
      return 1;
    },
    resolveEdgeIdForAccount: () => 'edge-1',
    personaBinding: () => 'unknown',
    logger: { log: () => {}, warn: () => {} },
  } as unknown as ConstructorParameters<typeof UiSnapshotService>[0]);

  service.pushPersonaBound('acc-1');
  assert.equal(sent.length, 0, 'unknown MUST NOT 下发 personaBound —— 一旦下发 false，客户端会自动弹人设向导');
});

test('7.4 暂停态方向性：副本陈旧且库内已暂停 → 判 unknown 并停手，绝不因「miss = active」继续放行', async () => {
  const store: AccountStore = {
    listAll: async (): Promise<AccountRecord[]> => [{ accountId: 'acc-1', status: 'paused', pausedAt: 1 }],
    setPaused: async () => {},
  } as unknown as AccountStore;
  const mgr = new AccountStateManager(store);
  await mgr.init();
  assert.equal(mgr.pauseStateOf('acc-1'), 'paused');
  // 关键方向：**副本里没有**这个账号（比如它是刚在另一个 target 被暂停的）。
  assert.equal(mgr.pauseStateOf('acc-unknown'), 'active', '副本新鲜时 miss = active（同进程全量镜像下正确）');

  const { refusals } = installStaleMirrors();
  try {
    assert.equal(mgr.pauseStateOf('acc-unknown'), 'unknown', '副本陈旧时 MUST NOT 沿用「miss = active」');
    assert.equal(mgr.pauseStateOf('acc-1'), 'unknown');
    assert.equal(mgr.getStatus('acc-unknown').status, 'unknown');
    // 取值口是**纯读**、不记账：它每条 note.arrived 都走一次，也被飞书 /status 与徽章投影这类
    // 「什么都没拒绝」的读调用。记账收口在真正的拒绝点（handler 的 note.arrived 停手分支）。
    assert.equal(refusals.length, 0, '纯取值口 MUST NOT 记账——否则每次热路径读都要落一条 PG 写、指标也被污染');
  } finally {
    installConfigMirrorFreshnessSource(null);
  }
});

// ── 审计修复回归（2026-07-22 审计 defects #1 / #4 / #7 / #9）─────────────────────────────

test('7.3 拉取面同样不得把「未知」压成权威的未绑：/my-environments 的绑定态来源不回 missing', async () => {
  // 当代客户端的人设绑定态**根本不经 WS 下发**（ui-snapshot 对拉取型客户端直接 return），
  // 它唯一的来源是 AccountPersonaService.get() → /my-environments 的 personaBound。
  // 副本陈旧时这里若回 state:'missing'，端点就会回一个权威的 personaBound:false → 客户端弹人设向导。
  const service = new AccountPersonaService({
    generator: { generate: async () => { throw new Error('unused'); } } as never,
    facade: {
      // 副本里没有这一行（可能就是因为副本陈旧读不到）。
      getDetail: async () => ({ accountId: 'acc-1', label: null, source: 'none' as const, persona: 'x', updatedAt: null, updatedBy: null }),
      setPersona: async () => { throw new Error('unused'); },
    } as never,
    personaBinding: () => 'unknown',
    logger: { warn: () => {} },
  });

  const stale = await service.get('acc-1');
  // 端点组装（client-auth-server.ts 的 /my-environments 逐字同款分支）：!ok → 不带 personaBound。
  const payload: Record<string, unknown> = stale.ok
    ? { personaState: stale.view.state, personaBound: stale.view.state === 'configured' }
    : { personaState: 'unavailable' };
  assert.equal(stale.ok, false, '副本陈旧 MUST NOT 回一个权威的「未绑」');
  assert.equal(stale.ok === false ? stale.reason : null, 'unavailable', '必须是契约里既有的诚实不可用态');
  assert.ok(!('personaBound' in payload), '陈旧时回包 MUST NOT 含 personaBound 字段');

  // 对照：副本新鲜时照旧回权威的「未绑」（云端有资格说没有）。
  const fresh = await new AccountPersonaService({
    generator: { generate: async () => { throw new Error('unused'); } } as never,
    facade: {
      getDetail: async () => ({ accountId: 'acc-1', label: null, source: 'none' as const, persona: 'x', updatedAt: null, updatedBy: null }),
      setPersona: async () => { throw new Error('unused'); },
    } as never,
    personaBinding: () => 'unbound',
    logger: { warn: () => {} },
  }).get('acc-1');
  assert.equal(fresh.ok, true);
  assert.equal(fresh.ok ? fresh.view.state : null, 'missing', '权威的「未绑」必须照旧下发——否则人设向导永远不弹');
});

test('4.8 传输层出口闸：unknown 只拦新的平台动作，租约归还 / 快照 / 验证码协助照常放行', () => {
  const category = (type: string) => automationOperationDescriptorFor(type as never)?.category ?? null;
  // 收尾与控制面：扣住它们 = 浏览器槽位不归还、在跑会话无法自然收敛、在线边缘被误报成离线。
  for (const type of ['edge.task.release', 'edge.task.acquire', 'captcha.assist.capture', 'captcha.assist.click',
    'ui.snapshot', 'pacing.update', 'interaction.browser.control', 'note.close', 'navigation.back']) {
    assert.equal(allowsTransportWhenGateUnknown(type, category(type)), true, `${type} 在 unknown 下必须放行`);
  }
  // 新的真实平台动作：这才是停手要拦的那一类。
  for (const type of ['note.open', 'interaction.like', 'interaction.comment', 'group.join', 'publish.command',
    'page.scroll', 'search.execute', 'interaction.reply.send']) {
    assert.equal(allowsTransportWhenGateUnknown(type, category(type)), false, `${type} 在 unknown 下必须拦下`);
  }
});

test('6.2 人设副本陈旧拒绝新会话 → MUST 计数（这是停手最常见的一条路径，没有后续命令泵去补记）', () => {
  const { refusals } = installStaleMirrors();
  const commands: EdgeCommand[] = [];
  const d = new RoleDispatcher({
    getSoul: () => mockSoul,
    llm: { complete: async () => '-1' },
    sendCommand: (c) => { commands.push(c); },
    personaBinding: () => 'unknown', // 人设副本陈旧
    onSessionRejected: () => {},
  });
  d.setup();
  try {
    d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });
    assert.equal(d.active, false, '人设副本陈旧时不启动新会话');
    assert.ok(refusals.includes('persona_config'), '因人设副本陈旧的拒绝 MUST 记在 persona_config 名下');
  } finally {
    installConfigMirrorFreshnessSource(null);
    d.endSession();
  }
});

test('4.7 慢启动投影：副本陈旧 MUST NOT 显示成「已入组 D1」（clamp 取最严 ≠ 对外宣称已入组）', () => {
  const controller = new RiskController({
    accountId: 'acc-1',
    nurtureProvider: {
      // 该账号**从未开启**慢启动：新鲜态下投影必须是 off。
      slowStartSinceFor: () => null,
      createdAtFor: () => null,
      platformFor: () => 'xiaohongshu',
    },
  } as unknown as ConstructorParameters<typeof RiskController>[0]);

  const fresh = controller.slowStartView();
  assert.equal(fresh.state, 'off');
  assert.equal(fresh.day, undefined, '前置：未入组的账号没有天数');

  installStaleMirrors();
  try {
    const stale = controller.slowStartView();
    assert.equal(stale.state, 'off', '读不到 MUST NOT 被编成「已入组」');
    assert.equal(stale.day, undefined, 'MUST NOT 显示「第 1 天」');
    assert.equal(stale.since, undefined, 'MUST NOT 编一个入组时刻');
    assert.equal(stale.eligible, false);
    assert.equal(stale.ineligibleReason, 'binding_unknown', '如实回「暂时判不了」，且复用既有枚举值（边缘对未知值会整段丢弃）');
  } finally {
    installConfigMirrorFreshnessSource(null);
  }
});
