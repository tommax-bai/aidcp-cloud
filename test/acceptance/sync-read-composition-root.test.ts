import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const serverPath = new URL('../../src/server.ts', import.meta.url);

test('monolith restores 4b owner snapshots before API serving and never starts the legacy roster refresher', async () => {
  const source = await readFile(serverPath, 'utf8');
  const automationSegment = source.indexOf(
    'async function segCAutomation(',
  );
  const syncReadStart = source.indexOf(
    "if (serviceModeFromEnv() === 'monolith') {",
    automationSegment,
  );
  const edgeListen = source.indexOf(
    'await server.start();',
    automationSegment,
  );
  const scheduledActivation = source.indexOf(
    'ctx.scheduledPublishReconciler?.start();',
    automationSegment,
  );

  assert.ok(automationSegment >= 0);
  assert.ok(syncReadStart > automationSegment);
  assert.ok(scheduledActivation > syncReadStart);
  assert.ok(edgeListen > syncReadStart);
  assert.ok(edgeListen > scheduledActivation);
  assert.match(source, /projection\.applyOwnerSnapshot\(envelope\)/);
  assert.doesNotMatch(source, /projection\.(?:refresh|start)\(\)/);
});

test('owner listeners expose closed snapshot routes while local authority removes only the HTTP hop', async () => {
  const source = await readFile(serverPath, 'utf8');

  assert.match(source, /owner: 'api'[\s\S]*streams: API_SYNC_READ_OWNER_STREAMS/);
  assert.match(
    source,
    /owner: 'automation'[\s\S]*streams: AUTOMATION_SYNC_READ_OWNER_STREAMS/,
  );
  assert.match(
    source,
    /const apiSource = createApiSyncReadSource\(ctx, executionTarget\)/,
  );
  assert.match(
    source,
    /const automationSource = createAutomationSyncReadSource\([\s\S]*ctx,[\s\S]*executionTarget/,
  );
  assert.doesNotMatch(source, /new SyncReadSnapshotHttpClient/);
});

test('panel and client queue consume freshness-bearing runtime evidence', async () => {
  const source = await readFile(serverPath, 'utf8');

  assert.match(source, /edgePresenceEvidence:/);
  assert.match(source, /publishInFlightEvidence:/);
  assert.match(source, /configMirrorServicesHealth:/);
  assert.match(
    source,
    /inFlightEvidence:[\s\S]*ctx\.apiSyncReadMirrors\.inFlightEvidence\(\)/,
  );
});
