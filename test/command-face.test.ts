import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createCommandFace,
  type EdgeResumeOutcome,
} from '../src/feishu/command-face.js';

function commandFace(options: {
  resume?: () => Promise<void>;
  edgeResume?: () => EdgeResumeOutcome | Promise<EdgeResumeOutcome>;
}) {
  const calls: string[] = [];
  const face = createCommandFace({
    account: {
      requireCommandAccount: async (accountId) => accountId ?? 'acct-1',
      getStatus: (accountId) => ({ accountId, status: 'active' }),
      pause: async () => {},
      resume: async () => {
        calls.push('account');
        await options.resume?.();
      },
      resumeEdgesForAccount: async () => {
        calls.push('edge');
        return options.edgeResume?.() ?? { state: 'applied', resumedEdges: 2 };
      },
    },
    bindChat: async () => {},
    delegate: async () => ({
      command: 'delegate',
      ok: true,
      title: 'ok',
      message: 'ok',
    }),
    publish: async () => ({
      ok: true,
      level: 'success',
      title: 'ok',
      message: 'ok',
    }),
    comment: async () => ({
      ok: true,
      level: 'success',
      title: 'ok',
      message: 'ok',
    }),
    dispatch: async (accountId, action) => ({
      accountId,
      dispatch: action === 'start' ? 'started' : 'stopped',
      changed: true,
      edgesOnline: 1,
    }),
    dispatchActive: () => true,
    managementChatIds: new Set(),
    logger: { log: () => {} },
  });
  return { face, calls };
}

test('resume does not send the Edge command when the API-owned account state write fails', async () => {
  const { face, calls } = commandFace({
    resume: async () => {
      throw new Error('account_state_write_failed');
    },
  });

  await assert.rejects(
    face.panelCommandActions.resume('acct-1'),
    /account_state_write_failed/,
  );
  assert.deepEqual(calls, ['account']);
});

test('resume reports active plus unknown without rollback or optimistic resumed count', async () => {
  const { face, calls } = commandFace({
    edgeResume: () => ({
      state: 'unknown',
      reason: 'edge_resume_result_unknown',
    }),
  });

  assert.deepEqual(await face.panelCommandActions.resume('acct-1'), {
    accountId: 'acct-1',
    status: 'active',
    accountState: 'active',
    edgeResume: 'unknown',
    reason: 'edge_resume_result_unknown',
  });
  assert.deepEqual(calls, ['account', 'edge']);
});

test('resume returns the owner receipt count only after both ordered steps apply', async () => {
  const { face, calls } = commandFace({
    edgeResume: () => ({ state: 'applied', resumedEdges: 3 }),
  });

  assert.deepEqual(await face.panelCommandActions.resume('acct-1'), {
    accountId: 'acct-1',
    status: 'active',
    accountState: 'active',
    edgeResume: 'applied',
    resumedEdges: 3,
  });
  assert.deepEqual(calls, ['account', 'edge']);
});

test('Feishu resume also exposes partial truth after account state has become active', async () => {
  const { face, calls } = commandFace({
    edgeResume: () => ({ state: 'failed', reason: 'owner_rejected' }),
  });

  await assert.rejects(
    async () => {
      await face.actions.resume?.('acct-1');
    },
    /已恢复为 active.*Edge 恢复结果为 failed.*owner_rejected/,
  );
  assert.deepEqual(calls, ['account', 'edge']);
});
