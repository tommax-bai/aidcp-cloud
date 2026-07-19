import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delegatedTasksConflict, type DelegatedOwnershipTask } from '../../src/delegated-task/ownership.js';

function ownershipTask(overrides: Partial<DelegatedOwnershipTask> = {}): DelegatedOwnershipTask {
  return {
    id: 'task-1',
    accountId: 'account-1',
    actionFamily: 'publish',
    status: 'executing',
    sourceConstraints: { sourceId: 'source-1' },
    ...overrides,
  };
}

test('rewrite ownership is single-flight per account and source', () => {
  const candidate = ownershipTask();
  assert.equal(delegatedTasksConflict(candidate, ownershipTask({ id: 'same-source' })), true);
  assert.equal(delegatedTasksConflict(candidate, ownershipTask({ id: 'other-source', sourceConstraints: { sourceId: 'source-2' } })), false);
});

test('rewrite draft waiting approval does not retain generation ownership', () => {
  const candidate = ownershipTask();
  const waiting = ownershipTask({ id: 'waiting', status: 'waiting_approval' });
  assert.equal(delegatedTasksConflict(candidate, waiting), false);
});

test('rewrite and autonomous publishing use separate ownership lanes', () => {
  const rewrite = ownershipTask();
  const autonomous = ownershipTask({ id: 'autonomous', sourceConstraints: {} });
  assert.equal(delegatedTasksConflict(rewrite, autonomous), false);
  assert.equal(delegatedTasksConflict(autonomous, rewrite), false);
});

test('autonomous publishing and non-publish families remain account single-flight', () => {
  const autonomous = ownershipTask({ sourceConstraints: {} });
  assert.equal(delegatedTasksConflict(autonomous, ownershipTask({ id: 'auto-2', sourceConstraints: {} })), true);

  const comment = ownershipTask({ actionFamily: 'comment', sourceConstraints: {} });
  assert.equal(delegatedTasksConflict(comment, ownershipTask({ id: 'comment-2', actionFamily: 'comment', sourceConstraints: {} })), true);
});
