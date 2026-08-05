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
import { NotificationClassifier, routeNotificationBatch } from '../../src/agents/notification-classifier.js';
import { NotificationDeduper, notificationItemKey, stripRelativeTime } from '../../src/agents/notification-deduper.js';
import { NotificationNotifier } from '../../src/agents/notification-notifier.js';
import { ExcursionResumer } from '../../src/agents/excursion-resumer.js';
import { EXCURSION_STALL_TIMEOUT_MS } from '../../src/risk/resume-limits.js';
import type { Soul } from '../../src/kernel/soul-types.js';
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
    ctx.noteCategorySelected('comments'); // 前置：本批确实来自「评论和@」栏（内容防御才轮得到上场）
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
    ctx.noteCategorySelected('comments'); // 前置：这条测的是内容防御，不是类别路由
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

// ─────────────────────────────────────────────────────────────────────────────
// change guard-excursion-stall：巡视停滞兜底
//
// 守的是「已上线但从未实装」的那条要求——巡视必须有一个基于时间的兜底。前三个显式终止入口覆盖了巡视
// 所有**已声明的结束方式**，漏的是「巡视没有结束、也不会再结束」：一步「回执成功但语义走岔」不产生任何
// 终止信号，浏览随即无限期挂起（2026-08-05 OL 实测）。
// ─────────────────────────────────────────────────────────────────────────────

/** 可推进的假定时器（不靠真实墙钟；同时记录每次排表时长，供「生产默认值真的接上了」断言）。 */
class FakeTimers {
  now = 0;
  private seq = 1;
  private readonly pending = new Map<number, { fn: () => void; at: number }>();
  readonly scheduled: number[] = [];
  readonly set = (fn: () => void, ms: number): unknown => {
    const id = this.seq++;
    this.pending.set(id, { fn, at: this.now + ms });
    this.scheduled.push(ms);
    return id;
  };
  readonly clear = (h: unknown): void => { this.pending.delete(h as number); };
  /** 前进 ms 并触发到点回调（回调新排的表不在本次触发，下一次 advance 才可能到点）。 */
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.pending]) {
      if (t.at <= this.now) { this.pending.delete(id); t.fn(); }
    }
  }
  get pendingCount(): number { return this.pending.size; }
}

const STALL_MS = 300_000;

/** 起一个装了假定时器的 resumer，并把巡视开起来（准入角色的同步 check-then-set 语义）。 */
function armedResumer(overrides: { stallTimeoutMs?: number; maxStallRecoveries?: number } = {}) {
  const bus = new EventBus();
  const ctx = new SessionContext();
  const timers = new FakeTimers();
  const resumer = new ExcursionResumer(
    {
      ...opts(bus),
      stallTimeoutMs: STALL_MS,
      maxStallRecoveries: 1,
      ...overrides,
      setTimeoutFn: timers.set,
      clearTimeoutFn: timers.clear,
    },
    ctx,
  );
  resumer.subscribe();
  const openings: string[] = [];
  const ended: { reason: string }[] = [];
  let feed = 0;
  bus.on('notification.opening', (p) => { openings.push(p.reason); });
  bus.on('excursion.ended', (p) => { ended.push(p); });
  bus.on('feed.entered', () => { feed++; });
  ctx.beginExcursion(1);
  ctx.setBrowseSuspended(true);
  bus.emit('excursion.requested', { epoch: 1, ts: 0 });
  return { bus, ctx, timers, resumer, openings, ended, feedCount: () => feed };
}

describe('通知巡视 — 停滞兜底（change guard-excursion-stall）', () => {
  it('承重·复刻 2026-08-05 OL 事故：回执成功但走岔回信息流 → 先只读重新对齐、再诚实收尾、浏览恢复', () => {
    const { bus, ctx, timers, openings, ended, feedCount } = armedResumer();

    // 边缘把「返回通知首页」做成了「回信息流」：回执 ok:true + 上报 page.cards。
    bus.emit('action.completed', { action: 'notification_back_home', ok: true, ts: 0 });

    // **违规输入**：非巡视上报落在停滞窗口**中段**——它让停滞「看起来还活着」。
    // 位置是关键：若把它算作巡视前进，时限会被推到 1.5×STALL_MS，下面这次到点就不会发生、用例即红。
    timers.advance(STALL_MS / 2);
    bus.emit('page.cards.arrived', { cards: [], ts: 0 });
    timers.advance(STALL_MS / 2);
    assert.deepEqual(openings, ['open'], '时限到点 MUST 先只读重新对齐（重开通知首页），而不是直接判失败');
    assert.equal(ended.length, 0, '自愈阶段 MUST NOT 落终态');
    assert.equal(ctx.excursionActive, true, '自愈阶段巡视仍在');
    assert.equal(ctx.browseSuspended, true, '自愈阶段浏览仍暂停（还没收尾）');

    // 自愈也落空：边缘继续只上报信息流卡片，巡视依旧毫无前进（同样落在窗口中段）。
    timers.advance(STALL_MS / 2);
    bus.emit('page.cards.arrived', { cards: [], ts: 0 });
    timers.advance(STALL_MS / 2);

    assert.equal(ended.length, 1, '预算耗尽 MUST 诚实收尾');
    assert.ok(
      ended[0].reason.startsWith('stalled_no_progress'),
      `收尾原因须可区分于正常收尾，实得 ${ended[0].reason}`,
    );
    assert.equal(ctx.excursionActive, false, '巡视已结束');
    assert.equal(ctx.browseSuspended, false, '浏览暂停已解除（不再无限期挂起）');
    assert.equal(feedCount(), 1, '回到信息流');
    assert.deepEqual(openings, ['open'], '自愈恰好 1 次：不是 0（跳过自愈直接判死），也不是 2（无限重发）');
    assert.equal(timers.pendingCount, 0, '收尾即停表，不留残余计时器');
  });

  it('反向闸：持续前进的健康巡视不被误伤（零自愈、不强制收尾）', () => {
    const { bus, ctx, timers, openings, ended } = armedResumer();
    // 每次都在时限内喂一条真前进证据，逐条覆盖四类信号。
    for (const feedProgress of [
      () => bus.emit('notification.home.arrived', { comments: 1, likes: 0, follows: 0, ts: 0 }),
      () => bus.emit('notification.category_selected', { category: 'comments', epoch: 1, ts: 0 }),
      () => bus.emit('notification.items.arrived', { items: [], ts: 0 }),
      () => bus.emit('action.completed', { action: 'browse_notification_comments', ok: true, ts: 0 }),
    ]) {
      timers.advance(STALL_MS - 1);
      feedProgress();
    }
    timers.advance(STALL_MS - 1);
    assert.deepEqual(openings, [], '健康巡视 MUST NOT 被注入自愈导航');
    assert.deepEqual(ended, [], '健康巡视 MUST NOT 被强制收尾');
    assert.equal(ctx.excursionActive, true);
  });

  it('自愈 MUST NOT 触发分类栏点击（提交点：消费未读、无回滚）', () => {
    const { bus, timers } = armedResumer();
    const browsed: string[] = [];
    bus.on('notification.browse_category', (p) => { browsed.push(p.category); });
    timers.advance(STALL_MS / 2);
    bus.emit('page.cards.arrived', { cards: [], ts: 0 });
    timers.advance(STALL_MS / 2);
    assert.deepEqual(browsed, [], '自愈只重开通知首页，绝不由自愈路径直接点分类栏');
  });

  it('显式终止先到即停表：兜底 MUST NOT 在正常收尾后再开一次火', () => {
    const { bus, ctx, timers, ended } = armedResumer();
    bus.emit('notification.triage_done', { epoch: 1, ts: 0 });
    assert.equal(ended.length, 1);
    assert.equal(ended[0].reason, 'triage_done');
    // 收尾即停表：角色实例跨会话复用，残留的表会在下一趟巡视里以陌生 epoch 开火（伪自愈 / 伪收尾）。
    assert.equal(timers.pendingCount, 0, '显式终止收尾后 MUST NOT 留下计时器');
    timers.advance(STALL_MS * 5);
    assert.equal(ended.length, 1, '巡视已结束，计时器不得再收尾一次');
    assert.equal(ctx.excursionActive, false);
  });

  it('计时器不跨场：unsubscribe 后推进时钟零事件（瞬时态绝不残留）', () => {
    const { ctx, timers, resumer, openings, ended } = armedResumer();
    resumer.unsubscribe();
    assert.equal(timers.pendingCount, 0, 'unsubscribe MUST 清表');
    ctx.beginExcursion(2); // 即便有个新巡视在跑，旧表也不该误触它
    timers.advance(STALL_MS * 5);
    assert.deepEqual(openings, []);
    assert.deepEqual(ended, []);
  });

  it('生产默认值真的接上了：不注入时限时按 EXCURSION_STALL_TIMEOUT_MS 排表', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const timers = new FakeTimers();
    // 只注入定时器、**不**注入 stallTimeoutMs → 走生产默认。
    new ExcursionResumer(
      { ...opts(bus), setTimeoutFn: timers.set, clearTimeoutFn: timers.clear },
      ctx,
    ).subscribe();
    ctx.beginExcursion(1);
    bus.emit('excursion.requested', { epoch: 1, ts: 0 });
    assert.deepEqual(timers.scheduled, [EXCURSION_STALL_TIMEOUT_MS]);
  });
});

describe('通知巡视 — 收尾原因三态可区分（change guard-excursion-stall）', () => {
  it('分诊到尝试上限诚实放弃时，triage_done MUST 带出被放弃的分类', () => {
    const bus = new EventBus(); const ctx = new SessionContext();
    ctx.beginExcursion(1);
    new NotificationTriage({ ...opts(bus), maxAttemptsPerCategory: 1 }, ctx).subscribe();
    const done: { givenUp?: string[] }[] = [];
    bus.on('notification.triage_done', (p) => { done.push(p); });
    // 第 1 轮：选中 comments（用掉唯一一次尝试）。第 2 轮：仍有未读但已到上限 → 诚实放弃。
    bus.emit('notification.home.arrived', { comments: 2, likes: 0, follows: 0, ts: 0 });
    bus.emit('notification.home.arrived', { comments: 2, likes: 0, follows: 0, ts: 0 });
    assert.equal(done.length, 1);
    assert.deepEqual(done[0].givenUp, ['comments'], '被放弃的分类须随事件带出，不能只留在日志里');
  });

  it('三态原因值互不相同：清零 / 诚实放弃 / 停滞兜底', () => {
    const reasonFor = (emit: (bus: EventBus) => void): string => {
      const { bus, ended } = armedResumer();
      emit(bus);
      assert.equal(ended.length, 1);
      return ended[0].reason;
    };
    const cleared = reasonFor((bus) => bus.emit('notification.triage_done', { epoch: 1, ts: 0 }));
    const gaveUp = reasonFor((bus) =>
      bus.emit('notification.triage_done', { epoch: 1, givenUp: ['comments', 'likes'], ts: 0 }));

    const stalled = (() => {
      const { bus, timers, ended } = armedResumer();
      timers.advance(STALL_MS / 2);
      bus.emit('page.cards.arrived', { cards: [], ts: 0 }); // 违规输入落窗口中段
      timers.advance(STALL_MS / 2); // 自愈
      timers.advance(STALL_MS); // 收尾
      assert.equal(ended.length, 1);
      return ended[0].reason;
    })();

    assert.equal(cleared, 'triage_done');
    assert.equal(gaveUp, 'triage_incomplete:comments,likes');
    assert.ok(stalled.startsWith('stalled_no_progress'));
    assert.equal(new Set([cleared, gaveUp, stalled]).size, 3, '三态 MUST NOT 压成一态');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// change route-notification-items-by-category：评论管线的入口按类别路由
//
// 守的是已上线要求「点赞、收藏、新增关注 MUST NOT 发飞书」。此前挡住它的不是这条类别禁令，而是分类器里
// 一条按正文文案写的正则——因为 `notification.items` 是**共用**上报通道：赞收藏 / 新增关注两栏在清未读
// 回执之外顺带回传的发送者条目（喂通知联系人名册用）与评论栏抽取的评论项走同一条，而云端无条件把它们
// 当评论抽取结果跑评论管线（dev 2026-08-05 15:29 实测：从没选过 comments，却出现「分类 comments 处理完」）。
// ─────────────────────────────────────────────────────────────────────────────

/** 一批「赞和收藏」栏顺带回传的发送者条目（现网执行端就长这样：kind 由命令类别推导）。 */
const LIKE_LANE_ITEMS: NotificationItem[] = [
  { kind: 'like', fromUser: '小明', content: '这家店的红烧肉真的绝了', itemKey: 'n1' },
  { kind: 'collect', fromUser: '小红', content: '周末去哪儿玩｜十条小众路线', itemKey: 'n2' },
];

describe('通知巡视 — 评论管线入口按类别路由（change route-notification-items-by-category）', () => {
  it('纯判据·喂违规输入：只有云端点名评论栏的批次才进评论管线', () => {
    // 违规输入 ①：云端点名的是赞收藏栏 —— 正文完全不长成任何已知固定说法（正文正则拦不住它）。
    assert.deepEqual(
      routeNotificationBatch({ selectedCategory: 'likes', items: LIKE_LANE_ITEMS }),
      { lane: 'contacts_only', reason: 'category_not_comments', kindDisagreement: false },
    );
    // 违规输入 ②：新增关注栏同理。
    assert.equal(
      routeNotificationBatch({ selectedCategory: 'follows', items: [{ kind: 'follow', fromUser: 'u', content: '' }] }).lane,
      'contacts_only',
    );
    // 违规输入 ③：本趟一栏都还没选过 —— 「不知道」MUST NOT 被当成「是评论栏」。
    assert.deepEqual(
      routeNotificationBatch({ selectedCategory: null, items: LIKE_LANE_ITEMS }),
      { lane: 'contacts_only', reason: 'category_unselected', kindDisagreement: false },
    );
    // 合法输入：点名评论栏 → 进管线。空批也进（空批要走到 deduper 才收得了尾，见下一条用例）。
    assert.deepEqual(
      routeNotificationBatch({ selectedCategory: 'comments', items: [{ kind: 'comment', fromUser: 'a', content: 'x' }] }),
      { lane: 'comment_pipeline', kindDisagreement: false },
    );
    assert.deepEqual(
      routeNotificationBatch({ selectedCategory: 'comments', items: [] }),
      { lane: 'comment_pipeline', kindDisagreement: false },
    );
  });

  it('纯判据·两个方向的打架都必须报出来（MUST NOT 静默取其一）', () => {
    // 正向：点名的不是评论栏，却混进了评论/@ 类型。
    assert.equal(
      routeNotificationBatch({
        selectedCategory: 'likes',
        items: [{ kind: 'like', fromUser: 'a', content: 'x' }, { kind: 'comment', fromUser: 'b', content: 'y' }],
      }).kindDisagreement,
      true,
    );
    // 反向：点名了评论栏，可这批（非空）里一条评论/@ 都没有。
    assert.equal(
      routeNotificationBatch({ selectedCategory: 'comments', items: LIKE_LANE_ITEMS }).kindDisagreement,
      true,
    );
    // 空批不算打架（没有任何条目可与之矛盾）。
    assert.equal(routeNotificationBatch({ selectedCategory: 'comments', items: [] }).kindDisagreement, false);
    // 未知 kind（执行端版本漂移 / 脏数据）恒不算评论 → 在非评论栏上不制造假打架。
    assert.equal(
      routeNotificationBatch({
        selectedCategory: 'likes',
        items: [{ kind: 'brand_new_kind' as NotificationItem['kind'], fromUser: 'a', content: 'x' }],
      }).kindDisagreement,
      false,
    );
  });

  it('承重·赞和收藏栏的旁路条目 MUST NOT 进评论管线（不分类/不去重/不发飞书/不收尾 comments）', async () => {
    const bus = new EventBus(); const ctx = new SessionContext();
    ctx.beginExcursion(1);
    const feishu: NotificationItem[][] = [];
    new NotificationTriage(opts(bus), ctx).subscribe();
    new NotificationLikeBrowser(opts(bus), ctx).subscribe();
    new NotificationClassifier(opts(bus), ctx).subscribe();
    new NotificationDeduper(opts(bus), ctx).subscribe();
    new NotificationNotifier({ ...opts(bus), notify: async (items) => { feishu.push(items); } }, ctx).subscribe();
    const classified: unknown[] = []; const worthy: unknown[] = []; const handled: string[] = [];
    bus.on('notification.classified', (p) => { classified.push(p); });
    bus.on('notification.worthy', (p) => { worthy.push(p); });
    bus.on('notification.category_handled', (p) => { handled.push(p.category); });

    // 云端自己点名看「赞和收藏」（经真分诊，不是测试里手写状态）。
    bus.emit('notification.home.arrived', { comments: 0, likes: 46, follows: 0, ts: Date.now() });
    assert.equal(ctx.excursionSelectedCategory, 'likes', '分诊选中的那一栏 MUST 记进巡视状态');

    // 执行端在清未读回执之外顺带回传发送者条目 —— 正是 dev 实测那一批。
    bus.emit('notification.items.arrived', { items: LIKE_LANE_ITEMS, ts: Date.now() });
    await tick();

    assert.deepEqual(classified, [], 'MUST NOT 被分类');
    assert.deepEqual(worthy, [], 'MUST NOT 被去重后当作新项');
    assert.deepEqual(feishu, [], '已上线红线：赞/收藏 MUST NOT 发飞书');
    assert.deepEqual(handled, [], 'MUST NOT 产生任何收尾事件（尤其不是 comments）');
  });

  it('反向闸·评论栏的空批次仍正常收尾该类（别把重复那条去掉后反而一次都收不了尾）', () => {
    const bus = new EventBus(); const ctx = new SessionContext();
    ctx.beginExcursion(1);
    new NotificationTriage(opts(bus), ctx).subscribe();
    new NotificationClassifier(opts(bus), ctx).subscribe();
    new NotificationDeduper(opts(bus), ctx).subscribe();
    const handled: string[] = [];
    bus.on('notification.category_handled', (p) => { handled.push(p.category); });

    bus.emit('notification.home.arrived', { comments: 3, likes: 0, follows: 0, ts: Date.now() });
    assert.equal(ctx.excursionSelectedCategory, 'comments');
    bus.emit('notification.items.arrived', { items: [], ts: Date.now() }); // 评论栏真的一条都没有

    assert.deepEqual(handled, ['comments'], '「评论栏真的没有」与「这批不是评论栏来的」是两态：前者仍要收尾本类');
  });

  it('单写者·分诊换一栏即改写，巡视结束即清空（陈旧值 MUST NOT 给下一批定性）', () => {
    const bus = new EventBus(); const ctx = new SessionContext();
    ctx.beginExcursion(1);
    new NotificationTriage(opts(bus), ctx).subscribe();
    assert.equal(ctx.excursionSelectedCategory, null, '开场未选任何栏');
    bus.emit('notification.home.arrived', { comments: 1, likes: 1, follows: 0, ts: Date.now() });
    assert.equal(ctx.excursionSelectedCategory, 'comments');
    bus.emit('notification.home.arrived', { comments: 0, likes: 1, follows: 0, ts: Date.now() });
    assert.equal(ctx.excursionSelectedCategory, 'likes', '换栏即改写');
    ctx.endExcursion();
    assert.equal(ctx.excursionSelectedCategory, null, '巡视结束 MUST 清空');
  });
});

describe('通知巡视 — 赞和收藏一轮端到端（假边缘，复刻 dev 2026-08-05 15:29）', () => {
  it('红线自检：likes 恰好收尾一次、comments 零次、返回导航恰好一条，且零飞书', async () => {
    const commands: EdgeCommand[] = [];
    const feishuSent: NotificationItem[][] = [];
    const handled: string[] = [];
    let homeRound = 0;
    let d: RoleDispatcher;
    const sendCommand = (cmd: EdgeCommand): void => {
      commands.push(cmd);
      if (cmd.action === 'open_notifications' || cmd.action === 'notification_back_home') {
        const home = homeRound === 0 ? { comments: 0, likes: 46, follows: 0 } : { comments: 0, likes: 0, follows: 0 };
        homeRound++;
        setTimeout(() => d.bus.emit('notification.home.arrived', { ...home, ts: Date.now() }), 0);
      } else if (cmd.action === 'browse_notification_likes') {
        // 执行端的真实顺序：先顺带回传发送者条目，再回「已看过」的动作回执。
        setTimeout(() => {
          d.bus.emit('notification.items.arrived', { items: LIKE_LANE_ITEMS, ts: Date.now() });
          d.bus.emit('action.completed', { action: 'browse_notification_likes', ok: true, ts: Date.now() });
        }, 0);
      }
    };
    d = new RoleDispatcher({
      soul: mockSoul,
      llm: { complete: async () => '' },
      sendCommand,
      notifyComments: async (items) => { feishuSent.push(items); },
    });
    d.setup(); d.startSession();
    d.bus.on('notification.category_handled', (p) => { handled.push(p.category); });

    let resumed = false;
    d.bus.on('feed.entered', (p) => { if (p.trigger === 'back_to_feed') resumed = true; });
    d.bus.emit('notification.detected.arrived', { epoch: 1, ts: Date.now() });
    for (let i = 0; i < 12 && !resumed; i++) await tick();

    assert.ok(resumed, '巡视仍须正常收尾回信息流');
    assert.deepEqual(feishuSent, [], '赞/收藏 MUST NOT 发飞书');
    assert.deepEqual(handled, ['likes'], 'likes 恰好收尾一次（靠它自己的回执），comments 一次都不该有');
    assert.equal(
      commands.filter((c) => c.action === 'notification_back_home').length, 1,
      '重复收尾会多发一条返回导航；去掉重复那条后仍 MUST 恰好发一条（不是零条）',
    );
    assert.equal(
      commands.filter((c) => c.action === 'browse_notification_comments').length, 0,
      '从没选过评论栏，MUST NOT 下发评论栏浏览命令',
    );
    d.endSession();
  });
});
