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
import type { Soul } from '../../src/soul/types.js';
import {
  installConfigMirrorFreshnessSource,
  type ConfigMirrorKey,
  type MirrorReadState,
} from '../../src/config-mirror-freshness.js';
import { AccountStateManager } from '../../src/account-state.js';
import type { AccountRecord, AccountStore } from '../../src/account-store.js';
import { UiSnapshotService } from '../../src/comm/ui-snapshot.js';

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

test('7.2 陈旧不得终结在跑会话：会话仍活着，只是不再下发新的平台动作', () => {
  const { d, commands } = makeDispatcher();
  try {
    // 先在新鲜状态下把会话跑起来。
    d.bus.emit('edge.hello', { edgeId: 'e1', accountId: 'acctX', ts: 1 });
    assert.equal(d.active, true, '前置：会话已在跑');

    installStaleMirrors();
    const before = commands.length;
    // 边缘继续上报 → 若照旧决策就会产生新的 open_note / scroll 等平台动作命令。
    d.bus.emit('page.cards.arrived', {
      cards: [{ index: 0, title: '测试笔记', likeCount: 100, collectCount: 10, noteId: 'n1' }],
      ts: 2,
    });
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
    assert.ok(refusals.includes('account_status'));
  } finally {
    installConfigMirrorFreshnessSource(null);
  }
});
