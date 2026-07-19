import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Edge WebSocket starts only after connection runtime registry is ready', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const runtimeReady = source.indexOf("runtimes = new ConnectionRuntimeRegistry({");
  const listen = source.indexOf('await server.start();');
  assert.ok(runtimeReady >= 0 && listen >= 0, 'startup landmarks must exist');
  assert.ok(runtimeReady < listen, 'Cloud must not accept hello before runtimes.onHandshake is initialized');
});
