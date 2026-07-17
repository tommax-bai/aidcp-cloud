import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RiskController } from '../src/risk/risk-controller.js';

/**
 * 记账只记既成事实（change risk-record-actuated-facts）。
 *
 * `record()` 此前在写计数前再过一次 `canDo()`，不过就静默丢弃——而它的调用点全是**事后回执**
 * （边缘回报「我已在真实页面上做完了」之后才驱动）。拒绝记录一次真实动作，并不能把它变回没发生。
 *
 * **两个问题、两个答案**：返回值答「在不在策略内」（逐字不变，红线不变）；计数器答「发生过没有」（改为无条件写）。
 *
 * 注：本套件**全部**是新断言——改动前全仓 2440 条测试没有一条能区分「写了」和「没写」
 * （实测：打上补丁后全量零改测试全绿），故这里就是这个 change 唯一的机械保障。
 */

function makeController(overrides: Partial<ConstructorParameters<typeof RiskController>[0]> = {}) {
  let now = 0;
  const c = new RiskController({
    quotaLevel: 'normal',
    clock: () => now,
    minViewsForLikeRatio: 0,
    ...overrides,
  });
  return { c, advance: (ms: number) => { now += ms; } };
}

test('撞顶那一次：仍返 false，但事实已记下（求值顺序钉死）', async () => {
  // normal 档 comment 日配额 8、小时窗 2（max(1, min(4, ceil(8/4)))）。
  const { c, advance } = makeController();
  assert.equal(await c.record('comment'), true);
  advance(3_600_001); // 跨小时窗，只留当日计数
  assert.equal(await c.record('comment'), true);
  advance(3_600_001);
  // 此刻当日已 2 条、配额 8 ⇒ 仍允许
  assert.equal(c.counts().day.comment, 2);

  // 把当日配额耗尽
  for (let i = 0; i < 6; i += 1) {
    await c.record('comment');
    advance(3_600_001);
  }
  assert.equal(c.counts().day.comment, 8);
  assert.equal(c.canDo('comment'), false, '日配额已耗尽');

  // 第 9 次：动作**已经发生**（回执抵达），策略说不该 ⇒ 返 false，但必须记下
  const allowed = await c.record('comment');
  assert.equal(allowed, false, '返回值答「在不在策略内」——红线逐字不变');
  assert.equal(c.counts().day.comment, 9, '事实已记下：拒绝记录改变不了它已经发生');
});

test('先取判定再写：撞顶那次绝不能因为把自己算进去而翻成 true', async () => {
  // 若实现写反（先写后判），最后一次在额度内的 record 会把刚写的这笔算进 canDo ⇒ 返回值从 true 翻 false。
  const { c, advance } = makeController({ quotaLevel: 'conservative' }); // comment 日配额 3
  assert.equal(await c.record('comment'), true);
  advance(3_600_001);
  assert.equal(await c.record('comment'), true);
  advance(3_600_001);
  assert.equal(await c.record('comment'), true, '第 3 次仍在额度内（3/3）——先写后判会让它错误返回 false');
  advance(3_600_001);
  assert.equal(c.counts().day.comment, 3);
  assert.equal(await c.record('comment'), false, '第 4 次超额：返 false');
  assert.equal(c.counts().day.comment, 4, '但它真的发生了，故记下');
});

test('紧窗口的拒绝不得污染松窗口的账本（预算被打穿那条的直接断言）', async () => {
  // normal 档 join_group：日 3、小时 1（max(1, min(HOUR_BURST_CAP=2, ceil(3/4)=1))）。
  // 运营一小时内手动加 3 个群（手动绕过下发闸，但回执照样进 record）。
  const { c } = makeController();
  assert.equal(c.counts().day.join_group, 0);
  await c.record('join_group'); // 第 1 次：允许
  await c.record('join_group'); // 第 2 次：撞小时窗（1）⇒ 返 false
  await c.record('join_group'); // 第 3 次：同上
  assert.equal(
    c.counts().day.join_group,
    3,
    '三次真实点击、FB 收到三次申请 ⇒ 日计数必须是 3。改动前是 1——小时窗的拒绝把日账本毒了，' +
      '日闸据此以为还有 2 格、放行自动加群再打 2 次 ⇒ 当天真实 5 次 / 预算 3',
  );
});

test('被限（restricted）时：计数照写，返回仍 false，状态机纹丝不动', async () => {
  const { c } = makeController();
  await c.applySignal({ kind: 'confirmed' }); // 平台真信号 → restricted
  const before = c.getState();
  assert.equal(before.status, 'restricted');

  // 动作在飞行途中已经做完了，回执此刻才到
  const allowed = await c.record('collect');
  assert.equal(allowed, false, '被限 ⇒ 返 false（红线：被禁 record 返 false）');
  assert.equal(c.counts().day.collect, 1, '它已经发生了 ⇒ 记下（拦的是未来，不是过去）');

  const after = c.getState();
  assert.equal(after.status, 'restricted', '绝不自残：记账不推动状态机');
  assert.equal(after.signalCount, before.signalCount);
  assert.equal(after.lastSignalAt, before.lastSignalAt);
});

test('frozen 时同理：记账既不放行动作、也不销毁证据', async () => {
  const { c } = makeController();
  await c.applySignal({ kind: 'manual_freeze' });
  assert.equal(c.getState().status, 'frozen');
  assert.equal(await c.record('collect'), false);
  assert.equal(c.counts().day.collect, 1);
  assert.equal(c.getState().status, 'frozen', '状态不因记账而变');
});

test('零回归：额度内的动作，返回值与计数逐位不变', async () => {
  const { c } = makeController();
  assert.equal(await c.record('collect'), true);
  assert.equal(c.counts().day.collect, 1);
  assert.equal(c.canDo('collect'), true);
});

test('view 记账后点赞比例规则真正生效（此处的丢弃方向是反的：少记 view = 更宽松）', async () => {
  // likeRatioAllowsNextLike: views < minViewsForLikeRatio ⇒ 直接放行（整条规则被跳过）。
  // 故 view 被少记会跌破阈值、让规则失效 —— 诚实记 view 才让它真正开火。
  const { c } = makeController({ minViewsForLikeRatio: 10 });
  for (let i = 0; i < 10; i += 1) await c.record('view');
  assert.equal(c.counts().day.view, 10, 'view 如实累加');
  // 10 次浏览 ⇒ 比例规则开始生效：projected (0+1)/10 = 0.1 <= 0.35 ⇒ 仍允许
  assert.equal(c.canDo('like'), true);
  for (let i = 0; i < 4; i += 1) await c.record('like');
  // projected (4+1)/10 = 0.5 > 0.35 ⇒ 规则真的拦住了
  assert.equal(c.canDo('like'), false, '比例规则生效——改动前 view 若被丢到不足阈值，这条规则整个不开火');
});
