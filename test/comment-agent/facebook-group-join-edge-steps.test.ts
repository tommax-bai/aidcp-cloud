import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../../src/event-bus/index.js';
import { buildFacebookGroupJoinEdgeSteps } from '../../src/comment-agent/facebook-group-join-edge-steps.js';

interface Env {
  type: string;
  payload: Record<string, unknown>;
}

function makePusher(
  behavior: (env: Env) => void,
  opts: { offline?: boolean; silent?: boolean } = {},
): { pusher: { pushToEdges: (e: unknown) => number }; sent: Env[] } {
  const sent: Env[] = [];
  const pusher = {
    pushToEdges: (envelope: unknown): number => {
      const env = envelope as Env;
      sent.push(env);
      if (opts.offline) return 0;
      if (!opts.silent) behavior(env);
      return 1;
    },
  };
  return { pusher, sent };
}

function steps(bus: EventBus, pusher: { pushToEdges: (e: unknown) => number }, stepTimeoutMs = 40) {
  return buildFacebookGroupJoinEdgeSteps({ bus, pusher, edgeId: 'e-fb', taskId: 'task-join-1', stepTimeoutMs, logger: { warn: () => {} } });
}

describe('buildFacebookGroupJoinEdgeSteps', () => {
  it('observeGroup: 下发 group.join click=false 并回传 observation', async () => {
    const bus = new EventBus();
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'group.join') {
        bus.emit('action.completed', {
          action: 'join_group',
          ok: false,
          reason: 'observation_only',
          groupUrl: env.payload.groupUrl,
          clicked: false,
          observation: { groupUrl: env.payload.groupUrl, mainCtaText: 'Join group' },
          ts: 0,
        } as never);
      }
    });
    const r = await steps(bus, pusher).observeGroup('https://www.facebook.com/groups/1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'observation_only');
    assert.equal(r.observation?.mainCtaText, 'Join group');
    assert.equal(sent[0].type, 'group.join');
    assert.equal(sent[0].payload.click, false);
  });

  it('clickJoin: 下发 group.join click=true，ok 只来自 join_group 回执', async () => {
    const bus = new EventBus();
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'group.join') {
        bus.emit('action.completed', {
          action: 'join_group',
          ok: true,
          groupUrl: env.payload.groupUrl,
          clicked: true,
          postObservation: { groupUrl: env.payload.groupUrl, mainCtaText: 'Joined' },
          ts: 0,
        } as never);
      }
    });
    const r = await steps(bus, pusher).clickJoin('https://www.facebook.com/groups/1', 100);
    assert.equal(r.ok, true);
    assert.equal(r.clicked, true);
    assert.equal(r.postObservation?.mainCtaText, 'Joined');
    assert.equal(sent[0].payload.click, true);
    assert.equal(sent[0].payload.thinkMs, 100);
  });

  it('无在线边端或静默无回执 → timeout，不假成功', async () => {
    const offline = new EventBus();
    const a = makePusher(() => {}, { offline: true });
    const r1 = await steps(offline, a.pusher).observeGroup('https://www.facebook.com/groups/1');
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'timeout');

    const silent = new EventBus();
    const b = makePusher(() => {}, { silent: true });
    const r2 = await steps(silent, b.pusher, 20).clickJoin('https://www.facebook.com/groups/1');
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'timeout');
  });
});
