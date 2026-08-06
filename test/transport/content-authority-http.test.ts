/**
 * automation → content 两条属主端口的跨进程往返。
 *
 * 这个文件只钉四件事，每一件都对应一个「不测就只有真跑起来才发现」的失败：
 *   ① 路由两端一致——三件套同文件的**全部理由**。`satisfies` 保证路由表是全的，
 *      保证不了注册函数把表里每条都挂上去，所以八条逐条走一遍。
 *   ② 属主读失败经这一跳后仍是**可识别的具名失败**，不是空数组。读失败被吃成空，
 *      表现是搜索词生成拿零样本照跑、发帖创作以为没素材照发，全程零报错。
 *   ③ `unsupported_method` 还原得出来——还原不出，概念池那条回落分支就是死代码。
 *   ④ target 漂移当场被拒，且属主**一次都没被调用**：DEV/OL 长期共库，放过去就是在另一台机器上真跑了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeploymentTarget } from '@kernel/deployment-target.js';
import { ContentPortError, isContentPortError } from '@kernel/kernel/content-port-error.js';
import { CuratedContentUnavailableError } from '@kernel/kernel/curated-content-types.js';
import type { ConceptPoolPort } from '@kernel/kernel/concept-pool-port.js';
import type { CuratedSelectionPort } from '@kernel/kernel/curated-selection-port.js';
import { InternalHttpClient, InternalHttpServer } from '@automation/transport/internal-http.js';
import type { CuratedPanelRow, CuratedTargetReader } from '@kernel/kernel/curated-content-types.js';
import {
  CONCEPT_POOL_AUTHORITY_ROUTES,
  CURATED_SELECTION_AUTHORITY_ROUTES,
  CURATED_TARGET_AUTHORITY_ROUTES,
  CuratedTargetAuthorityHttpClient,
  registerCuratedTargetAuthorityRoutes,
  ConceptPoolAuthorityHttpClient,
  CuratedSelectionAuthorityHttpClient,
  CURATED_WRITE_AUTHORITY_ROUTES,
  CuratedWriteAuthorityHttpClient,
  registerConceptPoolAuthorityRoutes,
  registerCuratedSelectionAuthorityRoutes,
  registerCuratedWriteAuthorityRoutes,
} from '@automation/transport/content-authority-http.js';
import type { CuratedWritePort } from '@kernel/kernel/curated-write-port.js';

const TOKEN = 'content-internal-token';

interface Harness {
  concept: ConceptPoolPort;
  curated: CuratedSelectionPort;
}

async function withChannel(
  opts: {
    concept?: ConceptPoolPort;
    curated?: CuratedSelectionPort;
    serverTarget?: DeploymentTarget;
    clientTarget?: DeploymentTarget;
  },
  run: (clients: Harness) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  const serverTarget = opts.serverTarget ?? 'dev';
  if (opts.concept) {
    registerConceptPoolAuthorityRoutes(server, opts.concept, TOKEN, serverTarget);
  }
  if (opts.curated) {
    registerCuratedSelectionAuthorityRoutes(server, opts.curated, TOKEN, serverTarget);
  }
  const port = await server.listen(0);
  const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
  const clientTarget = opts.clientTarget ?? 'dev';
  try {
    await run({
      concept: new ConceptPoolAuthorityHttpClient(http, TOKEN, clientTarget),
      curated: new CuratedSelectionAuthorityHttpClient(http, TOKEN, clientTarget),
    });
  } finally {
    await server.close();
  }
}

function selectItem(sourceId: string) {
  return {
    sourceId,
    contentType: 'image_text' as const,
    title: 'a title',
    body: 'a body',
    topics: ['t1'],
    likeCount: 12,
    // 计数诚实置空：null MUST 原样过去，绝不在这一跳被填成 0。
    collectCount: null,
    botLiked: false,
    botCollected: false,
    referenceImages: [],
  };
}

test('八条路由：服务端注册的路径就是客户端请求的路径，入参原样送达', async () => {
  const seen: unknown[] = [];
  await withChannel(
    {
      concept: {
        addCandidate: async (keyword, sourceNote) => {
          seen.push({ m: 'addCandidate', keyword, sourceNote });
          return false; // 撞唯一键：这个词早就在池里
        },
        loadPool: async () => {
          seen.push({ m: 'loadPool' });
          return { known: ['k1'], candidates: ['c1', 'c2'] };
        },
        markSearched: async (keyword) => {
          seen.push({ m: 'markSearched', keyword });
        },
        countNewSince: async (sinceMs) => {
          seen.push({ m: 'countNewSince', sinceMs });
          return 7;
        },
        getNewConceptsSince: async (sinceMs, limit) => {
          seen.push({ m: 'getNewConceptsSince', sinceMs, limit });
          return ['w1'];
        },
        getNewConceptsWithSourceSince: async (sinceMs, limit) => {
          seen.push({ m: 'getNewConceptsWithSourceSince', sinceMs, limit });
          return [{ keyword: 'w1', sourceNote: null }];
        },
      },
      curated: {
        selectForCreation: async (accountId, contentType, limit, window) => {
          seen.push({ m: 'selectForCreation', accountId, contentType, limit, window });
          return [selectItem('s1')];
        },
        selectSamplesForSearchTerms: async (accountId, contentType, limit) => {
          seen.push({ m: 'selectSamplesForSearchTerms', accountId, contentType, limit });
          return [{ title: 'x', topics: [], collectCount: null }];
        },
      },
    },
    async ({ concept, curated }) => {
      assert.equal(await concept.addCandidate('kw', 'note title'), false, '撞唯一键 MUST 是 false');
      assert.deepEqual(await concept.loadPool(), { known: ['k1'], candidates: ['c1', 'c2'] });
      await concept.markSearched('kw');
      assert.equal(await concept.countNewSince(1000), 7);
      assert.deepEqual(await concept.getNewConceptsSince(1000, 5), ['w1']);
      assert.deepEqual(await concept.getNewConceptsWithSourceSince(1000, 5), [
        { keyword: 'w1', sourceNote: null },
      ]);
      assert.deepEqual(await curated.selectForCreation('acct', 'source_post', 8, {
        updatedSinceMs: 42,
      }), [selectItem('s1')]);
      assert.deepEqual(await curated.selectSamplesForSearchTerms('acct', 'source_post', 8), [
        { title: 'x', topics: [], collectCount: null },
      ]);

      assert.deepEqual(seen, [
        { m: 'addCandidate', keyword: 'kw', sourceNote: 'note title' },
        { m: 'loadPool' },
        { m: 'markSearched', keyword: 'kw' },
        { m: 'countNewSince', sinceMs: 1000 },
        { m: 'getNewConceptsSince', sinceMs: 1000, limit: 5 },
        { m: 'getNewConceptsWithSourceSince', sinceMs: 1000, limit: 5 },
        {
          m: 'selectForCreation',
          accountId: 'acct',
          contentType: 'source_post',
          limit: 8,
          window: { updatedSinceMs: 42 },
        },
        { m: 'selectSamplesForSearchTerms', accountId: 'acct', contentType: 'source_post', limit: 8 },
      ]);
    },
  );
  assert.equal(
    Object.keys(CONCEPT_POOL_AUTHORITY_ROUTES).length +
      Object.keys(CURATED_SELECTION_AUTHORITY_ROUTES).length,
    8,
    '端口新增方法时这里要一起补一趟往返，别让新路由没人走过就上线',
  );
});

test('属主读失败：客户端侧仍是具名失败，MUST NOT 是空数组', async () => {
  await withChannel(
    {
      curated: {
        // 属主既有的缺表哨兵错误**没有 code**，靠服务端那层译码才没被压成泛化的 handler_error。
        selectForCreation: async () => {
          throw new CuratedContentUnavailableError('selectForCreation');
        },
        selectSamplesForSearchTerms: async () => {
          throw new Error('pool exhausted');
        },
      },
    },
    async ({ curated }) => {
      await assert.rejects(
        () => curated.selectForCreation('acct', 'source_post', 8),
        (error: unknown) => {
          assert.ok(isContentPortError(error), '跨这一跳后仍 MUST 被结构化守卫认出来');
          assert.equal(error.reason, 'remote_error');
          assert.match(String(error.detail), /missing table/, '属主原因不得在这一跳丢失');
          return true;
        },
      );
      await assert.rejects(() => curated.selectSamplesForSearchTerms('acct', 'source_post', 8));
    },
  );
});

test('unsupported_method 两条路径都还原得出来（否则回落分支是死代码）', async () => {
  // ① 对面版本落后、这条路由压根没注册：只挂了精选库那组。
  await withChannel(
    {
      curated: {
        selectForCreation: async () => [],
        selectSamplesForSearchTerms: async () => [],
      },
    },
    async ({ concept }) => {
      await assert.rejects(
        () => concept.getNewConceptsWithSourceSince(1000, 5),
        (error: unknown) => {
          assert.ok(isContentPortError(error));
          assert.equal(
            error.reason,
            'unsupported_method',
            '路由未注册 MUST 还原成 unsupported_method，不能落成泛化的 remote_error',
          );
          return true;
        },
      );
    },
  );

  // ② 属主显式答具名原因。
  await withChannel(
    {
      concept: {
        addCandidate: async () => true,
        loadPool: async () => ({ known: [], candidates: [] }),
        markSearched: async () => {},
        countNewSince: async () => 0,
        getNewConceptsSince: async () => ['fallback'],
        getNewConceptsWithSourceSince: async () => {
          throw new ContentPortError(
            'unsupported_method',
            'concept-pool.getNewConceptsWithSourceSince',
          );
        },
      },
    },
    async ({ concept }) => {
      await assert.rejects(
        () => concept.getNewConceptsWithSourceSince(1000),
        (error: unknown) => {
          assert.ok(isContentPortError(error));
          assert.equal(error.reason, 'unsupported_method');
          return true;
        },
      );
      // 回落分支由调用方按具名原因驱动，回落本身照常可用。
      assert.deepEqual(await concept.getNewConceptsSince(1000), ['fallback']);
    },
  );
});

test('target 漂移：当场被拒，且属主一次都没被调用', async () => {
  let calls = 0;
  await withChannel(
    {
      serverTarget: 'ol',
      clientTarget: 'dev',
      curated: {
        selectForCreation: async () => {
          calls += 1;
          return [];
        },
        selectSamplesForSearchTerms: async () => {
          calls += 1;
          return [];
        },
      },
    },
    async ({ curated }) => {
      await assert.rejects(
        () => curated.selectForCreation('acct', 'source_post', 8),
        (error: unknown) => {
          assert.ok(isContentPortError(error));
          assert.equal(error.reason, 'remote_error');
          assert.match(String(error.detail), /target_mismatch/, '原始 code MUST 留在 detail 里');
          return true;
        },
      );
      assert.equal(calls, 0, 'target 不符时 MUST NOT 在另一台机器上真跑');
    },
  );
});

test('形状不符 MUST 抛，MUST NOT 兜底成空值', async () => {
  await withChannel(
    {
      concept: {
        addCandidate: async () => true,
        loadPool: async () => ({ known: [], candidates: [] }),
        markSearched: async () => {},
        countNewSince: async () => 0,
        getNewConceptsSince: async () => ['w'],
        // 契约漂移的典型形态：来源字段整个不见了（JSON 会把 undefined 直接丢掉）。
        getNewConceptsWithSourceSince: async () =>
          [{ keyword: 'w' }] as unknown as { keyword: string; sourceNote: string | null }[],
      },
    },
    async ({ concept }) => {
      await assert.rejects(
        () => concept.getNewConceptsWithSourceSince(1000),
        (error: unknown) => {
          assert.ok(isContentPortError(error));
          assert.equal(error.reason, 'malformed_response');
          return true;
        },
      );
    },
  );
});

/**
 * 失败映射表只许有一份。
 *
 * **这条用例守的东西，上面五条往返用例一条都守不住**——复制出来的第二份副本在复制那一刻
 * 行为完全一致，往返测试照样全绿；它要等到某天有人只改了其中一份、且**恰好在失败真发生的那一刻**
 * 才现形，而失败路径正是最少被真跑到的那条。2026-07-31 结清这条欠账时，两份实现比下来
 * 语义确实还一致，等于说：**如果只靠行为测试，这个问题永远不会被发现。**
 *
 * 判据写成「取用方 MUST import 公共那份 + MUST NOT 自己定义同名函数」，
 * 而不是「文件里不许出现某段文本」——后者会被换个函数名轻易绕过。**别当冗余删掉。**
 */
test('content 属主端口的失败映射层只有一份，取用方一律 import 公共译码模块', async () => {
  const { readFile } = await import('node:fs/promises');
  // 取用方＝所有走 content 属主端口三件套的传输模块。新增一个就往这里加一条。
  const consumers = ['content-authority-http.ts', 'content-media-usage-http.ts'];
  // 只在公共模块里定义、别处一律 import 的符号。
  const shared = [
    'ownerFailureAsWireError',
    'clientFailureAsContentPortError',
    'ownerHasMethod',
    'runOwnerCall',
    'callContentAuthority',
  ];

  const { ownedSourcePath } = await import('../helpers/sibling-repos.js');
  const wire = await readFile(
    ownedSourcePath('automation', 'transport/content-authority-wire.ts'),
    'utf8',
  );
  for (const symbol of shared) {
    assert.match(
      wire,
      new RegExp(`function ${symbol}\\b`),
      `公共译码模块 MUST 是 ${symbol} 的唯一定义处`,
    );
  }

  for (const file of consumers) {
    const source = await readFile(
      ownedSourcePath('automation', `transport/${file}`),
      'utf8',
    );
    assert.match(
      source,
      /from '\.\/content-authority-wire\.js'/,
      `${file} MUST 从公共译码模块取用，不得自带一份`,
    );
    for (const symbol of shared) {
      assert.doesNotMatch(
        source,
        new RegExp(`function ${symbol}\\b`),
        `${file} 里出现了 ${symbol} 的本地定义 —— 那是第二份失败映射表，`
          + '它与公共那份在复制当天完全等价，只有某一份被改过、且恰好在失败发生时才看得出对不上',
      );
    }
  }
});

/* ══════════════════════════ 精选库写侧（task 2.4b） ══════════════════════════ */

/**
 * 写侧独立的小夹具：**刻意不去改上面那个读侧夹具**，改它会连带碰到五条既有用例。
 * `local` 只给要断言的方法，其余用一个当场失败的桩兜底——「路由把调用送到了另一个方法」
 * 这种错必须当场炸，不能悄悄落进一个空实现里。
 */
async function withWriteChannel(
  local: Partial<CuratedWritePort>,
  run: (client: CuratedWritePort, server: InternalHttpServer) => Promise<void>,
  opts: { serverTarget?: DeploymentTarget; clientTarget?: DeploymentTarget } = {},
): Promise<void> {
  const server = new InternalHttpServer();
  const notWired = (method: string) => () => {
    throw new Error(`unexpected call to ${method}`);
  };
  const port: CuratedWritePort = {
    upsertObservation: local.upsertObservation ?? notWired('upsertObservation'),
    refreshReferenceImages: local.refreshReferenceImages ?? notWired('refreshReferenceImages'),
    getTextCardContext: local.getTextCardContext ?? notWired('getTextCardContext'),
    archiveComment: local.archiveComment ?? notWired('archiveComment'),
    markBotAction: local.markBotAction ?? notWired('markBotAction'),
  };
  registerCuratedWriteAuthorityRoutes(server, port, TOKEN, opts.serverTarget ?? 'dev');
  const listening = await server.listen(0);
  const http = new InternalHttpClient(`http://127.0.0.1:${listening}`);
  try {
    await run(new CuratedWriteAuthorityHttpClient(http, TOKEN, opts.clientTarget ?? 'dev'), server);
  } finally {
    await server.close();
  }
}

test('五条写路由：注册的路径就是请求的路径，入参原样送达属主', async () => {
  const seen: unknown[] = [];
  await withWriteChannel(
    {
      upsertObservation: async (obs) => {
        seen.push({ m: 'upsertObservation', obs });
      },
      refreshReferenceImages: async (accountId, sourceId, contentType, input) => {
        seen.push({ m: 'refreshReferenceImages', accountId, sourceId, contentType, input });
        return 1;
      },
      getTextCardContext: async (accountId, sourceId, contentType) => {
        seen.push({ m: 'getTextCardContext', accountId, sourceId, contentType });
        return { referenceImages: [] };
      },
      archiveComment: async (accountId, input) => {
        seen.push({ m: 'archiveComment', accountId, input });
      },
      markBotAction: async (accountId, sourceId, action, content) => {
        seen.push({ m: 'markBotAction', accountId, sourceId, action, content });
      },
    },
    async (client) => {
      await client.upsertObservation({
        accountId: 'a1',
        contentType: 'image_text',
        sourceId: 's1',
        body: 'body',
        topics: ['t1'],
        admitReason: 'llm_eval',
        // 平台原文与换算锚点成对过来（少了锚点属主会按读到它的时刻换算，越晚读误差越大）。
        publishedAtText: '3 天前',
        publishedObservedAt: 1_700_000_000_000,
      });
      assert.equal(await client.refreshReferenceImages('a1', 's1', 'video', undefined), 1);
      assert.deepEqual(await client.getTextCardContext('a1', 's1', 'image_text'), {
        referenceImages: [],
      });
      await client.archiveComment('a1', { sourceId: 'c1', text: 'nice', topics: [] });
      await client.markBotAction('a1', 's1', 'collect', { body: 'b' });
    },
  );

  assert.deepEqual(seen, [
    {
      m: 'upsertObservation',
      obs: {
        accountId: 'a1',
        contentType: 'image_text',
        sourceId: 's1',
        body: 'body',
        topics: ['t1'],
        admitReason: 'llm_eval',
        publishedAtText: '3 天前',
        publishedObservedAt: 1_700_000_000_000,
      },
    },
    { m: 'refreshReferenceImages', accountId: 'a1', sourceId: 's1', contentType: 'video', input: undefined },
    { m: 'getTextCardContext', accountId: 'a1', sourceId: 's1', contentType: 'image_text' },
    { m: 'archiveComment', accountId: 'a1', input: { sourceId: 'c1', text: 'nice', topics: [] } },
    { m: 'markBotAction', accountId: 'a1', sourceId: 's1', action: 'collect', content: { body: 'b' } },
  ]);
  assert.deepEqual(
    Object.keys(CURATED_WRITE_AUTHORITY_ROUTES).sort(),
    ['archiveComment', 'getTextCardContext', 'markBotAction', 'refreshReferenceImages', 'upsertObservation'],
  );
});

/**
 * 返回 `void` 的三个方法：**空响应体 MUST 抛，MUST NOT 被读成写成功了**。
 *
 * 这条守的是写侧独有的那个失败态：`undefined` 编码后就是个空响应体，与「这条路由压根没跑」
 * 逐字节一样。少了显式回执，一次没落库的写会安安静静地返回，而精选语料只会少不会多——
 * **少一条谁都不会发现**。
 */
test('写侧 void 方法：路由回空响应体时 MUST 抛，MUST NOT 静默当成写成功', async () => {
  const server = new InternalHttpServer();
  // 用一个"忘了回执"的路由顶掉真注册（同路径、回 undefined）——正是漏写回执时的真实形态。
  server.registerBearer(CURATED_WRITE_AUTHORITY_ROUTES.upsertObservation, TOKEN, async () => undefined);
  const listening = await server.listen(0);
  const http = new InternalHttpClient(`http://127.0.0.1:${listening}`);
  const client = new CuratedWriteAuthorityHttpClient(http, TOKEN, 'dev');
  try {
    await assert.rejects(
      () =>
        client.upsertObservation({
          accountId: 'a1',
          contentType: 'image_text',
          sourceId: 's1',
          body: 'b',
          topics: [],
          admitReason: 'llm_eval',
        }),
      (err: unknown) =>
        isContentPortError(err) && err.reason === 'malformed_response',
      '空响应体 MUST 判形状不符；静默 resolve 等于把没落库的写报成成功',
    );
  } finally {
    await server.close();
  }
});

/**
 * 两个「0 / null 是领域答案」的回执：0 行受影响与「库里没有这条」MUST 原样过来，
 * 而属主真失败 MUST 是具名抛出、**MUST NOT 被译成那两个答案**。
 *
 * 这两者混起来的后果具体且不响：`refreshReferenceImages` 回 0 的意思是「库里没有这条源帖」，
 * 调用方据此分支；把一次读不到的失败译成 0，后续转写就会往一条不存在的行上写。
 */
test('写侧回执：0 与 null 是领域答案，属主失败仍是具名抛出', async () => {
  await withWriteChannel(
    {
      refreshReferenceImages: async () => 0,
      getTextCardContext: async () => null,
    },
    async (client) => {
      assert.equal(
        await client.refreshReferenceImages('a1', 'missing', 'image_text', []),
        0,
        '0 行受影响是「库里没有这条源帖」，MUST 原样过来',
      );
      assert.equal(
        await client.getTextCardContext('a1', 'missing', 'image_text'),
        null,
        'null 是「库里没有这条」，与读失败是两回事',
      );
    },
  );

  await withWriteChannel(
    {
      refreshReferenceImages: async () => {
        throw new CuratedContentUnavailableError('curated_content table missing');
      },
      getTextCardContext: async () => {
        throw new CuratedContentUnavailableError('curated_content table missing');
      },
    },
    async (client) => {
      await assert.rejects(
        () => client.refreshReferenceImages('a1', 's1', 'image_text', []),
        (err: unknown) => isContentPortError(err) && err.reason !== 'unsupported_method',
        '属主失败 MUST 是具名 ContentPortError，MUST NOT 落成 0',
      );
      await assert.rejects(
        () => client.getTextCardContext('a1', 's1', 'image_text'),
        (err: unknown) => isContentPortError(err),
        '读失败 MUST 抛，MUST NOT 落成 null（那会被读成「库里没有这条」）',
      );
    },
  );

  // 坏回执同样 MUST 抛。**这与上一段不是一回事**：上面是属主报了错，这里是属主答了、
  // 但答的不是一个行数（契约漂移 / 对面版本不符）。兜底成 0 会把它读成一句确定的
  // 「库里没有这条源帖」，后续转写就往一条不存在的行上写。
  await withWriteChannel(
    {
      refreshReferenceImages: (async () =>
        '1') as unknown as CuratedWritePort['refreshReferenceImages'],
    },
    async (client) => {
      await assert.rejects(
        () => client.refreshReferenceImages('a1', 's1', 'image_text', []),
        (err: unknown) => isContentPortError(err) && err.reason === 'malformed_response',
        '非整数回执 MUST 判形状不符，MUST NOT 取 0',
      );
    },
  );
});

/* ═══════════════════ 委托任务的精选目标校验（automation → content） */

async function withCuratedTarget(
  local: CuratedTargetReader,
  run: (client: CuratedTargetReader) => Promise<void>,
  opts: { serverTarget?: DeploymentTarget; clientTarget?: DeploymentTarget } = {},
): Promise<void> {
  const server = new InternalHttpServer();
  registerCuratedTargetAuthorityRoutes(server, local, TOKEN, opts.serverTarget ?? 'dev');
  const listening = await server.listen(0);
  const http = new InternalHttpClient(`http://127.0.0.1:${listening}`);
  try {
    await run(new CuratedTargetAuthorityHttpClient(http, TOKEN, opts.clientTarget ?? 'dev'));
  } finally {
    await server.close();
  }
}

function panelRow(): CuratedPanelRow {
  return {
    id: 7,
    accountId: 'a1',
    contentType: 'image_text',
    sourceId: 'note-7',
    title: '可定位标题',
    body: null,
    author: null,
    sourceUrl: null,
    topics: [],
    likeCount: null,
    collectCount: null,
    commentCount: null,
    countsCapturedAt: null,
    sourcePublishedAtText: null,
    sourcePublishedAt: null,
    sourcePublishedAtPrecision: null,
    sourcePublishedAtStatus: null,
    sourcePublishedAtObservedAt: null,
    botLiked: false,
    botCollected: false,
    admitReason: null,
    firstSeenAt: 1,
    updatedAt: 2,
    referenceImages: [],
  };
}

/**
 * 委托任务的两个目标校验钩子据这条读判「目标存不存在 / 归不归这个账号 / 有没有可定位标题」，
 * 所以三件事逐条钉：命中原样过、`null` 作为领域答案原样过、**属主失败 MUST 仍是具名抛出**。
 *
 * 第三条是这组端口存在的全部理由：走裸那条路由时，属主的缺表错误跨这一跳只剩一个普通传输错误，
 * 调用方的守卫恒 false ⇒ 「精选库不可用」被报成「目标不存在或归属不符」，
 * 而运营会照着那句话去查一个根本没问题的目标。
 */
test('精选目标校验：命中与 null 原样往返，属主失败仍是具名 ContentPortError', async () => {
  await withCuratedTarget(
    { getOneForAccount: async (id, accountId) => (id === 7 && accountId === 'a1' ? panelRow() : null) },
    async (client) => {
      assert.deepEqual(await client.getOneForAccount(7, 'a1'), panelRow());
      assert.equal(await client.getOneForAccount(7, 'other'), null, 'null 是属主的领域答案，MUST 原样过');
    },
  );
  await withCuratedTarget(
    {
      getOneForAccount: async () => {
        throw new CuratedContentUnavailableError('curated_content missing');
      },
    },
    async (client) => {
      await assert.rejects(
        () => client.getOneForAccount(7, 'a1'),
        (err: unknown) => isContentPortError(err) && err.reason === 'remote_error',
        '库读不到 MUST 抛具名失败，MUST NOT 变成 null（那是「这条不存在」的意思）',
      );
    },
  );
});

/** 回执形状不符 MUST 抛，MUST NOT 兜底成 `null` —— 那会把契约漂移伪装成一句确定的「目标不存在」。 */
test('精选目标校验：坏回执判形状不符，绝不兜底成 null', async () => {
  const server = new InternalHttpServer();
  server.registerBearer(
    CURATED_TARGET_AUTHORITY_ROUTES.getOneForAccount,
    TOKEN,
    async () => ({ id: 7, accountId: 'a1' }),
  );
  const listening = await server.listen(0);
  const http = new InternalHttpClient(`http://127.0.0.1:${listening}`);
  try {
    await assert.rejects(
      () => new CuratedTargetAuthorityHttpClient(http, TOKEN, 'dev').getOneForAccount(7, 'a1'),
      (err: unknown) => isContentPortError(err) && err.reason === 'malformed_response',
    );
  } finally {
    await server.close();
  }
});

/** target 漂移当场被拒，且属主一次都没被调用（DEV/OL 长期共库，放过去就是在另一台机器上真读了）。 */
test('精选目标校验：target 不符即拒，属主一次都不被调用', async () => {
  let calls = 0;
  await withCuratedTarget(
    {
      getOneForAccount: async () => {
        calls += 1;
        return panelRow();
      },
    },
    async (client) => {
      await assert.rejects(() => client.getOneForAccount(7, 'a1'));
      assert.equal(calls, 0);
    },
    { serverTarget: 'dev', clientTarget: 'ol' },
  );
});
