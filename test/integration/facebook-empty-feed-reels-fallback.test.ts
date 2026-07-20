import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/soul/types.js';

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

  const fallback = commands.filter((command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 1, '重复到底回执每场只能授权一次 Reels fallback');
  assert.equal(commands.some((command) => command.action === 'refresh' && command.reason === 'feed_exhausted_refresh'), false);
  dispatcher.endSession('test');
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
  inactive.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 4 });
  assert.equal(commands.some((command) => command.reason === 'empty_feed_reels_fallback'), false);
});
