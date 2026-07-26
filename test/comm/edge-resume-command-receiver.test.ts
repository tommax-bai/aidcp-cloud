import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EdgeResumeCommandReceiver,
  EdgeResumeReceiptCapacityError,
} from '../../src/comm/edge-resume-command-receiver.js';

test('EdgeResumeCommandReceiver returns the real count and reuses it for duplicates', async () => {
  const calls: string[] = [];
  const receiver = new EdgeResumeCommandReceiver({
    wsServer: {
      resumeEdgesForAccount(accountId) {
        calls.push(accountId);
        return 2;
      },
    },
  });

  assert.deepEqual(
    await receiver.resumeEdgesForAccount({
      commandId: 'resume-1',
      accountId: 'acct-1',
    }),
    {
      outcome: 'applied',
      commandId: 'resume-1',
      accountId: 'acct-1',
      resumedEdges: 2,
    },
  );
  assert.deepEqual(
    await receiver.resumeEdgesForAccount({
      commandId: 'resume-1',
      accountId: 'acct-1',
    }),
    {
      outcome: 'duplicate',
      commandId: 'resume-1',
      accountId: 'acct-1',
      resumedEdges: 2,
    },
  );
  assert.deepEqual(calls, ['acct-1']);
});

test('EdgeResumeCommandReceiver rejects a commandId collision without touching WsServer', async () => {
  let calls = 0;
  const receiver = new EdgeResumeCommandReceiver({
    wsServer: {
      resumeEdgesForAccount() {
        calls++;
        return 1;
      },
    },
  });

  await receiver.resumeEdgesForAccount({
    commandId: 'resume-collision',
    accountId: 'acct-1',
  });
  assert.deepEqual(
    await receiver.resumeEdgesForAccount({
      commandId: 'resume-collision',
      accountId: 'acct-2',
    }),
    { outcome: 'collision', commandId: 'resume-collision' },
  );
  assert.equal(calls, 1);
});

test('EdgeResumeCommandReceiver coalesces concurrent equivalents', async () => {
  let calls = 0;
  let release!: (count: number) => void;
  const pending = new Promise<number>((resolve) => {
    release = resolve;
  });
  const receiver = new EdgeResumeCommandReceiver({
    wsServer: {
      resumeEdgesForAccount() {
        calls++;
        return pending as unknown as number;
      },
    },
  });

  const first = receiver.resumeEdgesForAccount({
    commandId: 'resume-concurrent',
    accountId: 'acct-1',
  });
  const duplicate = receiver.resumeEdgesForAccount({
    commandId: 'resume-concurrent',
    accountId: 'acct-1',
  });
  release(3);

  assert.equal((await first).outcome, 'applied');
  assert.deepEqual(await duplicate, {
    outcome: 'duplicate',
    commandId: 'resume-concurrent',
    accountId: 'acct-1',
    resumedEdges: 3,
  });
  assert.equal(calls, 1);
});

test('EdgeResumeCommandReceiver never turns an unavailable owner into resumedEdges=0', async () => {
  const receiver = new EdgeResumeCommandReceiver({ wsServer: null });
  await assert.rejects(
    receiver.resumeEdgesForAccount({
      commandId: 'resume-unavailable',
      accountId: 'acct-1',
    }),
    /edge_resume_owner_unavailable/,
  );
});

test('EdgeResumeCommandReceiver fails closed at capacity and retains old receipts', async () => {
  let calls = 0;
  const receiver = new EdgeResumeCommandReceiver({
    wsServer: {
      resumeEdgesForAccount() {
        calls++;
        return 1;
      },
    },
  });
  for (let index = 0; index < 1_024; index++) {
    await receiver.resumeEdgesForAccount({
      commandId: `resume-capacity-${index}`,
      accountId: 'acct-1',
    });
  }

  await assert.rejects(
    receiver.resumeEdgesForAccount({
      commandId: 'resume-capacity-overflow',
      accountId: 'acct-1',
    }),
    EdgeResumeReceiptCapacityError,
  );
  assert.equal(
    (await receiver.resumeEdgesForAccount({
      commandId: 'resume-capacity-0',
      accountId: 'acct-1',
    })).outcome,
    'duplicate',
  );
  assert.equal(calls, 1_024);
});
