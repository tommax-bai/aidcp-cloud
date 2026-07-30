/**
 * 期1-4 托管自动化入口 HTTP 传输层单测：三路由往返 / 鉴权失败 / 总开关判定与
 * 「关闭 = 不注册 → route_not_found」/ 信封版本与 target 校验。
 * 服务层用本地桩（记录收到的 target 与 payload），不建库。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionTarget } from '../../src/managed-automation/contracts/common.js';
import type {
  CancelTaskProposal,
  CreateTaskProposal,
  QueryTaskRequest,
} from '../../src/managed-automation/contracts/agent-intents.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';
import {
  MANAGED_AUTOMATION_API_ENV,
  MANAGED_AUTOMATION_CONTRACT_VERSION,
  MANAGED_AUTOMATION_ROUTES,
  ManagedAutomationHttpClient,
  isManagedAutomationApiEnabled,
  registerManagedAutomationRoutes,
  type ManagedAutomationEntryPort,
} from '../../src/transport/managed-automation-http.js';

const TOKEN = 'test-managed-automation-token';

const createProposal = (): CreateTaskProposal => ({
  kind: 'create_task',
  conversationMessageId: null,
  correlationId: 'corr-http',
  proposedAt: 1,
  accountId: 'acc-1',
  platform: 'xiaohongshu',
  taskDefinitionId: 'def-1',
  taskDefinitionVersion: 1,
  requestedCapabilityScope: { allow: [], deny: [] },
  requestedAuthorization: {},
  constraints: {},
  budgets: { platformRisk: null, executionResource: null, aiContent: null },
  schedule: { scheduledAt: 1_000, latestStartAt: 2_000, missPolicy: 'skip' },
  planId: null,
  cycleId: null,
});

const cancelProposal = (taskId: string): CancelTaskProposal => ({
  kind: 'cancel_task',
  conversationMessageId: null,
  correlationId: 'corr-http',
  proposedAt: 2,
  taskId,
  reason: null,
});

const queryRequest = (taskId: string): QueryTaskRequest => ({
  kind: 'query_task',
  conversationMessageId: null,
  correlationId: 'corr-http',
  proposedAt: 3,
  taskId,
  accountId: null,
  include: { runs: true, attempts: false, traces: false },
});

/** 记录调用的服务桩：断言传输层注入的 target 与透传的 payload。 */
function stubService() {
  const calls: { method: string; target: ExecutionTarget; payload: unknown }[] = [];
  const port: ManagedAutomationEntryPort = {
    createTask: async (target, proposal) => {
      calls.push({ method: 'createTask', target, payload: proposal });
      return {
        accepted: true, taskId: 'task-1', revisionId: 'rev-1',
        executionPlanId: 'plan-1', runId: 'run-1', runStatus: 'queued',
      };
    },
    cancelTask: async (target, proposal) => {
      calls.push({ method: 'cancelTask', target, payload: proposal });
      return { accepted: true, taskId: proposal.taskId, cancelRequestedRunIds: ['run-1'], alreadyTerminalRunIds: [] };
    },
    queryTask: async (target, request) => {
      calls.push({ method: 'queryTask', target, payload: request });
      return { found: false, reasonCode: 'invalid_task_proposal', detail: `task_id=${request.taskId} 不存在` };
    },
  };
  return { calls, port };
}

async function withServer(
  run: (ctx: {
    client: ManagedAutomationHttpClient;
    raw: InternalHttpClient;
    calls: ReturnType<typeof stubService>['calls'];
  }) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  const { calls, port } = stubService();
  registerManagedAutomationRoutes(server, port, { executionTarget: 'dev', bearerToken: TOKEN });
  const listenPort = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${listenPort}`);
  const client = new ManagedAutomationHttpClient(raw, TOKEN, 'dev');
  try {
    await run({ client, raw, calls });
  } finally {
    await server.close();
  }
}

test('总开关：仅字面 true 开启（默认关闭，fail-closed）', () => {
  assert.equal(isManagedAutomationApiEnabled({}), false);
  assert.equal(isManagedAutomationApiEnabled({ [MANAGED_AUTOMATION_API_ENV]: 'true' }), true);
  assert.equal(isManagedAutomationApiEnabled({ [MANAGED_AUTOMATION_API_ENV]: 'TRUE' }), false);
  assert.equal(isManagedAutomationApiEnabled({ [MANAGED_AUTOMATION_API_ENV]: '1' }), false);
  assert.equal(isManagedAutomationApiEnabled({ [MANAGED_AUTOMATION_API_ENV]: '' }), false);
});

test('开关关闭 = 组合根不注册 → 三路由一律 route_not_found（API 明确不可用）', async () => {
  const server = new InternalHttpServer();
  // 模拟组合根开关关闭分支：不调 registerManagedAutomationRoutes。
  const listenPort = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${listenPort}`);
  try {
    for (const route of Object.values(MANAGED_AUTOMATION_ROUTES)) {
      await assert.rejects(
        () => raw.callBearer(route, {}, TOKEN),
        (err: unknown) => err instanceof InternalHttpError && err.code === 'route_not_found',
        `路由 ${route} 未注册时必须回 route_not_found`,
      );
    }
  } finally {
    await server.close();
  }
});

test('create：客户端信封往返，服务端注入 target，payload 原样透传', async () => {
  await withServer(async ({ client, calls }) => {
    const out = await client.createTask(createProposal());
    assert.ok(out.accepted);
    assert.equal(out.runStatus, 'queued');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'createTask');
    assert.equal(calls[0].target, 'dev');
    assert.deepEqual(calls[0].payload, createProposal());
  });
});

test('cancel + query：路由各自命中，返回值形状透传', async () => {
  await withServer(async ({ client, calls }) => {
    const cancelled = await client.cancelTask(cancelProposal('task-9'));
    assert.ok(cancelled.accepted);
    assert.deepEqual(cancelled.cancelRequestedRunIds, ['run-1']);
    const queried = await client.queryTask(queryRequest('task-9'));
    assert.ok(!queried.found);
    assert.deepEqual(calls.map((c) => c.method), ['cancelTask', 'queryTask']);
  });
});

test('鉴权失败：token 不符 → internal_http_unauthorized，服务层不被触达', async () => {
  await withServer(async ({ raw, calls }) => {
    const badClient = new ManagedAutomationHttpClient(raw, 'wrong-token', 'dev');
    await assert.rejects(
      () => badClient.createTask(createProposal()),
      (err: unknown) => err instanceof InternalHttpError && err.code === 'internal_http_unauthorized',
    );
    assert.equal(calls.length, 0, '鉴权失败不得触达服务层');
  });
});

test('信封校验：版本不符 → protocol_version_mismatch；target 不符 → execution_target_mismatch；缺 payload → invalid_task_proposal', async () => {
  await withServer(async ({ raw, calls }) => {
    await assert.rejects(
      () => raw.callBearer(MANAGED_AUTOMATION_ROUTES.createTask, {
        version: 2, executionTarget: 'dev', payload: createProposal(),
      }, TOKEN),
      (err: unknown) => err instanceof InternalHttpError && err.code === 'protocol_version_mismatch',
    );
    await assert.rejects(
      () => raw.callBearer(MANAGED_AUTOMATION_ROUTES.createTask, {
        version: MANAGED_AUTOMATION_CONTRACT_VERSION, executionTarget: 'ol', payload: createProposal(),
      }, TOKEN),
      (err: unknown) => err instanceof InternalHttpError && err.code === 'execution_target_mismatch',
    );
    await assert.rejects(
      () => raw.callBearer(MANAGED_AUTOMATION_ROUTES.createTask, {
        version: MANAGED_AUTOMATION_CONTRACT_VERSION, executionTarget: 'dev',
      }, TOKEN),
      (err: unknown) => err instanceof InternalHttpError && err.code === 'invalid_task_proposal',
    );
    assert.equal(calls.length, 0, '信封校验失败不得触达服务层');
  });
});
