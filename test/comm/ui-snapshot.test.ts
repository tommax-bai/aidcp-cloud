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
        startedAt: 1729999941000,
        windowMs: 60000,
        expiresAt: 1730000061000,
        totals: { view: 2, like: 1, collect: 0, comment: 0, follow: 0, publish: 0 },
        quotas: { view: 8, like: 3, collect: 2, comment: 1, follow: 1, publish: 1 },
        saturated: [],
      },
      hour: {
        startedAt: 1729996401000,
        windowMs: 3600000,
        expiresAt: 1730003601000,
        totals: { view: 10, like: 3, collect: 1, comment: 0, follow: 2, publish: 1 },
        quotas: { view: 60, like: 13, collect: 7, comment: 2, follow: 4, publish: 1 },
        saturated: ['publish'],
      },
      day: {
        startedAt: 1729958400000,
        windowMs: 86400000,
        expiresAt: 1730044800000,
        totals: { view: 10, like: 3, collect: 1, comment: 0, follow: 2, publish: 1 },
        quotas: { view: 150, like: 50, collect: 25, comment: 8, follow: 15, publish: 1 },
        saturated: ['publish'],
      },
      session: {
        active: true,
        startedAt: 1730000000000,
        windowMs: 600000,
        expiresAt: 1730000600000,
        totals: { view: 2, like: 1, collect: 0, comment: 0, follow: 0, publish: 0 },
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

test('ui-snapshot: hello snapshot includes browser standby hint when available', async () => {
  const browserStandby: UiSnapshotPayload['browserStandby'] = {
    enabled: true,
    eligible: true,
    reason: 'view_quota:hour',
    waitMs: 1_800_000,
    wakeAt: 1730001801000,
    generatedAt: 1730000001000,
    source: 'risk',
    minWaitMs: 1_200_000,
    warmupMs: 90_000,
  };
  const { service, sent } = makeService({ browserStandbyForAccount: async () => browserStandby });
  await service.pushHelloSnapshot('acc-1', 'edge-1');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].env.payload.browserStandby, browserStandby);
});

test('ui-snapshot: daily usage refresh is scheduled and remains targeted', async () => {
  const dailyUsage: UiSnapshotPayload['dailyUsage'] = {
    asOf: 1730000001000,
    totals: { view: 1, like: 0, collect: 0, comment: 0, follow: 0, publish: 0 },
    windows: {
      minute: {
        totals: { view: 1, like: 0, collect: 0, comment: 0, follow: 0, publish: 0 },
        refreshAt: 1730000061000,
      },
    },
  };
  let pusherOnline = true;
  const timers: Array<{ fn: () => void; delay: number }> = [];
  const sent: Sent[] = [];
  const service = new UiSnapshotService({
    pusher: {
      pushToEdges(env, edgeId) {
        if (!pusherOnline) return 0;
        sent.push({ env: env as Envelope<UiSnapshotPayload>, edgeId });
        return 1;
      },
    },
    resolveEdgeIdForAccount: () => 'edge-1',
    getNickname: () => null,
    lastPublishedForAccount: async () => null,
    pendingApprovalForAccount: async () => null,
    readApproval: async () => null,
    todayUsageForAccount: async () => dailyUsage,
    clock: () => 1730000001000,
    idGen: () => `uisnap-${sent.length + 1}`,
    setTimeoutFn: ((fn: () => void, delay: number) => {
      timers.push({ fn, delay });
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
    logger: { log: () => {}, warn: () => {} },
  });

  await service.pushHelloSnapshot('acc-1', 'edge-1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].edgeId, 'edge-1');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60_000);

  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].edgeId, 'edge-1');
  assert.deepEqual(sent[1].env.payload, { dailyUsage });

  pusherOnline = false;
  timers[1].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2, 'offline refresh should not broadcast or keep pushing visible messages');
});

test('ui-snapshot: daily usage refresh forwards browser standby alongside usage', async () => {
  const dailyUsage: UiSnapshotPayload['dailyUsage'] = {
    asOf: 1730000001000,
    totals: { view: 1, like: 0, collect: 0, comment: 0, follow: 0, publish: 0 },
    windows: { minute: { totals: { view: 1 }, refreshAt: 1730000061000 } },
  };
  const browserStandby: UiSnapshotPayload['browserStandby'] = {
    enabled: true,
    eligible: false,
    reason: 'short_wait',
    waitMs: 30_000,
    wakeAt: 1730000031000,
    generatedAt: 1730000001000,
    source: 'risk',
    minWaitMs: 1_200_000,
    warmupMs: 90_000,
  };
  const timers: Array<{ fn: () => void; delay: number }> = [];
  const { service, sent } = makeService({
    todayUsageForAccount: async () => dailyUsage,
    browserStandbyForAccount: async () => browserStandby,
    setTimeoutFn: ((fn: () => void, delay: number) => {
      timers.push({ fn, delay });
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  });

  await service.pushHelloSnapshot('acc-1', 'edge-1');
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent[1].env.payload, { dailyUsage, browserStandby });
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

test('ui-snapshot: hello 快照同时带待审稿件预览，且不携带原稿字段', async () => {
  const preview: NonNullable<UiSnapshotPayload['publishPreview']> = {
    recordId: 89,
    code: '#89',
    kind: 'rewrite',
    title: '洗稿后的标题',
    content: '洗稿后的正文',
    topics: ['生活方式', '周末去哪儿'],
    images: ['https://cdn.example.com/1.jpg'],
    contentVersion: 0,
    updatedAt: 1730000000000,
  };
  const { service, sent } = makeService({
    pendingPublishPreviewForAccount: async () => preview,
    readApproval: async () => null,
  });
  await service.pushHelloSnapshot('acc-1', 'edge-1');
  assert.deepEqual(sent[0].env.payload.publishPreview, preview);
  assert.deepEqual(sent[0].env.payload.publish, { state: 'pending', code: '#89', title: '洗稿后的标题' });
  assert.equal('source' in sent[0].env.payload.publishPreview!, false);
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

test('ui-snapshot: submitted 明确表示页面已提交但链接待确认', () => {
  const { service, sent } = makeService();
  service.pushPublishState('acc-1', 89, 'submitted', '待链接确认的帖子');
  assert.deepEqual(sent[0].env.payload.publish, { state: 'submitted', code: '#89', title: '待链接确认的帖子' });
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

// ── 人设绑定态三态（change persona-bound-tristate）──────────────────────────────────────────
// 云端是人设状态的唯一权威写方：true / false 都下发，且这个零 I/O 的 bit 绝不排在几轮 PG 往返之后。
// 旧契约「仅 true 时下发」把「云端说没有」与「云端还没说」压成边缘侧同一个值，导致已设置人设的账号被误弹向导。

test('ui-snapshot: personaBound=true 先于重快照单独下发（不排在 DB 往返之后）', async () => {
  const { service, sent } = makeService({
    isPersonaBound: () => true,
    // 重快照的 DB 往返很慢：绑定态绝不能被它拖住（真机上就是这段延迟造成误弹）。
    lastPublishedForAccount: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { title: '上一篇笔记', at: 1730000000000 };
    },
  });
  await service.pushHelloSnapshot('acc-1', 'edge-1');
  assert.equal(sent[0].env.payload.personaBound, true, '第一包就必须带绑定态');
  assert.equal(Object.keys(sent[0].env.payload).length, 1, '绑定态单独成包，不与慢快照耦合');
  assert.equal(sent[1].env.payload.personaBound, undefined, '后面的重快照不再重复带');
});

test('ui-snapshot: personaBound=false 同样下发（权威「未绑」绝不吞掉）', async () => {
  const { service, sent } = makeService({ isPersonaBound: () => false });
  await service.pushHelloSnapshot('acc-1', 'edge-1');
  assert.equal(sent[0].env.payload.personaBound, false, '云端有资格诚实地说「这个账号没有人设」');
});

test('ui-snapshot: 绑定/解绑后即时重推绑定态（不必等下一次握手）', async () => {
  let bound = false;
  const { service, sent } = makeService({ isPersonaBound: () => bound });
  bound = true;
  service.pushPersonaBound('acc-1');
  assert.equal(sent.at(-1)!.env.payload.personaBound, true);
  bound = false; // 清空人设保存 = 显式解绑
  service.pushPersonaBound('acc-1');
  assert.equal(sent.at(-1)!.env.payload.personaBound, false, '解绑必须推下去，否则客户端一直显示「已设置」');
});

test('ui-snapshot: 账号无在线边缘时绑定态如实放弃，绝不广播、绝不外抛', () => {
  const { service, sent } = makeService({ isPersonaBound: () => true, resolveEdgeIdForAccount: () => null });
  service.pushPersonaBound('acc-1');
  assert.equal(sent.length, 0);
});
