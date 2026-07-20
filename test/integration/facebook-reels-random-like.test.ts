import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACEBOOK_REELS_LIKE_PROBABILITY,
  RoleDispatcher,
  type EdgeCommand,
} from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/soul/types.js';

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

function startDispatcher(options: {
  randomFn?: () => number;
  platform?: 'facebook' | 'xiaohongshu';
  canInteract?: () => boolean;
} = {}) {
  const commands: EdgeCommand[] = [];
  let llmCalls = 0;
  const dispatcher = new RoleDispatcher({
    soul,
    llm: { complete: async () => { llmCalls++; return '{"verdict":"skip","reason":"test"}'; } },
    accountPlatform: options.platform ?? 'facebook',
    randomFn: options.randomFn,
    canInteract: options.canInteract,
    sendCommand: (command) => commands.push(command),
  });
  dispatcher.setup();
  dispatcher.startSession();
  return { dispatcher, commands, llmCalls: () => llmCalls };
}

function reportReel(dispatcher: RoleDispatcher, id = '42'): void {
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [reelCard(id)],
    listKind: 'reels',
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
