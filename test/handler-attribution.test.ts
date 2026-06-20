import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultMessageHandler, type AnchorStore } from '../src/comm/handler.js';
import type { EdgeSession } from '../src/comm/ws-server.js';
import { makeEnvelope } from '../src/comm/protocol.js';
import { EventBus } from '../src/event-bus/index.js';
import { SimplePlanner } from '../src/planner/index.js';
import type { LlmClient } from '../src/llm/qwen.js';

const noopCache = {
  get: async () => null,
  recordHit: async () => {},
  recordFailure: async () => {},
  stage: async () => {},
  confirmStaged: async () => ({ promoted: false, successes: 0, needed: 1 }),
  dropStaged: async () => {},
} as unknown as AnchorStore;

const llm: LlmClient = { complete: async () => '0' };

function makeHandler(eventBus: EventBus) {
  return new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm,
    cache: noopCache,
    eventBus,
    clock: () => 1000,
  });
}

function capture(eventBus: EventBus) {
  const got: { accountId?: string; action: string; noteId?: string }[] = [];
  eventBus.on('interaction.occurred', (e) => {
    got.push(e);
  });
  return got;
}

test('interaction.occurred 携带 accountId（从 session.accountId）', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  const session: EdgeSession = { sessionId: 's1', accountId: 'acc-x' };
  await makeHandler(eventBus).handle(
    makeEnvelope('action.completed', 'a1', 1, { action: 'like', ok: true }),
    session,
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].accountId, 'acc-x');
});

test('缺 session.accountId → 回退保留键 default（不误并入真名账号）', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  await makeHandler(eventBus).handle(
    makeEnvelope('action.completed', 'a2', 1, { action: 'like', ok: true }),
    { sessionId: 's2' },
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].accountId, 'default');
});

test('失败互动不 emit（只记真实发生）', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  await makeHandler(eventBus).handle(
    makeEnvelope('action.completed', 'a3', 1, { action: 'like', ok: false }),
    { sessionId: 's3' },
  );
  assert.equal(got.length, 0);
});

test('note.detail 戳 currentNoteId → interaction.occurred 携带 noteId（V1 9.2）', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  const handler = makeHandler(eventBus);
  const session: EdgeSession = { sessionId: 's4', accountId: 'acc-x' };
  // 先到达 note.detail，戳当前笔记
  await handler.handle(
    makeEnvelope('note.detail', 'n1', 1, {
      noteId: 'note-42', title: 't', content: 'c', likeCount: 0, collectCount: 0,
    }),
    session,
  );
  // 随后 like 完成
  await handler.handle(
    makeEnvelope('action.completed', 'a4', 1, { action: 'like', ok: true }),
    session,
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].noteId, 'note-42');
  assert.equal(got[0].accountId, 'acc-x');
});

test('未见 note.detail 时 noteId 不带（不编造）（V1 9.2）', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  await makeHandler(eventBus).handle(
    makeEnvelope('action.completed', 'a5', 1, { action: 'follow', ok: true }),
    { sessionId: 's5', accountId: 'acc-y' },
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].noteId, undefined);
});
