import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scheduledContactCommentLabel,
  scheduledContactCommentOptions,
} from '../../src/orchestrator/content-scheduler.js';

test('Facebook 自动联系动作对齐 /comment --join --contact', () => {
  assert.equal(scheduledContactCommentLabel('facebook'), '加群评论（联系）');
  assert.deepEqual(scheduledContactCommentOptions('facebook', 'review'), {
    injectContact: true,
    priority: 'automatic',
    approvalMode: 'review',
    joinFirst: true,
  });
});

test('非 Facebook 自动联系动作维持既有联系评论，不隐式加群', () => {
  assert.equal(scheduledContactCommentLabel('xiaohongshu'), '联系评论');
  assert.deepEqual(scheduledContactCommentOptions('xiaohongshu', 'auto_approve'), {
    injectContact: true,
    priority: 'automatic',
    approvalMode: 'auto_approve',
  });
});
