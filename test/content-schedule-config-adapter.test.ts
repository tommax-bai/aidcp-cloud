import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAutomationConfigCommands } from '../src/config/content-schedule-store.js';

test('automation config commands 只转发三项 API-owner 操作并保留原始参数', async () => {
  const calls: unknown[][] = [];
  const port = createAutomationConfigCommands(
    {
      countContactAttemptsToday: async (accountId) => {
        calls.push(['count', accountId]);
        return 3;
      },
      recordContactCommentAttempt: async (accountId, audit) => {
        calls.push(['record', accountId, audit]);
      },
    },
    {
      resolveContainerName: async (accountId, url, name) => {
        calls.push(['container', accountId, url, name]);
      },
    },
  );

  assert.equal(await port.countContactAttemptsToday('account-1'), 3);
  await port.recordContactCommentAttempt('account-1', {
    source: 'hot_lead',
    noteId: 'note-1',
    velocity: 12,
    ageHours: 2,
  });
  await port.resolveFacebookContainerName('account-1', 'https://facebook.com/groups/1', '社区一');

  assert.deepEqual(calls, [
    ['count', 'account-1'],
    ['record', 'account-1', {
      source: 'hot_lead',
      noteId: 'note-1',
      velocity: 12,
      ageHours: 2,
    }],
    ['container', 'account-1', 'https://facebook.com/groups/1', '社区一'],
  ]);
  assert.deepEqual(Object.keys(port).sort(), [
    'countContactAttemptsToday',
    'recordContactCommentAttempt',
    'resolveFacebookContainerName',
  ]);
});
