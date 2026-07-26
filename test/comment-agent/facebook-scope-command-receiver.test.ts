import assert from 'node:assert/strict';
import test from 'node:test';
import { FacebookGroupScopeError } from '../../src/kernel/facebook-group-types.js';
import type {
  FacebookGroupImportResult,
  ReplaceFacebookGroupTargetScopesResult,
} from '../../src/kernel/facebook-group-types.js';
import {
  FacebookRosterRefreshError,
  FacebookScopeCommandReceiver,
  FacebookScopeReceiptCapacityError,
  type FacebookScopeCommandOwner,
} from '../../src/comment-agent/facebook-scope-command-receiver.js';

const IMPORT_RESULT: FacebookGroupImportResult = {
  imported: 1,
  updated: 0,
  duplicate: 0,
  invalid: 0,
  rows: [],
};

const REPLACE_RESULT: ReplaceFacebookGroupTargetScopesResult = {
  ok: true,
  items: [],
};

function ownerStub(overrides: Partial<FacebookScopeCommandOwner> = {}): FacebookScopeCommandOwner {
  return {
    async importTargets() {
      return IMPORT_RESULT;
    },
    async replaceTargetScopes() {
      return REPLACE_RESULT;
    },
    ...overrides,
  };
}

test('FacebookScopeCommandReceiver preserves a direct owner result and dedupes it', async () => {
  let writes = 0;
  let refreshes = 0;
  const receiver = new FacebookScopeCommandReceiver({
    owner: ownerStub({
      async importTargets() {
        writes++;
        return IMPORT_RESULT;
      },
    }),
    async refreshAccountProjection() {
      refreshes++;
      return { ok: true, rows: 2 };
    },
  });
  const input = {
    commandId: 'facebook-import-1',
    inputs: [{ url: 'https://www.facebook.com/groups/group-a' }],
    importBatch: 'batch-1',
    options: { accountGroupLabels: ['招聘组'], updatedBy: 'panel:alice' },
  };

  assert.equal((await receiver.importTargets(input)).outcome, 'applied');
  assert.equal((await receiver.importTargets(input)).outcome, 'duplicate');
  assert.equal(writes, 1);
  assert.equal(refreshes, 0);
});

test('FacebookScopeCommandReceiver uses one refresh-before-reject helper for import and replace', async () => {
  const sequence: string[] = [];
  let importAttempts = 0;
  let replaceAttempts = 0;
  const receiver = new FacebookScopeCommandReceiver({
    owner: ownerStub({
      async importTargets() {
        sequence.push('import-owner');
        if (importAttempts++ === 0) {
          throw new FacebookGroupScopeError('invalid_account_group');
        }
        return IMPORT_RESULT;
      },
      async replaceTargetScopes() {
        sequence.push('replace-owner');
        if (replaceAttempts++ === 0) {
          throw new FacebookGroupScopeError('invalid_account_group');
        }
        return REPLACE_RESULT;
      },
    }),
    async refreshAccountProjection() {
      sequence.push('refresh');
      return { ok: true, rows: 2 };
    },
  });

  assert.equal(
    (await receiver.importTargets({
      commandId: 'facebook-import-refresh',
      inputs: [{ url: 'https://www.facebook.com/groups/group-a' }],
      importBatch: null,
      options: { accountGroupLabels: ['招聘组'] },
    })).outcome,
    'applied',
  );
  assert.equal(
    (await receiver.replaceTargetScopes({
      commandId: 'facebook-replace-refresh',
      groupUrls: ['https://www.facebook.com/groups/group-a'],
      accountGroupLabels: ['招聘组'],
      updatedBy: 'panel:alice',
    })).outcome,
    'applied',
  );
  assert.deepEqual(sequence, [
    'import-owner',
    'refresh',
    'import-owner',
    'replace-owner',
    'refresh',
    'replace-owner',
  ]);
});

test('FacebookScopeCommandReceiver stops before a retry when roster refresh is not proven', async () => {
  let ownerCalls = 0;
  const receiver = new FacebookScopeCommandReceiver({
    owner: ownerStub({
      async replaceTargetScopes() {
        ownerCalls++;
        throw new FacebookGroupScopeError('invalid_account_group');
      },
    }),
    async refreshAccountProjection() {
      return { ok: false, reason: 'empty_roster' };
    },
  });

  await assert.rejects(
    receiver.replaceTargetScopes({
      commandId: 'facebook-refresh-failed',
      groupUrls: ['https://www.facebook.com/groups/group-a'],
      accountGroupLabels: ['招聘组'],
      updatedBy: 'panel:alice',
    }),
    (error: unknown) =>
      error instanceof FacebookRosterRefreshError
      && error.reason === 'empty_roster',
  );
  assert.equal(ownerCalls, 1);
});

test('FacebookScopeCommandReceiver rejects collisions and coalesces concurrent writes', async () => {
  let calls = 0;
  let release!: (result: FacebookGroupImportResult) => void;
  const pending = new Promise<FacebookGroupImportResult>((resolve) => {
    release = resolve;
  });
  const receiver = new FacebookScopeCommandReceiver({
    owner: ownerStub({
      async importTargets() {
        calls++;
        return pending;
      },
    }),
    async refreshAccountProjection() {
      return { ok: true, rows: 1 };
    },
  });
  const input = {
    commandId: 'facebook-concurrent',
    inputs: [{ url: 'https://www.facebook.com/groups/group-a', name: 'A' }],
    importBatch: null,
  };

  const first = receiver.importTargets(input);
  const duplicate = receiver.importTargets({
    importBatch: null,
    inputs: [{ name: 'A', url: 'https://www.facebook.com/groups/group-a' }],
    commandId: 'facebook-concurrent',
  });
  assert.deepEqual(
    await receiver.importTargets({
      ...input,
      inputs: [{ url: 'https://www.facebook.com/groups/group-b' }],
    }),
    { outcome: 'collision', commandId: 'facebook-concurrent' },
  );
  release(IMPORT_RESULT);

  assert.equal((await first).outcome, 'applied');
  assert.equal((await duplicate).outcome, 'duplicate');
  assert.equal(calls, 1);
});

test('FacebookScopeCommandReceiver fails closed at capacity and retains old receipts', async () => {
  let writes = 0;
  const receiver = new FacebookScopeCommandReceiver({
    owner: ownerStub({
      async importTargets() {
        writes++;
        return IMPORT_RESULT;
      },
    }),
    async refreshAccountProjection() {
      return { ok: true, rows: 1 };
    },
  });
  for (let index = 0; index < 1_024; index++) {
    await receiver.importTargets({
      commandId: `facebook-capacity-${index}`,
      inputs: [{ url: 'https://www.facebook.com/groups/group-a' }],
      importBatch: null,
    });
  }

  await assert.rejects(
    receiver.importTargets({
      commandId: 'facebook-capacity-overflow',
      inputs: [{ url: 'https://www.facebook.com/groups/group-a' }],
      importBatch: null,
    }),
    FacebookScopeReceiptCapacityError,
  );
  assert.equal(
    (await receiver.importTargets({
      commandId: 'facebook-capacity-0',
      inputs: [{ url: 'https://www.facebook.com/groups/group-a' }],
      importBatch: null,
    })).outcome,
    'duplicate',
  );
  assert.equal(writes, 1_024);
});
