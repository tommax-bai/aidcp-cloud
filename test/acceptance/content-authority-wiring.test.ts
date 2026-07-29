/**
 * automation → content 两条属主端口在**组装根这一层**的接线（change split-cloud-automation-production-runtime 任务 2.1）。
 *
 * 跨进程往返本身已由 `test/transport/content-authority-http.test.ts` 逐条钉过，这里不重复。
 * 本文件只钉两件那边看不见的事，每件都对应一个「不测就只有真跑起来才发现」的失败：
 *
 *   ① **组装根真的把两组挂上去了，且两组各挂各的。** 传输层的 `satisfies` 保证路由表是全的，
 *      那份往返测试保证注册函数把表里每条都挂上，但没有任何东西保证**组装根去调了那个注册函数**。
 *      漏调的表现不是报错，是 automation 侧收到 404 → 译成「对面不支持这个方法」——
 *      一个本该留给版本落后的具名原因，被一次纯粹的接线遗漏冒名顶替。
 *   ② **属主存储结构上满足端口面。** 服务端注册那层带一个在场探针：属主缺方法就当场答
 *      `unsupported_method`。精选库属主此前**根本没有** `selectSamplesForSearchTerms`
 *      （三字段窄投影写在组装根的一个 `.then(rows => rows.map(...))` 里），照原样注册进去，
 *      评论侧的搜索词样本会永远读到「对面不支持这个方法」。
 *
 * 单体形态在本 change 里 MUST 逐位不变：这两组路由只挂在 content 模式的那个监听上，
 * 单体不起它（最后一条用例）。
 */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

import { listenersForMode } from '../../src/gateway/service-mode.js';
import { CuratedContentStore } from '../../src/cache/curated-content-store.js';
import {
  CONCEPT_POOL_AUTHORITY_ROUTES,
  CURATED_SELECTION_AUTHORITY_ROUTES,
} from '../../src/transport/content-authority-http.js';

const CONCEPT_REGISTRAR = 'registerConceptPoolAuthorityRoutes';
const CURATED_REGISTRAR = 'registerCuratedSelectionAuthorityRoutes';

interface RegistrarSite {
  /** 包裹该调用的全部 if 守卫里出现过的标识符。 */
  guardIdentifiers: Set<string>;
  /** 最近一层守卫有没有 else 分支——缺席时是「喊一声」还是「什么都不发生」。 */
  innermostGuardHasElse: boolean;
}

function functionBody(file: ts.SourceFile, name: string): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) {
      found = node.body;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(found, `组装根里找不到函数 ${name}（改名了？先修本闸再改代码）`);
  return found;
}

/** 收集某个注册函数在给定作用域内的调用点，连同包裹它的 if 守卫。 */
function registrarSites(scope: ts.Node, registrar: string): RegistrarSite[] {
  const sites: RegistrarSite[] = [];
  const guards: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      guards.push(node.expression);
      ts.forEachChild(node.thenStatement, visit);
      // then 分支里的调用才受这条守卫保护；条件表达式与 else 分支不算。
      guards.pop();
      if (node.elseStatement) ts.forEachChild(node.elseStatement, visit);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === registrar
    ) {
      const identifiers = new Set<string>();
      for (const guard of guards) {
        const collect = (child: ts.Node): void => {
          if (ts.isIdentifier(child)) identifiers.add(child.text);
          ts.forEachChild(child, collect);
        };
        collect(guard);
      }
      let innermost: ts.Node | undefined = node;
      let hasElse = false;
      while (innermost) {
        if (ts.isIfStatement(innermost)) {
          hasElse = innermost.elseStatement !== undefined;
          break;
        }
        innermost = innermost.parent;
      }
      sites.push({ guardIdentifiers: identifiers, innermostGuardHasElse: hasElse });
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return sites;
}

async function contentReadApiBody(): Promise<ts.Node> {
  const source = await readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('src/server.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return functionBody(file, 'startContentReadApi');
}

test('content 内部 API 真的挂上了概念池与精选召回两组，且两组各挂各的', async () => {
  const body = await contentReadApiBody();
  const concept = registrarSites(body, CONCEPT_REGISTRAR);
  const curated = registrarSites(body, CURATED_REGISTRAR);

  assert.equal(concept.length, 1, `${CONCEPT_REGISTRAR} 在 content 内部 API 里 MUST 恰好注册一次`);
  assert.equal(curated.length, 1, `${CURATED_REGISTRAR} 在 content 内部 API 里 MUST 恰好注册一次`);

  // 「一组初始化失败不得连带关闭其它组」的机械判据：两组各自至少有一条对方没有的守卫。
  // 若两者共用同一套守卫，属主 A 起不来就会把属主 B 的路由一起带下去——
  // 而 automation 侧读到的是同一个「对面不支持这个方法」，看不出真实原因。
  const conceptOnly = [...concept[0]!.guardIdentifiers].filter(
    (id) => !curated[0]!.guardIdentifiers.has(id),
  );
  const curatedOnly = [...curated[0]!.guardIdentifiers].filter(
    (id) => !concept[0]!.guardIdentifiers.has(id),
  );
  assert.ok(conceptOnly.length > 0, '概念池那组必须有一条精选组没有的守卫，否则两组是连体的');
  assert.ok(curatedOnly.length > 0, '精选组必须有一条概念池组没有的守卫，否则两组是连体的');

  // 缺席 MUST 留痕：没有 else 分支＝属主起不来时一条路由静默消失，启动日志里一个字都没有。
  assert.ok(concept[0]!.innermostGuardHasElse, '概念池那组未注册时 MUST 有 else 分支明说，不得静默跳过');
  assert.ok(curated[0]!.innermostGuardHasElse, '精选组未注册时 MUST 有 else 分支明说，不得静默跳过');
});

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

test('单体不挂这两组路由：本轮 content 侧接线对单体逐位不变', () => {
  assert.equal(listenersForMode('monolith').contentReadApi, false);
  assert.equal(listenersForMode('core').contentReadApi, false);
  assert.equal(listenersForMode('content').contentReadApi, true);
});
