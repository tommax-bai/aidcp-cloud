import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultMessageHandler, type AnchorStore } from '../src/comm/handler.js';
import { makeEnvelope } from '../src/comm/protocol.js';
import type { EdgeSession } from '../src/comm/ws-server.js';
import { EventBus } from '../src/event-bus/index.js';
import { SimplePlanner } from '../src/planner/index.js';
import type { LlmClient } from '../src/llm/qwen.js';

const cache = {
  get: async () => null,
  recordHit: async () => {},
  recordFailure: async () => {},
  stage: async () => {},
  confirmStaged: async () => ({ promoted: false, successes: 0, needed: 1 }),
  dropStaged: async () => {},
} as unknown as AnchorStore;
const llm: LlmClient = { complete: async () => '0' };

function makeHarness() {
  const bus = new EventBus();
  const handler = new DefaultMessageHandler({ planner: new SimplePlanner(), llm, cache, eventBus: bus, clock: () => 1000 });
  let empty = 0;
  let cards = 0;
  bus.on('feed.empty.confirmed', () => { empty += 1; });
  bus.on('page.cards.arrived', () => { cards += 1; });
  return { bus, handler, counts: () => ({ empty, cards }) };
}

test('handler 只把 Facebook feed/empty + 0 卡翻译为 confirmed-empty 内部事件', async () => {
  const h = makeHarness();
  const session: EdgeSession = { sessionId: 'fb', platform: 'facebook' };
  await h.handler.handle(makeEnvelope('page.cards', '1', 1, { cards: [], listKind: 'feed', listState: 'empty' }), session);
  assert.deepEqual(h.counts(), { empty: 1, cards: 0 });

  await h.handler.handle(makeEnvelope('page.cards', '2', 2, {
    cards: [{ index: 0, title: 'real', likeCount: 0, collectCount: 0 }],
    listKind: 'feed',
    listState: 'empty',
  }), session);
  await h.handler.handle(makeEnvelope('page.cards', '3', 3, { cards: [], listKind: 'reels', listState: 'empty' }), session);
  await h.handler.handle(makeEnvelope('page.cards', '4', 4, { cards: [] }), { sessionId: 'xhs', platform: 'xiaohongshu' });
  assert.deepEqual(h.counts(), { empty: 1, cards: 3 }, '畸形/其它列表/其它平台均不得扩大为空态');
});
