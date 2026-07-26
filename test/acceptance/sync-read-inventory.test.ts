import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SYNC_READ_STREAM_DEFINITIONS,
  type SyncReadStream,
} from '../../src/kernel/sync-read-snapshot.js';
import { readJson, repoPath } from './helpers/boundary-scan.js';

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

test('registered synchronous members still exist at their source and current call sites', () => {
  const missing: string[] = [];
  for (const item of inventory.items) {
    for (const member of item.members) {
      const declaration = readFileSync(repoPath(member.sourceFile), 'utf8');
      const declarationPattern = new RegExp(`\\b${escapeRegExp(member.method)}\\s*(?:\\?|!)?\\s*\\(`);
      const callPattern = new RegExp(`\\b${escapeRegExp(member.method)}\\s*(?:\\?\\.|!)?\\s*\\(`);
      if (!declarationPattern.test(declaration)) {
        missing.push(`${item.id} declaration ${member.symbol} in ${member.sourceFile}`);
      }
      if (
        !member.callSiteFiles.some((file) =>
          callPattern.test(readFileSync(repoPath(file), 'utf8')),
        )
      ) {
        missing.push(`${item.id} call site ${member.symbol} in ${member.callSiteFiles.join(',')}`);
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

test('source-derived cross-owner synchronous census has no unregistered member', () => {
  const unregistered: string[] = [];
  const unresolved: string[] = [];
  for (const policy of inventory.censusPolicies) {
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
  const fullSource = readFileSync(repoPath(policy.file), 'utf8');
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
  const ownerSource = readFileSync(repoPath(policy.sourceFile), 'utf8');
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
