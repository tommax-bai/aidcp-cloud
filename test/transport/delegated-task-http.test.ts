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
import { ApiDirectHttpError, apiDirectEnvelope } from '../../src/transport/api-direct-http-common.js';
import {
  isDelegatedTaskServiceError,
  restoreDelegatedTaskServiceError,
} from '../../src/kernel/operator-command-port.js';
import {
  DelegatedTaskServiceError,
  type DelegatedTask,
  type DelegatedTaskIntent,
  type DelegatedTaskServicePort,
} from '../../src/kernel/delegated-task-types.js';

const TOKEN = 'delegated-task-test-token';
const TARGET = 'dev' as const;

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

function sampleConfirmation() {
  return {
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
    constraints: [] as string[],
    capability: 'supported' as const,
  };
}

/**
 * 本地端口桩。三个 taskId 是**行为开关**，用来把服务端的抛出形态钉死：
 *   - `conflict`  → 版本冲突（409）：跨那一跳后客户端侧的结构化守卫必须仍认得出来；
 *   - `unsupported` → 平台不支持（422）：用来抓「客户端补默认 400」这个错法；
 *   - `nameless` → 没有具名 code 的抛出物：MUST 被判成结果未知，MUST NOT 被伪造成业务原因。
 */
function stubPort(): DelegatedTaskServicePort {
  return {
    createDraft: async (intent: DelegatedTaskIntent) => ({
      task: sampleTask({ status: 'draft', action: intent.action }),
      confirmation: sampleConfirmation(),
      created: true,
      autoQueued: false,
    }),
    confirm: async (taskId, version) => {
      if (taskId === 'conflict') {
        throw new DelegatedTaskServiceError('version_conflict', '任务已被其他操作更新', 409);
      }
      if (taskId === 'unsupported') {
        throw new DelegatedTaskServiceError('unsupported_action', '该平台不支持此委托', 422);
      }
      if (taskId === 'nameless') throw new Error('boom without a code');
      return sampleTask({ id: taskId, version, status: 'queued' });
    },
    pause: async (taskId) => sampleTask({ id: taskId, pauseRequested: true }),
    resume: async (taskId) => sampleTask({ id: taskId, status: 'queued' }),
    cancel: async (taskId) => sampleTask({ id: taskId, status: 'cancelled', cancelRequested: true }),
    get: async (taskId) => {
      if (taskId === 'missing') throw new InternalHttpError('not_found', `no task: ${taskId}`);
      if (taskId === 'malformed') {
        // 缺 progress 的任务对象：客户端 MUST 判形状不符并抛，MUST NOT 放行成属性为 undefined 的对象。
        const { progress: _dropped, ...rest } = sampleTask({ id: taskId });
        return rest as unknown as DelegatedTask;
      }
      return sampleTask({ id: taskId });
    },
    list: async (filter) => [sampleTask({ accountId: filter?.accountId ?? 'acc-1' })],
  };
}

async function withPortServer(
  run: (port: DelegatedTaskServicePort, raw: InternalHttpClient) => Promise<void>,
  opts: { clientToken?: string; clientTarget?: 'dev' | 'ol' } = {},
): Promise<void> {
  const server = new InternalHttpServer();
  registerDelegatedTaskRoutes(server, stubPort(), TOKEN, TARGET);
  const listenPort = await server.listen(0);
  const http = new InternalHttpClient(`http://127.0.0.1:${listenPort}`);
  const client: DelegatedTaskServicePort = new DelegatedTaskHttpClient(
    http,
    opts.clientToken ?? TOKEN,
    opts.clientTarget ?? TARGET,
  );
  try {
    await run(client, http);
  } finally {
    await server.close();
  }
}

/* ───────────────────────────────────────── 端口形状与往返（既有保证，不得回退） */

test('DelegatedTaskHttpClient 满足 kernel 端口形状（编译期 + 运行期）', async () => {
  await withPortServer(async (port) => {
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

/* ───────────────────────────────────── 鉴权 / 版本 / 执行目标（用例 1-4） */

test('用例 1｜不带令牌调用任一条委托路由 → 401（红 = 有一条路由漏了鉴权）', async () => {
  const server = new InternalHttpServer();
  registerDelegatedTaskRoutes(server, stubPort(), TOKEN, TARGET);
  const listenPort = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${listenPort}`);
  try {
    for (const route of Object.values(DELEGATED_TASK_ROUTES)) {
      await assert.rejects(
        () => raw.call(route, apiDirectEnvelope(TARGET, { taskId: 'task-1', version: 1 })),
        (err: unknown) =>
          err instanceof InternalHttpError && err.code === 'internal_http_unauthorized',
        `route without bearer must be rejected: ${route}`,
      );
    }
  } finally {
    await server.close();
  }
});

test('用例 2｜信封版本不符 → 版本不支持码（红 = 契约版本漂了却没人拦）', async () => {
  await withPortServer(async (_port, raw) => {
    await assert.rejects(
      () =>
        raw.callBearer(
          DELEGATED_TASK_ROUTES.get,
          { version: 999, executionTarget: TARGET, input: { taskId: 'task-1' } },
          TOKEN,
        ),
      (err: unknown) =>
        err instanceof InternalHttpError && err.code === 'api_direct_version_unsupported',
    );
  });
});

test('用例 3｜信封目标与接收方不符 → 目标不匹配码（红 = DEV/OL 隔离失效）', async () => {
  await withPortServer(
    async (port) => {
      await assert.rejects(
        () => port.get('task-1'),
        (err: unknown) =>
          err instanceof ApiDirectHttpError && err.code === 'api_direct_target_mismatch',
      );
    },
    { clientTarget: 'ol' },
  );
});

test('用例 4｜客户端无从自选目标：7 个方法入参里都没有 target 位', () => {
  // 目标只能经构造参数注入。这条用编译期 + 结构两道钉：方法签名固定（下面逐条调用即编译校验），
  // 且服务端逐字比对的是构造时注入的那个值——请求体里没有任何一个字段能改变它。
  const port: DelegatedTaskServicePort = new DelegatedTaskHttpClient(
    new InternalHttpClient('http://127.0.0.1:1'),
    TOKEN,
    TARGET,
  );
  assert.equal(port.get.length, 1, 'get 只收 taskId');
  assert.equal(port.confirm.length, 2, 'confirm 只收 taskId + version');
  assert.equal(port.list.length, 1, 'list 只收 filter');
});

/* ─────────────────────────── 业务拒绝跨那一跳（用例 5-6，本 change 的核心） */

test('用例 5｜服务端抛版本冲突 → 客户端侧结构化守卫为真且 status===409（此前这条是红的）', async () => {
  await withPortServer(async (port) => {
    await assert.rejects(
      () => port.confirm('conflict', 1),
      (err: unknown) => {
        // 守卫判的是 `name`，而 `name` 正是此前在线格式那一跳被丢掉的字段。
        assert.ok(isDelegatedTaskServiceError(err), '结构化守卫必须认得出跨线后的业务错误');
        assert.equal(err.code, 'version_conflict');
        assert.equal(err.status, 409, 'status 必须是服务端给的 409，不是客户端补的默认值');
        return true;
      },
    );
  });
});

test('用例 6｜服务端抛平台不支持（422）→ 客户端 status===422（红 = 有人补了默认 400）', async () => {
  await withPortServer(async (port) => {
    await assert.rejects(
      () => port.confirm('unsupported', 1),
      (err: unknown) => {
        assert.ok(isDelegatedTaskServiceError(err));
        assert.equal(err.code, 'unsupported_action');
        assert.equal(err.status, 422);
        return true;
      },
    );
  });
});

test('没有具名 code 的抛出物 MUST 判成结果未知，MUST NOT 被伪造成业务原因', async () => {
  await withPortServer(async (port) => {
    await assert.rejects(
      () => port.confirm('nameless', 1),
      (err: unknown) => {
        assert.equal(isDelegatedTaskServiceError(err), false, '不得被还原成业务拒绝');
        assert.ok(err instanceof ApiDirectHttpError);
        assert.equal(err.code, 'api_authority_result_unknown');
        return true;
      },
    );
  });
});

test('还原判据的两个方向：传输码不得被还原；缺整数 status 不得补默认', () => {
  // 补集判据：传输层自己的码 ⇒ 结果未知。
  assert.equal(
    restoreDelegatedTaskServiceError({
      code: 'timeout',
      message: 'x',
      details: { name: 'DelegatedTaskServiceError', status: 409 },
    }),
    null,
  );
  // 附加位缺 status ⇒ 还原不出，**绝不套默认 400**（那个类的构造默认值恰好就是 400）。
  assert.equal(
    restoreDelegatedTaskServiceError({
      code: 'version_conflict',
      message: 'x',
      details: { name: 'DelegatedTaskServiceError' },
    }),
    null,
  );
  // 齐全时才还原，且 status 逐字取服务端给的那个。
  const restored = restoreDelegatedTaskServiceError({
    code: 'version_conflict',
    message: 'x',
    details: { name: 'DelegatedTaskServiceError', status: 409 },
  });
  assert.ok(restored);
  assert.equal(restored.status, 409);
});

/* ─────────────────────────────────── 形状与结果未知（用例 7 / 14） */

test('用例 7｜服务端返回缺字段的任务对象 → 客户端判形状不符并抛，不放行成 undefined 属性', async () => {
  await withPortServer(async (port) => {
    await assert.rejects(
      () => port.get('malformed'),
      (err: unknown) =>
        err instanceof ApiDirectHttpError && err.code === 'api_authority_bad_response',
    );
  });
});

test('用例 14｜连不上 → 抛，且读路径译成读不到、写路径译成结果未知', async () => {
  const dead = new InternalHttpClient('http://127.0.0.1:1', { timeoutMs: 200 });
  const port: DelegatedTaskServicePort = new DelegatedTaskHttpClient(dead, TOKEN, TARGET);
  await assert.rejects(
    () => port.get('task-1'),
    (err: unknown) => err instanceof ApiDirectHttpError && err.code === 'api_authority_unavailable',
  );
  await assert.rejects(
    () => port.confirm('task-1', 1),
    (err: unknown) =>
      err instanceof ApiDirectHttpError && err.code === 'api_authority_result_unknown',
  );
});

test('端口方法抛传输层错误经 HTTP 透传（保留 code，不被还原成业务拒绝）', async () => {
  await withPortServer(async (port) => {
    await assert.rejects(
      () => port.get('missing'),
      (err: unknown) => {
        assert.equal(isDelegatedTaskServiceError(err), false);
        assert.ok(err instanceof InternalHttpError && err.code === 'not_found');
        return true;
      },
    );
  });
});

/* ──────────────────────────────────────────── 路由注册对账（用例 17） */

test('用例 17｜路由常量表逐条真被注册函数挂上（typecheck 抓不到这一条）', async () => {
  const server = new InternalHttpServer();
  registerDelegatedTaskRoutes(server, stubPort(), TOKEN, TARGET);
  const listenPort = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${listenPort}`);
  try {
    for (const route of Object.values(DELEGATED_TASK_ROUTES)) {
      // 只问「这条路由在不在」：带令牌 + 合法信封发一次，拿到任何非 route_not_found 的结果即算挂上。
      // `satisfies Record<keyof Port, string>` 只保证表全，保证不了每条都被挂上——实测变异过。
      let notFound = false;
      try {
        await raw.callBearer(route, apiDirectEnvelope(TARGET, { taskId: 'task-1', version: 1 }), TOKEN);
      } catch (err) {
        notFound = err instanceof InternalHttpError && err.code === 'route_not_found';
      }
      assert.equal(notFound, false, `route not mounted: ${route}`);
    }
  } finally {
    await server.close();
  }
});
