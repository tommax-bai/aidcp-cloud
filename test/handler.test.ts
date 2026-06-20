import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultMessageHandler } from '../src/comm/index.js';
import type { AnchorStore } from '../src/comm/handler.js';
import type { EdgeSession } from '../src/comm/ws-server.js';
import { makeEnvelope, type RemoteAnchor } from '../src/comm/index.js';
import { SimplePlanner } from '../src/planner/index.js';
import type { LlmClient } from '../src/llm/index.js';
import { EventBus } from '../src/event-bus/index.js';
import { AccountStateManager } from '../src/account-state.js';

/** 内存版 AnchorStore：复刻反污染晋升语义，供 handler 单测 */
function memStore(): AnchorStore & { main: Map<string, RemoteAnchor>; staging: Map<string, number> } {
  const main = new Map<string, RemoteAnchor>();
  const staging = new Map<string, number>();
  const needed = 2;
  return {
    main,
    staging,
    async get(id) {
      return main.get(id) ?? null;
    },
    async recordHit() {},
    async recordFailure() {},
    async stage(a) {
      if (!staging.has(a.actionId)) staging.set(a.actionId, 0);
      main.set('__staged__' + a.actionId, a);
    },
    async confirmStaged(id) {
      const s = (staging.get(id) ?? 0) + 1;
      staging.set(id, s);
      if (s >= needed) {
        const a = main.get('__staged__' + id);
        if (a) main.set(id, a);
        staging.delete(id);
        return { promoted: true, successes: s, needed };
      }
      return { promoted: false, successes: s, needed };
    },
    async dropStaged(id) {
      staging.delete(id);
    },
  };
}

const session: EdgeSession = { sessionId: 'sess-test' };
const fixedClock = () => 1000;

function makeHandler(llm: LlmClient, store: AnchorStore) {
  return new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm,
    cache: store,
    clock: fixedClock,
    eventBus: new EventBus(),
  });
}

const dummyLlm: LlmClient = { complete: async () => '0' };

test('hello → welcome，并记录 edgeId 到会话', async () => {
  const h = makeHandler(dummyLlm, memStore());
  const s: EdgeSession = { sessionId: 'sX' };
  const res = await h.handle(makeEnvelope('hello', 'h1', 1, { edgeId: 'edge-1', app: 'xhs' }), s);
  assert.equal(res?.type, 'welcome');
  assert.equal(s.edgeId, 'edge-1');
  assert.equal(s.app, 'xhs');
});

test('ping → pong', async () => {
  const h = makeHandler(dummyLlm, memStore());
  const res = await h.handle(makeEnvelope('ping', 'p1', 1, {}), session);
  assert.equal(res?.type, 'pong');
  assert.equal(res?.id, 'p1');
});

test('plan.request → plan.response（走规则）', async () => {
  const h = makeHandler(dummyLlm, memStore());
  const res = await h.handle(makeEnvelope('plan.request', 'pl1', 1, { goal: '点赞' }), session);
  assert.equal(res?.type, 'plan.response');
  const payload = res?.payload as { steps: unknown[]; reason: string };
  assert.equal(payload.steps.length, 1);
});

test('select.request → 选中 LLM 返回的合法编号', async () => {
  const llm: LlmClient = { complete: async () => '编号是 1' };
  const h = makeHandler(llm, memStore());
  const res = await h.handle(
    makeEnvelope('select.request', 's1', 1, {
      goal: '关注',
      elements: [
        { index: 0, role: 'button', tag: 'button', text: '点赞', attributes: {} },
        { index: 1, role: 'button', tag: 'button', text: '关注', attributes: {} },
      ],
    }),
    session,
  );
  const payload = res?.payload as { index: number | null; reason: string };
  assert.equal(payload.index, 1);
  assert.equal(payload.reason, 'llm_selected');
});

test('select.request → 越界编号被拦截（防幻觉）', async () => {
  const llm: LlmClient = { complete: async () => '99' };
  const h = makeHandler(llm, memStore());
  const res = await h.handle(
    makeEnvelope('select.request', 's2', 1, {
      goal: 'x',
      elements: [{ index: 0, role: 'button', tag: 'button', text: 'a', attributes: {} }],
    }),
    session,
  );
  const payload = res?.payload as { index: number | null; reason: string };
  assert.equal(payload.index, null);
  assert.match(payload.reason, /index_out_of_range/);
});

test('anchor.get → 命中主缓存返回锚点', async () => {
  const store = memStore();
  store.main.set('note.like', { actionId: 'note.like', role: 'button', text: '点赞' });
  const h = makeHandler(dummyLlm, store);
  const res = await h.handle(makeEnvelope('anchor.get', 'a1', 1, { actionId: 'note.like' }), session);
  const payload = res?.payload as { anchor: RemoteAnchor | null };
  assert.equal(payload.anchor?.text, '点赞');
});

test('anchor.report（llm+validated）反污染：两次确认后晋升主缓存', async () => {
  const store = memStore();
  const h = makeHandler(dummyLlm, store);
  const candidate: RemoteAnchor = { actionId: 'note.fav', role: 'button', text: '收藏' };

  await h.handle(makeEnvelope('anchor.report', 'r1', 1, { actionId: 'note.fav', source: 'llm', validated: true, candidate }), session);
  assert.equal(store.main.get('note.fav'), undefined, '一次确认不晋升');

  await h.handle(makeEnvelope('anchor.report', 'r2', 1, { actionId: 'note.fav', source: 'llm', validated: true, candidate }), session);
  assert.equal(store.main.get('note.fav')?.text, '收藏', '第二次确认后晋升');
});

test('未知类型 → error 信封', async () => {
  const h = makeHandler(dummyLlm, memStore());
  const bogus = makeEnvelope('ping', 'b1', 1, {});
  bogus.type = 'totally.bogus' as typeof bogus.type;
  const res = await h.handle(bogus, session);
  assert.equal(res?.type, 'error');
});

test('note.content → 通过 EventBus 发射 note.arrived 并返回 note.ack', async () => {
  const eventBus = new EventBus();
  const emitted: unknown[] = [];
  eventBus.on('note.arrived', (data) => { emitted.push(data); });

  const h = new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm: dummyLlm,
    cache: memStore(),
    clock: fixedClock,
    eventBus,
  });
  const res = await h.handle(
    makeEnvelope('note.content', 'nc1', 1, {
      noteId: 'x', title: 'T', summary: 'S', likeCount: 100, collectCount: 50,
    }),
    session,
  );
  assert.equal(res!.type, 'note.ack');
  assert.equal(res!.id, 'nc1');
  assert.equal((res!.payload as { received: boolean }).received, true);
  assert.equal(emitted.length, 1);
  assert.equal((emitted[0] as { note: { title: string } }).note.title, 'T');
});

test('note.content 字段映射：body→summary, likes→likeCount', async () => {
  const eventBus = new EventBus();
  const emitted: unknown[] = [];
  eventBus.on('note.arrived', (data) => { emitted.push(data); });

  const h = new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm: dummyLlm,
    cache: memStore(),
    clock: fixedClock,
    eventBus,
  });
  const res = await h.handle(
    { v: 1, type: 'note.content', id: 'nc2', ts: 1, payload: {
      noteId: 'x2', title: 'EventBus测试', body: '内容正文', likes: 10, collects: 3,
    }},
    session,
  );
  assert.equal(res!.type, 'note.ack');
  assert.equal(res!.id, 'nc2');
  const note = (emitted[0] as { note: { summary: string; likeCount: number; collectCount: number } }).note;
  assert.equal(note.summary, '内容正文');
  assert.equal(note.likeCount, 10);
  assert.equal(note.collectCount, 3);
});



test('note.content 暂停状态 → 返回 ack、不触发 eventBus emit', async () => {
  const eventBus = new EventBus();
  const emitted: unknown[] = [];
  eventBus.on('note.arrived', (data) => { emitted.push(data); });

  const accountState = new AccountStateManager();
  await accountState.pause('default');

  const h = new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm: dummyLlm,
    cache: memStore(),
    clock: fixedClock,
    eventBus,
    accountState,
  });
  const res = await h.handle(
    makeEnvelope('note.content', 'nc-p1', 1, {
      noteId: 'x', title: 'Paused', summary: 'S', likeCount: 10, collectCount: 5,
    }),
    session,
  );
  assert.equal(res!.type, 'note.ack');
  assert.equal(res!.id, 'nc-p1');
  assert.equal((res!.payload as { received: boolean }).received, true);
  assert.equal(emitted.length, 0, '暂停时不应触发 note.arrived 事件');
});

test('note.content 未暂停状态 → 返回 ack、正常触发 eventBus emit', async () => {
  const eventBus = new EventBus();
  const emitted: unknown[] = [];
  eventBus.on('note.arrived', (data) => { emitted.push(data); });

  const accountState = new AccountStateManager();
  // 不调用 pause，保持 active

  const h = new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm: dummyLlm,
    cache: memStore(),
    clock: fixedClock,
    eventBus,
    accountState,
  });
  const res = await h.handle(
    makeEnvelope('note.content', 'nc-a1', 1, {
      noteId: 'x', title: 'Active', summary: 'S', likeCount: 10, collectCount: 5,
    }),
    session,
  );
  assert.equal(res!.type, 'note.ack');
  assert.equal(res!.id, 'nc-a1');
  assert.equal(emitted.length, 1, '未暂停时应正常触发事件');
});

test('note.content 未注入 accountState → 正常工作（向后兼容）', async () => {
  const eventBus = new EventBus();
  const emitted: unknown[] = [];
  eventBus.on('note.arrived', (data) => { emitted.push(data); });

  const h = new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm: dummyLlm,
    cache: memStore(),
    clock: fixedClock,
    eventBus,
    // 不注入 accountState
  });
  const res = await h.handle(
    makeEnvelope('note.content', 'nc-b1', 1, {
      noteId: 'x', title: 'Compat', summary: 'S', likeCount: 10, collectCount: 5,
    }),
    session,
  );
  assert.equal(res!.type, 'note.ack');
  assert.equal(res!.id, 'nc-b1');
  assert.equal(emitted.length, 1, '无 accountState 时应正常触发事件');
});

test('publish.approval_request → 调 sendApprovalCard', async () => {
  const sent: Array<{ chatId: string; card: unknown }> = [];
  const h = new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm: dummyLlm,
    cache: memStore(),
    clock: fixedClock,
    eventBus: new EventBus(),
    messenger: {
      sendApprovalCard: async (chatId, card) => {
        sent.push({ chatId, card });
      },
    },
    approvalChatId: 'oc_chat',
  });
  const res = await h.handle(
    makeEnvelope('publish.approval_request', 'apr1', 1, {
      requestId: 'req-1',
      title: 'T',
      content: 'C',
      tags: ['x'],
      edgeId: 'edge-1',
    }),
    session,
  );
  assert.equal(res, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'oc_chat');
  assert.match(JSON.stringify(sent[0].card), /req-1/);
});
