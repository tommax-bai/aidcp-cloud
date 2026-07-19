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

test('hello handler does not activate business runtime until onEdgeRegistered post-welcome callback', async () => {
  const [handler, registry, server] = await Promise.all([
    readFile(new URL('../src/comm/handler.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/orchestrator/connection-runtime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.ts', import.meta.url), 'utf8'),
  ]);
  assert.equal(
    handler.includes("this.bus(session).emit('edge.hello'"),
    false,
    'hello request handling must not start persona-dependent business work before welcome',
  );
  const admission = registry.slice(registry.indexOf('async onHandshake('), registry.indexOf('onWelcomed('));
  assert.equal(admission.includes('buildDispatcher('), false, 'pre-welcome admission must not construct dispatcher');
  assert.match(server, /onEdgeRegistered:[\s\S]*runtimes\?\.onWelcomed\(session\)/);
});
