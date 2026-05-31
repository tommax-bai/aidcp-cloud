import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LikeCommandService } from '../src/comm/like-command.js';
import { SimplePlanner } from '../src/planner/index.js';
import type { EdgePusher } from '../src/comm/ws-server.js';
import type { Envelope, PlanResponsePayload } from '../src/comm/protocol.js';

class FakePusher implements EdgePusher {
  readonly pushed: { env: Envelope; edgeId?: string }[] = [];
  constructor(private readonly count = 1) {}
  pushToEdges(env: Envelope, edgeId?: string): number {
    this.pushed.push({ env, edgeId });
    return this.count;
  }
  edgeCount(): number {
    return this.count;
  }
}

test('LikeCommandService: 规划点赞 → 单步 click 并下发给边缘', async () => {
  const svc = new LikeCommandService({
    planner: new SimplePlanner(),
    clock: () => 1000,
    idGen: () => 'like-1',
  });
  const pusher = new FakePusher(2);

  const res = await svc.dispatchLike(pusher);

  assert.equal(res.steps.length, 1);
  assert.equal(res.steps[0].actionId, 'note.like_button');
  assert.equal(res.steps[0].op, 'click');
  assert.equal(res.dispatched, 2);
  assert.equal(pusher.pushed.length, 1);
  // 下发的信封是 plan.response，承载有序步骤
  const env = pusher.pushed[0].env;
  assert.equal(env.type, 'plan.response');
  assert.equal(env.id, 'like-1');
  assert.equal((env.payload as PlanResponsePayload).steps[0].actionId, 'note.like_button');
});

test('LikeCommandService: 定向 edgeId 透传给 pusher', async () => {
  const svc = new LikeCommandService({ planner: new SimplePlanner() });
  const pusher = new FakePusher(1);
  await svc.dispatchLike(pusher, 'edge-local');
  assert.equal(pusher.pushed[0].edgeId, 'edge-local');
});

test('LikeCommandService: 无步骤时不下发', async () => {
  // 一个永远规划不出步骤的 planner
  const emptyPlanner = {
    plan: async () => ({ steps: [], reason: 'no_rule_no_llm' as const }),
  };
  const svc = new LikeCommandService({ planner: emptyPlanner });
  const pusher = new FakePusher(1);
  const res = await svc.dispatchLike(pusher, undefined, '做点别的奇怪事');
  assert.equal(res.steps.length, 0);
  assert.equal(res.dispatched, 0);
  assert.equal(pusher.pushed.length, 0);
});