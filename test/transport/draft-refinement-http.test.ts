/**
 * 稿件精修双向通道的往返测试。
 *
 * 只钉「跨这一跳会悄悄坏掉」的那几件事，不重复钉传输骨架本身（`internal-http.test.ts` 已覆盖）：
 *   ① 两族的路由表都与 kernel 端口逐条对齐（satisfies 只保表全，注册函数漏挂它看不见）；
 *   ② `Map` 往返 —— 直接 JSON 化会变成 `{}`，列表页从此永远显示「没精修过」；
 *   ③ 唯一活跃作业冲突 `23505` 原样过线 —— 丢了会把「已经在调整了」压成 500；
 *   ④ 读口失败**抛**，MUST NOT 退化成 null / 空 Map；
 *   ⑤ 落稿写口的「结果未知」走具名码 —— 它是 worker 那句「原稿未变化」的唯一闸。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InternalHttpClient,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';
import {
  DRAFT_REFINEMENT_DRAFTS_ROUTES,
  DRAFT_REFINEMENT_QUEUE_ROUTES,
  DraftRefinementDraftsHttpClient,
  DraftRefinementQueueHttpClient,
  registerDraftRefinementDraftsRoutes,
  registerDraftRefinementQueueRoutes,
  type DraftRefinementDraftsWriter,
} from '../../src/transport/draft-refinement-http.js';
import type {
  DraftRefinementJob,
  DraftRefinementReadWritePort,
} from '../../src/kernel/publish-draft-contract.js';

const TARGET = 'dev' as const;
const TOKEN = 'test-token';

const QUEUE_METHODS = [
  'create', 'getForAccount', 'latestForAccountRecord', 'latestForAccountRecords',
] as const satisfies readonly (keyof DraftRefinementReadWritePort)[];

function job(overrides: Partial<DraftRefinementJob> = {}): DraftRefinementJob {
  return {
    id: 'job-1',
    executionTarget: TARGET,
    accountId: 'acc-1',
    recordId: 7,
    expectedVersion: 3,
    scope: 'body',
    instruction: '第二段改短一点',
    selection: null,
    status: 'queued',
    progress: [{ seq: 1, stage: '计划', status: 'running', summary: '已锁定范围', at: 1 }],
    claimToken: null,
    resultVersion: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    ...overrides,
  };
}

const notImpl = () => {
  throw new Error('not stubbed');
};

async function withQueue(
  local: Partial<DraftRefinementReadWritePort>,
  run: (port: DraftRefinementReadWritePort) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerDraftRefinementQueueRoutes(
    server,
    {
      create: notImpl as DraftRefinementReadWritePort['create'],
      getForAccount: notImpl as DraftRefinementReadWritePort['getForAccount'],
      latestForAccountRecord: notImpl as DraftRefinementReadWritePort['latestForAccountRecord'],
      latestForAccountRecords: notImpl as DraftRefinementReadWritePort['latestForAccountRecords'],
      ...local,
    },
    TOKEN,
    TARGET,
  );
  const listenPort = await server.listen(0);
  try {
    await run(new DraftRefinementQueueHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${listenPort}`),
      TOKEN,
      TARGET,
    ));
  } finally {
    await server.close();
  }
}

async function withDrafts(
  local: DraftRefinementDraftsWriter,
  run: (port: DraftRefinementDraftsWriter) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerDraftRefinementDraftsRoutes(server, local, TOKEN, TARGET);
  const listenPort = await server.listen(0);
  try {
    await run(new DraftRefinementDraftsHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${listenPort}`),
      TOKEN,
      TARGET,
    ));
  } finally {
    await server.close();
  }
}

test('AC-REFINE-01 队列族四个方法都真的挂上了（表全 ≠ 注册全）', async () => {
  await withQueue(
    {
      create: async () => job(),
      getForAccount: async () => null,
      latestForAccountRecord: async () => null,
      latestForAccountRecords: async () => new Map(),
    },
    async (port) => {
      for (const m of QUEUE_METHODS) {
        assert.equal(typeof port[m], 'function', `客户端缺方法 ${m}`);
      }
      // 逐条真打一次：漏注册的表现是 404，而 404 只会被读成「对面版本落后」。
      await port.create({
        accountId: 'acc-1', recordId: 7, expectedVersion: 3,
        scope: 'body', instruction: '短一点', selection: null,
      });
      await port.getForAccount('acc-1', 7, 'job-1');
      await port.latestForAccountRecord('acc-1', 7);
      await port.latestForAccountRecords('acc-1', [7]);
    },
  );
});

test('AC-REFINE-02 落稿写口挂上了，补丁与选区原样送达', async () => {
  const seen: unknown[] = [];
  await withDrafts(
    {
      refineDraft: async (recordId, accountId, expectedVersion, scope, selection, patch, editor) => {
        seen.push({ recordId, accountId, expectedVersion, scope, selection, patch, editor });
        return { ok: true, contentVersion: 4, title: 't', content: 'c', metadata: null, images: ['a'] };
      },
    },
    async (port) => {
      const result = await port.refineDraft(
        7, 'acc-1', 3, 'selected_text',
        { start: 1, end: 4, text: 'abc' },
        { content: 'new body' },
        'draft-refinement:job-1',
      );
      assert.deepEqual(result, {
        ok: true, contentVersion: 4, title: 't', content: 'c', metadata: null, images: ['a'],
      });
    },
  );
  assert.deepEqual(seen, [{
    recordId: 7, accountId: 'acc-1', expectedVersion: 3, scope: 'selected_text',
    selection: { start: 1, end: 4, text: 'abc' },
    patch: { content: 'new body' },
    editor: 'draft-refinement:job-1',
  }]);
});

test('AC-REFINE-03 latestForAccountRecords 的 Map 真的过得来（直接 JSON 化会变成空）', async () => {
  await withQueue(
    {
      latestForAccountRecords: async (accountId, recordIds) => {
        assert.equal(accountId, 'acc-1');
        assert.deepEqual(recordIds, [7, 9]);
        return new Map([
          [7, job({ id: 'job-7', recordId: 7 })],
          [9, job({ id: 'job-9', recordId: 9, status: 'completed', resultVersion: 5 })],
        ]);
      },
    },
    async (port) => {
      const map = await port.latestForAccountRecords('acc-1', [7, 9]);
      assert.ok(map instanceof Map, '回来的必须还是 Map —— 拿到普通对象时 .get 会当场炸');
      assert.equal(map.size, 2);
      assert.equal(map.get(7)?.id, 'job-7');
      assert.equal(map.get(9)?.status, 'completed');
      assert.equal(map.get(9)?.resultVersion, 5);
    },
  );
});

test('AC-REFINE-04 唯一活跃作业冲突码 23505 原样过线（否则 409 会变 500）', async () => {
  await withQueue(
    {
      create: async () => {
        // 属主侧真实抛出物的形状：pg 的错误对象带 string code。
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        });
      },
    },
    async (port) => {
      const err = await port.create({
        accountId: 'acc-1', recordId: 7, expectedVersion: 3,
        scope: 'body', instruction: '短一点', selection: null,
      }).then(() => null, (e: unknown) => e);
      assert.ok(err, '冲突 MUST 抛');
      assert.equal(
        (err as { code?: string }).code,
        '23505',
        'api 的客户端鉴权服务只认这个码来答 409 refinement_already_active',
      );
    },
  );
});

test('AC-REFINE-05 读口失败抛，MUST NOT 退化成 null / 空 Map', async () => {
  await withQueue(
    {
      latestForAccountRecord: async () => {
        throw new Error('content db down');
      },
      latestForAccountRecords: async () => {
        throw new Error('content db down');
      },
    },
    async (port) => {
      const single = await port.latestForAccountRecord('acc-1', 7).then(() => 'RESOLVED', () => 'THREW');
      assert.equal(single, 'THREW', '读不到落成 null 会被读成「这条稿子没精修过」');
      const many = await port.latestForAccountRecords('acc-1', [7]).then(() => 'RESOLVED', () => 'THREW');
      assert.equal(many, 'THREW', '读不到落成空 Map 与「都没精修过」完全同形');
    },
  );
});

test('AC-REFINE-06 落稿写口的「结果未知」走具名码，与「确认没做成」分得开', async () => {
  // 结果未知：应答畸形（等价于超时 / 连接断——写可能已经提交）。
  const server = new InternalHttpServer();
  server.registerBearer(DRAFT_REFINEMENT_DRAFTS_ROUTES.refineDraft, TOKEN, async () => ({
    nonsense: true,
  }));
  const listenPort = await server.listen(0);
  try {
    const client = new DraftRefinementDraftsHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${listenPort}`),
      TOKEN,
      TARGET,
    );
    const err = await client
      .refineDraft(7, 'acc-1', 3, 'body', null, { content: 'x' }, 'e')
      .then(() => null, (e: unknown) => e);
    assert.equal(
      (err as { code?: string }).code,
      'api_authority_result_unknown',
      'worker 按这个码出「已提交但没能确认」，压掉它就会回到那句假的「原稿未变化」',
    );
  } finally {
    await server.close();
  }

  // 确认没做成：属主明确答了一个拒因 —— 这条 MUST 是正常返回，不是抛。
  await withDrafts(
    { refineDraft: async () => ({ ok: false, reason: 'version_conflict' }) },
    async (port) => {
      const result = await port.refineDraft(7, 'acc-1', 3, 'body', null, { content: 'x' }, 'e');
      assert.deepEqual(result, { ok: false, reason: 'version_conflict' });
    },
  );
});

test('AC-REFINE-07 target 不符当场拒绝（DEV/OL 长期共库，调用方无入口挑 target）', async () => {
  const server = new InternalHttpServer();
  registerDraftRefinementQueueRoutes(
    server,
    {
      create: async () => job(),
      getForAccount: async () => null,
      latestForAccountRecord: async () => null,
      latestForAccountRecords: async () => new Map(),
    },
    TOKEN,
    'ol',
  );
  const listenPort = await server.listen(0);
  try {
    const client = new DraftRefinementQueueHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${listenPort}`),
      TOKEN,
      'dev',
    );
    const err = await client.latestForAccountRecord('acc-1', 7).then(() => null, (e: unknown) => e);
    assert.equal((err as { code?: string }).code, 'api_direct_target_mismatch');
  } finally {
    await server.close();
  }
});

test('AC-REFINE-08 两族路由名互不重叠，且都带版本段', async () => {
  const all = [
    ...Object.values(DRAFT_REFINEMENT_QUEUE_ROUTES),
    ...Object.values(DRAFT_REFINEMENT_DRAFTS_ROUTES),
  ];
  assert.equal(new Set(all).size, all.length, '路由名撞车 = 注册期 route_conflict');
  for (const route of all) {
    assert.match(route, /\/v1\//, `路由 ${route} 缺版本段`);
  }
});
