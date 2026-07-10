/**
 * 通知巡视（消息查看）测试 — 12 角色的关键不变量 + 端到端闭环 + 发命令暂停出口。
 *
 * 角色级单测：喂入事件 → 断言出事件 / 状态。
 * 端到端：notification.detected → 准入→暂停→开首页→分诊→按类浏览→分类→去重→发飞书→返回→恢复，
 *         经"假边缘"回应跑到底，最终回 feed.entered{back_to_feed} 且暂停开关已清。
 * 暂停出口：巡视期扣 browse 命令、放 excursion 命令；恢复后 browse 命令照常。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { SessionContext } from '../../src/agents/session-context.js';
import { RoleDispatcher } from '../../src/orchestrator/role-dispatcher.js';
import type { EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import { NotificationGatekeeper } from '../../src/agents/notification-gatekeeper.js';
import { BrowseSuspender } from '../../src/agents/browse-suspender.js';
import { NotificationTriage } from '../../src/agents/notification-triage.js';
import { NotificationCommentBrowser } from '../../src/agents/notification-comment-browser.js';
import { NotificationLikeBrowser } from '../../src/agents/notification-like-browser.js';
import { NotificationClassifier } from '../../src/agents/notification-classifier.js';
import { NotificationDeduper, notificationItemKey, stripRelativeTime } from '../../src/agents/notification-deduper.js';
import { NotificationNotifier } from '../../src/agents/notification-notifier.js';
import { ExcursionResumer } from '../../src/agents/excursion-resumer.js';
import type { Soul } from '../../src/soul/types.js';
import type { NotificationItem } from '../../src/comm/protocol.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
};
const opts = (bus: EventBus) => ({ eventBus: bus, soul: mockSoul });
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('通知巡视 — 角色级不变量', () => {
  it('gatekeeper: 准入通过 → beginExcursion + excursion.requested', () => {
    const bus = new EventBus(); const ctx = new SessionContext();
    new NotificationGatekeeper({ ...opts(bus), isHardPaused: () => false }, ctx).subscribe();
    let req: { epoch: number } | null = null;
    bus.on('excursion.requested', (p) => { req = p; });
    bus.emit('notification.detected.arrived', { epoch: 1, ts: Date.now() });
    assert.ok(req, '应准入');
    assert.equal(ctx.excursionActive, true);
    assert.equal(ctx.excursionEpoch, 1);
  });

  it('gatekeeper: 硬暂停中 → 放弃巡视（红线：硬暂停期不叠巡视）', () => {
    const bus = new EventBus(); const ctx = new SessionContext();
    new NotificationGatekeeper({ ...opts(bus), isHardPaused: () => true }, ctx).subscribe();
    let req = false; bus.on('excursion.requested', () => { req = true; });
    bus.emit('notification.detected.arrived', { epoch: 1, ts: Date.now() });
    assert.equal(req, false);
    assert.equal(ctx.excursionActive, false);
  });

  it('gatekeeper: 巡视中 → 忽略（active 闸）；结束后再来 → 重开（去 epoch 已处理过闸，真有新消息就处理）', () => {
    const bus = new EventBus(); const ctx = new SessionContext();
    new NotificationGatekeeper({ ...opts(bus), isHardPaused: () => false }, ctx).subscribe();
    let count = 0; bus.on('excursion.requested', () => { count++; });
    bus.emit('notification.detected.arrived', { epoch: 1, ts: Date.now() }); // 开
    bus.emit('notification.detected.arrived', { epoch: 2, ts: Date.now() }); // 巡视中 → active 闸忽略（即便是更大的新 epoch）
    assert.equal(count, 1, '巡视进行中不开并发第二趟');
    ctx.endExcursion();
    bus.emit('notification.detected.arrived', { epoch: 1, ts: Date.now() }); // 结束后即便同 epoch 也重开：不因「处理过」而拒绝新检测
    assert.equal(count, 2, '结束后真有新检测就处理（去掉 epoch 已处理过闸）');
  });

  it('suspender: excursion.requested → browseSuspended=true + browse.suspended', () => {
    const bus = new EventBus(); const ctx = new SessionContext();
    new BrowseSuspender(opts(bus), ctx).subscribe();
    let sus = false; bus.on('browse.suspended', () => { sus = true; });
    bus.emit('excursion.requested', { epoch: 1, ts: Date.now() });
    assert.equal(ctx.browseSuspended, true);
    assert.equal(sus, true);
  });

  it('triage: 循环到三栏清零（每轮重读计数，按优先级逐类清 → triage_done）', () => {
    const bus = new EventBus(); const ctx = new SessionContext();
    ctx.beginExcursion(1);
    new NotificationTriage(opts(bus), ctx).subscribe();
    const picks: string[] = []; let done = 0;
    bus.on('notification.category_selected', (p) => { picks.push(p.category); });
    bus.on('notification.triage_done', () => { done++; });
    // 每轮 home 反映上一类被看后已清零（loop-to-zero）
    bus.emit('notification.home.arrived', { comments: 1, likes: 1, follows: 1, ts: Date.now() }); // → comments
    bus.emit('notification.home.arrived', { comments: 0, likes: 1, follows: 1, ts: Date.now() }); // comments 清 → likes
    bus.emit('notification.home.arrived', { comments: 0, likes: 0, follows: 1, ts: Date.now() }); // likes 清 → follows
    bus.emit('notification.home.arrived', { comments: 0, likes: 0, follows: 0, ts: Date.now() }); // 全清 → done
    assert.deepEqual(picks, ['comments', 'likes', 'follows'], '按优先级逐类清零');
    assert.equal(done, 1, '三栏全 0 收敛为 triage_done');
  });

  it('triage: 某类清不掉 → 上限内重试后诚实放弃、仍收敛（不无限重选、不空转）', () => {
    const bus = new EventBus(); const ctx = new SessionContext();
    ctx.beginExcursion(1);
    new NotificationTriage({ ...opts(bus), maxAttemptsPerCategory: 2 }, ctx).subscribe();
    const picks: string[] = []; let done = 0;
    bus.on('notification.category_selected', (p) => { picks.push(p.category); });
    bus.on('notification.triage_done', () => { done++; });
    const stuck = { comments: 1, likes: 0, follows: 0, ts: Date.now() }; // comments 永不清
    bus.emit('notification.home.arrived', stuck); // 选 comments 第 1 次
    bus.emit('notification.home.arrived', stuck); // 第 2 次（=上限）
    bus.emit('notification.home.arrived', stuck); // 到上限 → 放弃 comments → 无其他未读 → triage_done
    assert.deepEqual(picks, ['comments', 'comments'], '上限内重试 2 次');
    assert.equal(done, 1, '到上限诚实放弃后收敛，不无限重选');
  });

  it('triage: 放弃清不掉的高优先类后仍处理低优先类（清不掉的不挡住能清的）', () => {
    const bus = new EventBus(); const ctx = new SessionContext();
    ctx.beginExcursion(1);
    new NotificationTriage({ ...opts(bus), maxAttemptsPerCategory: 1 }, ctx).subscribe();
    const picks: string[] = []; let done = 0;
    bus.on('notification.category_selected', (p) => { picks.push(p.category); });
    bus.on('notification.triage_done', () => { done++; });
    bus.emit('notification.home.arrived', { comments: 1, likes: 1, follows: 0, ts: Date.now() }); // comments 第 1 次(=上限)
    bus.emit('notification.home.arrived', { comments: 1, likes: 1, follows: 0, ts: Date.now() }); // comments 到上限放弃 → likes 第 1 次
    bus.emit('notification.home.arrived', { comments: 1, likes: 0, follows: 0, ts: Date.now() }); // likes 清；comments 仍放弃 → done
    assert.deepEqual(picks, ['comments', 'likes'], '高优先清不掉被放弃，低优先仍被处理');
    assert.equal(done, 1);
  });

  it('triage: 非巡视期的杂散首页上报被忽略', () => {
    const bus = new EventBus(); const ctx = new SessionContext(); // 未 beginExcursion
    new NotificationTriage(opts(bus), ctx).subscribe();
    let any = false;
    bus.on('notification.category_selected', () => { any = true; });
    bus.on('notification.triage_done', () => { any = true; });
    bus.emit('notification.home.arrived', { comments: 5, likes: 0, follows: 0, ts: Date.now() });
    assert.equal(any, false);
  });

  it('comment_browser: category_selected{comments} → browse_category{comments, scrollMax}', () => {
    const bus = new EventBus(); const ctx = new SessionContext(); ctx.beginExcursion(1);
    new NotificationCommentBrowser(opts(bus), ctx).subscribe();
    const cmds: { category: string; scrollMax?: number }[] = [];
    bus.on('notification.browse_category', (p) => { cmds.push(p); });
    bus.emit('notification.category_selected', { category: 'comments', epoch: 1, ts: Date.now() });
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].category, 'comments');
    assert.ok((cmds[0].scrollMax ?? 0) > 0);
  });

  it('like_browser: 选中 → browse_category{likes}；回执 ok:true → category_handled；ok:false → 不收尾(交 resumer)', () => {
    const bus = new EventBus(); const ctx = new SessionContext(); ctx.beginExcursion(1);
    new NotificationLikeBrowser(opts(bus), ctx).subscribe();
    let browse = false; let handled = 0;
    bus.on('notification.browse_category', (p) => { if (p.category === 'likes') browse = true; });
    bus.on('notification.category_handled', (p) => { if (p.category === 'likes') handled++; });
    bus.emit('notification.category_selected', { category: 'likes', epoch: 1, ts: Date.now() });
    assert.equal(browse, true);
    bus.emit('action.completed', { action: 'browse_notification_likes', ok: false, ts: Date.now() });
    assert.equal(handled, 0, 'ok:false 不在此收尾');
    bus.emit('action.completed', { action: 'browse_notification_likes', ok: true, ts: Date.now() });
    assert.equal(handled, 1, 'ok:true 收尾');
  });

  it('classifier: 过滤空内容 → classified{worthy}', () => {
    const bus = new EventBus(); const ctx = new SessionContext(); ctx.beginExcursion(1);
    new NotificationClassifier(opts(bus), ctx).subscribe();
    const classified: NotificationItem[][] = [];
    bus.on('notification.classified', (p) => { classified.push(p.worthy); });
    const items: NotificationItem[] = [
      { kind: 'comment', fromUser: 'a', content: '好文' },
      { kind: 'comment', fromUser: 'b', content: '   ' }, // 空 → 滤掉
      { kind: 'mention', fromUser: 'c', content: '@你看看' },
    ];
    bus.emit('notification.items.arrived', { items, ts: Date.now() });
    assert.equal(classified.length, 1);
    assert.equal(classified[0].length, 2);
  });

  it('classifier(NCQ-1 纵深): 拒 正文==用户名 与 纯动作标签（边缘 blob 残留防御）', () => {
    const bus = new EventBus(); const ctx = new SessionContext(); ctx.beginExcursion(1);
    new NotificationClassifier(opts(bus), ctx).subscribe();
    const classified: NotificationItem[][] = [];
    bus.on('notification.classified', (p) => { classified.push(p.worthy); });
    const items: NotificationItem[] = [
      { kind: 'comment', fromUser: '阿强', content: '这条很实用' },     // 真评论 → 留
      { kind: 'comment', fromUser: '阿强', content: '阿强' },           // 正文==用户名（错抓名字）→ 拒
      { kind: 'comment', fromUser: '小美', content: '赞了你的笔记' },    // 纯动作标签无正文 → 拒
      { kind: 'comment', fromUser: '小紫', content: '该评论已删除' },    // 已删除占位（真机观察）→ 拒
    ];
    bus.emit('notification.items.arrived', { items, ts: Date.now() });
    assert.equal(classified[0].length, 1, '只留真评论');
    assert.equal(classified[0][0].content, '这条很实用');
  });

  it('deduper(NCQ-3): 回退去重键剥相对时间 → 同条评论跨巡视时间漂移不重复通知', () => {
    // itemKey 缺失时回退键含正文；正文带「N分钟前」会跨巡视漂移 → 旧码同条评论键变化 → 重复打扰。
    const k1 = notificationItemKey({ kind: 'comment', fromUser: '阿强', content: '说得对 3分钟前' });
    const k2 = notificationItemKey({ kind: 'comment', fromUser: '阿强', content: '说得对 8分钟前' });
    assert.equal(k1, k2, '剥掉相对时间后同条评论键稳定');
    assert.equal(stripRelativeTime('说得对 3分钟前'), '说得对');
  });

  it('deduper(NCQ-3 修正): 只剥尾部时间戳，正文内联数字/日期保留 → 不同评论不误折叠丢失', () => {
    // 内联数字/日期绝不被剥（否则两条不同评论撞键 → 第二条当已通知静默丢失，lose-real-data 红线）。
    assert.equal(stripRelativeTime('打折5-1活动'), '打折5-1活动');
    assert.equal(stripRelativeTime('价格12-25元'), '价格12-25元');
    assert.equal(stripRelativeTime('我3年前去过'), '我3年前去过');
    assert.equal(stripRelativeTime('2024-01-01 发布的笔记'), '2024-01-01 发布的笔记');
    const a = notificationItemKey({ kind: 'comment', fromUser: '阿强', content: '打折5-1活动' });
    const b = notificationItemKey({ kind: 'comment', fromUser: '阿强', content: '打折6-1活动' });
    assert.notEqual(a, b, '仅内联 token 不同的两条评论键必须不同（不折叠丢失）');
  });

  it('deduper(NB-5): itemKey 为 profile 链时不当主键 → 退化到 用户名|正文（防同人多评论折叠）', () => {
    const a = notificationItemKey({ kind: 'comment', fromUser: '阿强', content: '第一条', itemKey: '/user/profile/u1' });
    const b = notificationItemKey({ kind: 'comment', fromUser: '阿强', content: '第二条', itemKey: '/user/profile/u1' });
    assert.notEqual(a, b, '同人两条评论即便 profile 链相同，键也必须不同（不被折叠丢失）');
    // 真 per-comment permalink 则直接作主键
    assert.equal(notificationItemKey({ kind: 'comment', fromUser: '阿强', content: 'x', itemKey: '/explore/note9#c1' }), '/explore/note9#c1');
  });

  it('deduper: 新项 → worthy；全部已通知 → all_seen + category_handled', () => {
    const bus = new EventBus(); const ctx = new SessionContext(); ctx.beginExcursion(1);
    new NotificationDeduper(opts(bus), ctx).subscribe();
    let worthy = 0; let allSeen = 0; let handled = 0;
    bus.on('notification.worthy', () => { worthy++; });
    bus.on('notification.all_seen', () => { allSeen++; });
    bus.on('notification.category_handled', () => { handled++; });
    const item: NotificationItem = { kind: 'comment', fromUser: 'a', content: 'x', itemKey: 'k1' };
    bus.emit('notification.classified', { worthy: [item], epoch: 1, ts: Date.now() });
    assert.equal(worthy, 1, '首次为新 → worthy');
    ctx.markItemNotified('k1'); // 模拟已发
    bus.emit('notification.classified', { worthy: [item], epoch: 1, ts: Date.now() });
    assert.equal(allSeen, 1, '已通知 → all_seen');
    assert.equal(handled, 1, 'all_seen 分支直接收尾');
  });

  it('notifier: 成功 → markItemNotified + notified + category_handled', async () => {
    const bus = new EventBus(); const ctx = new SessionContext(); ctx.beginExcursion(1);
    const sent: NotificationItem[][] = [];
    new NotificationNotifier({ ...opts(bus), notify: async (items) => { sent.push(items); } }, ctx).subscribe();
    let notified = 0; let handled = 0;
    bus.on('notification.notified', () => { notified++; });
    bus.on('notification.category_handled', () => { handled++; });
    const item: NotificationItem = { kind: 'comment', fromUser: 'a', content: 'x', itemKey: 'k1' };
    bus.emit('notification.worthy', { items: [item], epoch: 1, ts: Date.now() });
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(ctx.isItemNotified('k1'), true, '成功路径推进水位');
    assert.equal(notified, 1);
    assert.equal(handled, 1);
  });

  it('notifier: 发送失败 → 不推水位（下次重试）但仍 category_handled 收尾（红线：不吞）', async () => {
    const bus = new EventBus(); const ctx = new SessionContext(); ctx.beginExcursion(1);
    new NotificationNotifier({ ...opts(bus), notify: async () => { throw new Error('feishu down'); } }, ctx).subscribe();
    let handled = 0; bus.on('notification.category_handled', () => { handled++; });
    const item: NotificationItem = { kind: 'comment', fromUser: 'a', content: 'x', itemKey: 'k1' };
    bus.emit('notification.worthy', { items: [item], epoch: 1, ts: Date.now() });
    await tick();
    assert.equal(ctx.isItemNotified('k1'), false, '失败不推水位');
    assert.equal(handled, 1, '失败仍收尾，不卡死巡视');
  });

  it('resumer: triage_done → endExcursion(关暂停) + feed.entered；幂等（多终止只恢复一次）', () => {
    const bus = new EventBus(); const ctx = new SessionContext();
    ctx.beginExcursion(1); ctx.setBrowseSuspended(true);
    new ExcursionResumer(opts(bus), ctx).subscribe();
    let feed = 0; let suspendedAtFeed: boolean | null = null;
    bus.on('feed.entered', () => { feed++; suspendedAtFeed = ctx.browseSuspended; });
    bus.emit('notification.triage_done', { epoch: 1, ts: Date.now() });
    bus.emit('notification.triage_done', { epoch: 1, ts: Date.now() }); // 幂等
    bus.emit('notification.classify_failed', { epoch: 1, reason: 'x', ts: Date.now() }); // 幂等
    assert.equal(feed, 1, '只恢复一次');
    assert.equal(ctx.excursionActive, false);
    assert.equal(ctx.browseSuspended, false, '恢复后暂停开关已清');
    assert.equal(suspendedAtFeed, false, 'emit feed.entered 时暂停已先解除（back 命令不被扣）');
  });

  it('resumer: 巡视命令回执 ok:false → 恢复浏览', () => {
    const bus = new EventBus(); const ctx = new SessionContext();
    ctx.beginExcursion(1); ctx.setBrowseSuspended(true);
    new ExcursionResumer(opts(bus), ctx).subscribe();
    let feed = 0; bus.on('feed.entered', () => { feed++; });
    bus.emit('action.completed', { action: 'browse_notification_likes', ok: false, ts: Date.now() });
    assert.equal(feed, 1);
    assert.equal(ctx.browseSuspended, false);
  });
});

describe('通知巡视 — 发命令暂停出口（软暂停）', () => {
  it('巡视期扣 browse 命令、放 excursion 命令；恢复后 browse 命令照常', async () => {
    const commands: EdgeCommand[] = [];
    const d = new RoleDispatcher({ soul: mockSoul, llm: { complete: async () => '' }, sendCommand: (c) => commands.push(c) });
    d.setup(); d.startSession();
    d.context.setBrowseSuspended(true);
    d.bus.emit('feed.scrolled', { pageType: 'feed', scrollCount: 1, ts: Date.now() }); // browse → 应被扣
    d.bus.emit('notification.opening', { epoch: 1, reason: 'open', ts: Date.now() }); // excursion → 应放行
    await tick();
    assert.equal(commands.filter((c) => c.action === 'scroll').length, 0, '巡视期 browse scroll 被扣');
    assert.equal(commands.filter((c) => c.action === 'open_notifications').length, 1, '巡视命令放行');
    d.context.setBrowseSuspended(false);
    d.bus.emit('feed.scrolled', { pageType: 'feed', scrollCount: 1, ts: Date.now() });
    await tick();
    assert.ok(commands.filter((c) => c.action === 'scroll').length >= 1, '恢复后 browse 命令照常');
    d.endSession();
  });

  it('生产租约路径：acquired 前缓存巡视命令，整趟携同一 taskId，ended 后释放', async () => {
    const commands: EdgeCommand[] = [];
    const releases: string[] = [];
    let resolveAcquire!: (lease: { taskId: string; edgeId: string; kind: 'notification'; priority: 'automatic' }) => void;
    const acquiring = new Promise<{ taskId: string; edgeId: string; kind: 'notification'; priority: 'automatic' }>(
      (resolve) => { resolveAcquire = resolve; },
    );
    const d = new RoleDispatcher({
      soul: mockSoul,
      llm: { complete: async () => '' },
      sendCommand: (command) => commands.push(command),
      edgeTaskLeases: {
        acquire: async () => acquiring,
        release: async (lease) => { releases.push(lease.taskId); },
      },
    });
    d.setup();
    d.startSession();
    d.bus.emit('edge.hello', { edgeId: 'edge-1', accountId: 'acc-1', ts: Date.now() });
    d.bus.emit('excursion.requested', { epoch: 1, ts: Date.now() });
    d.bus.emit('notification.opening', { epoch: 1, reason: 'open', ts: Date.now() });
    await tick();
    assert.equal(commands.some((command) => command.action === 'open_notifications'), false, 'acquired 前零业务命令');

    resolveAcquire({ taskId: 'task-notification-1', edgeId: 'edge-1', kind: 'notification', priority: 'automatic' });
    await tick();
    const opened = commands.find((command) => command.action === 'open_notifications');
    assert.equal(opened?.params?.taskId, 'task-notification-1');
    d.bus.emit('excursion.ended', { epoch: 1, reason: 'test_complete', ts: Date.now() });
    await tick();
    assert.deepEqual(releases, ['task-notification-1']);
    d.endSession();
  });
});

describe('通知巡视 — 端到端闭环（假边缘）', () => {
  it('detected → 巡视全程 → 回 feed.entered{back_to_feed} 且暂停开关已清', async () => {
    const commands: EdgeCommand[] = [];
    let homeRound = 0;
    let d: RoleDispatcher;
    const feishuSent: NotificationItem[][] = [];
    const sendCommand = (cmd: EdgeCommand): void => {
      commands.push(cmd);
      if (cmd.action === 'open_notifications' || cmd.action === 'notification_back_home') {
        // 首轮报有评论未读，之后报全 0（评论已看 → 红点清）
        const home = homeRound === 0 ? { comments: 1, likes: 0, follows: 0 } : { comments: 0, likes: 0, follows: 0 };
        homeRound++;
        setTimeout(() => d.bus.emit('notification.home.arrived', { ...home, ts: Date.now() }), 0);
      } else if (cmd.action === 'browse_notification_comments') {
        setTimeout(() => d.bus.emit('notification.items.arrived', {
          items: [{ kind: 'comment', fromUser: '小明', content: '学到了', itemKey: 'c1' }],
          ts: Date.now(),
        }), 0);
      }
    };
    d = new RoleDispatcher({
      soul: mockSoul,
      llm: { complete: async () => '' },
      sendCommand,
      notifyComments: async (items) => { feishuSent.push(items); },
    });
    d.setup(); d.startSession();

    let resumed: { trigger: string } | null = null;
    d.bus.on('feed.entered', (p) => { if (p.trigger === 'back_to_feed') resumed = p; });

    d.bus.emit('notification.detected.arrived', { epoch: 1, ts: Date.now() });
    for (let i = 0; i < 12 && !resumed; i++) await tick();

    assert.ok(resumed, '巡视后应回 feed.entered{back_to_feed}');
    assert.equal(d.context.excursionActive, false, '巡视已结束');
    assert.equal(d.context.browseSuspended, false, '暂停开关已清（断连不冻结的前提）');
    assert.equal(feishuSent.length, 1, '评论/@ 发了一次飞书');
    assert.equal(feishuSent[0][0].fromUser, '小明');
    assert.ok(commands.some((c) => c.action === 'open_notifications'), '开过通知首页');
    assert.ok(commands.some((c) => c.action === 'browse_notification_comments'), '浏览过评论和@');
    assert.ok(commands.some((c) => c.action === 'notification_back_home'), '处理完返回过首页');
    d.endSession();
  });
});
