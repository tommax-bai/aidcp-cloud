import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultMessageHandler, type AnchorStore } from '../src/comm/handler.js';
import type { EdgeSession } from '../src/comm/ws-server.js';
import { makeEnvelope } from '../src/comm/protocol.js';
import { EventBus } from '../src/event-bus/index.js';
import { SimplePlanner } from '../src/planner/index.js';
import type { LlmClient } from '../src/llm/qwen.js';
import { PLATFORM_REGISTRY } from '../src/platform/registry.js';

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

test('缺 session.accountId → 不回落 default（emit accountId=undefined，下游 consumer honest-fail 丢弃）', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  await makeHandler(eventBus).handle(
    makeEnvelope('action.completed', 'a2', 1, { action: 'like', ok: true }),
    { sessionId: 's2' },
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].accountId, undefined, 'retire-default-account：绝不回落保留键 default（下游 consumer 据此 honest-fail 丢弃）');
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
  // note.detail 发一条 view（fix view-count-zero）+ action.completed 发一条 like；取 like 校验归因。
  const like = got.find((e) => e.action === 'like');
  assert.ok(like, 'like interaction 已发射');
  assert.equal(like!.noteId, 'note-42');
  assert.equal(like!.accountId, 'acc-x');
});

test('refreshOnly note.detail 只刷新图片快照，不计 view', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  const snapshots: unknown[] = [];
  eventBus.on('note.image_snapshot.arrived', (e) => {
    snapshots.push(e);
  });
  const handler = makeHandler(eventBus);
  const session: EdgeSession = { sessionId: 's-refresh', accountId: 'acc-x' };
  await handler.handle(
    makeEnvelope('note.detail', 'n-refresh', 1, {
      noteId: 'note-42',
      title: 't',
      content: 'c',
      likeCount: 0,
      collectCount: 0,
      images: [{ index: 0, url: 'https://img.test/a.jpg' }],
      refreshOnly: true,
    }),
    session,
  );

  assert.equal(got.find((e) => e.action === 'view'), undefined);
  assert.equal(snapshots.length, 1);
});

test('Reels 单卡一经呈现即记一次 view；匹配 note.detail 仍驱动详情链但不重复计数', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  const details: unknown[] = [];
  const cardEvents: Array<{ listKind?: 'feed' | 'reels' }> = [];
  eventBus.on('note.detail.arrived', (e) => { details.push(e); });
  eventBus.on('page.cards.arrived', (e) => { cardEvents.push(e); });
  const handler = makeHandler(eventBus);
  const session: EdgeSession = { sessionId: 's-reel-view', accountId: 'acc-fb', platform: 'facebook' };

  await handler.handle(
    makeEnvelope('page.cards', 'reel-card', 1, {
      cards: [{ index: 0, noteId: 'https://www.facebook.com/reel/42', title: 'visible reel', likeCount: 0, collectCount: 0, isVideo: true }],
      listKind: 'reels',
      listState: 'ready',
    }),
    session,
  );
  assert.deepEqual(got.filter((e) => e.action === 'view'), [{
    action: 'view', accountId: 'acc-fb', noteId: 'https://www.facebook.com/reel/42',
  }]);
  assert.equal(cardEvents[0]?.listKind, 'reels', '内部卡片事件须保留 Reels 形态供 Cloud 策略决策');

  await handler.handle(
    makeEnvelope('note.detail', 'reel-detail', 2, {
      noteId: 'https://www.facebook.com/reel/42', title: 'visible reel', content: 'full summary', mediaType: 'video', likeCount: 0, collectCount: 0,
    }),
    session,
  );
  assert.equal(details.length, 1, '详情仍须进入质量/互动链，不能为去重而吞事件');
  assert.equal(got.filter((e) => e.action === 'view').length, 1, '同一 Reel 的 detail 不得重复记 view');
});

test('Reels 空/畸形多卡不记 view；后续普通 feed detail 保持既有一次 view', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  const handler = makeHandler(eventBus);
  const session: EdgeSession = { sessionId: 's-reel-boundary', accountId: 'acc-fb', platform: 'facebook' };

  await handler.handle(
    makeEnvelope('page.cards', 'reel-empty', 1, { cards: [], listKind: 'reels', listState: 'empty' }),
    session,
  );
  await handler.handle(
    makeEnvelope('page.cards', 'reel-ambiguous', 2, {
      cards: [
        { index: 0, noteId: 'reel-a', title: 'a', likeCount: 0, collectCount: 0 },
        { index: 1, noteId: 'reel-b', title: 'b', likeCount: 0, collectCount: 0 },
      ],
      listKind: 'reels', listState: 'ready',
    }),
    session,
  );
  assert.equal(got.filter((e) => e.action === 'view').length, 0);

  await handler.handle(
    makeEnvelope('page.cards', 'feed-card', 3, {
      cards: [{ index: 0, noteId: 'feed-1', title: 'feed', likeCount: 0, collectCount: 0 }],
      listKind: 'feed', listState: 'ready',
    }),
    session,
  );
  await handler.handle(
    makeEnvelope('note.detail', 'feed-detail', 4, {
      noteId: 'feed-1', title: 'feed', content: 'content', likeCount: 0, collectCount: 0,
    }),
    session,
  );
  assert.deepEqual(got.filter((e) => e.action === 'view'), [{ action: 'view', accountId: 'acc-fb', noteId: 'feed-1' }]);
});

test('Facebook Feed 主视频呈现即按规范身份记一次 view；重报和随后 detail 不重复', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  const ruleViews: unknown[] = [];
  eventBus.on('facebook.rule.view.confirmed', (event) => { ruleViews.push(event); });
  const handler = makeHandler(eventBus);
  const session: EdgeSession = { sessionId: 's-feed-video-view', accountId: 'acc-fb', platform: 'facebook' };
  const card = {
    index: 0,
    noteId: 'https://www.facebook.com/watch?v=1632570071375207',
    title: 'safe cooking video',
    likeCount: 27_000,
    collectCount: 0,
    isVideo: true,
  };

  await handler.handle(makeEnvelope('page.cards', 'feed-video-1', 1, { cards: [card], listKind: 'feed', listState: 'ready' }), session);
  await handler.handle(makeEnvelope('page.cards', 'feed-video-2', 2, { cards: [card], listKind: 'feed', listState: 'ready' }), session);
  await handler.handle(
    makeEnvelope('note.detail', 'feed-video-detail', 3, {
      noteId: card.noteId, title: card.title, content: card.title, mediaType: 'video', likeCount: 27_000, collectCount: 0,
    }),
    session,
  );

  assert.deepEqual(got.filter((event) => event.action === 'view'), [{
    action: 'view', accountId: 'acc-fb', noteId: card.noteId,
  }]);
  assert.deepEqual(ruleViews, [{
    accountId: 'acc-fb',
    noteId: card.noteId,
    sourceDedupeKey: `feed-video-1:rule-view:${card.noteId}`,
    source: 'feed_video',
    occurredAt: 1000,
  }], '只有首次、已持久进入风控漏斗的确认浏览才能推进规则进度');
});

test('Facebook 普通 detail 推进规则浏览事实；非 Facebook 与 refreshOnly 均不推进', async () => {
  const eventBus = new EventBus();
  const ruleViews: unknown[] = [];
  eventBus.on('facebook.rule.view.confirmed', (event) => { ruleViews.push(event); });
  const handler = makeHandler(eventBus);

  await handler.handle(makeEnvelope('note.detail', 'fb-detail', 1, {
    noteId: 'https://www.facebook.com/posts/42',
    title: 'safe',
    content: 'safe body',
    likeCount: 0,
    collectCount: 0,
  }), { sessionId: 'fb', accountId: 'acc-fb', platform: 'facebook' });
  await handler.handle(makeEnvelope('note.detail', 'xhs-detail', 2, {
    noteId: 'xhs-42',
    title: 'safe',
    content: 'safe body',
    likeCount: 0,
    collectCount: 0,
  }), { sessionId: 'xhs', accountId: 'acc-xhs', platform: 'xiaohongshu' });
  await handler.handle(makeEnvelope('note.detail', 'fb-refresh', 3, {
    noteId: 'https://www.facebook.com/posts/43',
    title: 'safe',
    content: 'safe body',
    likeCount: 0,
    collectCount: 0,
    refreshOnly: true,
  }), { sessionId: 'fb-refresh', accountId: 'acc-fb', platform: 'facebook' });

  assert.deepEqual(ruleViews, [{
    accountId: 'acc-fb',
    noteId: 'https://www.facebook.com/posts/42',
    sourceDedupeKey: 'fb-detail:rule-view:https://www.facebook.com/posts/42',
    source: 'detail',
    occurredAt: 1000,
  }]);
});

test('风控事实持久入队失败时 Facebook 规则浏览事实不发射、不推进', async () => {
  const eventBus = new EventBus();
  const ruleViews: unknown[] = [];
  eventBus.on('facebook.rule.view.confirmed', (event) => { ruleViews.push(event); });
  const handler = new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm,
    cache: noopCache,
    eventBus,
    clock: () => 1000,
    riskAccounting: {
      enqueue: async () => { throw new Error('outbox unavailable'); },
      record: async () => ({ allowed: true }),
    },
  });

  await assert.rejects(
    () => handler.handle(makeEnvelope('note.detail', 'fb-failed', 1, {
      noteId: 'https://www.facebook.com/posts/failed',
      title: 'safe',
      content: 'safe body',
      likeCount: 0,
      collectCount: 0,
    }), { sessionId: 'fb-failed', accountId: 'acc-fb', platform: 'facebook' }),
    /outbox unavailable/,
  );
  assert.deepEqual(ruleViews, []);
});

test('Facebook Feed 0/多视频和非规范视频目标不提前记 view；普通详情计数保持不变', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  const handler = makeHandler(eventBus);
  const session: EdgeSession = { sessionId: 's-feed-video-invalid', accountId: 'acc-fb', platform: 'facebook' };
  const video = (id: string, noteId = `https://www.facebook.com/watch?v=${id}`) => ({
    index: Number(id), noteId, title: `video ${id}`, likeCount: 0, collectCount: 0, isVideo: true,
  });

  await handler.handle(makeEnvelope('page.cards', 'feed-none', 1, {
    cards: [{ ...video('1'), isVideo: false }], listKind: 'feed', listState: 'ready',
  }), session);
  await handler.handle(makeEnvelope('page.cards', 'feed-many', 2, {
    cards: [video('2'), video('3')], listKind: 'feed', listState: 'ready',
  }), session);
  await handler.handle(makeEnvelope('page.cards', 'feed-bad', 3, {
    cards: [video('4', 'https://evil.example/watch?v=4')], listKind: 'feed', listState: 'ready',
  }), session);
  assert.equal(got.filter((event) => event.action === 'view').length, 0);

  await handler.handle(makeEnvelope('note.detail', 'ordinary-detail', 4, {
    noteId: 'ordinary-1', title: 'ordinary', content: 'ordinary', likeCount: 0, collectCount: 0,
  }), session);
  assert.deepEqual(got.filter((event) => event.action === 'view'), [{
    action: 'view', accountId: 'acc-fb', noteId: 'ordinary-1',
  }]);
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

// ── change platform-browse-protocol（C1b）：归账仲裁 ─────────────────────────────
// 阶段 0（readSurface 恒 detail、edge 不发派生 noteId/observation）⇒ 恒回落 currentNoteId=今天行为（上方既有测试覆盖）。
// 以下坐实仲裁的三条新分支：派生 noteId 优先、feed-surface 拒记账（版本偏斜闸）、独立见证比对。

test('C1b：回执带派生 noteId ⇒ 用派生 id（不回落 currentNoteId）', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  const handler = makeHandler(eventBus);
  const session: EdgeSession = { sessionId: 's-derived', accountId: 'acc-x', platform: 'xiaohongshu' };
  await handler.handle(
    makeEnvelope('note.detail', 'nd', 1, { noteId: 'note-42', title: 't', content: 'c', likeCount: 0, collectCount: 0 }),
    session,
  );
  await handler.handle(
    makeEnvelope('action.completed', 'ac', 1, { action: 'like', ok: true, noteId: 'derived-9' }),
    session,
  );
  const like = got.find((e) => e.action === 'like');
  assert.ok(like, 'like 已发射');
  assert.equal(like!.noteId, 'derived-9', '派生 noteId 优先于 currentNoteId');
});

test('C1b：feed-surface + 声明 inline_targeting + 回执缺派生 noteId ⇒ 拒写血缘（noteId 不带）、风控仍计数', async () => {
  const original = PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content;
  PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = 'feed'; // 模拟 C2：FB 就地读
  try {
    const eventBus = new EventBus();
    const got = capture(eventBus);
    const handler = makeHandler(eventBus);
    const session: EdgeSession = {
      sessionId: 's-feed-refuse', accountId: 'acc-fb', platform: 'facebook',
      capabilities: ['inline_targeting'], currentNoteId: 'note-42',
    };
    await handler.handle(
      makeEnvelope('action.completed', 'ac', 1, { action: 'like', ok: true }),
      session,
    );
    const like = got.find((e) => e.action === 'like');
    assert.ok(like, 'like 仍发射 → 风控按真实发生计数');
    assert.equal(like!.noteId, undefined, 'feed-surface 缺派生 noteId ⇒ 拒写血缘、不回落 currentNoteId');
  } finally {
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = original;
  }
});

test('C1b：feed-surface 但边缘未声明 inline_targeting（老边端）⇒ 版本偏斜闸不启用，回落 currentNoteId', async () => {
  const original = PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content;
  PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = 'feed';
  try {
    const eventBus = new EventBus();
    const got = capture(eventBus);
    const handler = makeHandler(eventBus);
    const session: EdgeSession = {
      sessionId: 's-old-edge', accountId: 'acc-fb', platform: 'facebook', currentNoteId: 'note-42',
    };
    await handler.handle(
      makeEnvelope('action.completed', 'ac', 1, { action: 'like', ok: true }),
      session,
    );
    const like = got.find((e) => e.action === 'like');
    assert.equal(like!.noteId, 'note-42', '老边端（未声明能力）⇒ 逐位回落 currentNoteId，绝不误拒');
  } finally {
    PLATFORM_REGISTRY.facebook!.noteSurfaces.read_content = original;
  }
});

test('C1b：独立见证与选中卡不符 ⇒ target_mismatch，拒写血缘（noteId 不带）、风控仍计数', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  const handler = makeHandler(eventBus);
  const session: EdgeSession = { sessionId: 's-mismatch', accountId: 'acc-x', platform: 'xiaohongshu' };
  // 选中卡：Alice / Hello world
  await handler.handle(
    makeEnvelope('page.cards', 'pc', 1, {
      cards: [{ index: 0, title: 'Hello world', author: 'Alice', likeCount: 5, collectCount: 1, noteId: 'note-42' }],
    }),
    session,
  );
  await handler.handle(
    makeEnvelope('note.detail', 'nd', 1, { noteId: 'note-42', title: 'Hello world', content: 'c', likeCount: 5, collectCount: 1 }),
    session,
  );
  // 回执见证：Bob / Totally different —— 与选中卡不符
  await handler.handle(
    makeEnvelope('action.completed', 'ac', 1, {
      action: 'like', ok: true, observation: { author: 'Bob', textPreviewHead: 'Totally different' },
    }),
    session,
  );
  const like = got.find((e) => e.action === 'like');
  assert.ok(like, 'like 仍发射 → 风控按真实发生计数（数量真实、目标存疑不猜血缘）');
  assert.equal(like!.noteId, undefined, '见证不符 ⇒ 拒写 liked_notes 血缘');
});

test('C1b：独立见证与选中卡相符 ⇒ 血缘正常写（noteId=选中卡）', async () => {
  const eventBus = new EventBus();
  const got = capture(eventBus);
  const handler = makeHandler(eventBus);
  const session: EdgeSession = { sessionId: 's-match', accountId: 'acc-x', platform: 'xiaohongshu' };
  await handler.handle(
    makeEnvelope('page.cards', 'pc', 1, {
      cards: [{ index: 0, title: 'Hello world', author: 'Alice', likeCount: 5, collectCount: 1, noteId: 'note-42' }],
    }),
    session,
  );
  await handler.handle(
    makeEnvelope('note.detail', 'nd', 1, { noteId: 'note-42', title: 'Hello world', content: 'c', likeCount: 5, collectCount: 1 }),
    session,
  );
  await handler.handle(
    makeEnvelope('action.completed', 'ac', 1, {
      action: 'like', ok: true, observation: { author: 'Alice', textPreviewHead: 'Hello' },
    }),
    session,
  );
  const like = got.find((e) => e.action === 'like');
  assert.equal(like!.noteId, 'note-42', '见证相符 ⇒ 血缘按选中卡写');
});
