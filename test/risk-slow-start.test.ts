import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RiskController, coldStartDailyCap, deriveWindowQuotas } from '../src/risk/index.js';
import type {
  AccountNurtureProvider,
  ActionQuota,
  RiskQuotaLevel,
  RiskState,
  RiskStatus,
  WindowQuotas,
} from '../src/risk/index.js';
import { shanghaiDayStartMs } from '../src/time/shanghai-day.js';

// change account-level-slow-start：账号级慢启动（accounts.slow_start_since 非 NULL = 开且为起点）。
// 本文件锁 Phase 0 的六条不变量：同源同格 / 单调性 / 热加载现读 / 平台诚实 / 两路径不合成 / 全局停用闸。

const DAY = 86_400_000;
const NOW = 1_000_000_000_000;

const state = (status: RiskStatus, quotaLevel: RiskQuotaLevel): RiskState => ({
  accountId: 'acc-1',
  status,
  quotaLevel,
  signalCount: 0,
  lastSignalAt: null,
  statusSince: 0,
  updatedAt: 0,
});

/**
 * 可变的养号事实 provider 桩：模拟 AccountStore 的同步内存镜像（改值即被现读看到）。
 * **三个字段刻意都不给默认值**：默认值会把显式传入的 undefined 悄悄换成真平台，
 * 而「平台未知」正是本文件要测的一条闸——桩自己回落一次，那条测试就永远测不到东西。
 */
class NurtureStub implements AccountNurtureProvider {
  public completedAt: number | null = null;
  public facebookPolicy: { totalDays: number; dailyCaps: ActionQuota[] } = {
    totalDays: 7,
    dailyCaps: Array.from(
      { length: 7 },
      (_, index) => coldStartDailyCap(index, 'facebook')!,
    ),
  };

  constructor(
    public platform: string | undefined,
    public slowStartSince: number | null,
    public createdAt?: number,
  ) {}
  platformFor(): string | undefined {
    return this.platform;
  }
  slowStartSinceFor(): number | null {
    return this.slowStartSince;
  }
  slowStartCompletedAtFor(): number | null {
    return this.completedAt;
  }
  facebookSlowStartPolicy(): { totalDays: number; dailyCaps: ActionQuota[] } {
    return this.facebookPolicy;
  }
  createdAtFor(): number | undefined {
    return this.createdAt;
  }
}

const controllerAt = (nurture: AccountNurtureProvider, now: number, opts: {
  status?: RiskStatus;
  level?: RiskQuotaLevel;
  coldStartRampEnabled?: boolean;
  slowStartDisabled?: boolean;
  quotaProvider?: { windowQuotasFor: () => WindowQuotas };
} = {}) =>
  new RiskController({
    accountId: 'acc-1',
    initialState: state(opts.status ?? 'normal', opts.level ?? 'normal'),
    clock: () => now,
    nurtureProvider: nurture,
    coldStartRampEnabled: opts.coldStartRampEnabled,
    slowStartDisabled: opts.slowStartDisabled,
    quotaProvider: opts.quotaProvider,
  });

// ── 3.1 同源同格：投影的 day 与 clamp 实际用的 day 逐格相等 ──
// 「显示的 = 生效的」的守卫：徽章说 D7 而 clamp 已按 D8 放行，是本功能最难发现的谎。

test('同源同格：slowStartView().day 与 clamp 实际生效的天数逐格相等（day 1..8 + off）', () => {
  for (let day = 1; day <= 8; day += 1) {
    const since = NOW - ((day - 1) * DAY + 1000);
    const c = controllerAt(new NurtureStub('facebook', since), NOW);
    const view = c.slowStartView();
    // clamp 侧的真值：用同一天数直接查曲线，与 effectiveQuotas 的结果比对。
    const cap = coldStartDailyCap(day - 1, 'facebook');
    if (day > 7) {
      assert.equal(view.state, 'graduated', `第 ${day} 天应毕业`);
      assert.equal(cap, null, '第 8 天曲线应返回 null（毕业）');
      assert.deepEqual(c.effectiveQuotas(), deriveWindowQuotas('normal'), '毕业后逐位回落风控缩放');
    } else {
      assert.equal(view.state, 'active');
      assert.equal(view.day, day, `投影天数应为 ${day}`);
      assert.equal(c.effectiveQuotas().day.view, Math.min(deriveWindowQuotas('normal').day.view, cap!.view),
        `第 ${day} 天 clamp 必须按同一天的曲线生效`);
      if (day === 1) {
        assert.equal(c.effectiveQuotas().minute.view, 2, '环境级 FB 慢启动 D1 view=20/day 应按 /10 得到 2/minute');
      }
    }
  }
  // 关（slow_start_since = NULL）→ off，且不 clamp。
  const off = controllerAt(new NurtureStub('facebook', null), NOW);
  assert.equal(off.slowStartView().state, 'off');
  assert.deepEqual(off.effectiveQuotas(), deriveWindowQuotas('normal'));
});

// ── 3.2 单调性（不是「必变小」）──
// design D6：「必变小」在可编辑的 quota_config 下为假，而单测用写死默认三档会稳过
// ——那条守卫守不住它声称守的东西。这里只锁「逐位 ≤」，它在任何档位配置下都为真。

test('单调性：同一 controller 开启慢启动前后 effectiveQuotas() 逐位 ≤（绝不抬高任何一格）', () => {
  const nurture = new NurtureStub('facebook', null);
  const c = controllerAt(nurture, NOW, { level: 'aggressive' });
  const before = c.effectiveQuotas();
  nurture.slowStartSince = NOW; // D1
  const after = c.effectiveQuotas();
  for (const w of ['minute', 'hour', 'day'] as const) {
    for (const a of Object.keys(before[w]) as (keyof (typeof before)['day'])[]) {
      assert.ok(after[w][a] <= before[w][a], `${w}.${a} 开启慢启动后不得抬高（${before[w][a]} → ${after[w][a]}）`);
    }
  }
});

// ── 3.3 binding：勾了但没压时必须如实标注 ──
// 注意（实测偏离 tasks 3.3 的原假设）：XHS conservative + D5-7 的 binding 是 **true** 而非 false
// ——view/like/comment/publish 四项确实逐位不变，但 collect 10→5 / follow 5→3 / comment_like 3→2
// 三项真收紧了（design D6 自己的表就是这么写的）。binding 的定义是「至少收紧一项」，
// 故此档位下 binding=true 是正确答案：对一个 collect 额度被砍半的号说「不额外限制」是假话。
//
// binding=false 的真实可达场景是 D6 点名的那个：曲线写死、**档位数字面板可热编辑**，
// 两者之间没有任何不变量保证曲线更紧——运营把档位编辑得比曲线还严时，慢启动就一格都压不动。

test('binding=true：XHS conservative + D5-7 —— 四个头部动作纹丝不动，但 collect/follow/comment_like 真收紧', () => {
  const c = controllerAt(new NurtureStub('xiaohongshu', NOW - 5 * DAY), NOW, { level: 'conservative' });
  const base = deriveWindowQuotas('conservative').day;
  const eff = c.effectiveQuotas().day;
  // 头部四项逐位不变——这正是「验收 MUST NOT 用 XHS conservative 号看数字变没变」的原因。
  assert.equal(eff.view, base.view, 'view 不变（80 vs 曲线 120，档位更严）');
  assert.equal(eff.like, base.like, 'like 不变');
  assert.equal(eff.comment, base.comment, 'comment 不变');
  assert.equal(eff.publish, base.publish, 'publish 不变');
  // 但另外三项确实被曲线压低了 → binding 必须为 true（绝不能宣称「不额外限制」）。
  assert.ok(eff.collect < base.collect, 'collect 被曲线压低');
  assert.ok(eff.follow < base.follow, 'follow 被曲线压低');
  assert.ok(eff.comment_like < base.comment_like, 'comment_like 被曲线压低');
  assert.equal(c.slowStartView().binding, true, '有任一项收紧即 binding=true');
});

test('binding=false：档位被面板编辑得比曲线更严 → 一格都压不动，如实标注「不额外限制」', () => {
  // D6 的真实场景：quota_config 面板可热编辑，与写死的曲线之间没有任何不变量保证曲线更紧。
  const tight: WindowQuotas = {
    minute: { view: 1, like: 0, collect: 0, comment: 0, follow: 0, publish: 0, search: 0, comment_like: 0, join_group: 0, dm_reply: 0 },
    hour: { view: 1, like: 0, collect: 0, comment: 0, follow: 0, publish: 0, search: 0, comment_like: 0, join_group: 0, dm_reply: 0 },
    day: { view: 1, like: 0, collect: 0, comment: 0, follow: 0, publish: 0, search: 0, comment_like: 0, join_group: 0, dm_reply: 0 },
  };
  const c = controllerAt(new NurtureStub('facebook', NOW), NOW, { quotaProvider: { windowQuotasFor: () => tight } });
  const view = c.slowStartView();
  assert.equal(view.state, 'active');
  assert.equal(view.binding, false, '曲线一格都没压动 → binding=false');
  assert.deepEqual(c.effectiveQuotas(), tight, '逐位等于档位本身（慢启动没起任何作用）');
});

// ── 3.4 热加载：正对着「registry 的 controller Map 永不驱逐」──
// 这是本设计唯一真正消灭问题而非绕过问题的地方：provider 现读做对之后，
// 「Map 永不驱逐」从一个需要被绕开的坑变成一个不再相关的事实。

test('热加载：改 provider 值后，**同一个 controller 实例** 的 effectiveQuotas 立刻变（不重建、不重启）', () => {
  const nurture = new NurtureStub('facebook', null);
  const c = controllerAt(nurture, NOW, { level: 'aggressive' });
  assert.deepEqual(c.effectiveQuotas(), deriveWindowQuotas('aggressive'), '开启前：走档位');
  assert.equal(c.slowStartView().state, 'off');

  nurture.slowStartSince = NOW; // 模拟 setSlowStart 写库后刷镜像

  assert.equal(c.effectiveQuotas().day.view, 20, '同一实例立刻按 FB D1 曲线 clamp（view≤20）');
  assert.equal(c.slowStartView().state, 'active', '投影同步现读，无需重建 controller');
  assert.equal(c.slowStartView().day, 1);

  nurture.slowStartSince = null; // 取消勾选

  assert.deepEqual(c.effectiveQuotas(), deriveWindowQuotas('aggressive'), '关闭后立刻逐位回落');
  assert.equal(c.slowStartView().state, 'off');
});

test('Facebook 全局冷启动配置热加载：保留当前天数，立即采用新上限，缩短后当场毕业', () => {
  const nurture = new NurtureStub('facebook', NOW - 4 * DAY - 1000);
  const configuredCap = (view: number): ActionQuota => ({
    view,
    like: 1,
    collect: 0,
    comment: 0,
    follow: 0,
    publish: 0,
    search: 0,
    comment_like: 0,
    join_group: 0,
    dm_reply: 0,
  });
  nurture.facebookPolicy = {
    totalDays: 14,
    dailyCaps: Array.from({ length: 14 }, () => configuredCap(11)),
  };
  const controller = controllerAt(nurture, NOW, { level: 'aggressive' });

  assert.equal(controller.slowStartView().day, 5, '配置更新不重置锚点，仍是第 5 天');
  assert.equal(controller.effectiveQuotas().day.view, 11);

  nurture.facebookPolicy.dailyCaps[4] = configuredCap(13);
  assert.equal(controller.slowStartView().day, 5, '同一 controller 仍保留第 5 天');
  assert.equal(controller.effectiveQuotas().day.view, 13, '当前天新上限立即生效');

  nurture.facebookPolicy = {
    totalDays: 4,
    dailyCaps: nurture.facebookPolicy.dailyCaps.slice(0, 4),
  };
  assert.equal(controller.slowStartView().state, 'graduated', '总天数缩短到当前天之前应立即毕业');
  assert.deepEqual(
    controller.effectiveQuotas(),
    deriveWindowQuotas('aggressive'),
    '毕业后不应回落到编译期第 5 天上限',
  );
});

test('Facebook 粘滞毕业：延长总天数不会让已毕业环境重新进入冷启动', () => {
  const nurture = new NurtureStub('facebook', NOW - 9 * DAY - 1000);
  nurture.completedAt = NOW - 2 * DAY;
  nurture.facebookPolicy = {
    totalDays: 14,
    dailyCaps: Array.from({ length: 14 }, () => ({
      view: 1,
      like: 0,
      collect: 0,
      comment: 0,
      follow: 0,
      publish: 0,
      search: 0,
      comment_like: 0,
      join_group: 0,
      dm_reply: 0,
    })),
  };
  const controller = controllerAt(nurture, NOW, { level: 'aggressive' });

  assert.equal(controller.slowStartView().state, 'graduated');
  assert.equal(controller.slowStartView().totalDays, 14);
  assert.deepEqual(controller.effectiveQuotas(), deriveWindowQuotas('aggressive'));
});

// ── 3.5 platform 诚实闸（design D5）──

test('platform 未知：不 clamp + eligible=false + ineligibleReason=platform_unknown（绝不回落 XHS 曲线）', () => {
  const unknown = controllerAt(new NurtureStub(undefined, NOW), NOW);
  const offBaseline = controllerAt(new NurtureStub(undefined, null), NOW);
  assert.deepEqual(unknown.effectiveQuotas(), offBaseline.effectiveQuotas(), '平台未知时与不开慢启动逐位一致');
  assert.deepEqual(unknown.effectiveQuotas(), deriveWindowQuotas('normal'));
  const view = unknown.slowStartView();
  assert.equal(view.eligible, false);
  assert.equal(view.ineligibleReason, 'platform_unknown');
});

test('coldStartDailyCap：platform 未传 → null（不 clamp），绝不静默回落小红书曲线', () => {
  assert.equal(coldStartDailyCap(0), null, '平台未确认时不给天花板');
  assert.equal(coldStartDailyCap(0, 'xiaohongshu')!.view, 50);
  assert.equal(coldStartDailyCap(0, 'facebook')!.view, 20, 'FB D1 是 20 而非 XHS 的 50（差 2.5 倍）');
});

test('平台不支持（视频号，design D12）：eligible=false + ineligibleReason=platform_unsupported', () => {
  const c = controllerAt(new NurtureStub('wechat_channels', NOW), NOW);
  const view = c.slowStartView();
  assert.equal(view.eligible, false);
  assert.equal(view.ineligibleReason, 'platform_unsupported');
});

test('env 旁路不能绕过平台准入：视频号逐位保留风控配额且投影同样标记不支持', () => {
  const base = deriveWindowQuotas('normal');
  base.minute.dm_reply = 1;
  base.hour.dm_reply = 2;
  base.day.dm_reply = 5;
  const c = controllerAt(new NurtureStub('wechat_channels', null, NOW), NOW, {
    coldStartRampEnabled: true,
    quotaProvider: { windowQuotasFor: () => base },
  });
  assert.deepEqual(c.effectiveQuotas(), base);
  assert.ok(c.effectiveQuotas().day.comment > 0);
  assert.ok(c.effectiveQuotas().day.dm_reply > 0);
  assert.equal(c.slowStartView().eligible, false);
  assert.equal(c.slowStartView().ineligibleReason, 'platform_unsupported');
});

// ── 3.6 两路径不合成（design D4）──
// 合成一次就把 FB 车队夹回 view=70——正是 07-15 判为根因的那个上限。

test('两路径不合成：env 开 + 账号级开且起点不同 → 严格按账号级起点，绝不取 created_at', () => {
  const accountSince = NOW - 1000; // 账号级：今天勾的 → D1
  const createdAt = NOW - 6 * DAY; // env 路径若被采用 → D7（FB view=70，正是要避免的那个上限）
  const c = controllerAt(new NurtureStub('facebook', accountSince, createdAt), NOW, { coldStartRampEnabled: true, level: 'aggressive' });
  assert.equal(c.slowStartView().day, 1, '必须按账号级起点算 D1');
  assert.equal(c.effectiveQuotas().day.view, 20, 'FB D1 view≤20');
  assert.notEqual(c.effectiveQuotas().day.view, 70, '绝不落到 created_at 派生的 D7 上限');
});

test('env 旁路仍原样可用：账号级关 + AIDCP_COLDSTART_RAMP 开 → 按 created_at 现算（回滚拉杆不失效）', () => {
  const c = controllerAt(new NurtureStub('facebook', null, NOW - 6 * DAY), NOW, { coldStartRampEnabled: true, level: 'aggressive' });
  assert.equal(c.effectiveQuotas().day.view, 70, 'env 路径按 created_at → FB D7 view≤70（历史行为逐位保留）');
  // 但 env 旁路不是「账号级慢启动」——UI MUST NOT 把它显示成用户勾过的东西。
  assert.equal(c.slowStartView().state, 'off', 'env 旁路不冒充账号级开关');
});

test('env 旁路关（默认）+ 账号级关：逐位零回归', () => {
  const c = controllerAt(new NurtureStub('facebook', null, NOW), NOW, { level: 'aggressive' });
  assert.deepEqual(c.effectiveQuotas(), deriveWindowQuotas('aggressive'), '默认态与改动前逐位相同');
  assert.equal(c.slowStartView().state, 'off');
});

// ── 3.8 全局停用闸 ──

test('全局停用闸：AIDCP_SLOW_START_DISABLED → 无视账号级开关、全体不 clamp + reason=globally_disabled', () => {
  const c = controllerAt(new NurtureStub('facebook', NOW), NOW, { slowStartDisabled: true, level: 'aggressive' });
  assert.deepEqual(c.effectiveQuotas(), deriveWindowQuotas('aggressive'), '停用闸置真 → 一格都不 clamp');
  const view = c.slowStartView();
  assert.equal(view.eligible, false);
  assert.equal(view.ineligibleReason, 'globally_disabled');
});

test('全局停用闸也压过 env 旁路（止血就要止干净）', () => {
  const c = controllerAt(new NurtureStub('facebook', null, NOW), NOW, {
    slowStartDisabled: true,
    coldStartRampEnabled: true,
    level: 'aggressive',
  });
  assert.deepEqual(c.effectiveQuotas(), deriveWindowQuotas('aggressive'));
});

// ── 3.7 上海日对齐（design D2）──
// 起点若按墙钟算，dayIndex 与「今日进展」的上海自然日计数窗口不同相：23:50 勾选的号，
// 次日 23:51 会「计数没清零、上限凭空长一档」——一个打满的号在午夜前十分钟又能动。

test('上海日对齐：23:50 勾选 → 起点落当日 00:00，day 递增与上海自然日同相', () => {
  // 2026-07-17 23:50 Asia/Shanghai = 2026-07-17T15:50Z
  const at2350 = Date.UTC(2026, 6, 17, 15, 50);
  const since = shanghaiDayStartMs(at2350);
  assert.equal(since, Date.UTC(2026, 6, 16, 16, 0), '起点对齐到 2026-07-17 00:00 +08');

  const nurture = new NurtureStub('facebook', since);
  // 勾选当天整天算第 1 天。
  assert.equal(controllerAt(nurture, at2350, {}).slowStartView().day, 1, '23:50 当刻仍是第 1 天');
  // 次日 23:49（跨过上海午夜）→ 第 2 天；day 递增与计数窗口清零同时发生。
  const nextDay2349 = Date.UTC(2026, 6, 18, 15, 49);
  assert.equal(controllerAt(nurture, nextDay2349, {}).slowStartView().day, 2, '次日应为第 2 天');
  assert.equal(shanghaiDayStartMs(nextDay2349), since + DAY, 'day 递增与上海自然日边界同相');
});
