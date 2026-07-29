import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  PRODUCTION_CONSUMER_BINDINGS,
  assertNoIndependentRootBlockers,
  deriveIndependentRootBlockers,
  deriveSeamSuppressedProbeMatches,
  deriveSurface,
  evidenceForProbe,
  type DerivedBlocker,
  type SurfaceDirection,
} from './helpers/composition-root-4a-census.js';

interface SurfaceGroup {
  id: string;
  direction: SurfaceDirection;
  owner: 'api' | 'automation' | 'content';
  ownerSourceFile: string;
  consumer: string;
  methods: string[];
}

interface ApprovedAlternate {
  id: string;
  description: string;
  oneOf: string[];
}

interface SurfaceInventory {
  expectedGroups: number;
  expectedMethodSlots: number;
  expectedProductionConsumerSlots: number;
  directions: Record<SurfaceDirection, { groups: number; methodSlots: number }>;
  groups: SurfaceGroup[];
  approvedAlternates: ApprovedAlternate[];
  excludedMethods: string[];
}

interface OwnershipEntry {
  path: string;
  layer: string;
}

interface BlockerLedger {
  claimBlocked: boolean;
  claim: string;
  blockers: DerivedBlocker[];
}

async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as T;
}

test('4a source-derived census is exactly 20 groups and 55 method slots', async () => {
  const [inventory, derived] = await Promise.all([
    loadJson<SurfaceInventory>(
      '../../boundaries/composition-root-4a-authority-surface.json',
    ),
    deriveSurface(),
  ]);
  assert.equal(inventory.expectedGroups, 20);
  assert.equal(inventory.expectedMethodSlots, 55);
  assert.equal(inventory.expectedProductionConsumerSlots, 55);
  assert.equal(inventory.groups.length, 20);
  assert.equal(
    inventory.groups.reduce((sum, group) => sum + group.methods.length, 0),
    55,
  );
  assert.equal(derived.groups.length, 20);

  const expectedById = new Map(inventory.groups.map((group) => [group.id, group]));
  for (const actual of derived.groups) {
    const expected = expectedById.get(actual.id);
    assert.ok(expected, `${actual.id} must be listed in the reviewed inventory`);
    assert.equal(actual.direction, expected.direction, `${actual.id} direction`);
    assert.deepEqual(
      actual.methods,
      expected.methods,
      `${actual.id} kernel interface drifted from the reviewed inventory`,
    );
    assert.deepEqual(
      actual.routeMethods,
      actual.methods,
      `${actual.id} transport route keys must exhaust the compiler-derived port`,
    );
    assert.deepEqual(
      actual.registeredRouteMethods,
      actual.methods,
      `${actual.id} owner route registration must exhaust the compiler-derived port`,
    );
    assert.deepEqual(
      actual.clientMethods,
      actual.methods,
      `${actual.id} HTTP client must exhaust the compiler-derived port`,
    );
    assert.deepEqual(
      actual.productionConsumerMethods,
      actual.methods,
      `${actual.id} has an admitted slot without a real production consumer call site`,
    );
    assert.deepEqual(
      Object.keys(actual.productionConsumerCallSites),
      actual.methods,
      `${actual.id} consumer evidence must be method-exhaustive and ordered`,
    );
    for (const method of actual.methods) {
      assert.ok(
        actual.productionConsumerCallSites[method]?.every((site) => site.includes('#call:')),
        `${actual.id}.${method} must resolve to AST call-site evidence`,
      );
    }
    assert.equal(
      actual.productionRegistration,
      true,
      `${actual.id} owner route is not registered by src/server.ts`,
    );
    assert.equal(
      actual.productionClient,
      true,
      `${actual.id} remote client is not constructed by src/server.ts`,
    );
  }

  for (const direction of Object.keys(inventory.directions) as SurfaceDirection[]) {
    const groups = derived.groups.filter((group) => group.direction === direction);
    assert.equal(
      groups.length,
      inventory.directions[direction].groups,
      `${direction} group count`,
    );
    assert.equal(
      groups.reduce((sum, group) => sum + group.methods.length, 0),
      inventory.directions[direction].methodSlots,
      `${direction} method-slot count`,
    );
  }
  assert.deepEqual(inventory.directions, {
    'automation-to-api': { groups: 16, methodSlots: 50 },
    'api-to-automation': { groups: 3, methodSlots: 4 },
    'api-to-content': { groups: 1, methodSlots: 1 },
  });
  const consumerSlotKeys = PRODUCTION_CONSUMER_BINDINGS.map(
    (binding) => `${binding.groupId}:${binding.method}`,
  );
  assert.equal(consumerSlotKeys.length, 55);
  assert.equal(
    new Set(consumerSlotKeys).size,
    55,
    'production consumer bindings must cover each admitted slot exactly once',
  );
});

test('4a source guard accepts only the reviewed pending-scan and preview alternates', async () => {
  const [inventory, derived] = await Promise.all([
    loadJson<SurfaceInventory>(
      '../../boundaries/composition-root-4a-authority-surface.json',
    ),
    deriveSurface(),
  ]);
  const reviewed = new Map(
    inventory.approvedAlternates.map((alternate) => [alternate.id, alternate.oneOf]),
  );
  for (const alternate of derived.alternates) {
    assert.ok(alternate.selected, `${alternate.id} has no approved production wiring`);
    assert.ok(
      reviewed.get(alternate.id)?.includes(alternate.selected),
      `${alternate.id} used unreviewed production wiring ${alternate.selected}`,
    );
  }
  assert.equal(
    derived.alternates.find((alternate) => alternate.id === 'pending-publish-scan')?.selected,
    'publishApprovalClient.listPendingDispatch',
    '3b authenticated listPendingDispatch remains the approved dispatcher scan; do not add a 4a listPendingApprovalIds slot',
  );
});

test('4a inventory owner sources agree with the generated module ownership map', async () => {
  const [inventory, ownership] = await Promise.all([
    loadJson<SurfaceInventory>('../../boundaries/composition-root-4a-authority-surface.json'),
    loadJson<OwnershipEntry[]>('../../boundaries/module-ownership.json'),
  ]);
  const ownerByPath = new Map(ownership.map((entry) => [entry.path, entry.layer]));
  for (const group of inventory.groups) {
    assert.equal(
      ownerByPath.get(group.ownerSourceFile),
      group.owner,
      `${group.id} owner source ${group.ownerSourceFile}`,
    );
  }
});

test('4a inventory excludes local-only, 3b and 4b methods from every remote surface', async () => {
  const inventory = await loadJson<SurfaceInventory>(
    '../../boundaries/composition-root-4a-authority-surface.json',
  );
  const admitted = new Set(inventory.groups.flatMap((group) => group.methods));
  for (const method of inventory.excludedMethods) {
    assert.equal(admitted.has(method), false, `${method} must remain outside 4a remote ports`);
  }
  assert.deepEqual(
    inventory.groups.find((group) => group.id === 'api-notification-exit')?.methods,
    ['deliver'],
    'notification transport must not expose chat resolve/bind helpers',
  );
  assert.deepEqual(
    inventory.groups.find((group) => group.id === 'publish-log-for-automation')?.methods.length,
    19,
    'publish authority has 19 admitted slots after indirect-consumer review',
  );
});

test('full-root blocker ledger exactly matches source-derived composition blockers', async () => {
  const [ledger, actual] = await Promise.all([
    loadJson<BlockerLedger>(
      '../../boundaries/composition-root-independent-blockers.json',
    ),
    deriveIndependentRootBlockers(),
  ]);
  assert.equal(
    ledger.claimBlocked,
    actual.length > 0,
    'claimBlocked must be derived from whether the source blocker ledger is empty',
  );
  assert.match(ledger.claim, /independently bootable/);
  assert.deepEqual(
    actual,
    ledger.blockers,
    'blocker ledger must be updated whenever source adds, removes, or rewires a full-root blocker',
  );
  assert.equal(
    actual.filter((blocker) => blocker.category === '4b-mirror').length,
    14,
    '4b blockers must enumerate A1-A6, B1-B4 and four independent B5 streams',
  );
  assert.equal(
    actual.filter((blocker) => blocker.category === 'operator-command').length,
    4,
    'Feishu operator bridge must enumerate delegate, publish/comment, card actions and dispatch',
  );
  assert.equal(
    actual.filter((blocker) => blocker.category === 'content-owner').length,
    10,
    'content-owner blockers: draft refinement, facebook publish media, concept, curated,'
    + ' role factories, generic llm, token usage, text-card transcription, reply generation,'
    + ' publish rejection evidence',
  );
  for (const blocker of actual) {
    assert.ok(blocker.owner.length > 0, `${blocker.id} owner`);
    assert.ok(blocker.consumer.length > 0, `${blocker.id} consumer`);
    assert.ok(
      blocker.closingChange === 'split-cloud-api-composition-root-4b'
        || blocker.closingChange === 'future',
      `${blocker.id} closing change`,
    );
    assert.ok(
      blocker.evidence.every((item) => item.startsWith('src/')),
      `${blocker.id} evidence must name a production source anchor`,
    );
  }
  assert.ok(actual.some((blocker) => blocker.id === 'content-facebook-publish-media-authority'));
  assert.ok(actual.some((blocker) => blocker.id === 'content-role-factories'));
  assert.ok(actual.some((blocker) => blocker.id === 'content-generic-llm-authority'));
  assert.ok(actual.some((blocker) => blocker.id === 'content-token-usage-authority'));
  assert.ok(actual.some((blocker) => blocker.id === 'content-textcard-transcription-authority'));
  assert.ok(actual.some((blocker) => blocker.id === 'content-reply-generation-authority'));
  assert.ok(
    actual.some((blocker) => blocker.id === 'content-publish-rejection-evidence-authority'),
  );
  assert.ok(actual.some((blocker) => blocker.id.startsWith('seg-a-foreign-pool-')));
  assert.ok(actual.some((blocker) => blocker.id.startsWith('seg-a-api-owner-')));
  assert.equal(
    actual.some((blocker) =>
      blocker.id.includes('persona-generator')
      || blocker.evidence.some((item) => item.includes('PersonaGenerator'))),
    false,
    'PersonaGenerator is the approved 4a content port and must not remain in the blocker ledger;'
    + ' the only segC `new PersonaGenerator` (src/server.ts) sits inside the'
    + " `seamMode === 'monolith'` branch — in automation mode the persona port comes from"
    + ' apiDirectPorts.accountPersona, so it does not block an independent automation root',
  );
});

/**
 * The seam filter is otherwise unobservable: a probe aimed at a branch no
 * independent root executes would just quietly add a phantom blocker, and no
 * existing assertion would move. These three probes are the anchor — the two
 * negative cases are real unexecuted constructions in segC (one behind
 * `=== 'monolith'`, one behind `!== 'automation'`, which task 0.3f widened the
 * filter to cover), the positive case is a real unconditional one in the same
 * scope, so deleting the filter turns the first assertions red and weakening
 * `existsInScope` turns the last one red.
 */
test('new/call probes ignore seam branches no independent root executes', async () => {
  assert.equal(
    await evidenceForProbe({
      sourceFile: 'src/server.ts',
      scope: 'segCAutomation',
      kind: 'new',
      symbol: 'PersonaGenerator',
    }),
    null,
    "segC's only `new PersonaGenerator` sits inside `if (seamMode === 'monolith')`;"
    + ' an automation process never executes it, so a probe pointing there must not'
    + ' manufacture a blocker',
  );
  assert.equal(
    await evidenceForProbe({
      sourceFile: 'src/server.ts',
      scope: 'segCAutomation',
      kind: 'new',
      symbol: 'DraftRefinementWorker',
    }),
    null,
    "segC's only `new DraftRefinementWorker` sits behind `seamMode !== 'automation' && …`,"
    + ' so the automation process skips it by guard while api and content skip segC'
    + ' entirely — no independent root is blocked by it',
  );
  assert.equal(
    await evidenceForProbe({
      sourceFile: 'src/server.ts',
      scope: 'segCAutomation',
      kind: 'new',
      symbol: 'ConfigMirrorRefresher',
    }),
    'src/server.ts#segCAutomation:new:ConfigMirrorRefresher',
    'an unconditional segC construction must still resolve; the seam filter must not'
    + ' swallow real evidence',
  );
});

/**
 * The filter's only failure mode is silence — it subtracts evidence lines, and
 * a subtracted line is indistinguishable from a line that was never derived.
 * Pinning the exact dropped set is what makes widening or narrowing it a
 * reviewed change instead of a quietly shorter ledger. Adding a case here is
 * expected work when a new seam guard appears; having one appear *without* this
 * list moving is the thing that must not be possible.
 */
test('seam-filtered probe matches are enumerated, never silently dropped', async () => {
  const suppressed = await deriveSeamSuppressedProbeMatches();
  assert.deepEqual(
    suppressed.map((match) => ({ probe: match.probe, reasons: match.reasons })),
    [
      {
        probe: 'src/server.ts#segCAutomation:call:accountDisplayName',
        reasons: [
          "automation: guarded by `seamMode !== 'automation' && publishApprovalStore"
          + ' && deploymentTarget`',
          'api: does not run segC',
          'content: does not run segC',
        ],
      },
      {
        probe: 'src/server.ts#segCAutomation:new:DraftRefinementWorker',
        reasons: [
          "automation: guarded by `seamMode !== 'automation' && draftRefinementStore"
          + ' && imageProvider`',
          'api: does not run segC',
          'content: does not run segC',
        ],
      },
    ],
    'the seam filter dropped a different set of probe matches than the reviewed one;'
    + ' run `npm run composition-root:census` to see them and adjudicate before'
    + ' updating this list',
  );
  for (const match of suppressed) {
    assert.match(match.location, /^src\/[^:]+\.ts:\d+$/, `${match.probe} location`);
  }
  // The pending-dispatch watchdog's `accountDisplayName` call is dropped, but the
  // mirror entry survives on its other, unguarded segC call site: suppression
  // shortens evidence, it does not by itself extinguish a blocker.
  const blockers = await deriveIndependentRootBlockers();
  assert.deepEqual(
    blockers.find((blocker) => blocker.id === '4b-b4-account-identity-status-mirror')?.evidence,
    [
      'src/server.ts#segCAutomation:call:accountDisplayName',
      'src/server.ts#segCAutomation:identifier-use:accountStore',
    ],
  );
  assert.deepEqual(
    blockers.find((blocker) => blocker.id === 'content-draft-refinement-authority')?.evidence,
    [
      'src/server.ts#segAApiFoundation:new:DraftRefinementStore',
      'src/server.ts#segDApiServing:identifier-use:draftRefinementStore',
    ],
    'draft refinement stays a Cloud-ledger blocker on its segA store and segD reader;'
    + ' only the segC worker line goes away',
  );
});

test('require-empty gate prevents a source-only 4a delivery from claiming independent roots', async () => {
  const blockers = await deriveIndependentRootBlockers();
  assert.throws(
    () => assertNoIndependentRootBlockers(blockers),
    /independent composition roots remain blocked/,
  );
});
