import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  API_DIRECT_CONTRACT_VERSION,
  API_DIRECT_TOKEN_ENV,
  AUTOMATION_COMMAND_TOKEN_ENV,
  CONTENT_COMMAND_TOKEN_ENV,
  type EdgeResumeCommandPort,
  type FacebookScopeCommandPort,
  type PersonaGeneratorAuthorityPort,
} from '@kernel/kernel/api-direct-port.js';
import { ApiDirectHttpError } from '@automation/transport/api-direct-http-common.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '@automation/transport/internal-http.js';
import {
  EDGE_RESUME_COMMAND_ROUTES,
  FACEBOOK_SCOPE_COMMAND_ROUTES,
  PERSONA_GENERATOR_COMMAND_ROUTES,
  EdgeResumeCommandHttpClient,
  FacebookScopeCommandHttpClient,
  PersonaGeneratorCommandHttpClient,
  registerEdgeResumeCommandRoutes,
  registerFacebookScopeCommandRoutes,
  registerPersonaGeneratorCommandRoutes,
} from '@automation/transport/paired-command-http.js';

const AUTOMATION_TOKEN = 'automation-command-token';
const CONTENT_TOKEN = 'content-command-token';

test('4a command directions use separate token names and three admitted method slots', () => {
  assert.notEqual(API_DIRECT_TOKEN_ENV, AUTOMATION_COMMAND_TOKEN_ENV);
  assert.notEqual(API_DIRECT_TOKEN_ENV, CONTENT_COMMAND_TOKEN_ENV);
  assert.notEqual(AUTOMATION_COMMAND_TOKEN_ENV, CONTENT_COMMAND_TOKEN_ENV);
  assert.deepEqual(Object.keys(EDGE_RESUME_COMMAND_ROUTES), ['resumeEdgesForAccount']);
  assert.deepEqual(Object.keys(FACEBOOK_SCOPE_COMMAND_ROUTES), [
    'importTargets',
    'replaceTargetScopes',
  ]);
  assert.deepEqual(Object.keys(PERSONA_GENERATOR_COMMAND_ROUTES), ['generate']);
});

test('paired command clients preserve command ids, true counts, and owner receipts', async () => {
  const calls: string[] = [];
  const edge: EdgeResumeCommandPort = {
    async resumeEdgesForAccount(input) {
      calls.push(`edge:${input.commandId}`);
      return {
        outcome: 'applied',
        commandId: input.commandId,
        accountId: input.accountId,
        resumedEdges: 2,
      };
    },
  };
  const facebook: FacebookScopeCommandPort = {
    async importTargets(input) {
      calls.push(`import:${input.commandId}`);
      return {
        outcome: 'applied',
        commandId: input.commandId,
        result: { imported: 1, updated: 0, duplicate: 0, invalid: 0, rows: [] },
      };
    },
    async replaceTargetScopes(input) {
      calls.push(`replace:${input.commandId}`);
      return {
        outcome: 'applied',
        commandId: input.commandId,
        result: { ok: true, items: [] },
      };
    },
  };
  const persona: PersonaGeneratorAuthorityPort = {
    async generate(input) {
      calls.push(`persona:${input.idempotencyKey}`);
      return {
        outcome: 'applied',
        idempotencyKey: input.idempotencyKey,
        result: { ok: true, soulYaml: 'identity: Alice', identitySummary: 'Alice' },
      };
    },
  };
  const server = new InternalHttpServer();
  registerEdgeResumeCommandRoutes(server, edge, AUTOMATION_TOKEN, 'dev');
  registerFacebookScopeCommandRoutes(server, facebook, AUTOMATION_TOKEN, 'dev');
  registerPersonaGeneratorCommandRoutes(server, persona, CONTENT_TOKEN, 'dev');
  const port = await server.listen(0);
  try {
    const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
    const edgeClient = new EdgeResumeCommandHttpClient(http, AUTOMATION_TOKEN, 'dev');
    const facebookClient = new FacebookScopeCommandHttpClient(
      http,
      AUTOMATION_TOKEN,
      'dev',
    );
    const personaClient = new PersonaGeneratorCommandHttpClient(
      http,
      CONTENT_TOKEN,
      'dev',
    );
    const edgeReceipt = await edgeClient.resumeEdgesForAccount({
      commandId: 'edge-command-1',
      accountId: 'acct-1',
    });
    assert.notEqual(edgeReceipt.outcome, 'collision');
    if (edgeReceipt.outcome !== 'collision') {
      assert.equal(edgeReceipt.resumedEdges, 2);
    }
    assert.equal(
      (await facebookClient.importTargets({
        commandId: 'facebook-import-1',
        inputs: [{ url: 'https://facebook.test/groups/1' }],
        importBatch: null,
      })).outcome,
      'applied',
    );
    assert.equal(
      (await facebookClient.replaceTargetScopes({
        commandId: 'facebook-replace-1',
        groupUrls: ['https://facebook.test/groups/1'],
        accountGroupLabels: ['north'],
        updatedBy: 'operator',
      })).outcome,
      'applied',
    );
    assert.equal(
      (await personaClient.generate({
        idempotencyKey: 'persona-1',
        accountId: 'acct-1',
        keywordSelections: ['travel'],
        diversitySeed: 'seed-1',
      })).outcome,
      'applied',
    );
    assert.deepEqual(calls, [
      'edge:edge-command-1',
      'import:facebook-import-1',
      'replace:facebook-replace-1',
      'persona:persona-1',
    ]);
  } finally {
    await server.close();
  }
});

test('paired command routes reject bearer/version/target before owner mutation', async () => {
  let calls = 0;
  const server = new InternalHttpServer();
  registerEdgeResumeCommandRoutes(
    server,
    {
      async resumeEdgesForAccount(input) {
        calls += 1;
        return {
          outcome: 'applied',
          commandId: input.commandId,
          accountId: input.accountId,
          resumedEdges: 0,
        };
      },
    },
    AUTOMATION_TOKEN,
    'dev',
  );
  const port = await server.listen(0);
  try {
    const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
    const base = {
      version: API_DIRECT_CONTRACT_VERSION,
      executionTarget: 'dev',
      input: { commandId: 'cmd-1', accountId: 'acct-1' },
    };
    for (const invoke of [
      () =>
        http.callBearer(
          EDGE_RESUME_COMMAND_ROUTES.resumeEdgesForAccount,
          base,
          'wrong-token',
        ),
      () =>
        http.callBearer(
          EDGE_RESUME_COMMAND_ROUTES.resumeEdgesForAccount,
          { ...base, version: 2 },
          AUTOMATION_TOKEN,
        ),
      () =>
        http.callBearer(
          EDGE_RESUME_COMMAND_ROUTES.resumeEdgesForAccount,
          { ...base, executionTarget: 'ol' },
          AUTOMATION_TOKEN,
        ),
    ]) {
      await assert.rejects(
        invoke,
        (error: unknown) =>
          error instanceof InternalHttpError &&
          (error.code === 'internal_http_unauthorized' ||
            error.code === 'api_direct_version_unsupported' ||
            error.code === 'api_direct_target_mismatch'),
      );
    }
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test('paired command transport failures remain capability-specific result unknown', async () => {
  const http = new InternalHttpClient('http://127.0.0.1:1', { timeoutMs: 30 });
  await assert.rejects(
    () =>
      new EdgeResumeCommandHttpClient(http, AUTOMATION_TOKEN, 'dev')
        .resumeEdgesForAccount({ commandId: 'edge-unknown', accountId: 'acct-1' }),
    (error: unknown) =>
      error instanceof ApiDirectHttpError &&
      error.code === 'edge_resume_result_unknown',
  );
  await assert.rejects(
    () =>
      new FacebookScopeCommandHttpClient(http, AUTOMATION_TOKEN, 'dev')
        .replaceTargetScopes({
          commandId: 'facebook-unknown',
          groupUrls: [],
          accountGroupLabels: [],
          updatedBy: 'operator',
        }),
    (error: unknown) =>
      error instanceof ApiDirectHttpError &&
      error.code === 'facebook_scope_result_unknown',
  );
  await assert.rejects(
    () =>
      new PersonaGeneratorCommandHttpClient(http, CONTENT_TOKEN, 'dev').generate({
        idempotencyKey: 'persona-unknown',
        accountId: 'acct-1',
        keywordSelections: ['travel'],
      }),
    (error: unknown) =>
      error instanceof ApiDirectHttpError &&
      error.code === 'persona_generation_result_unknown',
  );
});

test('paired command clients bind receipts to request identity and deeply validate result rows', async () => {
  const server = new InternalHttpServer();
  server.registerBearer(
    EDGE_RESUME_COMMAND_ROUTES.resumeEdgesForAccount,
    AUTOMATION_TOKEN,
    async () => ({
      outcome: 'applied',
      commandId: 'different-edge-command',
      accountId: 'different-account',
      resumedEdges: 2,
    }),
  );
  server.registerBearer(
    FACEBOOK_SCOPE_COMMAND_ROUTES.importTargets,
    AUTOMATION_TOKEN,
    async () => ({
      outcome: 'applied',
      commandId: 'facebook-import-identity',
      result: {
        imported: 1,
        updated: 0,
        duplicate: 0,
        invalid: 0,
        rows: [{
          groupUrl: 'https://facebook.test/groups/1',
          groupName: null,
          region: null,
          park: null,
          direction: null,
          joinGating: 'unknown',
          priority: 0,
          enabled: true,
          importBatch: null,
          createdAt: '2026-07-26T00:00:00.000Z',
          updatedAt: '2026-07-26T00:00:00.000Z',
          accountGroupLabels: [42],
        }],
      },
    }),
  );
  server.registerBearer(
    FACEBOOK_SCOPE_COMMAND_ROUTES.replaceTargetScopes,
    AUTOMATION_TOKEN,
    async () => ({
      outcome: 'duplicate',
      commandId: 'different-facebook-command',
      result: { ok: true, items: [] },
    }),
  );
  server.registerBearer(
    PERSONA_GENERATOR_COMMAND_ROUTES.generate,
    CONTENT_TOKEN,
    async () => ({
      outcome: 'applied',
      idempotencyKey: 'different-persona-key',
      result: { ok: false, reason: 'arbitrary_owner_reason' },
    }),
  );

  const port = await server.listen(0);
  try {
    const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
    await assert.rejects(
      () => new EdgeResumeCommandHttpClient(http, AUTOMATION_TOKEN, 'dev')
        .resumeEdgesForAccount({
          commandId: 'edge-identity',
          accountId: 'account-identity',
        }),
      (error: unknown) =>
        error instanceof ApiDirectHttpError &&
        error.code === 'edge_resume_result_unknown',
    );
    const facebook = new FacebookScopeCommandHttpClient(
      http,
      AUTOMATION_TOKEN,
      'dev',
    );
    await assert.rejects(
      () => facebook.importTargets({
        commandId: 'facebook-import-identity',
        inputs: [{ url: 'https://facebook.test/groups/1' }],
        importBatch: null,
      }),
      (error: unknown) =>
        error instanceof ApiDirectHttpError &&
        error.code === 'facebook_scope_result_unknown',
    );
    await assert.rejects(
      () => facebook.replaceTargetScopes({
        commandId: 'facebook-replace-identity',
        groupUrls: [],
        accountGroupLabels: [],
        updatedBy: 'operator',
      }),
      (error: unknown) =>
        error instanceof ApiDirectHttpError &&
        error.code === 'facebook_scope_result_unknown',
    );
    await assert.rejects(
      () => new PersonaGeneratorCommandHttpClient(http, CONTENT_TOKEN, 'dev')
        .generate({
          idempotencyKey: 'persona-identity',
          accountId: 'account-identity',
          keywordSelections: ['travel'],
        }),
      (error: unknown) =>
        error instanceof ApiDirectHttpError &&
        error.code === 'persona_generation_result_unknown',
    );
  } finally {
    await server.close();
  }
});

test('paired command clients reject malformed false variants with matching identities', async () => {
  const server = new InternalHttpServer();
  server.registerBearer(
    FACEBOOK_SCOPE_COMMAND_ROUTES.replaceTargetScopes,
    AUTOMATION_TOKEN,
    async () => ({
      outcome: 'applied',
      commandId: 'facebook-invalid-reason',
      result: { ok: false, reason: 'not_a_contract_reason' },
    }),
  );
  server.registerBearer(
    PERSONA_GENERATOR_COMMAND_ROUTES.generate,
    CONTENT_TOKEN,
    async () => ({
      outcome: 'duplicate',
      idempotencyKey: 'persona-invalid-reason',
      result: { ok: false, reason: 'not_a_contract_reason' },
    }),
  );
  const port = await server.listen(0);
  try {
    const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
    await assert.rejects(
      () => new FacebookScopeCommandHttpClient(http, AUTOMATION_TOKEN, 'dev')
        .replaceTargetScopes({
          commandId: 'facebook-invalid-reason',
          groupUrls: [],
          accountGroupLabels: [],
          updatedBy: 'operator',
        }),
      (error: unknown) =>
        error instanceof ApiDirectHttpError &&
        error.code === 'facebook_scope_result_unknown',
    );
    await assert.rejects(
      () => new PersonaGeneratorCommandHttpClient(http, CONTENT_TOKEN, 'dev')
        .generate({
          idempotencyKey: 'persona-invalid-reason',
          accountId: 'account-identity',
          keywordSelections: ['travel'],
        }),
      (error: unknown) =>
        error instanceof ApiDirectHttpError &&
        error.code === 'persona_generation_result_unknown',
    );
  } finally {
    await server.close();
  }
});
