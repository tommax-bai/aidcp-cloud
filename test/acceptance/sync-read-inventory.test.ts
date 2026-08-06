import { readFileSync, readdirSync, statSync } from 'node:fs';
// aidcp:test-owner=cloud
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  SYNC_READ_STREAM_DEFINITIONS,
  type SyncReadStream,
} from '@kernel/kernel/sync-read-snapshot.js';
import { readJson } from './helpers/sql-scan.js';
import { ownedSourcePath, siblingRepoRoot, type OwnerLayer } from '../helpers/sibling-repos.js';

/**
 * 事实源翻转后（invert-split-fact-source 5.3/5.6）本清点的读法：
 *   - 清点记录本身（boundaries/sync-read-inventory.json）与文件级归属表仍读本仓冻结副本；
 *   - 源码证据改读**属主仓的现役文件**（经归属表解析），成员的「仍被调用」证据改在
 *     四个兄弟仓 src/ 的并集图上找 —— 单体 src/server.ts 的调用点已不存在，
 *     并集图正是「整台机器还在同步消费这个面」在拆分宇宙里的对应物。
 */
const OWNER_LAYERS = new Set<OwnerLayer>(['api', 'automation', 'content', 'kernel']);
const OWNERSHIP: Map<string, string> = new Map(
  readJson<Array<{ path: string; layer: string }>>('boundaries/module-ownership.json').map(
    (entry) => [entry.path, entry.layer],
  ),
);

/** 属主仓里该文件的现役路径。组装根（layer=composition）没有单一现役文件，调用方须走并集。 */
function ownedDataPath(monolithRel: string): string | null {
  const layer = OWNERSHIP.get(monolithRel);
  assert.ok(layer, `${monolithRel} 不在冻结归属表里：清点记录与归属表漂移，先修记录`);
  if (layer === 'composition') return null;
  assert.ok(OWNER_LAYERS.has(layer as OwnerLayer), `${monolithRel} 的属主层 ${layer} 无仓可解析`);
  return ownedSourcePath(layer as OwnerLayer, monolithRel.replace(/^src\//, ''));
}

function readOwnedData(monolithRel: string): string {
  const path = ownedDataPath(monolithRel);
  assert.ok(path, `${monolithRel} 是单体组装根，没有单一现役文件 —— 该断言必须走并集图`);
  return readFileSync(path, 'utf8');
}

/** 四个兄弟仓 src/ 的并集图（惰性读一次）。 */
let unionCache: Array<{ label: string; content: string }> | null = null;
function unionSourceFiles(): Array<{ label: string; content: string }> {
  if (unionCache) return unionCache;
  const out: Array<{ label: string; content: string }> = [];
  for (const repo of ['aidcp-api', 'aidcp-automation', 'aidcp-content', 'aidcp-kernel']) {
    const root = join(siblingRepoRoot(repo), 'src');
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === 'node_modules' || name === 'dist') continue;
          walk(full);
        } else if (name.endsWith('.ts')) {
          out.push({ label: `${repo}${full.slice(join(root, '..').length)}`, content: readFileSync(full, 'utf8') });
        }
      }
    };
    walk(root);
  }
  assert.ok(out.length > 0, 'union source graph is empty — sibling checkouts missing?');
  unionCache = out;
  return out;
}

interface InventoryMember {
  symbol: string;
  method: string;
  sourceFile: string;
  callSiteFiles: string[];
  kind: 'sync_read';
}

interface InventoryItem {
  id: string;
  owner: 'api' | 'automation' | 'local';
  consumer: 'api' | 'automation' | 'api_and_automation';
  factScope: 'shared' | 'target' | 'static' | 'local';
  transport: 'owner_snapshot' | 'kernel_static' | 'per_process_runtime';
  streams: SyncReadStream[];
  localShape: string;
  survivingFields?: string[];
  excludedFields?: string[];
  pendingCompositionRootRemovals?: string[];
  freshnessTier: string;
  members: InventoryMember[];
  excludedSideEffects?: Array<{
    symbol: string;
    method: string;
    ownerChange: string;
    mechanism: string;
  }>;
}

interface Inventory {
  schemaVersion: number;
  baseline: {
    cloudSha: string;
    barrierMergeCommit: string;
    controlChange: string;
    note: string;
  };
  censusPolicies: CensusPolicy[];
  items: InventoryItem[];
}

interface CensusPolicy {
  id: string;
  inventoryIds: string[];
  mode: 'receiver_methods' | 'method_declarations' | 'named_imports';
  file: string;
  startMarker?: string;
  endMarker?: string;
  receiverPattern?: string;
  symbolPrefix?: string;
  sourceFile?: string;
  modulePatterns?: string[];
}

const inventory = readJson<Inventory>('boundaries/sync-read-inventory.json');

const READ_SHAPED_METHOD =
  /^(?:automationGate|available|binding|count|created|declarations|edge|effective|get|has|health|is|list|normalize|online|platform|resolve|slowStart|week)/;

test('4b census has exactly A1-A6/B1-B5 with machine-readable owner, scope, shape and freshness', () => {
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.baseline.cloudSha, 'b94f6ad7d8ac935562e88feafefeeafd5c4e2941');
  assert.equal(inventory.baseline.barrierMergeCommit, '2fcbdda');
  assert.equal(inventory.baseline.controlChange, 'split-cloud-api-composition-root-4b');
  assert.deepEqual(
    inventory.items.map((item) => item.id),
    ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5'],
  );
  for (const item of inventory.items) {
    assert.ok(item.owner);
    assert.ok(item.consumer);
    assert.ok(item.factScope);
    assert.ok(item.transport);
    assert.ok(item.localShape);
    assert.ok(item.freshnessTier);
    assert.ok(item.members.length > 0, `${item.id} must name its current synchronous members`);
  }
});

test('post-4a B1/B2/B4 owner snapshots expose only the surviving split-service fields', () => {
  const byId = new Map(inventory.items.map((item) => [item.id, item]));
  assert.deepEqual(byId.get('B1')?.survivingFields, ['accountId', 'personaText', 'soul']);
  assert.deepEqual(byId.get('B2')?.survivingFields, [
    'blockedEnvironmentKeys',
    'slowStartAnchors.accountId',
    'slowStartAnchors.slowStartSince',
    'slowStartAnchors.slowStartCompletedAt',
    'slowStartAnchors.ambiguous',
  ]);
  assert.deepEqual(byId.get('B4')?.survivingFields, [
    'accountId',
    'platform',
    'groupLabel',
    'createdAt',
    'status',
  ]);

  for (const id of ['B1', 'B2', 'B4']) {
    const item = byId.get(id);
    assert.ok(item?.excludedFields?.length, `${id} must name intentionally excluded fields`);
    assert.equal(item.excludedFields?.some((field) => item.survivingFields?.includes(field)), false);
  }
  assert.deepEqual(byId.get('B4')?.pendingCompositionRootRemovals, [
    'accountDisplayName',
    'accountDisplayNameCandidates',
    'PgAccountStore.getNickname',
  ]);
});

test('all remote snapshot streams are registered exactly once with matching owner/consumer/scope', () => {
  const inventoryStreams = inventory.items.flatMap((item) =>
    item.streams.map((stream) => ({
      stream,
      owner: item.owner,
      consumer: item.consumer,
      factScope: item.factScope,
    })),
  );
  assert.deepEqual(
    inventoryStreams.map(({ stream }) => stream).sort(),
    Object.keys(SYNC_READ_STREAM_DEFINITIONS).sort(),
  );
  for (const entry of inventoryStreams) {
    const definition = SYNC_READ_STREAM_DEFINITIONS[entry.stream];
    assert.equal(definition.owner, entry.owner, `${entry.stream} owner drift`);
    assert.equal(definition.consumer, entry.consumer, `${entry.stream} consumer drift`);
    assert.equal(definition.factScope, entry.factScope, `${entry.stream} fact scope drift`);
  }
});

/**
 * 拆分后按裁定退休的成员：单体组装根曾就地声明的 `PersonaResolver.resolvePersona`，
 * 在四仓并集图上既无声明也无调用（人设查询面拆分后 = PersonaStore.getForAccount/bindingFor
 * + kernel parseSyncReadPersonaSoul，由 AC-PERSONA-PARSE-* 与 api 仓同步读用例看守）。
 * 反向钉死：它若在并集图上重新出现，本清单必须重审 —— 不许静默放行。
 */
const RETIRED_MEMBER_METHODS = new Set(['resolvePersona']);

test('registered synchronous members still exist at their source and in the union graph', () => {
  const missing: string[] = [];
  const union = unionSourceFiles();
  for (const item of inventory.items) {
    for (const member of item.members) {
      const declarationPattern = new RegExp(`\\b${escapeRegExp(member.method)}\\s*(?:\\?|!)?\\s*\\(`);
      const callPattern = new RegExp(`\\b${escapeRegExp(member.method)}\\s*(?:\\?\\.|!)?\\s*\\(`);
      if (RETIRED_MEMBER_METHODS.has(member.method)) {
        const reappeared = union.filter(
          (f) => declarationPattern.test(f.content) || callPattern.test(f.content),
        );
        assert.deepEqual(
          reappeared.map((f) => f.label),
          [],
          `${item.id} ${member.symbol} 已按裁定退休（单体死亡时随之消失），却在并集图上重新出现 —— 先重审清点记录`,
        );
        continue;
      }
      const declPath = ownedDataPath(member.sourceFile);
      const declared = declPath
        ? declarationPattern.test(readFileSync(declPath, 'utf8'))
        : union.some((f) => declarationPattern.test(f.content));
      if (!declared) {
        missing.push(`${item.id} declaration ${member.symbol} in ${member.sourceFile}`);
      }
      if (!union.some((f) => callPattern.test(f.content))) {
        missing.push(`${item.id} call site ${member.symbol} (union graph)`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `registered cross-owner synchronous reads drifted; update owner/consumer/shape/unknown semantics before changing the census:\n${missing.join('\n')}`,
  );
});

test('snapshot members are read-only and A3 excludes the 4a resume command', () => {
  const registeredReads = new Set(
    inventory.items
      .filter((item) => item.transport === 'owner_snapshot')
      .flatMap((item) => item.members.map((member) => member.method)),
  );
  const forbiddenPrefixes =
    /^(?:add|apply|bind|claim|create|delete|emit|pause|publish|record|remove|replace|resume|set|start|stop|submit|update|write)(?:[A-Z]|$)/;
  const suspicious = [...registeredReads].filter((method) => forbiddenPrefixes.test(method));
  assert.deepEqual(
    suspicious,
    [],
    `side-effect-shaped methods cannot be snapshot members: ${suspicious.join(',')}`,
  );

  const a3 = inventory.items.find((item) => item.id === 'A3');
  assert.ok(a3);
  assert.deepEqual(
    a3.members.map((member) => member.method),
    ['edgeCount', 'onlineEdgeCount', 'resolveEdgeIdForAccount'],
  );
  assert.deepEqual(a3.excludedSideEffects, [
    {
      symbol: 'EdgeCloudServer.resumeEdgesForAccount',
      method: 'resumeEdgesForAccount',
      ownerChange: 'split-cloud-api-composition-root-4a',
      mechanism: 'authenticated_target_bound_idempotent_command_with_result_unknown',
    },
  ]);
  assert.equal(registeredReads.has('resumeEdgesForAccount'), false);
});

/**
 * 单体组装根（file=src/server.ts）上的清点策略按裁定退休：它们观测的宇宙 —— 「一份组装根里、
 * 消费段直接对另一属主的存储收发同步调用」 —— 随单体一起消失了。拆分后同步跨属主读在结构上
 * 不可达：消费仓里根本 import 不到对方的存储类（各仓 typecheck / 边界门禁当场拦），
 * 现役的跨进程面由 kernel 的流注册表（上面那条 parity 用例钉着）与各仓自己的组装根用例看守
 * （api：api-sync-read-refresh-margin / mirror-bump-wiring；automation：automation-root-readiness-ledger
 * 与镜像用例）。留下的两条策略观测的是仍然活着的跨仓面（api 面板契约 ↔ automation 实现、
 * api 存储 ↔ kernel 目录读者），继续在属主仓的现役文件上执行。
 * 下面的集合相等断言保证退休名单**恰好**等于组装根策略：新策略若锚在现役文件上，绝不会被顺带跳过。
 */
const RETIRED_MONOLITH_ROOT_POLICIES = [
  'A1-content-schedule-injection',
  'A3-api-edge-resolution',
  'A4-api-in-flight',
  'A5-api-captcha',
  'A6-api-automation-health',
  'B1-automation-persona',
  'B2-automation-client-environment',
  'B3-local-freshness-imports',
  'B4-automation-account-store',
  'B4-automation-account-state',
  'B5-content-schedule',
  'B5-hot-lead',
  'B5-facebook-comment',
  'B5-facebook-group-join',
] as const;

test('retired census policies are exactly the monolith-root ones, nothing else is skipped', () => {
  assert.deepEqual(
    inventory.censusPolicies
      .filter((policy) => policy.file === 'src/server.ts')
      .map((policy) => policy.id)
      .sort(),
    [...RETIRED_MONOLITH_ROOT_POLICIES].sort(),
    '退休名单 MUST 恰好等于「锚在单体组装根上」的策略集合；任何锚在现役文件上的策略都必须真跑',
  );
});

test('source-derived cross-owner synchronous census has no unregistered member', () => {
  const unregistered: string[] = [];
  const unresolved: string[] = [];
  const retired = new Set<string>(RETIRED_MONOLITH_ROOT_POLICIES);
  for (const policy of inventory.censusPolicies) {
    if (retired.has(policy.id)) continue;
    const registered = new Set(
      inventory.items
        .filter((item) => policy.inventoryIds.includes(item.id))
        .flatMap((item) => item.members.map((member) => member.symbol)),
    );
    let observed: string[];
    try {
      observed = observePolicy(policy);
    } catch (error) {
      unresolved.push(`${policy.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const symbol of observed) {
      if (!registered.has(symbol)) unregistered.push(`${policy.id}: ${symbol}`);
    }
  }
  assert.deepEqual(
    unresolved,
    [],
    `census policy could not be evaluated; unresolved input must fail rather than disappear:\n${unresolved.join('\n')}`,
  );
  assert.deepEqual(
    unregistered,
    [],
    `source census found an unregistered synchronous cross-owner read; declare owner, consumer, shape, freshness and unknown semantics first:\n${unregistered.join('\n')}`,
  );
});

test('census scanner self-test rejects a newly inserted read-shaped receiver method', () => {
  const observed = scanReceiverMethodNames(
    'foreign.getKnown(); foreign.resolveNewTarget(); await foreign.listAsync();',
    'foreign',
  ).filter((method) => method !== 'listAsync');
  const registered = new Set(['getKnown']);
  assert.deepEqual(
    observed.filter((method) => !registered.has(method)),
    ['resolveNewTarget'],
  );
});

function observePolicy(policy: CensusPolicy): string[] {
  const fullSource = readOwnedData(policy.file);
  const source = slicePolicyRegion(fullSource, policy);
  if (policy.mode === 'named_imports') {
    const names = (policy.modulePatterns ?? []).flatMap((modulePattern) =>
      namedImportsFrom(fullSource, modulePattern),
    );
    return [...new Set(names.filter((name) => new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(fullSource)))].sort();
  }
  if (!policy.symbolPrefix) throw new Error('symbolPrefix is required');
  if (policy.mode === 'method_declarations') {
    const methods = [...source.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*:/g)]
      .map((match) => match[1]!)
      .filter((method) => READ_SHAPED_METHOD.test(method));
    return [...new Set(methods.map((method) => `${policy.symbolPrefix}.${method}`))].sort();
  }
  if (!policy.receiverPattern || !policy.sourceFile) {
    throw new Error('receiverPattern and sourceFile are required');
  }
  const ownerSource = readOwnedData(policy.sourceFile);
  const methods = scanReceiverMethodNames(source, policy.receiverPattern)
    .filter((method) => READ_SHAPED_METHOD.test(method))
    .filter((method) => methodIsSynchronous(ownerSource, method));
  return [...new Set(methods.map((method) => `${policy.symbolPrefix}.${method}`))].sort();
}

function slicePolicyRegion(source: string, policy: CensusPolicy): string {
  let start = 0;
  let end = source.length;
  if (policy.startMarker) {
    start = source.indexOf(policy.startMarker);
    if (start < 0) throw new Error(`start marker missing: ${policy.startMarker}`);
  }
  if (policy.endMarker) {
    end = source.indexOf(policy.endMarker, start + (policy.startMarker?.length ?? 0));
    if (end < 0) throw new Error(`end marker missing: ${policy.endMarker}`);
  }
  if (end <= start) throw new Error('census region is empty or reversed');
  return source.slice(start, end);
}

function scanReceiverMethodNames(source: string, receiverPattern: string): string[] {
  const pattern = new RegExp(
    `(?:${receiverPattern})\\s*(?:\\?\\.|\\.)\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*(?:\\?\\.)?!?\\s*\\(`,
    'g',
  );
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

function methodIsSynchronous(source: string, method: string): boolean {
  const pattern = new RegExp(
    `^\\s*(?:(?:public|private|protected|readonly|static|abstract|override)\\s+)*(async\\s+)?${escapeRegExp(method)}\\s*\\??\\s*\\([^)]*\\)\\s*(?::\\s*([^;{\\n]+))?\\s*[;{]`,
    'gm',
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0) {
    throw new Error(`method declaration not found: ${method}`);
  }
  return matches.some((match) => !match[1] && !/\bPromise\s*</.test(match[2] ?? ''));
}

function namedImportsFrom(source: string, modulePath: string): string[] {
  const pattern = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapeRegExp(modulePath)}['"]`,
    'g',
  );
  return [...source.matchAll(pattern)].flatMap((match) =>
    match[1]!
      .split(',')
      .map((member) => member.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[1] ?? member.trim().replace(/^type\s+/, ''))
      .filter((member) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(member)),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
