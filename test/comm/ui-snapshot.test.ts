/**
 * UiSnapshotService（edge-companion-ui 8.1）：陪伴界面数据下发。
 * 红线断言：宁缺毋假（无昵称不发 identity / 全空不发包 / 已拒草稿 hello 不回放）、
 * 定向推送（无在线边缘如实放弃、绝不广播）、通知层异常绝不外抛。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UiSnapshotService, publishUiCode } from '../../src/comm/ui-snapshot.js';
import type { Envelope, UiSnapshotPayload } from '../../src/comm/protocol.js';

interface Sent {
  env: Envelope<UiSnapshotPayload>;
  edgeId?: string;
}

function makeService(overrides: Partial<ConstructorParameters<typeof UiSnapshotService>[0]> = {}) {
  const sent: Sent[] = [];
  const service = new UiSnapshotService({
    pusher: {
      pushToEdges(env, edgeId) {
        sent.push({ env: env as Envelope<UiSnapshotPayload>, edgeId });
        return 1;
      },
    },
    resolveEdgeIdForAccount: () => 'edge-1',
    getNickname: () => '晚风手作',
    lastPublishedForAccount: async () => ({ title: '上一篇笔记', at: 1730000000000 }),
    pendingApprovalForAccount: async () => null,
    readApproval: async () => null,
    clock: () => 1730000001000,
    idGen: () => 'uisnap-test',
    logger: { log: () => {}, warn: () => {} },
    ...overrides,
  });
  return { service, sent };
}

test('ui-snapshot: hello 快照带昵称 + 最近发布，定向到该 edge', async () => {
  const { service, sent } = makeService();
  await service.pushHelloSnapshot('acc-1', 'edge-1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].edgeId, 'edge-1');
  assert.equal(sent[0].env.type, 'ui.snapshot');
  assert.deepEqual(sent[0].env.payload.account, { id: 'acc-1', nickname: '晚风手作' });
  assert.deepEqual(sent[0].env.payload.lastPublish, { title: '上一篇笔记', at: 1730000000000 });
  assert.equal(sent[0].env.payload.publish, undefined);
});

test('ui-snapshot: hello snapshot includes account daily usage and quota saturation', async () => {
  const dailyUsage: UiSnapshotPayload['dailyUsage'] = {
    asOf: 1730000001000,
    quotaLevel: 'normal',
    totals: { view: 10, like: 3, collect: 1, comment: 0, follow: 2, publish: 1 },
    quotas: { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
    saturated: ['publish'],
    windows: {
      minute: {
        totals: { view: 2, like: 1, collect: 0, comment: 0, follow: 0, publish: 0 },
        quotas: { view: 8, like: 3, collect: 2, comment: 1, follow: 1, publish: 1 },
        saturated: [],
      },
      hour: {
        totals: { view: 10, like: 3, collect: 1, comment: 0, follow: 2, publish: 1 },
        quotas: { view: 60, like: 13, collect: 7, comment: 2, follow: 4, publish: 1 },
        saturated: ['publish'],
      },
      day: {
        totals: { view: 10, like: 3, collect: 1, comment: 0, follow: 2, publish: 1 },
        quotas: { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
        saturated: ['publish'],
      },
      session: {
        active: true,
        startedAt: 1730000000000,
        totals: { like: 1, collect: 0, comment: 0, follow: 0 },
        quotas: { like: 10, collect: 5, comment: 2, follow: 3 },
        saturated: [],
      },
    },
  };
  const { service, sent } = makeService({ todayUsageForAccount: async () => dailyUsage });
  await service.pushHelloSnapshot('acc-1', 'edge-1');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].env.payload.dailyUsage, dailyUsage);
});

test('ui-snapshot: daily usage alone is enough to send hello snapshot', async () => {
  const { service, sent } = makeService({
    getNickname: () => null,
    lastPublishedForAccount: async () => null,
    pendingApprovalForAccount: async () => null,
    todayUsageForAccount: async () => ({
      asOf: 1730000001000,
      totals: { view: 0, like: 0, collect: 0, comment: 0, follow: 0, publish: 0 },
    }),
  });
  await service.pushHelloSnapshot('acc-1', 'edge-1');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].env.payload.dailyUsage?.totals, {
    view: 0,
    like: 0,
    collect: 0,
    comment: 0,
    follow: 0,
    publish: 0,
  });
});

test('ui-snapshot: 无昵称不发 identity 字段（宁缺毋假）', async () => {
  const { service, sent } = makeService({ getNickname: () => null });
  await service.pushHelloSnapshot('acc-1', 'edge-1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].env.payload.account, undefined);
  assert.ok(sent[0].env.payload.lastPublish, '仍带最近发布');
});

test('ui-snapshot: 全空快照不发包（无数据不造活跃）', async () => {
  const { service, sent } = makeService({
    getNickname: () => null,
    lastPublishedForAccount: async () => null,
    pendingApprovalForAccount: async () => null,
  });
  await service.pushHelloSnapshot('acc-1', 'edge-1');
  assert.equal(sent.length, 0);
});

test('ui-snapshot: 待审草稿无授权信号 → hello 快照带 pending（发布卡自动展开）', async () => {
  const { service, sent } = makeService({
    pendingApprovalForAccount: async () => ({ id: 83, title: '候审笔记' }),
    readApproval: async () => null,
  });
  await service.pushHelloSnapshot('acc-1', 'edge-1');
  assert.deepEqual(sent[0].env.payload.publish, { state: 'pending', code: '#83', title: '候审笔记' });
});

test('ui-snapshot: 已授权在途 → hello 快照带 approved；已拒 → 不回放（重启不翻旧账）', async () => {
  const approvedCase = makeService({
    pendingApprovalForAccount: async () => ({ id: 84, title: 'T' }),
    readApproval: async () => ({ approved: true }),
  });
  await approvedCase.service.pushHelloSnapshot('acc-1', 'edge-1');
  assert.equal(approvedCase.sent[0].env.payload.publish?.state, 'approved');

  const rejectedCase = makeService({
    getNickname: () => null,
    lastPublishedForAccount: async () => null,
    pendingApprovalForAccount: async () => ({ id: 85, title: 'T' }),
    readApproval: async () => ({ approved: false }),
  });
  await rejectedCase.service.pushHelloSnapshot('acc-1', 'edge-1');
  assert.equal(rejectedCase.sent.length, 0, '已拒草稿不在 hello 快照回放，且无其他数据时不发包');
});

test('ui-snapshot: pushPublishState 定向推状态；无在线边缘如实放弃不抛错', () => {
  const { service, sent } = makeService();
  service.pushPublishState('acc-1', 86, 'rejected', '被拒的笔记');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].env.payload.publish, { state: 'rejected', code: '#86', title: '被拒的笔记' });

  const offline = makeService({ resolveEdgeIdForAccount: () => null });
  offline.service.pushPublishState('acc-1', 87, 'approved');
  assert.equal(offline.sent.length, 0, '无在线边缘绝不广播');
});

test('ui-snapshot: 快照数据源抛错 / pusher 抛错 → 自吞不外抛（绝不影响发布主链路）', async () => {
  const { service } = makeService({
    lastPublishedForAccount: async () => {
      throw new Error('pg down');
    },
    pusher: {
      pushToEdges() {
        throw new Error('ws down');
      },
    },
  });
  await service.pushHelloSnapshot('acc-1', 'edge-1'); // 不应 reject
  service.pushPublishState('acc-1', 88, 'failed'); // 不应 throw
});

test('ui-snapshot: accountId/edgeId 缺失时 hello 快照直接跳过', async () => {
  const { service, sent } = makeService();
  await service.pushHelloSnapshot(undefined, 'edge-1');
  await service.pushHelloSnapshot('acc-1', undefined);
  assert.equal(sent.length, 0);
});

test('ui-snapshot: publishUiCode 与飞书卡编号同源（#<记录id>）', () => {
  assert.equal(publishUiCode(83), '#83');
});
