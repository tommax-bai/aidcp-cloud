/**
 * change generalize-facebook-content-derived-post-identity — 身份分档从 `page.cards` 传到派生事实。
 *
 * 详情与互动回执只带 noteId、不带分档。下游要判「这条能不能落库、能不能交给人」，
 * 若不把边缘的**显式声明**在这里留存并打到派生事件上，就只剩「按字符串形态猜身份」一条路——
 * 而那正是协议明令禁止的做法（漏判一处就是把会话内引用当地址用）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultMessageHandler, type AnchorStore } from '@automation/comm/handler.js';
import type { EdgeSession } from '@automation/comm/ws-server.js';
import { makeEnvelope } from '@automation/comm/protocol.js';
import { EventBus } from '@automation/event-bus/index.js';
import { SimplePlanner } from '@automation/planner/index.js';
import type { LlmClient } from '@content/llm/qwen.js';

const noopCache = {
  get: async () => null,
  recordHit: async () => {},
  recordFailure: async () => {},
  stage: async () => {},
  confirmStaged: async () => ({ promoted: false, successes: 0, needed: 1 }),
  dropStaged: async () => {},
} as unknown as AnchorStore;

const llm: LlmClient = { complete: async () => '0' };
const CONTENT_REF = `aidcp:facebook-group-feed-post:v1:${'a1'.repeat(32)}`;
const PERMALINK = 'https://www.facebook.com/Alice/posts/pfbid1';

function makeHandler(eventBus: EventBus) {
  return new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm,
    cache: noopCache,
    eventBus,
    clock: () => 1000,
  });
}

function card(noteId: string, noteIdKind?: 'permalink' | 'content_ref') {
  return { index: 0, title: '一条群组帖', likeCount: 3, collectCount: 0, noteId, ...(noteIdKind ? { noteIdKind } : {}) };
}

async function browse(noteId: string, noteIdKind?: 'permalink' | 'content_ref') {
  const eventBus = new EventBus();
  const interactions: Array<{ action: string; noteId?: string; noteIdKind?: string }> = [];
  const details: Array<{ noteIdKind?: string }> = [];
  eventBus.on('interaction.occurred', (e) => { interactions.push(e); });
  eventBus.on('note.detail.arrived', (e) => { details.push(e); });
  const session: EdgeSession = { sessionId: 's1', accountId: 'acc-1', platform: 'facebook' };
  const handler = makeHandler(eventBus);
  await handler.handle(makeEnvelope('page.cards', 'c1', 1, { cards: [card(noteId, noteIdKind)], listKind: 'feed' }), session);
  await handler.handle(makeEnvelope('note.detail', 'd1', 1, { noteId, title: 't', content: 'b', likeCount: 3, collectCount: 0 }), session);
  await handler.handle(makeEnvelope('action.completed', 'a1', 1, { action: 'like', ok: true, noteId }), session);
  return { interactions, details };
}

test('声明为会话内引用 ⇒ 浏览与点赞事实都带上分档（下游据此拒绝按笔记键落库）', async () => {
  const { interactions, details } = await browse(CONTENT_REF, 'content_ref');
  assert.equal(details.length, 1);
  assert.equal(details[0]!.noteIdKind, 'content_ref');
  const view = interactions.find((e) => e.action === 'view');
  const like = interactions.find((e) => e.action === 'like');
  assert.equal(view?.noteIdKind, 'content_ref');
  assert.equal(like?.noteIdKind, 'content_ref');
});

test('声明为平台链接 / 老边端缺声明 ⇒ 不带分档，行为逐位等于今天', async () => {
  for (const kind of ['permalink', undefined] as const) {
    const { interactions, details } = await browse(PERMALINK, kind);
    assert.equal(details[0]!.noteIdKind, undefined);
    for (const evt of interactions) assert.equal(evt.noteIdKind, undefined);
  }
});
