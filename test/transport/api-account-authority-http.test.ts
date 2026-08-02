import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  API_DIRECT_CONTRACT_VERSION,
  type AccountOwnershipAuthorityPort,
  type AccountRosterAuthorityPort,
  type AccountRuntimeAuthorityPort,
} from '../../src/kernel/api-direct-port.js';
import {
  ACCOUNT_OWNERSHIP_ROUTES,
  ACCOUNT_ROSTER_ROUTES,
  ACCOUNT_RUNTIME_ROUTES,
  AccountOwnershipHttpClient,
  AccountRosterHttpClient,
  AccountRuntimeHttpClient,
  registerAccountOwnershipRoutes,
  registerAccountRosterRoutes,
  registerAccountRuntimeRoutes,
} from '../../src/transport/api-account-authority-http.js';
import { ApiDirectHttpError } from '../../src/transport/api-direct-http-common.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';

const TOKEN = 'api-direct-account-token';

async function withAccountServer(
  run: (baseUrl: string, ownerCalls: string[]) => Promise<void>,
): Promise<void> {
  const ownerCalls: string[] = [];
  const roster: AccountRosterAuthorityPort = {
    async listAccountIdentities() {
      ownerCalls.push('listAccountIdentities');
      return [{
        accountId: 'acct-1',
        platform: 'facebook',
        groupLabel: 'north',
        createdAt: 1_700_000_000_000,
        status: 'active',
      }];
    },
  };
  const ownership: AccountOwnershipAuthorityPort = {
    async getExecutionTarget(accountId) {
      ownerCalls.push(`getExecutionTarget:${accountId}`);
      return 'dev';
    },
    async resolveExecutionTarget(accountId) {
      ownerCalls.push(`resolveExecutionTarget:${accountId}`);
      return { outcome: 'owned', target: 'dev' };
    },
    async setExecutionTarget(accountId, target) {
      ownerCalls.push(`setExecutionTarget:${accountId}:${target}`);
      return { outcome: 'claimed', target };
    },
  };
  const runtime: AccountRuntimeAuthorityPort = {
    async ensureAccount(accountId, platform) {
      ownerCalls.push(`ensureAccount:${accountId}:${platform ?? ''}`);
    },
    async getPlatformOrNull(accountId) {
      ownerCalls.push(`getPlatformOrNull:${accountId}`);
      return 'facebook';
    },
    async getContactInfo(accountId) {
      ownerCalls.push(`getContactInfo:${accountId}`);
      return null;
    },
    async recordNickname(accountId, nickname) {
      ownerCalls.push(`recordNickname:${accountId}:${nickname}`);
      return { outcome: 'updated', nickname };
    },
    async pauseAccount(accountId, reason) {
      ownerCalls.push(`pauseAccount:${accountId}:${reason}`);
    },
  };
  const server = new InternalHttpServer();
  registerAccountRosterRoutes(server, roster, TOKEN, 'dev');
  registerAccountOwnershipRoutes(server, ownership, TOKEN, 'dev');
  registerAccountRuntimeRoutes(server, runtime, TOKEN, 'dev');
  const port = await server.listen(0);
  try {
    await run(`http://127.0.0.1:${port}`, ownerCalls);
  } finally {
    await server.close();
  }
}

test('account 4a routes keep 1/3/4 method parity and omit claimExecutionTarget', async () => {
  assert.deepEqual(Object.keys(ACCOUNT_ROSTER_ROUTES), ['listAccountIdentities']);
  assert.deepEqual(Object.keys(ACCOUNT_OWNERSHIP_ROUTES), [
    'getExecutionTarget',
    'resolveExecutionTarget',
    'setExecutionTarget',
  ]);
  assert.deepEqual(Object.keys(ACCOUNT_RUNTIME_ROUTES), [
    'ensureAccount',
    'getPlatformOrNull',
    'getContactInfo',
    'recordNickname',
    'pauseAccount',
  ]);

  await withAccountServer(async (baseUrl, calls) => {
    const http = new InternalHttpClient(baseUrl);
    const roster = new AccountRosterHttpClient(http, TOKEN, 'dev');
    const ownership = new AccountOwnershipHttpClient(http, TOKEN, 'dev');
    const runtime = new AccountRuntimeHttpClient(http, TOKEN, 'dev');
    assert.equal((await roster.listAccountIdentities())[0]?.groupLabel, 'north');
    assert.equal(await ownership.getExecutionTarget('acct-1'), 'dev');
    assert.deepEqual(await ownership.resolveExecutionTarget('acct-1'), {
      outcome: 'owned',
      target: 'dev',
    });
    assert.deepEqual(await ownership.setExecutionTarget('acct-1', 'dev'), {
      outcome: 'claimed',
      target: 'dev',
    });
    await runtime.ensureAccount('acct-1', 'facebook');
    assert.equal(await runtime.getPlatformOrNull('acct-1'), 'facebook');
    assert.equal(await runtime.getContactInfo('acct-1'), null);
    assert.deepEqual(await runtime.recordNickname('acct-1', 'Alice'), {
      outcome: 'updated',
      nickname: 'Alice',
    });
    // 批 H：暂停账号。原因随命令一起过去 —— 属主要把它写进日志，
    // 缺了运营只会把这条暂停当成误操作。
    await runtime.pauseAccount('acct-1', 'join_failed');
    assert.equal(calls.at(-1), 'pauseAccount:acct-1:join_failed');
    assert.equal(calls.length, 9);
  });
});

test('account routes reject wrong bearer, version, and target before owner handlers', async () => {
  await withAccountServer(async (baseUrl, calls) => {
    const raw = new InternalHttpClient(baseUrl);
    const validInput = {
      version: API_DIRECT_CONTRACT_VERSION,
      executionTarget: 'dev',
      input: {},
    };
    await assert.rejects(
      () => raw.callBearer(ACCOUNT_ROSTER_ROUTES.listAccountIdentities, validInput, 'wrong-token'),
      (error: unknown) =>
        error instanceof InternalHttpError && error.code === 'internal_http_unauthorized',
    );
    await assert.rejects(
      () =>
        raw.callBearer(
          ACCOUNT_ROSTER_ROUTES.listAccountIdentities,
          { ...validInput, version: 2 },
          TOKEN,
        ),
      (error: unknown) =>
        error instanceof InternalHttpError && error.code === 'api_direct_version_unsupported',
    );
    await assert.rejects(
      () =>
        raw.callBearer(
          ACCOUNT_ROSTER_ROUTES.listAccountIdentities,
          { ...validInput, executionTarget: 'ol' },
          TOKEN,
        ),
      (error: unknown) =>
        error instanceof InternalHttpError && error.code === 'api_direct_target_mismatch',
    );
    await assert.rejects(
      () =>
        raw.callBearer(
          ACCOUNT_OWNERSHIP_ROUTES.setExecutionTarget,
          {
            version: API_DIRECT_CONTRACT_VERSION,
            executionTarget: 'dev',
            input: { accountId: 'acct-1', target: 'ol' },
          },
          TOKEN,
        ),
      (error: unknown) =>
        error instanceof InternalHttpError && error.code === 'api_direct_target_mismatch',
    );
    assert.deepEqual(calls, []);
  });
});

test('account clients separate malformed reads from write result unknown', async () => {
  const server = new InternalHttpServer();
  server.registerBearer(ACCOUNT_ROSTER_ROUTES.listAccountIdentities, TOKEN, async () => ({
    malformed: true,
  }));
  server.registerBearer(ACCOUNT_RUNTIME_ROUTES.recordNickname, TOKEN, async () => ({
    malformed: true,
  }));
  const port = await server.listen(0);
  try {
    const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
    await assert.rejects(
      () => new AccountRosterHttpClient(http, TOKEN, 'dev').listAccountIdentities(),
      (error: unknown) =>
        error instanceof ApiDirectHttpError && error.code === 'api_authority_bad_response',
    );
    await assert.rejects(
      () =>
        new AccountRuntimeHttpClient(http, TOKEN, 'dev').recordNickname(
          'acct-1',
          'Alice',
        ),
      (error: unknown) =>
        error instanceof ApiDirectHttpError && error.code === 'api_authority_result_unknown',
    );
  } finally {
    await server.close();
  }
});
