import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RiskController,
  coldStartDailyCap,
  deriveWindowQuotas,
  deriveWindowQuotasFromDaily,
  minWindowQuotas,
  scaleWindowQuotas,
  zeroInteractionQuotas,
} from '../src/risk/index.js';
import type { RiskQuotaLevel, RiskState, RiskStatus } from '../src/risk/index.js';

// change disable-account-age-coldstart-ramp：账号年龄冷启动爬坡降级为 **opt-in（默认关）**。
// 缺省不叠冷启动 clamp，effectiveQuotas 直接走安全限额配置（见文件末「默认关」用例）。
// 下列「启用态」用例显式传 coldStartRampEnabled: true——机制作为 opt-in 保留、仍受测：
// effectiveQuotas = min(账号年龄冷启动天花板, 风控缩放配额)，锁 min 语义、FB 更保守曲线、
// 毕业回落、旁路零回归——全部脱真机、桩注入 createdAt。

const DAY = 86_400_000;
const NOW = 1_000_000_000_000;

const state = (status: RiskStatus, quotaLevel: RiskQuotaLevel): RiskState => ({
  accountId: 't',
  status,
  quotaLevel,
  signalCount: 0,
  lastSignalAt: null,
  statusSince: 0,
  updatedAt: 0,
});

/** createdAt 使账号刚好落在冷启动第 (n) 天（nurture-day = floor(ageDays)+1）。 */
const createdAtForDay = (nurtureDay: number): number => NOW - ((nurtureDay - 1) * DAY + 1000);

test('新号 Day1（normal 档，opt-in）被压到冷启动天花板，绝不吃满 normal 档', () => {
  const c = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW, createdAt: NOW, coldStartRampEnabled: true });
  const q = c.effectiveQuotas();
  // 小红书冷启动 Day1 天花板：view≤50 / like≤3 / comment=0 → 与 normal（view150/like50/comment8）逐位取 min。
  assert.equal(q.day.view, 50);
  assert.equal(q.day.like, 3);
  assert.equal(q.day.comment, 0);
  assert.ok(q.day.like < deriveWindowQuotas('normal').day.like, '绝不发满 normal 点赞额');
});

test('warned + 年轻号（opt-in）：effectiveQuotas = min(warned 缩放, 冷启动天花板)，两闸同时生效', () => {
  const c = new RiskController({ initialState: state('warned', 'aggressive'), clock: () => NOW, createdAt: NOW, coldStartRampEnabled: true });
  const warnedScaled = scaleWindowQuotas(deriveWindowQuotas('conservative'), 0.7);
  const coldDay1 = deriveWindowQuotasFromDaily(coldStartDailyCap(0)!);
  assert.deepEqual(c.effectiveQuotas(), minWindowQuotas(warnedScaled, coldDay1));
});

test('毕业号（opt-in，账号年龄超冷启动窗口 7 天）：无 clamp，逐位回落风控缩放', () => {
  const c = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW, createdAt: NOW - 8 * DAY, coldStartRampEnabled: true });
  assert.deepEqual(c.effectiveQuotas(), deriveWindowQuotas('normal'));
});

test('旁路关（coldStartRampEnabled=false）+ 年轻号：逐位零回归，直接走安全限额', () => {
  const c = new RiskController({
    initialState: state('normal', 'normal'),
    clock: () => NOW,
    createdAt: NOW,
    coldStartRampEnabled: false,
  });
  assert.deepEqual(c.effectiveQuotas(), deriveWindowQuotas('normal'));
});

test('无 createdAt（opt-in 也不叠）：不叠冷启动（零回归，兼容既有 controller 构造）', () => {
  const c = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW, coldStartRampEnabled: true });
  assert.deepEqual(c.effectiveQuotas(), deriveWindowQuotas('normal'));
});

test('Facebook 曲线比小红书更保守（opt-in）：FB Day1 只浏览+极少赞、无评论无发布', () => {
  const xhs = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW, createdAt: NOW, coldStartRampEnabled: true });
  const fb = new RiskController({
    initialState: state('normal', 'normal'),
    clock: () => NOW,
    createdAt: NOW,
    platform: 'facebook',
    coldStartRampEnabled: true,
  });
  assert.equal(fb.effectiveQuotas().day.like, 2); // FB Day1 like≤2 < 小红书 3
  assert.ok(fb.effectiveQuotas().day.like < xhs.effectiveQuotas().day.like);
  assert.equal(fb.effectiveQuotas().day.comment, 0);
  assert.equal(fb.effectiveQuotas().day.publish, 0);
});

test('Facebook Day5 才放开少量发布/加组（opt-in）', () => {
  const fb = new RiskController({
    initialState: state('normal', 'normal'),
    clock: () => NOW,
    createdAt: createdAtForDay(5),
    platform: 'facebook',
    coldStartRampEnabled: true,
  });
  const q = fb.effectiveQuotas();
  assert.equal(q.day.publish, 1); // min(normal publish 1, FB Day5 publish≤1)
  assert.equal(q.day.join_group, 2); // min(normal join 3, FB Day5 join≤2)
});

test('min 语义绝不抬高（opt-in）：restricted 清零的互动配额不被冷启动天花板抬起', () => {
  const c = new RiskController({ initialState: state('restricted', 'normal'), clock: () => NOW, createdAt: NOW, coldStartRampEnabled: true });
  const q = c.effectiveQuotas();
  assert.equal(q.day.like, 0);
  assert.equal(q.day.comment, 0);
  const restrictedView = zeroInteractionQuotas(deriveWindowQuotas('conservative')).day.view;
  assert.equal(q.day.view, Math.min(restrictedView, coldStartDailyCap(0)!.view));
});

test('冷启动天花板确定性（opt-in）：同一账号多次 effectiveQuotas 稳定不抖动（非随机采样）', () => {
  const c = new RiskController({
    initialState: state('normal', 'normal'),
    clock: () => NOW,
    createdAt: NOW,
    platform: 'facebook',
    coldStartRampEnabled: true,
  });
  assert.deepEqual(c.effectiveQuotas(), c.effectiveQuotas());
});

// change disable-account-age-coldstart-ramp 核心：默认关（不 opt-in）时，年轻号直接走安全限额配置，
// 浏览不再被冷启动第 7 天的 70 压低——这正是用户要的「走安全里面的浏览配额」。
test('默认关（未传 coldStartRampEnabled）：年轻 FB aggressive 号走安全 view 配额、不再被 70 压', () => {
  const fbDay7 = new RiskController({
    initialState: state('normal', 'aggressive'),
    clock: () => NOW,
    createdAt: createdAtForDay(7),
    platform: 'facebook',
  });
  const q = fbDay7.effectiveQuotas();
  // 安全限额 aggressive 写死默认 view=300；绝不被冷启动 FB Day7 的 70 压低。
  assert.deepEqual(q, deriveWindowQuotas('aggressive'));
  assert.equal(q.day.view, deriveWindowQuotas('aggressive').day.view);
  assert.notEqual(q.day.view, 70);
  assert.ok(q.day.view > 70, '默认关：新号浏览额不再被冷启动 70 封顶');
});

test('默认关：小红书年轻号（Day1）也直接走安全 normal 配额、不被 Day1 天花板压', () => {
  const xhsDay1 = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW, createdAt: NOW });
  assert.deepEqual(xhsDay1.effectiveQuotas(), deriveWindowQuotas('normal'));
});
