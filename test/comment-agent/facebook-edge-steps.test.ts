import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../../src/event-bus/index.js';
import { buildFacebookEdgeSteps } from '../../src/comment-agent/facebook-edge-steps.js';

interface Env {
  type: string;
  payload: Record<string, unknown>;
}

/** 假边端：订阅已先建立，pushToEdges 内同步 emit 配置的上报（behavior 闭包持有 bus）。可配 offline / silent。 */
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
  return buildFacebookEdgeSteps({ bus, pusher, edgeId: 'e-fb', stepTimeoutMs, logger: { log: () => {}, warn: () => {} } });
}

describe('buildFacebookEdgeSteps', () => {
  it('search：命中 page.cards → 候选 permalink；search.execute 带 container', async () => {
    const bus = new EventBus();
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'search.execute') {
        bus.emit('page.cards.arrived', { cards: [{ noteId: 'https://fb.com/g/1/posts/2' }, { noteId: 'https://fb.com/g/1/posts/3' }], ts: 0 } as never);
      }
    });
    const r = await steps(bus, pusher).searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
    assert.equal(r.ok, true);
    assert.deepEqual(r.candidates.map((c) => c.permalink), ['https://fb.com/g/1/posts/2', 'https://fb.com/g/1/posts/3']);
    assert.equal(sent[0].payload.container, 'https://www.facebook.com/groups/1');
    assert.equal(sent[0].payload.keyword, '咖啡');
  });

  it('search：诚实失败回执 action.completed{search} → ok:false + reason', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher((env) => {
      if (env.type === 'search.execute') bus.emit('action.completed', { action: 'search', ok: false, reason: 'login_required', ts: 0 } as never);
    });
    const r = await steps(bus, pusher).searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'login_required');
  });

  it('search：无在线边端（命中0）→ ok:false timeout', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher(() => {}, { offline: true });
    const r = await steps(bus, pusher).searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
  });

  it('search：边端静默无回执 → 有界超时 timeout（不无限等）', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher(() => {}, { silent: true });
    const r = await steps(bus, pusher, 30).searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
  });

  it('open：note.detail.arrived 匹配 url → ok；note.open 带 url', async () => {
    const bus = new EventBus();
    const url = 'https://www.facebook.com/groups/1/posts/2';
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'note.open') bus.emit('note.detail.arrived', { detail: { noteId: (env.payload as { url?: string }).url }, ts: 0 } as never);
    });
    const r = await steps(bus, pusher).openPost(url);
    assert.equal(r.ok, true);
    assert.equal(sent[0].payload.url, url);
  });

  it('open：note.detail 的 noteId 不匹配 url → 不误认（超时）', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher((env) => {
      if (env.type === 'note.open') bus.emit('note.detail.arrived', { detail: { noteId: 'OTHER' }, ts: 0 } as never);
    });
    const r = await steps(bus, pusher, 30).openPost('https://www.facebook.com/groups/1/posts/2');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
  });

  it('open：诚实失败回执 action.completed{open_note} → ok:false + reason', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher((env) => {
      if (env.type === 'note.open') bus.emit('action.completed', { action: 'open_note', ok: false, reason: 'editor_not_found', ts: 0 } as never);
    });
    const r = await steps(bus, pusher).openPost('https://www.facebook.com/groups/1/posts/2');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'editor_not_found');
  });

  it('comment：action.completed{comment,ok:true} → ok:true；interaction.comment 带 noteId+text', async () => {
    const bus = new EventBus();
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'interaction.comment') bus.emit('action.completed', { action: 'comment', ok: true, ts: 0 } as never);
    });
    const r = await steps(bus, pusher).submitComment('https://fb.com/g/1/posts/2', '很喜欢');
    assert.equal(r.ok, true);
    assert.equal(sent[0].payload.noteId, 'https://fb.com/g/1/posts/2');
    assert.equal(sent[0].payload.text, '很喜欢');
  });

  it('comment：action.completed{comment,ok:false,reason} → ok:false + reason', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher((env) => {
      if (env.type === 'interaction.comment') bus.emit('action.completed', { action: 'comment', ok: false, reason: 'verification_ambiguous', ts: 0 } as never);
    });
    const r = await steps(bus, pusher).submitComment('https://fb.com/g/1/posts/2', '很喜欢');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'verification_ambiguous');
  });
});
