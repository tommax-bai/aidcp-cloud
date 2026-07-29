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
import type { DeploymentTarget } from '../../src/deployment-target.js';
import { ContentPortError, isContentPortError } from '../../src/kernel/content-port-error.js';
import { CuratedContentUnavailableError } from '../../src/kernel/curated-content-types.js';
import type { ConceptPoolPort } from '../../src/kernel/concept-pool-port.js';
import type { CuratedSelectionPort } from '../../src/kernel/curated-selection-port.js';
import { InternalHttpClient, InternalHttpServer } from '../../src/transport/internal-http.js';
import {
  CONCEPT_POOL_AUTHORITY_ROUTES,
  CURATED_SELECTION_AUTHORITY_ROUTES,
  ConceptPoolAuthorityHttpClient,
  CuratedSelectionAuthorityHttpClient,
  registerConceptPoolAuthorityRoutes,
  registerCuratedSelectionAuthorityRoutes,
} from '../../src/transport/content-authority-http.js';

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
