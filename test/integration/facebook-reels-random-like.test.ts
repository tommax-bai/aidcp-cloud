import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACEBOOK_REELS_FOLLOW_PROBABILITY,
  FACEBOOK_REELS_LIKE_PROBABILITY,
  RoleDispatcher,
  type EdgeCommand,
} from '../../src/orchestrator/role-dispatcher.js';
import { ActionCooldownGate } from '../../src/risk/action-cooldown.js';
import { InteractionGuard } from '../../src/risk/interaction-guard.js';
import type { Soul } from '../../src/kernel/soul-types.js';

const soul: Soul = {
  identity: { name: 'Reel Test', role: 'viewer', background: 'test', tone: 'plain' },
  interests: { primary: ['video'], secondary: [], seed_keywords: [] },
};

const reelCard = (id = '42') => ({
  index: 0,
  noteId: `https://www.facebook.com/reel/${id}`,
  title: `reel ${id}`,
  likeCount: 0,
  collectCount: 0,
});

const feedVideoCard = (id = '42', title = `feed video ${id}`) => ({
  index: 0,
  noteId: `https://www.facebook.com/watch?v=${id}`,
  title,
  likeCount: 0,
  collectCount: 0,
  isVideo: true,
});

type InteractionAction = 'like' | 'collect' | 'follow' | 'comment' | 'comment_like';

function startDispatcher(options: {
  randomFn?: () => number;
  platform?: 'facebook' | 'xiaohongshu';
  canInteract?: (action: InteractionAction) => boolean;
  hasReelFollow?: boolean;
  cooldownGate?: ActionCooldownGate;
  interactionGuard?: InteractionGuard;
  clock?: () => number;
} = {}) {
  const commands: EdgeCommand[] = [];
  let llmCalls = 0;
  const dispatcher = new RoleDispatcher({
    soul,
    llm: { complete: async () => { llmCalls++; return '{"verdict":"skip","reason":"test"}'; } },
    accountPlatform: options.platform ?? 'facebook',
    randomFn: options.randomFn,
    canInteract: options.canInteract,
    hasReelFollow: () => options.hasReelFollow ?? false,
    cooldownGate: options.cooldownGate,
    interactionGuard: options.interactionGuard,
    clock: options.clock,
    sendCommand: (command) => commands.push(command),
  });
  dispatcher.setup();
  dispatcher.startSession();
  return { dispatcher, commands, llmCalls: () => llmCalls };
}

function reportReel(dispatcher: RoleDispatcher, id = '42', author?: string): void {
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ ...reelCard(id), ...(author ? { author } : {}) }],
    listKind: 'reels',
    ts: Date.now(),
  });
}

function reportFeedVideo(dispatcher: RoleDispatcher, id = '42', title = `feed video ${id}`): void {
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [feedVideoCard(id, title)],
    listKind: 'feed',
    ts: Date.now(),
  });
}

test('Facebook Reel: random < 0.25 时立即下发一次 note-scoped like 意图', () => {
  const { dispatcher, commands } = startDispatcher({ randomFn: () => FACEBOOK_REELS_LIKE_PROBABILITY - Number.EPSILON });
  reportReel(dispatcher);

  const likes = commands.filter((command) => command.action === 'like');
  assert.equal(likes.length, 1);
  assert.equal(likes[0]?.reason, 'facebook_reel_probability_hit');
  assert.equal(likes[0]?.params?.noteId, 'https://www.facebook.com/reel/42');
  dispatcher.endSession('test');
});

test('Facebook Reel: random === 0.25 时不下发 like', () => {
  const { dispatcher, commands } = startDispatcher({ randomFn: () => FACEBOOK_REELS_LIKE_PROBABILITY });
  reportReel(dispatcher);
  assert.equal(commands.some((command) => command.action === 'like'), false);
  dispatcher.endSession('test');
});

test('Facebook Reel: 同一规范身份重报不重抽、不重复下发', () => {
  let randomCalls = 0;
  const { dispatcher, commands } = startDispatcher({ randomFn: () => { randomCalls++; return 0.1; } });
  reportReel(dispatcher);
  reportReel(dispatcher);

  assert.equal(randomCalls, 1);
  assert.equal(commands.filter((command) => command.action === 'like').length, 1);
  dispatcher.endSession('test');
});

test('Facebook Reel: 非 FB、非 reels、畸形批次和非规范 URL 均 fail-closed', () => {
  let randomCalls = 0;
  const randomFn = () => { randomCalls++; return 0.1; };
  const fb = startDispatcher({ randomFn });
  fb.dispatcher.bus.emit('page.cards.arrived', { cards: [reelCard()], listKind: 'feed', ts: 1 });
  fb.dispatcher.bus.emit('page.cards.arrived', { cards: [], listKind: 'reels', ts: 2 });
  fb.dispatcher.bus.emit('page.cards.arrived', { cards: [reelCard('1'), reelCard('2')], listKind: 'reels', ts: 3 });
  fb.dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ ...reelCard(), noteId: 'https://evil.example/reel/42' }], listKind: 'reels', ts: 4,
  });
  assert.equal(fb.commands.some((command) => command.action === 'like'), false);
  fb.dispatcher.endSession('test');

  const xhs = startDispatcher({ randomFn, platform: 'xiaohongshu' });
  reportReel(xhs.dispatcher);
  assert.equal(xhs.commands.some((command) => command.action === 'like'), false);
  xhs.dispatcher.endSession('test');
  assert.equal(randomCalls, 0);
});

test('Facebook Reel: 概率命中但风险闸拒绝时不下发、不假成功', () => {
  const { dispatcher, commands } = startDispatcher({ randomFn: () => 0.1, canInteract: () => false });
  reportReel(dispatcher);
  assert.equal(commands.some((command) => command.action === 'like'), false);
  dispatcher.endSession('test');
});

test('Facebook Reel: 新会话清空一次性决策集合，同一 Reel 可重新抽一次', () => {
  let randomCalls = 0;
  const { dispatcher, commands } = startDispatcher({ randomFn: () => { randomCalls++; return 0.1; } });
  reportReel(dispatcher);
  dispatcher.endSession('first');
  dispatcher.startSession();
  reportReel(dispatcher);

  assert.equal(randomCalls, 2);
  assert.equal(commands.filter((command) => command.action === 'like').length, 2);
  dispatcher.endSession('second');
});

test('Facebook Reel follow: 独立 10% 掷骰命中并下发作者与 Reel 双锚点', () => {
  const rolls = [FACEBOOK_REELS_LIKE_PROBABILITY, FACEBOOK_REELS_FOLLOW_PROBABILITY - Number.EPSILON];
  const { dispatcher, commands } = startDispatcher({
    hasReelFollow: true,
    randomFn: () => rolls.shift() ?? 0.5,
  });
  reportReel(dispatcher, '88', ' Salon   de Comolis ');

  assert.equal(commands.some((command) => command.action === 'like'), false, '关注与点赞独立，点赞可弃权');
  const follows = commands.filter((command) => command.action === 'follow');
  assert.equal(follows.length, 1);
  assert.equal(follows[0]?.reason, 'facebook_reel_follow_probability_hit');
  assert.equal(follows[0]?.params?.noteId, 'https://www.facebook.com/reel/88');
  assert.equal(follows[0]?.params?.authorId, 'Salon de Comolis');
  dispatcher.endSession('test');
});

test('Facebook Reel follow: 0.10 边界弃权，同一 Reel 重报不重抽', () => {
  let randomCalls = 0;
  const rolls = [FACEBOOK_REELS_LIKE_PROBABILITY, FACEBOOK_REELS_FOLLOW_PROBABILITY];
  const { dispatcher, commands } = startDispatcher({
    hasReelFollow: true,
    randomFn: () => { randomCalls++; return rolls.shift() ?? 0; },
  });
  reportReel(dispatcher, '89', 'Bao');
  reportReel(dispatcher, '89', 'Bao');

  assert.equal(randomCalls, 2, '首次分别为点赞/关注掷骰；重复卡片不再掷骰');
  assert.equal(commands.some((command) => command.action === 'follow'), false);
  dispatcher.endSession('test');
});

test('Facebook Reel follow: 旧 Edge、缺作者、会话配额耗尽均在掷骰前失败关闭', () => {
  let randomCalls = 0;
  const randomFn = () => { randomCalls++; return 0.5; };

  const oldEdge = startDispatcher({ randomFn });
  reportReel(oldEdge.dispatcher, '90', 'Bao');
  assert.equal(oldEdge.commands.some((command) => command.action === 'follow'), false);
  oldEdge.dispatcher.endSession('test');

  const missingAuthor = startDispatcher({ hasReelFollow: true, randomFn });
  reportReel(missingAuthor.dispatcher, '91');
  assert.equal(missingAuthor.commands.some((command) => command.action === 'follow'), false);
  missingAuthor.dispatcher.endSession('test');

  const exhausted = startDispatcher({ hasReelFollow: true, randomFn });
  while (exhausted.dispatcher.consumeBudget('follow')) { /* exhaust the bounded session quota */ }
  reportReel(exhausted.dispatcher, '92', 'Bao');
  assert.equal(exhausted.commands.some((command) => command.action === 'follow'), false);
  exhausted.dispatcher.endSession('test');

  assert.equal(randomCalls, 3, '三例都只允许既有点赞掷骰，关注不得掷骰');
});

test('Facebook Reel follow: RiskController、动作冷却与作者去重逐层拦截', () => {
  const now = 1_000_000;
  const cooldownGate = new ActionCooldownGate({ startedAtMs: 0, restartQuietMs: 0 });
  cooldownGate.markActed('__unbound__', 'follow', now - 1_000);
  const guard = new InteractionGuard();
  guard.complete(InteractionGuard.keyFor('follow', { authorId: 'Bao' }));

  const cases = [
    startDispatcher({ hasReelFollow: true, randomFn: () => 0, canInteract: (action) => action !== 'follow' }),
    startDispatcher({ hasReelFollow: true, randomFn: () => 0, cooldownGate, clock: () => now }),
    startDispatcher({ hasReelFollow: true, randomFn: () => 0, interactionGuard: guard }),
  ];
  for (const [index, candidate] of cases.entries()) {
    reportReel(candidate.dispatcher, String(100 + index), 'Bao');
    assert.equal(candidate.commands.some((command) => command.action === 'follow'), false);
    candidate.dispatcher.endSession('test');
  }
});

test('Facebook Reel follow: 下发不扣配额，只有新关注成功回执扣一次', () => {
  const rolls = [FACEBOOK_REELS_LIKE_PROBABILITY, 0];
  const { dispatcher, commands } = startDispatcher({
    hasReelFollow: true,
    randomFn: () => rolls.shift() ?? 0.5,
  });
  const before = dispatcher.remainingFollows;
  reportReel(dispatcher, '120', 'Bao');
  assert.equal(commands.filter((command) => command.action === 'follow').length, 1);
  assert.equal(dispatcher.remainingFollows, before, '命令下发不乐观扣关注配额');

  dispatcher.bus.emit('action.completed', { action: 'follow', ok: true, ts: 1 });
  assert.equal(dispatcher.remainingFollows, before - 1, '真实新关注成功才扣一次');
  dispatcher.bus.emit('action.completed', { action: 'follow', ok: true, reason: 'already_followed', ts: 2 });
  assert.equal(dispatcher.remainingFollows, before - 1, 'already_followed 是 no-op，不重复扣额');
  dispatcher.endSession('test');
});

test('Facebook Feed video: 唯一安全视频 random < 0.25 时立即下发一次 note-scoped like 意图', () => {
  const { dispatcher, commands } = startDispatcher({ randomFn: () => FACEBOOK_REELS_LIKE_PROBABILITY - Number.EPSILON });
  reportFeedVideo(dispatcher, '1632570071375207', 'Cách nấu cá niêng trong ống tre ngon đến mức ăn quên no');

  const likes = commands.filter((command) => command.action === 'like');
  assert.equal(likes.length, 1);
  assert.equal(likes[0]?.reason, 'facebook_feed_video_probability_hit');
  assert.equal(likes[0]?.params?.noteId, 'https://www.facebook.com/watch?v=1632570071375207');
  dispatcher.endSession('test');
});

test('Facebook Feed video: random === 0.25、空摘要和明显高风险摘要均弃权且重报不重抽', () => {
  let randomCalls = 0;
  const { dispatcher, commands } = startDispatcher({ randomFn: () => { randomCalls++; return FACEBOOK_REELS_LIKE_PROBABILITY; } });
  reportFeedVideo(dispatcher, '100', 'safe cooking video');
  reportFeedVideo(dispatcher, '100', 'safe cooking video');
  reportFeedVideo(dispatcher, '200', '');
  reportFeedVideo(dispatcher, '200', 'now safe but duplicate');
  reportFeedVideo(dispatcher, '300', 'casino gambling highlights');
  reportFeedVideo(dispatcher, '300', 'now safe but duplicate');

  assert.equal(randomCalls, 1, '只有安全且有摘要的视频掷一次骰；安全缺口也占据一次性决策坑');
  assert.equal(commands.some((command) => command.action === 'like'), false);
  dispatcher.endSession('test');
});

test('Facebook Feed video: 一批可混有普通卡但必须恰好一个视频；多视频与非规范目标失败关闭', () => {
  let randomCalls = 0;
  const { dispatcher, commands } = startDispatcher({ randomFn: () => { randomCalls++; return 0.1; } });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [
      { ...feedVideoCard('401'), index: 1 },
      { index: 0, noteId: 'https://www.facebook.com/a/posts/400', title: 'text', likeCount: 0, collectCount: 0, isVideo: false },
    ],
    listKind: 'feed', ts: 1,
  });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [feedVideoCard('501'), feedVideoCard('502')], listKind: 'feed', ts: 2,
  });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ ...feedVideoCard('601'), noteId: 'https://evil.example/watch?v=601' }], listKind: 'feed', ts: 3,
  });

  assert.equal(randomCalls, 1);
  assert.equal(commands.filter((command) => command.action === 'like').length, 1);
  assert.equal(commands.find((command) => command.action === 'like')?.params?.noteId, 'https://www.facebook.com/watch?v=401');
  dispatcher.endSession('test');
});
