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

test('delegated worker startup recovery finishes before its execution pump is announced ready', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const workerStart = source.indexOf("await worker.start(readEnvNumber('AIDCP_DELEGATED_TASK_POLL_MS'");
  const readyLog = source.indexOf('DelegatedTaskWorker 已启动');
  assert.ok(workerStart >= 0 && readyLog >= 0, 'delegated worker startup landmarks must exist');
  assert.ok(workerStart < readyLog, 'interrupted claims must recover before worker readiness is announced');
});

test('every Feishu receiver production composition injects the durable approval write authority', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const compositions = [...source.matchAll(/new FeishuWsReceiver\(\{([\s\S]*?)\n  \}\);/g)].map((match) => match[1] ?? '');
  assert.ok(compositions.length > 0, 'production must compose at least one Feishu receiver');
  for (const composition of compositions) {
    assert.match(composition, /\bwriteApproval:\s*\(/, 'Feishu receiver must receive an explicit approval write port');
    assert.match(
      composition,
      /\bwriteApprovalDecision\(/,
      'Feishu approval ingress must converge on the shared durable approval authority',
    );
  }
});
