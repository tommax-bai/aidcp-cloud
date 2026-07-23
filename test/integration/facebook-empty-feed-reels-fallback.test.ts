import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/kernel/soul-types.js';

const soul: Soul = {
  identity: { name: 'Test', role: 'tester', background: 'test', tone: 'plain' },
  interests: { primary: ['video'], secondary: [], seed_keywords: [] },
};

const llm = { complete: async () => '{"verdict":"skip","reason":"test"}' };

test('Facebook 明确空 Feed：Cloud 每场只用现有 scroll 命令授权一次 Reels fallback', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('feed.empty.confirmed', { startupId: 'start-1', ts: 1 });
  dispatcher.bus.emit('feed.empty.confirmed', { startupId: 'start-1', ts: 2 });

  const fallback = commands.filter((command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 1, '重复空态报告不得多次导航 Reels');
  dispatcher.endSession('test');
});

test('Facebook 非空 Feed 确认到底：切 Reels、不 refresh，重复回执保持幂等', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 1 });
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 2 });
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 3 });

  const fallback = commands.filter((command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 1, '重复到底回执每场只能授权一次 Reels fallback');
  assert.equal(commands.some((command) => command.action === 'refresh' && command.reason === 'feed_exhausted_refresh'), false);
  dispatcher.endSession('test');
});

test('Facebook 首页物理卡连续不可上报：Cloud 每场只授权一次 Reels fallback', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('feed.present_unreportable.confirmed', { startupId: 'start-1', documentGeneration: 'doc-1', ts: 1 });
  dispatcher.bus.emit('feed.present_unreportable.confirmed', { startupId: 'start-1', documentGeneration: 'doc-1', ts: 2 });
  dispatcher.bus.emit('feed.empty.confirmed', { startupId: 'start-1', documentGeneration: 'doc-1', ts: 3 });

  const fallback = commands.filter((command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 1, '同场重复结构态及其后空态都不得再次导航 Reels');
  dispatcher.endSession('test');
});

test('Facebook Reels pending/no_target 只做两次兼容握手恢复，耗尽后释放等待新证据', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('feed.empty.confirmed', { ts: 1 });
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'reels_pending', ts: 2 });
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'no_target', ts: 3 });
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'reels_pending', ts: 4 });

  let fallback = commands.filter((command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 3, '首次授权后最多再真正下发两次恢复');

  dispatcher.bus.emit('feed.empty.confirmed', { ts: 5 });
  fallback = commands.filter((command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 4, '恢复耗尽后回 idle，新一轮页面证据可重新授权');
  dispatcher.endSession('test');
});

test('Facebook Reels 卡片到达才把 fallback 确认为完成，之后迟到失败不再重驱', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('feed.empty.confirmed', { ts: 1 });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: 'reel', likeCount: 0, collectCount: 0, noteId: 'https://www.facebook.com/reel/1' }],
    listKind: 'reels',
    ts: 2,
  });
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'reels_pending', ts: 3 });
  dispatcher.bus.emit('feed.empty.confirmed', { ts: 4 });

  const fallback = commands.filter((command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 1, '可读 Reels 卡确认后，迟到失败和旧空态均不得重导航');
  dispatcher.endSession('test');
});

test('Facebook fallback 被浏览配额或软暂停抑制时不进入 pending，保留后续授权资格', () => {
  const quotaCommands: EdgeCommand[] = [];
  const quota = new RoleDispatcher({
    soul,
    llm,
    accountPlatform: 'facebook',
    explainView: () => ({ allowed: false, reason: 'quota:minute', retryAfterMs: 60_000 }),
    setTimeoutFn: () => ({ id: 'quota-wake' }),
    clearTimeoutFn: () => {},
    sendCommand: (command) => quotaCommands.push(command),
  });
  quota.setup();
  quota.startSession();
  quota.bus.emit('feed.empty.confirmed', { ts: 1 });
  assert.equal(quotaCommands.some((command) => command.reason === 'empty_feed_reels_fallback'), false);
  quota.endSession('test');

  const pausedCommands: EdgeCommand[] = [];
  const paused = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => pausedCommands.push(command) });
  paused.setup();
  paused.startSession();
  paused.context.setBrowseSuspended(true);
  paused.bus.emit('feed.empty.confirmed', { ts: 2 });
  paused.context.setBrowseSuspended(false);
  paused.bus.emit('feed.empty.confirmed', { ts: 3 });
  const fallback = pausedCommands.filter((command) => command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 1, '准入恢复后同一证据仍可授权');
  paused.endSession('test');
});

test('非 Facebook 或非活跃会话不授权 Reels fallback', () => {
  const commands: EdgeCommand[] = [];
  const xhs = new RoleDispatcher({ soul, llm, accountPlatform: 'xiaohongshu', sendCommand: (command) => commands.push(command) });
  xhs.setup();
  xhs.startSession();
  xhs.bus.emit('feed.empty.confirmed', { ts: 1 });
  assert.equal(commands.some((command) => command.reason === 'empty_feed_reels_fallback'), false);
  xhs.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 2 });
  assert.equal(commands.some((command) => command.action === 'refresh' && command.reason === 'feed_exhausted_refresh'), true);
  xhs.endSession('test');

  const inactive = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  inactive.setup();
  inactive.bus.emit('feed.empty.confirmed', { ts: 3 });
  inactive.bus.emit('feed.present_unreportable.confirmed', { ts: 3 });
  inactive.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 4 });
  assert.equal(commands.some((command) => command.reason === 'empty_feed_reels_fallback'), false);
});
