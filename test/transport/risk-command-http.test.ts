import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { RiskCommandPort } from '@kernel/kernel/risk-command-types.js';
import { InternalHttpClient, InternalHttpError, InternalHttpServer } from '@automation/transport/internal-http.js';
import {
  RISK_COMMAND_ROUTES,
  RiskCommandHttpClient,
  registerRiskCommandRoutes,
} from '@automation/transport/risk-command-http.js';

function localPort(calls: string[]): RiskCommandPort {
  return {
    async submitSignal() {
      calls.push('submitSignal');
      return { commandId: 'legacy-signal' };
    },
    async submitQuotaLevel() {
      calls.push('submitQuotaLevel');
      return { commandId: 'legacy-quota' };
    },
    async outcomeOf(commandId) {
      calls.push(`outcomeOf:${commandId}`);
      return { commandId, state: 'processing' };
    },
    async submitRestrictedRecovery(input) {
      calls.push(`submitRestrictedRecovery:${input.accountId}:${input.requestedBy}`);
      return { commandId: '42' };
    },
    async restrictedRecoveryOutcomeOf(commandId, envKey, accountId) {
      calls.push(`restrictedRecoveryOutcomeOf:${commandId}:${envKey}:${accountId}`);
      return {
        commandId,
        state: 'applied',
        risk: {
          accountId,
          status: 'normal',
          quotaLevel: 'normal',
          signalCount: 0,
          lastSignalAt: null,
          statusSince: 10,
          updatedAt: 20,
        },
        changed: true,
        resumedEdges: 1,
      };
    },
  };
}

async function loopback(serverTarget: string | undefined = 'dev') {
  const calls: string[] = [];
  const server = new InternalHttpServer();
  registerRiskCommandRoutes(server, localPort(calls), { executionTarget: serverTarget });
  const port = await server.listen(0);
  const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
  return { calls, server, http };
}

test('restricted recovery route/client 往返保留专用 submit 与 env+account-scoped outcome', async (t) => {
  const { calls, server, http } = await loopback();
  t.after(() => server.close());
  const client = new RiskCommandHttpClient(http, { executionTarget: 'dev' });

  assert.deepEqual(
    await client.submitRestrictedRecovery({
      envKey: 'env-1',
      accountId: 'acc-1',
      reason: 'customer recovery',
      requestedBy: 'customer:env-1',
    }),
    { commandId: '42' },
  );
  const outcome = await client.restrictedRecoveryOutcomeOf('42', 'env-1', 'acc-1');
  assert.equal(outcome.state, 'applied');
  assert.equal(outcome.state === 'applied' && outcome.risk.accountId, 'acc-1');
  assert.deepEqual(calls, [
    'submitRestrictedRecovery:acc-1:customer:env-1',
    'restrictedRecoveryOutcomeOf:42:env-1:acc-1',
  ]);
});

test('recovery route 在 owner 调用前拒绝未知版本、缺失 target 与跨 target', async (t) => {
  const { calls, server, http } = await loopback();
  t.after(() => server.close());

  await assert.rejects(
    http.call(RISK_COMMAND_ROUTES.submitRestrictedRecovery, {
      contractVersion: 999,
      executionTarget: 'dev',
      input: { envKey: 'env-1', accountId: 'acc-1', reason: 'recover', requestedBy: 'customer:env' },
    }),
    (err: unknown) =>
      err instanceof InternalHttpError && err.code === 'risk_command_contract_version_unsupported',
  );
  await assert.rejects(
    http.call(RISK_COMMAND_ROUTES.submitRestrictedRecovery, {
      contractVersion: 1,
      input: { envKey: 'env-1', accountId: 'acc-1', reason: 'recover', requestedBy: 'customer:env' },
    }),
    (err: unknown) => err instanceof InternalHttpError && err.code === 'risk_command_target_mismatch',
  );
  await assert.rejects(
    http.call(RISK_COMMAND_ROUTES.restrictedRecoveryOutcomeOf, {
      contractVersion: 1,
      executionTarget: 'ol',
      commandId: '42',
      envKey: 'env-1',
      accountId: 'acc-1',
    }),
    (err: unknown) => err instanceof InternalHttpError && err.code === 'risk_command_target_mismatch',
  );
  assert.deepEqual(calls, [], 'version/target 闸必须先于 owner 方法');
});

test('client 或 owner 未注入合法本地 target 时 fail-closed，不回落默认 target', async (t) => {
  const { calls, server, http } = await loopback('');
  t.after(() => server.close());
  const missingClientTarget = new RiskCommandHttpClient(http);

  await assert.rejects(
    async () =>
      missingClientTarget.submitRestrictedRecovery({
        envKey: 'env-1',
        accountId: 'acc-1',
        reason: 'recover',
        requestedBy: 'customer:env',
      }),
    (err: unknown) => err instanceof InternalHttpError && err.code === 'risk_command_target_unavailable',
  );

  const configuredClient = new RiskCommandHttpClient(http, { executionTarget: 'dev' });
  await assert.rejects(
    configuredClient.restrictedRecoveryOutcomeOf('42', 'env-1', 'acc-1'),
    (err: unknown) => err instanceof InternalHttpError && err.code === 'risk_command_target_unavailable',
  );
  assert.deepEqual(calls, []);
});

test('已有 signal/quota 三条 legacy route 形状保持兼容', async (t) => {
  const { calls, server, http } = await loopback();
  t.after(() => server.close());
  const client = new RiskCommandHttpClient(http);

  assert.deepEqual(
    await client.submitSignal({ accountId: 'acc-1', kind: 'manual_freeze', requestedBy: 'panel:alice' }),
    { commandId: 'legacy-signal' },
  );
  assert.deepEqual(await client.outcomeOf('legacy-signal'), {
    commandId: 'legacy-signal',
    state: 'processing',
  });
  assert.deepEqual(calls, ['submitSignal', 'outcomeOf:legacy-signal']);
});
