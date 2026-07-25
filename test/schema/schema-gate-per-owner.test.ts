/**
 * 启动期契约门的**逐属主**判定（src/schema/schema-gate.ts）。
 *
 * 用例克制：只钉三条 ——
 *   ① 属主 URL 未设（今天）：三属主共用一个账本连接，只读一次账本，三家判定全通过；
 *   ② 拆库后单个属主库缺自己的迁移 → enforce 下**响亮失败**，且只点该属主
 *      （这正是原实现的假绿：它只读旧共享库那一份账本，永远看不见属主库里的洞）；
 *   ③ 属主判据不可用（迁移目录 / 边界清单读不出）→ MUST 判失败，MUST NOT「查不到就当通过」。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadMigrationFiles } from '../../src/schema/migration-files.js';
import {
  attributeMigrations,
  loadTableOwnership,
  versionsForOwner,
} from '../../src/schema/migration-owners.js';
import { versionOf } from '../../src/schema/migration-plan.js';
import { runSchemaContractGate } from '../../src/schema/schema-gate.js';

function ledgerStub(versions: string[]) {
  const queries: string[] = [];
  return {
    queries,
    client: {
      async query(text: string) {
        queries.push(text);
        return { rows: versions.map((version) => ({ version })) };
      },
    },
  };
}

test('属主 URL 未设：三属主共用一个账本连接，读一次账本、判三次、全通过', async () => {
  const files = await loadMigrationFiles();
  const stub = ledgerStub(files.map((f) => versionOf(f.name)));

  const result = await runSchemaContractGate({ client: stub.client, mode: 'enforce' });

  assert.equal(result.pass, true);
  assert.deepEqual(result.owners.map((o) => o.owner), ['content', 'automation', 'api']);
  assert.equal(stub.queries.length, 1, '同一个连接目标 MUST 只读一次账本（今天的库侧动作与改动前一致）');
  for (const owner of result.owners) {
    assert.equal(owner.decision.status, 'ok', `${owner.owner}: ${owner.conclusion}`);
    assert.deepEqual(owner.decision.holes, [], `${owner.owner} 的账本不该有空洞`);
  }
});

test('拆库后单个属主库缺自己的迁移 → enforce 响亮失败，且只点该属主', async () => {
  const files = await loadMigrationFiles();
  const index = attributeMigrations(files, await loadTableOwnership());
  const all = files.map((f) => versionOf(f.name));
  // content 库只应用到最早那条：它自己的账本是残缺的，而 api / automation 两库完好。
  const contentPartial = [versionsForOwner(index, 'content')[0]];

  const contentStub = ledgerStub(contentPartial);
  const automationStub = ledgerStub(all);
  const apiStub = ledgerStub(all);

  await assert.rejects(
    () =>
      runSchemaContractGate({
        mode: 'enforce',
        clients: { content: contentStub.client, automation: automationStub.client, api: apiStub.client },
      }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /schema_behind_code/);
      assert.match(message, /\[content\]/, '失败 MUST 点名是哪个属主库');
      assert.ok(!message.includes('[api]'), 'api 库是完好的，MUST NOT 被连坐');
      assert.ok(!message.includes('[automation]'), 'automation 库是完好的，MUST NOT 被连坐');
      return true;
    },
  );

  // 每个属主各连各的库、各读各的账本：三条连接各读一次。
  assert.equal(contentStub.queries.length, 1);
  assert.equal(automationStub.queries.length, 1);
  assert.equal(apiStub.queries.length, 1);
});

test('属主判据不可用 → 明确失败，绝不「查不到就当通过」', async () => {
  const stub = ledgerStub([]);
  await assert.rejects(
    () =>
      runSchemaContractGate({
        mode: 'enforce',
        client: stub.client,
        loadScopes: () => Promise.reject(new Error('migrations/ 读不出来')),
      }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /schema_owner_attribution_unavailable/);
      assert.match(message, /migrations\/ 读不出来/);
      return true;
    },
  );
  assert.equal(stub.queries.length, 0, '判据不可用时 MUST NOT 连库「试一下」再放行');
});

/* ── Block④ 三仓提取 · 批次 0：判定范围跟随「本进程连了哪些属主库」 ────────────────────
 * 两条即够：收窄时只判该属主（不替没连的库背书），空集合不许把门关掉。
 */

test('owners 收窄：只判本进程连的属主，不给没连的库出结论', async () => {
  const files = await loadMigrationFiles();
  const stub = ledgerStub(files.map((f) => versionOf(f.name)));

  const result = await runSchemaContractGate({
    client: stub.client,
    mode: 'enforce',
    owners: ['content'],
  });

  assert.equal(result.pass, true);
  assert.deepEqual(
    result.owners.map((o) => o.owner),
    ['content'],
    '本进程没连 api / automation 的库，就没有立场声称它们的 schema 对或不对',
  );
});

test('owners 传空集合视为未指定：MUST 判满三个属主，绝不把门静默关掉', async () => {
  const files = await loadMigrationFiles();
  const stub = ledgerStub(files.map((f) => versionOf(f.name)));

  const result = await runSchemaContractGate({ client: stub.client, mode: 'enforce', owners: [] });

  assert.deepEqual(
    result.owners.map((o) => o.owner),
    ['content', 'automation', 'api'],
    '「一个库都不判」永远不该是默认结果——那等于一次静默的门失效',
  );
});
