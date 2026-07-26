import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  PendingPublishPreview,
  PublishUiUpdateCommandInput,
} from '../../src/kernel/api-direct-port.js';
import {
  PublishUiUpdateCommandReceiver,
  PublishUiUpdateReceiptCapacityError,
} from '../../src/comm/publish-ui-update-command-receiver.js';

function preview(accountId = 'acct-1', contentVersion = 3): PendingPublishPreview {
  return {
    id: 41,
    accountId,
    platform: 'xiaohongshu',
    kind: 'generated',
    title: null,
    content: '正文',
    topics: ['周末'],
    images: ['https://cdn.test/1.jpg'],
    contentVersion,
    updatedAt: 1_750_000_000_000,
    publishMode: 'scheduled',
    publishTime: 1_750_000_600_000,
    sourceCuratedId: 9,
    imageReferenceAudit: {
      requestedCount: 2,
      usableCount: 1,
      generatedCount: 1,
      status: 'used',
    },
  };
}

function stateCommand(
  commandId: string,
  state: 'pending' | 'approved' | 'submitted' | 'rejected' | 'failed' = 'approved',
  factVersion = 3,
): PublishUiUpdateCommandInput {
  return {
    commandId,
    accountId: 'acct-1',
    update: {
      kind: 'state',
      recordId: 41,
      state,
      factVersion,
      title: '标题',
    },
  };
}

test('publish UI receiver applies preview and every admitted state only through UiSnapshotService', async () => {
  const calls: unknown[] = [];
  const receiver = new PublishUiUpdateCommandReceiver({
    uiSnapshot: {
      pushPublishPreview(accountId, input) {
        calls.push(['preview', accountId, input]);
      },
      pushPublishState(accountId, recordId, state, title) {
        calls.push(['state', accountId, recordId, state, title]);
      },
    },
  });

  const previewReceipt = await receiver.applyPublishUiUpdate({
    commandId: 'preview-1',
    accountId: 'acct-1',
    update: { kind: 'preview', preview: preview() },
  });
  assert.deepEqual(previewReceipt, {
    outcome: 'applied',
    commandId: 'preview-1',
    accountId: 'acct-1',
  });
  assert.deepEqual(calls[0], [
    'preview',
    'acct-1',
    {
      recordId: 41,
      code: '#41',
      kind: 'generated',
      title: '',
      content: '正文',
      topics: ['周末'],
      images: ['https://cdn.test/1.jpg'],
      contentVersion: 3,
      updatedAt: 1_750_000_000_000,
      imageReferenceAudit: {
        requestedCount: 2,
        usableCount: 1,
        generatedCount: 1,
        status: 'used',
      },
    },
  ]);

  for (const state of ['pending', 'approved', 'submitted', 'rejected', 'failed'] as const) {
    await receiver.applyPublishUiUpdate(stateCommand(`state-${state}`, state));
  }
  assert.deepEqual(
    calls.slice(1).map((call) => (call as unknown[])[3]),
    ['pending', 'approved', 'submitted', 'rejected', 'failed'],
  );
});

test('publish UI receiver deduplicates concurrent commands and rejects payload collisions', async () => {
  let calls = 0;
  const receiver = new PublishUiUpdateCommandReceiver({
    uiSnapshot: {
      pushPublishPreview() {
        calls += 1;
      },
      pushPublishState() {
        calls += 1;
      },
    },
  });
  const command = stateCommand('same-command');
  const [first, duplicate] = await Promise.all([
    receiver.applyPublishUiUpdate(command),
    receiver.applyPublishUiUpdate(command),
  ]);
  assert.equal(first.outcome, 'applied');
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(calls, 1);

  assert.deepEqual(
    await receiver.applyPublishUiUpdate(stateCommand('same-command', 'rejected')),
    {
      outcome: 'collision',
      commandId: 'same-command',
      accountId: 'acct-1',
    },
  );
  assert.equal(calls, 1);
});

test('publish UI receiver rejects a delayed older fact without regressing the snapshot', async () => {
  const calls: unknown[] = [];
  const receiver = new PublishUiUpdateCommandReceiver({
    uiSnapshot: {
      pushPublishPreview(accountId, input) {
        calls.push(['preview', accountId, input.contentVersion]);
      },
      pushPublishState(accountId, recordId, state, title) {
        calls.push(['state', accountId, recordId, state, title]);
      },
    },
  });

  assert.equal(
    (await receiver.applyPublishUiUpdate({
      commandId: 'preview-v10',
      accountId: 'acct-1',
      update: { kind: 'preview', preview: preview('acct-1', 10) },
    })).outcome,
    'applied',
  );
  assert.deepEqual(
    await receiver.applyPublishUiUpdate(
      stateCommand('state-v9', 'rejected', 9),
    ),
    {
      outcome: 'stale',
      commandId: 'state-v9',
      accountId: 'acct-1',
    },
  );
  assert.deepEqual(calls, [['preview', 'acct-1', 10]]);

  assert.equal(
    (await receiver.applyPublishUiUpdate(
      stateCommand('state-v10', 'rejected', 10),
    )).outcome,
    'applied',
  );
  assert.equal(calls.length, 2);
});

test('publish UI receiver rejects preview account mismatch before pushing or recording', async () => {
  let calls = 0;
  const receiver = new PublishUiUpdateCommandReceiver({
    uiSnapshot: {
      pushPublishPreview() {
        calls += 1;
      },
      pushPublishState() {
        calls += 1;
      },
    },
  });
  const invalid: PublishUiUpdateCommandInput = {
    commandId: 'preview-mismatch',
    accountId: 'acct-1',
    update: { kind: 'preview', preview: preview('acct-2') },
  };
  await assert.rejects(
    () => receiver.applyPublishUiUpdate(invalid),
    /publish_ui_update_account_mismatch/,
  );
  assert.equal(calls, 0);

  const repaired = await receiver.applyPublishUiUpdate({
    ...invalid,
    update: { kind: 'preview', preview: preview('acct-1') },
  });
  assert.equal(repaired.outcome, 'applied');
  assert.equal(calls, 1);
});

test('publish UI receiver keeps all old receipts and fails closed at exact capacity', async () => {
  let calls = 0;
  const receiver = new PublishUiUpdateCommandReceiver({
    uiSnapshot: {
      pushPublishPreview() {
        calls += 1;
      },
      pushPublishState() {
        calls += 1;
      },
    },
  });
  for (let index = 0; index < 1_024; index += 1) {
    const receipt = await receiver.applyPublishUiUpdate(
      stateCommand(`bounded-${index}`),
    );
    assert.equal(receipt.outcome, 'applied');
  }
  await assert.rejects(
    () => receiver.applyPublishUiUpdate(stateCommand('bounded-overflow')),
    PublishUiUpdateReceiptCapacityError,
  );
  assert.equal(
    (await receiver.applyPublishUiUpdate(stateCommand('bounded-0'))).outcome,
    'duplicate',
  );
  assert.equal(calls, 1_024);
});
