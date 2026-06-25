/**
 * 动作冷却闸单测（change engagement-restraint）。
 * 按账号按动作隔离 + 注入假时钟下「未到点抑制 / 恰好到点放行 / 过点放行」+ 真实成功才起算。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionCooldownGate, COOLDOWN_MS } from '../../src/risk/action-cooldown.js';

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

test('各动作冷却时长：like 2min / collect 5min / follow 10min / comment 30min', () => {
  assert.equal(COOLDOWN_MS.like, 2 * 60_000);
  assert.equal(COOLDOWN_MS.collect, 5 * 60_000);
  assert.equal(COOLDOWN_MS.follow, 10 * 60_000);
  assert.equal(COOLDOWN_MS.comment, 30 * 60_000);
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
  assert.equal(g.remainingMs('default', 'comment', T0 + 60_000), COOLDOWN_MS.comment - 60_000);
  assert.equal(g.remainingMs('default', 'comment', T0 + COOLDOWN_MS.comment), 0);
  assert.equal(g.remainingMs('default', 'comment', T0 + COOLDOWN_MS.comment + 99), 0); // 不为负
  // 无历史 → 0
  assert.equal(g.remainingMs('other', 'like', T0), 0);
});
