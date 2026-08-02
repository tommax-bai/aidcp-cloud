import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  API_DIRECT_CONTRACT_VERSION,
  type AccountPersonaAuthorityPort,
  type AutomationConfigCommandsPort,
  type EnvironmentHandshakePort,
  type OffboardAdmissionLedgerPort,
  type StructuredNotificationDeliveryPort,
} from '../../src/kernel/api-direct-port.js';
import {
  ACCOUNT_PERSONA_ROUTES,
  AUTOMATION_CONFIG_COMMANDS_ROUTES,
  COMMENT_APPROVAL_POLICY_ROUTES,
  ENVIRONMENT_HANDSHAKE_ROUTES,
  FIRST_POST_PROGRESS_ROUTES,
  NOTIFICATION_CONTACTS_ROUTES,
  OFFBOARD_ADMISSION_LEDGER_ROUTES,
  STRUCTURED_NOTIFICATION_ROUTES,
  AccountPersonaHttpClient,
  AutomationConfigCommandsHttpClient,
  CommentApprovalPolicyHttpClient,
  EnvironmentHandshakeHttpClient,
  FirstPostProgressHttpClient,
  NotificationContactsHttpClient,
  OffboardAdmissionLedgerHttpClient,
  StructuredNotificationHttpClient,
  registerAccountPersonaRoutes,
  registerAutomationConfigCommandsRoutes,
  registerCommentApprovalPolicyRoutes,
  registerEnvironmentHandshakeRoutes,
  registerFirstPostProgressRoutes,
  registerNotificationContactsRoutes,
  registerOffboardAdmissionLedgerRoutes,
  registerStructuredNotificationRoutes,
} from '../../src/transport/api-aux-authority-http.js';
import {
  ApiDirectHttpError,
} from '../../src/transport/api-direct-http-common.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';

const TOKEN = 'api-aux-token';

test('aux authority route tables preserve independent 2/1/1/1/1/3/4/1 faces', () => {
  assert.equal(Object.keys(ACCOUNT_PERSONA_ROUTES).length, 2);
  assert.equal(Object.keys(ENVIRONMENT_HANDSHAKE_ROUTES).length, 1);
  assert.equal(Object.keys(COMMENT_APPROVAL_POLICY_ROUTES).length, 1);
  assert.equal(Object.keys(NOTIFICATION_CONTACTS_ROUTES).length, 1);
  assert.equal(Object.keys(FIRST_POST_PROGRESS_ROUTES).length, 1);
  assert.equal(Object.keys(AUTOMATION_CONFIG_COMMANDS_ROUTES).length, 3);
  // 3 写 + 1 读：撤权 hold 的读面与写面同属一本台账，故同组，不另开一组。
  assert.equal(Object.keys(OFFBOARD_ADMISSION_LEDGER_ROUTES).length, 4);
  assert.equal(Object.keys(STRUCTURED_NOTIFICATION_ROUTES).length, 1);
});

test('aux clients preserve persona, owner ack, offboard CAS receipt, and delivery truth', async () => {
  const calls: string[] = [];
  const persona: AccountPersonaAuthorityPort = {
    async generate(input) {
      calls.push(`persona:${input.idempotencyKey}`);
      return { ok: true, soulYaml: 'identity: Alice', identitySummary: 'Alice' };
    },
    async persist(accountId) {
      calls.push(`persist:${accountId}`);
      return { ok: true, firstPostOnboarding: true };
    },
  };
  const handshake: EnvironmentHandshakePort = {
    async registerHandshakeEnvironment(input) {
      calls.push(`handshake:${input.envKey}`);
    },
  };
  const config: AutomationConfigCommandsPort = {
    async countContactAttemptsToday(accountId) {
      calls.push(`count:${accountId}`);
      return 2;
    },
    async recordContactCommentAttempt(accountId) {
      calls.push(`attempt:${accountId}`);
    },
    async resolveFacebookContainerName(accountId) {
      calls.push(`container:${accountId}`);
    },
  };
  const offboard: OffboardAdmissionLedgerPort = {
    async reconcileActiveOffboardSnapshot(input) {
      calls.push(`reconcile:${input.commandId}`);
      return { outcome: 'applied', adopted: 1, released: 0 };
    },
    async claimPendingMaterializations(input) {
      calls.push(`claim:${input.commandId}`);
      return { outcome: 'applied', candidates: [] };
    },
    async recordMaterializationReceipt(input) {
      calls.push(`receipt:${input.commandId}`);
      return { outcome: 'applied', revision: input.expectedRevision + 1 };
    },
    async hasPendingRevocationHold(accountId) {
      calls.push(`hold:${accountId}`);
      return true;
    },
  };
  const notification: StructuredNotificationDeliveryPort = {
    async deliver(input) {
      calls.push(`deliver:${input.commandId}`);
      return { outcome: 'delivered', deliveryId: input.commandId };
    },
  };
  const server = new InternalHttpServer();
  registerAccountPersonaRoutes(server, persona, TOKEN, 'dev');
  registerEnvironmentHandshakeRoutes(server, handshake, TOKEN, 'dev');
  registerCommentApprovalPolicyRoutes(
    server,
    {
      async getAccountCommentMode(accountId) {
        calls.push(`policy:${accountId}`);
        return 'auto_approve_all';
      },
    },
    TOKEN,
    'dev',
  );
  registerNotificationContactsRoutes(
    server,
    {
      async appendEvents(accountId) {
        calls.push(`contacts:${accountId}`);
      },
    },
    TOKEN,
    'dev',
  );
  registerFirstPostProgressRoutes(
    server,
    {
      async getFirstPostProgress(accountId) {
        calls.push(`first-post:${accountId}`);
        return null;
      },
    },
    TOKEN,
    'dev',
  );
  registerAutomationConfigCommandsRoutes(server, config, TOKEN, 'dev');
  registerOffboardAdmissionLedgerRoutes(server, offboard, TOKEN, 'dev');
  registerStructuredNotificationRoutes(server, notification, TOKEN, 'dev');
  const port = await server.listen(0);
  try {
    const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
    const personaClient = new AccountPersonaHttpClient(http, TOKEN, 'dev');
    assert.equal(
      (await personaClient.generate({
        accountId: 'acct-1',
        platform: 'facebook',
        keywordSelections: ['travel'],
        idempotencyKey: 'persona-1',
      })).ok,
      true,
    );
    assert.equal(
      (await personaClient.persist('acct-1', 'identity: Alice', 'operator')).ok,
      true,
    );
    const handshakeClient = new EnvironmentHandshakeHttpClient(http, TOKEN, 'dev');
    await handshakeClient.registerHandshakeEnvironment({
      envKey: 'env-1',
      label: null,
      platform: 'facebook',
      accountId: 'acct-1',
    });
    const policyClient = new CommentApprovalPolicyHttpClient(http, TOKEN, 'dev');
    assert.equal(await policyClient.getAccountCommentMode('acct-1'), 'auto_approve_all');
    const contactsClient = new NotificationContactsHttpClient(http, TOKEN, 'dev');
    await contactsClient.appendEvents('acct-1', [
      { kind: 'follow', fromUser: 'Bob', content: '' },
    ]);
    const firstPostClient = new FirstPostProgressHttpClient(http, TOKEN, 'dev');
    assert.equal(await firstPostClient.getFirstPostProgress('acct-1'), null);
    const configClient = new AutomationConfigCommandsHttpClient(http, TOKEN, 'dev');
    assert.equal(await configClient.countContactAttemptsToday('acct-1'), 2);
    await configClient.recordContactCommentAttempt('acct-1', { source: 'scheduled' });
    await configClient.resolveFacebookContainerName(
      'acct-1',
      'https://facebook.test/groups/1',
      'Group One',
    );
    const offboardClient = new OffboardAdmissionLedgerHttpClient(http, TOKEN, 'dev');
    assert.deepEqual(
      await offboardClient.reconcileActiveOffboardSnapshot({
        commandId: 'reconcile-1',
        complete: true,
        observedAt: 100,
        rows: [],
      }),
      { outcome: 'applied', adopted: 1, released: 0 },
    );
    assert.deepEqual(
      await offboardClient.claimPendingMaterializations({
        commandId: 'claim-1',
        workerId: 'worker-1',
        limit: 10,
        now: 100,
        leaseMs: 1000,
      }),
      { outcome: 'applied', candidates: [] },
    );
    assert.deepEqual(
      await offboardClient.recordMaterializationReceipt({
        commandId: 'receipt-1',
        revocationId: 'revocation-1',
        claimToken: 'claim-token-1',
        expectedRevision: 1,
        result: { kind: 'binding_missing' },
      }),
      { outcome: 'applied', revision: 2 },
    );
    // 读面同组同往返。**这个布尔的方向要盯住**：`true` = 还挂着 hold = 不放行；
    // 跨进程这一跳一旦把失败降级成 false，正在被撤权的环境会被重新放开互动写。
    assert.equal(
      await offboardClient.hasPendingRevocationHold('acct-1'),
      true,
    );
    const notificationClient = new StructuredNotificationHttpClient(http, TOKEN, 'dev');
    assert.deepEqual(
      await notificationClient.deliver({
        commandId: 'notice-1',
        notification: {
          kind: 'operational_text',
          input: { route: 'account', accountId: 'acct-1', text: 'watchdog' },
        },
      }),
      { outcome: 'delivered', deliveryId: 'notice-1' },
    );
    assert.deepEqual(calls, [
      'persona:persona-1',
      'persist:acct-1',
      'handshake:env-1',
      'policy:acct-1',
      'contacts:acct-1',
      'first-post:acct-1',
      'count:acct-1',
      'attempt:acct-1',
      'container:acct-1',
      'reconcile:reconcile-1',
      'claim:claim-1',
      'receipt:receipt-1',
      'hold:acct-1',
      'deliver:notice-1',
    ]);
  } finally {
    await server.close();
  }
});

test('aux method parsers reject incomplete snapshots and unknown notification kinds before owner', async () => {
  let calls = 0;
  const server = new InternalHttpServer();
  registerOffboardAdmissionLedgerRoutes(
    server,
    {
      async reconcileActiveOffboardSnapshot() {
        calls += 1;
        return { outcome: 'applied', adopted: 0, released: 0 };
      },
      async claimPendingMaterializations() {
        calls += 1;
        return { outcome: 'applied', candidates: [] };
      },
      async recordMaterializationReceipt() {
        calls += 1;
        return { outcome: 'applied', revision: 1 };
      },
      async hasPendingRevocationHold() {
        calls += 1;
        return false;
      },
    },
    TOKEN,
    'dev',
  );
  registerStructuredNotificationRoutes(
    server,
    {
      async deliver(input) {
        calls += 1;
        return { outcome: 'delivered', deliveryId: input.commandId };
      },
    },
    TOKEN,
    'dev',
  );
  const port = await server.listen(0);
  try {
    const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
    const envelope = (input: unknown) => ({
      version: API_DIRECT_CONTRACT_VERSION,
      executionTarget: 'dev',
      input,
    });
    await assert.rejects(
      () =>
        http.callBearer(
          OFFBOARD_ADMISSION_LEDGER_ROUTES.reconcileActiveOffboardSnapshot,
          envelope({
            commandId: 'reconcile-1',
            complete: false,
            observedAt: 100,
            rows: [],
          }),
          TOKEN,
        ),
      (error: unknown) =>
        error instanceof InternalHttpError && error.code === 'api_direct_invalid_request',
    );
    await assert.rejects(
      () =>
        http.callBearer(
          STRUCTURED_NOTIFICATION_ROUTES.deliver,
          envelope({
            commandId: 'notice-1',
            notification: { kind: 'free_text_fallback', input: {} },
          }),
          TOKEN,
        ),
      (error: unknown) =>
        error instanceof InternalHttpError && error.code === 'api_direct_invalid_request',
    );
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test('mandatory pre-authorization notification survives the authenticated HTTP round-trip', async () => {
  const received: unknown[] = [];
  const server = new InternalHttpServer();
  registerStructuredNotificationRoutes(
    server,
    {
      async deliver(input) {
        received.push(input);
        return { outcome: 'delivered', deliveryId: input.commandId };
      },
    },
    TOKEN,
    'dev',
  );
  const port = await server.listen(0);
  try {
    const input = {
      commandId: 'mandatory-preauth-1',
      notification: {
        kind: 'mandatory_comment_pre_authorization' as const,
        input: {
          requestId: 'comment-preauth-1',
          noteId: 'note-preauth-1',
          text: '强制互动评论',
          accountId: 'acct-1',
          approvalSource: 'mandatory_persona' as const,
        },
      },
    };
    const client = new StructuredNotificationHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${port}`),
      TOKEN,
      'dev',
    );
    assert.deepEqual(await client.deliver(input), {
      outcome: 'delivered',
      deliveryId: 'mandatory-preauth-1',
    });
    assert.deepEqual(received, [input]);
  } finally {
    await server.close();
  }
});

test('notification ack loss is returned as delivery result unknown without auto-resend', async () => {
  const client = new StructuredNotificationHttpClient(
    new InternalHttpClient('http://127.0.0.1:1', { timeoutMs: 30 }),
    TOKEN,
    'dev',
  );
  assert.deepEqual(
    await client.deliver({
      commandId: 'notice-unknown',
      notification: {
        kind: 'operational_text',
        input: { route: 'default', text: 'alert' },
      },
    }),
    { outcome: 'unknown', reason: 'delivery_result_unknown' },
  );
});

test('offboard claim client 穷举校验 candidate；任何畸形回包都保持 result_unknown', async () => {
  const validCandidate = {
    revocationId: 'revocation-1',
    offboardId: 'offboard-1',
    envKey: 'env-1',
    userId: null,
    reason: 'environment_unbind',
    actor: null,
    unboundTerminalAllowed: false,
    requestedAt: 1_000,
    claimToken: 'claim-token-1',
    revision: 2,
    claimExpiresAt: 31_000,
  };
  const malformed: Array<[string, Record<string, unknown>]> = [
    ['revocationId', { revocationId: '' }],
    ['offboardId', { offboardId: '' }],
    ['envKey', { envKey: '' }],
    ['userId union', { userId: 1 }],
    ['userId empty', { userId: '' }],
    ['reason union', { reason: 'unknown_reason' }],
    ['actor union', { actor: false }],
    ['actor empty', { actor: '' }],
    ['unboundTerminalAllowed', { unboundTerminalAllowed: 'false' }],
    ['requestedAt negative', { requestedAt: -1 }],
    ['requestedAt fractional', { requestedAt: 1.5 }],
    ['requestedAt non-finite', { requestedAt: Number.POSITIVE_INFINITY }],
    ['claimToken', { claimToken: '' }],
    ['revision minimum', { revision: 0 }],
    ['revision integer', { revision: 1.5 }],
    ['claimExpiresAt negative', { claimExpiresAt: -1 }],
    ['claimExpiresAt fractional', { claimExpiresAt: 1.5 }],
    ['claimExpiresAt non-finite', { claimExpiresAt: Number.POSITIVE_INFINITY }],
  ];

  for (const [label, patch] of malformed) {
    const http = {
      async callBearer() {
        return {
          outcome: 'applied',
          candidates: [{ ...validCandidate, ...patch }],
        };
      },
    } as unknown as InternalHttpClient;
    const client = new OffboardAdmissionLedgerHttpClient(http, TOKEN, 'dev');
    await assert.rejects(
      () => client.claimPendingMaterializations({
        commandId: `claim-malformed-${label}`,
        workerId: 'worker-1',
        limit: 1,
        now: 100,
        leaseMs: 1_000,
      }),
      (error: unknown) =>
        error instanceof ApiDirectHttpError
        && error.code === 'api_authority_result_unknown',
      label,
    );
  }

  const validHttp = {
    async callBearer() {
      return { outcome: 'applied', candidates: [validCandidate] };
    },
  } as unknown as InternalHttpClient;
  const validClient = new OffboardAdmissionLedgerHttpClient(validHttp, TOKEN, 'dev');
  assert.deepEqual(
    await validClient.claimPendingMaterializations({
      commandId: 'claim-valid',
      workerId: 'worker-1',
      limit: 1,
      now: 100,
      leaseMs: 1_000,
    }),
    { outcome: 'applied', candidates: [validCandidate] },
  );
});
