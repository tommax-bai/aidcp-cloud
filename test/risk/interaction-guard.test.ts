/**
 * 同账号并行（N:1）互动去重闸单测（multi-account-node-support D7②）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InteractionGuard, InteractionGuardRegistry, isGuardedInteraction } from '../../src/risk/interaction-guard.js';

test('keyFor：按目标取键（like/collect/comment→note，follow→author，comment_like→note+anchor）', () => {
  assert.equal(InteractionGuard.keyFor('like', { noteId: 'n1' }), 'like::n1');
  assert.equal(InteractionGuard.keyFor('collect', { noteId: 'n1' }), 'collect::n1');
  assert.equal(InteractionGuard.keyFor('comment', { noteId: 'n1' }), 'comment::n1');
  assert.equal(InteractionGuard.keyFor('follow', { authorId: 'a1' }), 'follow::a1');
  assert.equal(InteractionGuard.keyFor('comment_like', { noteId: 'n1', commentAnchorId: 'c9' }), 'comment_like::n1::c9');
  // 缺目标 → null（调用方放行、不去重，绝不静默吞）
  assert.equal(InteractionGuard.keyFor('like', {}), null);
  assert.equal(InteractionGuard.keyFor('follow', { noteId: 'n1' }), null);
});

test('isGuardedInteraction 仅认 5 类互动动作', () => {
  for (const a of ['like', 'collect', 'follow', 'comment', 'comment_like']) assert.equal(isGuardedInteraction(a), true);
  for (const a of ['scroll', 'back', 'open_note', 'session.end']) assert.equal(isGuardedInteraction(a), false);
});

test('tryClaim：同目标第二次占坑被拒（in-flight 窗口），key=null 放行不去重', () => {
  const g = new InteractionGuard();
  assert.equal(g.tryClaim('like::n1'), true); // 首次占坑
  assert.equal(g.tryClaim('like::n1'), false); // 已在途 → 拒（第二节点跳过）
  assert.equal(g.tryClaim('like::n2'), true); // 不同目标互不影响
  assert.equal(g.tryClaim(null), true); // 缺目标键 → 不去重
  assert.equal(g.tryClaim(null), true);
});

test('complete：成功后记已完成，对同目标后续动作仍拒（本进程内不重复）', () => {
  const g = new InteractionGuard();
  assert.equal(g.tryClaim('follow::a1'), true);
  g.complete('follow::a1');
  assert.equal(g.tryClaim('follow::a1'), false); // 已完成 → 拒
});

test('releaseFailed：失败仅释放在途坑、不记已完成，允许后续重试', () => {
  const g = new InteractionGuard();
  assert.equal(g.tryClaim('comment::n1'), true);
  g.releaseFailed('comment::n1');
  assert.equal(g.tryClaim('comment::n1'), true); // 失败已释放 → 可重试
});

test('TTL 自动释放在途坑（防回执丢失永久占坑）', () => {
  const fires: Array<() => void> = [];
  const g = new InteractionGuard({
    setTimerImpl: (cb) => {
      fires.push(cb);
      return { clear: () => {} };
    },
  });
  assert.equal(g.tryClaim('like::n1'), true);
  assert.equal(g.tryClaim('like::n1'), false); // 在途
  fires.forEach((f) => f()); // 模拟 TTL 到点
  assert.equal(g.tryClaim('like::n1'), true); // 在途坑已释放 → 可再占
});

test('Registry：同账号共用一个 guard（共享 in-flight/completed），不同账号互不影响', () => {
  const reg = new InteractionGuardRegistry();
  const a1 = reg.forAccount('A');
  const a2 = reg.forAccount('A');
  const b = reg.forAccount('B');
  assert.equal(a1, a2); // 同账号 N 连接 → 同一 guard 实例
  assert.notEqual(a1, b);
  // 同账号两节点撞同一笔记：第一节点占坑，第二节点（同 guard）被拒 → 只下发一次。
  assert.equal(a1.tryClaim('like::n1'), true);
  assert.equal(a2.tryClaim('like::n1'), false);
  // 不同账号互不串：B 对同一笔记仍可占坑。
  assert.equal(b.tryClaim('like::n1'), true);
});
