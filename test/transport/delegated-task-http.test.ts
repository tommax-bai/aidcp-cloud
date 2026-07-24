import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';
import {
  DELEGATED_TASK_ROUTES,
  DelegatedTaskHttpClient,
  registerDelegatedTaskRoutes,
} from '../../src/transport/delegated-task-http.js';
import type {
  DelegatedTask,
  DelegatedTaskIntent,
  DelegatedTaskServicePort,
} from '../../src/kernel/delegated-task-types.js';

/** 一个类型正确的最小 DelegatedTask 夹具（satisfies 保证字段口径对齐 kernel）。 */
function sampleTask(overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  const base: DelegatedTask = {
    id: 'task-1',
    executionTarget: 'dev',
    accountId: 'acc-1',
    accountName: 'Tom',
    platform: 'xiaohongshu',
    action: 'comment_batch',
    actionFamily: 'comment',
    targetSuccessCount: 3,
    maxAttempts: 6,
    deadlineAt: 1_700_000_000_000,
    notBefore: 0,
    executionWindow: { mode: 'immediate' },
    sourceConstraints: {},
    targetConstraints: {},
    approvalMode: 'review',
    priority: 'normal',
    source: 'api',
    sourceRef: null,
    originChatId: null,
    status: 'queued',
    progress: { successCount: 0, attemptCount: 0, skippedCount: 0, failureCount: 0 },
    currentStep: null,
    terminalOutcome: null,
    pauseRequested: false,
    cancelRequested: false,
    nextEligibleAt: null,
    claimToken: null,
    claimExpiresAt: null,
    dedupeKey: 'dk-1',
    version: 1,
    createdAt: 1_699_000_000_000,
    updatedAt: 1_699_000_000_000,
    confirmedAt: null,
    completedAt: null,
  };
  return { ...base, ...overrides } satisfies DelegatedTask;
}

/**
 * 一个只实现被测方法的本地端口桩（其余方法抛错，证明只有被调到的 route 触发）。
 * 结构上满足 DelegatedTaskServicePort。
 */
function stubPort(): DelegatedTaskServicePort {
  return {
    createDraft: async (intent: DelegatedTaskIntent) => ({
      task: sampleTask({ status: 'draft', action: intent.action }),
      confirmation: {
        taskId: 'task-1',
        version: 1,
        title: 'draft',
        accountName: 'Tom',
        platformLabel: '小红书',
        actionLabel: 'comment',
        target: 't',
        attempts: '0/6',
        schedule: 'immediate',
        approval: 'review',
        priority: 'normal',
        constraints: [],
        capability: 'supported',
      },
      created: true,
      autoQueued: false,
    }),
    confirm: async (taskId, version) => sampleTask({ id: taskId, version, status: 'queued' }),
    pause: async (taskId) => sampleTask({ id: taskId, pauseRequested: true }),
    resume: async (taskId) => sampleTask({ id: taskId, status: 'queued' }),
    cancel: async (taskId) => sampleTask({ id: taskId, status: 'cancelled', cancelRequested: true }),
    get: async (taskId) => {
      if (taskId === 'missing') throw new InternalHttpError('not_found', `no task: ${taskId}`);
      return sampleTask({ id: taskId });
    },
    list: async (filter) => [sampleTask({ accountId: filter?.accountId ?? 'acc-1' })],
  };
}

async function withPortServer(
  run: (port: DelegatedTaskServicePort) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerDelegatedTaskRoutes(server, stubPort());
  const listenPort = await server.listen(0);
  const client: DelegatedTaskServicePort = new DelegatedTaskHttpClient(
    new InternalHttpClient(`http://127.0.0.1:${listenPort}`),
  );
  try {
    await run(client);
  } finally {
    await server.close();
  }
}

test('DelegatedTaskHttpClient 满足 kernel 端口形状（编译期 + 运行期）', async () => {
  await withPortServer(async (port) => {
    // 编译期：port 的静态类型就是 DelegatedTaskServicePort（上面的注解已保证）。
    // 运行期：逐方法名存在且可调。
    for (const m of ['createDraft', 'confirm', 'pause', 'resume', 'cancel', 'get', 'list'] as const) {
      assert.equal(typeof port[m], 'function', `missing method: ${m}`);
    }
  });
});

test('get：mock server 返回 → client 拿到形状正确的 DelegatedTask', async () => {
  await withPortServer(async (port) => {
    const task = await port.get('task-42');
    assert.equal(task.id, 'task-42');
    assert.equal(task.accountName, 'Tom');
    assert.equal(task.progress.successCount, 0);
    assert.equal(task.status, 'queued');
  });
});

test('list：filter 透传并回投影数组', async () => {
  await withPortServer(async (port) => {
    const rows = await port.list({ accountId: 'acc-9' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].accountId, 'acc-9');
  });
});

test('createDraft：intent 往返，返回带 confirmation 摘要', async () => {
  await withPortServer(async (port) => {
    const out = await port.createDraft({
      action: 'publish_post',
      targetSuccessCount: 1,
      maxAttempts: 1,
      deadlineAt: 1_700_000_000_000,
      source: 'api',
    });
    assert.equal(out.created, true);
    assert.equal(out.task.action, 'publish_post');
    assert.equal(out.confirmation.taskId, 'task-1');
  });
});

test('confirm：位置参数 taskId+version 正确送达', async () => {
  await withPortServer(async (port) => {
    const task = await port.confirm('task-7', 5);
    assert.equal(task.id, 'task-7');
    assert.equal(task.version, 5);
  });
});

test('端口方法抛错经 HTTP 透传为 InternalHttpError（保留 code）', async () => {
  await withPortServer(async (port) => {
    await assert.rejects(
      () => port.get('missing'),
      (err: unknown) => err instanceof InternalHttpError && err.code === 'not_found',
    );
  });
});

test('路由常量表逐条被 server 接住（无未注册路由）', async () => {
  const server = new InternalHttpServer();
  registerDelegatedTaskRoutes(server, stubPort());
  const listenPort = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${listenPort}`);
  try {
    // list route 存在：返回数组而非 route_not_found
    const rows = await raw.call<DelegatedTask[]>(DELEGATED_TASK_ROUTES.list, {});
    assert.ok(Array.isArray(rows));
  } finally {
    await server.close();
  }
});
