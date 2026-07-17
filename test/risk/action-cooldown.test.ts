/**
 * 动作冷却闸单测（change engagement-restraint；不变量断言加于 cooldown-as-backstop-not-quota）。
 * 按账号按动作隔离 + 注入假时钟下「未到点抑制 / 恰好到点放行 / 过点放行」+ 真实成功才起算。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionCooldownGate, COOLDOWN_ACTIONS, COOLDOWN_MS } from '../../src/risk/action-cooldown.js';
import { HOUR_BURST_CAP, MINUTE_BURST_CAP } from '../../src/risk/quotas.js';

const T0 = 1_000_000; // 任意基准时刻（毫秒）

test('从未成功过 → 放行（无历史不拦）', () => {
  const g = new ActionCooldownGate();
  assert.equal(g.canAct('default', 'like', T0), true);
  assert.equal(g.canAct('default', 'follow', T0), true);
});

test('markActed 后未到间隔被抑制、恰好到点放行、过点放行', () => {
  const g = new ActionCooldownGate();
  g.markActed('default', 'like', T0);
  // 间隔内（差 1ms）→ 抑制
  assert.equal(g.canAct('default', 'like', T0 + COOLDOWN_MS.like - 1), false);
  // 恰好到点（>= 边界）→ 放行
  assert.equal(g.canAct('default', 'like', T0 + COOLDOWN_MS.like), true);
  // 过点 → 放行
  assert.equal(g.canAct('default', 'like', T0 + COOLDOWN_MS.like + 5_000), true);
});

test('动作类型之间互不冷却（like 冷却不拦 collect/follow/comment）', () => {
  const g = new ActionCooldownGate();
  g.markActed('default', 'like', T0);
  assert.equal(g.canAct('default', 'like', T0 + 1_000), false); // like 在冷却
  assert.equal(g.canAct('default', 'collect', T0 + 1_000), true);
  assert.equal(g.canAct('default', 'follow', T0 + 1_000), true);
  assert.equal(g.canAct('default', 'comment', T0 + 1_000), true);
});

test('账号之间互不影响', () => {
  const g = new ActionCooldownGate();
  g.markActed('accA', 'like', T0);
  assert.equal(g.canAct('accA', 'like', T0 + 1_000), false); // A 在冷却
  assert.equal(g.canAct('accB', 'like', T0 + 1_000), true); // B 不受 A 影响
});

test('各动作冷却时长：四动作统一 15s（兜底值，非数量闸）', () => {
  assert.equal(COOLDOWN_MS.like, 15_000);
  assert.equal(COOLDOWN_MS.collect, 15_000);
  assert.equal(COOLDOWN_MS.follow, 15_000);
  assert.equal(COOLDOWN_MS.comment, 15_000);
});

// 守卫：下面几条不变量断言都以 COOLDOWN_ACTIONS 为循环源 ⇒ 该集合若为空，它们会**静默全过**。
// 这条钉住它非空、且与 COOLDOWN_MS 同构（它也是 quota-config-store 夹 cap 的作用域来源）。
test('COOLDOWN_ACTIONS 与 COOLDOWN_MS 同构且非空（防不变量断言空转）', () => {
  assert.deepEqual([...COOLDOWN_ACTIONS].sort(), ['collect', 'comment', 'follow', 'like']);
  assert.equal(COOLDOWN_ACTIONS.length, Object.keys(COOLDOWN_MS).length);
});

// ── 🔴 不变量回归（change cooldown-as-backstop-not-quota）────────────────────────────────
// **兜底必须比主闸松。** 冷却是兜底（只防意外爆发），风控配额是主闸（单独负责数量）。
// 冷却若在任一窗口上比主闸紧，就顶替了主闸：运营调大该窗口配额会「行为纹丝不动、无日志、无告警」。
// 改判前四动作全部违反（comment 30min 的最大速率恰＝小时配额 2/h，把那个旋钮焊死）。
//
// 这条断言**就是不变量本身**——typecheck 抓不到（都是裸 number），只有它守得住。
// 谁把某个冷却值调大到越过上界，这里当场红。别为了让它过而删它或放宽算式。
//
// 动作全集取自源码导出的 COOLDOWN_ACTIONS（＝COOLDOWN_MS 的键），不在测试里手写字面量数组——
// 手写的话，将来给 COOLDOWN_MS 加第五个动作时这里会**静默漏掉它**，不变量对新动作形同虚设。

test('不变量：冷却 ≤ 分钟窗上界（60s ÷ MINUTE_BURST_CAP）——主闸的分钟旋钮必须拧得动', () => {
  for (const action of COOLDOWN_ACTIONS) {
    const cap = MINUTE_BURST_CAP[action];
    const upperBoundMs = 60_000 / cap; // like 15s / collect 20s / follow 60s / comment 60s
    assert.ok(
      COOLDOWN_MS[action] <= upperBoundMs,
      `${action}: 冷却 ${COOLDOWN_MS[action]}ms 超过分钟窗上界 ${upperBoundMs}ms（60s ÷ cap ${cap}）` +
        ` ⇒ 兜底比主闸严、分钟配额旋钮被焊死`,
    );
  }
});

test('不变量：冷却 ≤ 小时窗上界（3600s ÷ HOUR_BURST_CAP）', () => {
  for (const action of COOLDOWN_ACTIONS) {
    const cap = HOUR_BURST_CAP[action];
    const upperBoundMs = 3_600_000 / cap;
    assert.ok(
      COOLDOWN_MS[action] <= upperBoundMs,
      `${action}: 冷却 ${COOLDOWN_MS[action]}ms 超过小时窗上界 ${upperBoundMs}ms（3600s ÷ cap ${cap}）`,
    );
  }
});

// 分钟窗是四个冷却动作里**唯一**可能被冷却反超的窗口（cap 最紧）⇒ 也是取值路径唯一夹 cap 的窗口
// （quota-config-store.windowQuotasFor 只夹 perMinute，见那里的红线）。此测钉住这个「为什么只夹分钟」的前提：
// 分钟 cap 蕴含的速率若已比时/日 cap 紧，时/日窗就不可能成为 binding 的那一个。
test('前提：分钟 cap 蕴含的小时速率 ≥ 小时 cap（故只需夹 perMinute，不必夹 perHour）', () => {
  for (const action of COOLDOWN_ACTIONS) {
    assert.ok(
      MINUTE_BURST_CAP[action] * 60 >= HOUR_BURST_CAP[action],
      `${action}: 分钟 cap ${MINUTE_BURST_CAP[action]}/min（=${MINUTE_BURST_CAP[action] * 60}/h）` +
        ` 竟低于小时 cap ${HOUR_BURST_CAP[action]}/h ⇒ 小时窗可能反成 binding，需重新审视只夹 perMinute 的决定`,
    );
  }
});

test('15 的推导：15s ＝ 60s ÷ max(四动作分钟 cap)，即不焊死任何旋钮的最大统一值', () => {
  const maxCap = Math.max(...COOLDOWN_ACTIONS.map((a) => MINUTE_BURST_CAP[a]));
  assert.equal(maxCap, MINUTE_BURST_CAP.like, '最紧的那个应是 like（分钟 cap 最大 ⇒ 上界最小）');
  assert.equal(60_000 / maxCap, 15_000);
  // 取的就是上界（压线合格：冷却取等放行 + 配额半开窗 count>=quota 才拒 ⇒ c=L/q 时窗内恒 q-1<q ⇒ 配额可跑满）
  assert.equal(COOLDOWN_MS.like, 60_000 / maxCap);
});

test('再次 markActed 重置冷却窗（按最近一次真实成功计时）', () => {
  const g = new ActionCooldownGate();
  g.markActed('default', 'follow', T0);
  assert.equal(g.canAct('default', 'follow', T0 + COOLDOWN_MS.follow), true);
  // 在到点时又成功一次 → 冷却窗从新时刻重新起算
  g.markActed('default', 'follow', T0 + COOLDOWN_MS.follow);
  assert.equal(g.canAct('default', 'follow', T0 + COOLDOWN_MS.follow + 1_000), false);
});

test('remainingMs：冷却中返回剩余、到点返回 0', () => {
  const g = new ActionCooldownGate();
  g.markActed('default', 'comment', T0);
  assert.equal(g.remainingMs('default', 'comment', T0), COOLDOWN_MS.comment);
  // 探点取窗口内的相对位置（原写死 60_000 假设了 comment 冷却远大于 1min；统一 15s 后该假设不再成立）
  const midMs = Math.floor(COOLDOWN_MS.comment / 3);
  assert.equal(g.remainingMs('default', 'comment', T0 + midMs), COOLDOWN_MS.comment - midMs);
  assert.equal(g.remainingMs('default', 'comment', T0 + COOLDOWN_MS.comment), 0);
  assert.equal(g.remainingMs('default', 'comment', T0 + COOLDOWN_MS.comment + 99), 0); // 不为负
  assert.equal(g.remainingMs('default', 'comment', T0 + 60 * 60_000), 0); // 远过点也不为负
  // 无历史 → 0
  assert.equal(g.remainingMs('other', 'like', T0), 0);
});
