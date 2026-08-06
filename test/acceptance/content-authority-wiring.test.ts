/**
 * automation → content 两条属主端口：属主存储结构上满足端口面（change split-cloud-automation-production-runtime 任务 2.1）。
 *
 * 跨进程往返本身已由 `test/transport/content-authority-http.test.ts` 逐条钉过，这里不重复。
 * 本文件只钉「属主存储结构上满足端口面」这一件事：服务端注册那层带一个在场探针，属主缺方法
 * 就当场答 `unsupported_method`。精选库属主此前**根本没有** `selectSamplesForSearchTerms`
 * （三字段窄投影写在组装根的一个 `.then(rows => rows.map(...))` 里），照原样注册进去，
 * 评论侧的搜索词样本会永远读到「对面不支持这个方法」。
 *
 * 事实源翻转后（invert-split-fact-source 5.6）：原第 1、4 条用例断的是**单体组装根**的注册
 * 位点与「单体不挂这两组路由」——单体已冻结、不再部署，那两条的现役等价物由属主仓自己的
 * `aidcp-content/test/acceptance/content-authority-routes.test.ts` 钉住（含「两组各挂各的守卫
 * + 未注册必须有 else 留痕」的同款判据），故在本仓删除、不再读死照片。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CuratedContentStore } from '@content/cache/curated-content-store.js';
import {
  CONCEPT_POOL_AUTHORITY_ROUTES,
  CURATED_SELECTION_AUTHORITY_ROUTES,
} from '@automation/transport/content-authority-http.js';

test('两个属主存储结构上满足端口面：在场探针不会把接线遗漏冒充成能力缺口', () => {
  // 期望的方法名从路由表现算，不另抄一份清单：那两张表带 `satisfies Record<keyof Port, string>`，
  // 端口加了方法而表没跟上会在 typecheck 当场失败，于是表的键恒等于端口的方法集。
  const store = new CuratedContentStore({
    schemaEnsurer: async () => 'ready' as const,
    pool: {} as never,
    triggeredRefsReader: () => ({
      triggeredPublishRefs: async () => ({ curatedIds: [], sourceIds: [] }),
    }),
  });
  for (const method of Object.keys(CURATED_SELECTION_AUTHORITY_ROUTES)) {
    assert.equal(
      typeof (store as unknown as Record<string, unknown>)[method],
      'function',
      `精选库属主缺方法 ${method}：服务端在场探针会把它译成「对面不支持这个方法」，` +
        '而真实原因是窄投影没有归位属主',
    );
  }
  // 概念池属主的六条同理；它在 content 进程里是这两组路由存在的唯一理由。
  assert.equal(Object.keys(CONCEPT_POOL_AUTHORITY_ROUTES).length, 6);
});

test('搜索词样本＝创作召回的三字段投影，且计数不被填成 0', async () => {
  const rows = [
    { title: 'a', topics: ['x'], collectCount: 12, body: '大块正文', referenceImages: [1, 2, 3] },
    { title: 'b', topics: [], collectCount: null, body: '大块正文', referenceImages: [] },
  ];
  const store = new CuratedContentStore({
    schemaEnsurer: async () => 'ready' as const,
    pool: {} as never,
    triggeredRefsReader: () => ({
      triggeredPublishRefs: async () => ({ curatedIds: [], sourceIds: [] }),
    }),
  });
  (store as unknown as { selectForCreation: unknown }).selectForCreation = async () => rows;

  assert.deepEqual(await store.selectSamplesForSearchTerms('acc-1', 'source_post', 8), [
    { title: 'a', topics: ['x'], collectCount: 12 },
    // `null` 原样过去：「没记到收藏数」与「收藏数真是 0」在选词排序里不是一回事。
    { title: 'b', topics: [], collectCount: null },
  ]);
});
