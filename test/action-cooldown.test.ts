import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionCooldownGate, COOLDOWN_MS } from '../src/risk/action-cooldown.js';

// change account-nurture-discipline-spine §4.1：重启冷启动静默期——冷却是内存态、重启即清零，
// 若无静默期则重启瞬间每账号每类互动「无历史→放行」可 burst。静默窗内暂抑制无历史互动。

const START = 1_000_000;
const QUIET = 180_000; // 3min

test('静默期内：无历史互动被抑制（防重启 burst）', () => {
  const g = new ActionCooldownGate({ startedAtMs: START, restartQuietMs: QUIET });
  // 刚重启（now=START）→ 四类互动都无历史 → 全被静默窗抑制，绝不 burst
  assert.equal(g.canAct('a', 'like', START), false);
  assert.equal(g.canAct('a', 'comment', START), false);
  assert.equal(g.canAct('a', 'collect', START + QUIET - 1), false); // 窗口末刻仍抑制
});

test('静默期过：无历史互动恢复放行', () => {
  const g = new ActionCooldownGate({ startedAtMs: START, restartQuietMs: QUIET });
  assert.equal(g.canAct('a', 'like', START + QUIET), true); // 窗口结束即放行
  assert.equal(g.canAct('a', 'comment', START + QUIET + 1), true);
});

test('静默期关闭（restartQuietMs=0）：无历史立即放行（零回归）', () => {
  const g = new ActionCooldownGate({ startedAtMs: START, restartQuietMs: 0 });
  assert.equal(g.canAct('a', 'like', START), true);
  assert.equal(g.canAct('a', 'comment', START), true);
});

test('缺省构造（无 options）：静默期关闭，历史行为不变', () => {
  const g = new ActionCooldownGate();
  assert.equal(g.canAct('a', 'like', Date.now()), true);
});

test('既有冷却语义不受静默期影响：markActed 后按最小间隔', () => {
  const g = new ActionCooldownGate({ startedAtMs: START, restartQuietMs: QUIET });
  // 账号在静默期内真实成功一次（例如手动/审批路径）→ 有历史后走正常冷却，不再被静默窗拦
  g.markActed('a', 'like', START + 1000);
  assert.equal(g.canAct('a', 'like', START + 1000), false); // 未到 like 冷却(2min)
  assert.equal(g.canAct('a', 'like', START + 1000 + COOLDOWN_MS.like), true); // 到冷却 → 放行
});

test('静默期按账号隔离 + 只压受冷却的四类互动', () => {
  const g = new ActionCooldownGate({ startedAtMs: START, restartQuietMs: QUIET });
  // 账号 a 已有 follow 历史 → 走正常冷却（未到 → false）；账号 b 无历史 → 静默期抑制
  g.markActed('a', 'follow', START - COOLDOWN_MS.follow + 1000); // 快到但未到
  assert.equal(g.canAct('a', 'follow', START), false); // 正常冷却未到
  assert.equal(g.canAct('a', 'follow', START - COOLDOWN_MS.follow + 1000 + COOLDOWN_MS.follow), true);
  assert.equal(g.canAct('b', 'follow', START), false); // 静默期抑制无历史
});
