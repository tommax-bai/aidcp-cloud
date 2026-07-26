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

test('automation internal API keeps non-risk owner routes when risk registry is unavailable', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function startAutomationInternalApi(');
  const end = source.indexOf('\nasync function startContentReadApi(', start);
  assert.ok(start >= 0 && end > start, 'automation internal API composition must exist');
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /if\s*\(\s*!registry\s*\)\s*(?:\{[^}]*\}\s*)?return\b/);
  for (const registration of [
    'registerPanelAutomationRoutes(',
    'registerPanelConfigRoutes(',
    'registerFacebookGroupOpsRoutes(',
    'registerGroupRouteRoutes(',
    'registerAlertResolutionRoutes(',
  ]) {
    assert.ok(
      body.includes(registration),
      `${registration} must stay in the automation internal API composition`,
    );
  }
  assert.ok(
    body.indexOf('registerPanelAutomationRoutes(') > body.indexOf("console.warn('[aidcp-cloud] automation 内部 API：risk-read"),
    'non-risk owner routes must be registered after the optional risk-read branch, not nested inside it',
  );
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

/**
 * P4（cloud-coupling-phase4-runtime-ports）：四个**可选**注入端口的唯一机械守卫。
 *
 * 它们不注入时的语义是「恒不停手 / 预览退化成诚实说明」——与端口引入前逐位一致，所以漏接线
 * 既不抛错、也不会被 typecheck 抓到，只会在生产上静默失去一整层闸或一整页预览。这条断言读
 * 组合根源码，把「实现确实交到了消费方手里」钉死在编译期之外的一道上。
 *
 * ⚠️ 物理拆仓后每个仓有自己的 server.ts，本断言 MUST 跟着复制到 automation 仓并指向它自己的组合根，
 * 否则守卫在拆仓当天蒸发、可选端口回到裸奔。
 */
test('P4 optional runtime ports are actually wired at the composition root', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /const configMirrorGate: ConfigMirrorGatePort = \{/,
    'composition root must build exactly one config-mirror halt adapter',
  );
  const handler = source.slice(source.indexOf('new DefaultMessageHandler({'));
  assert.match(handler.slice(0, 400), /\n {4}configMirrorGate,\n/, 'message handler must receive the halt gate');
  const dispatcher = source.slice(source.indexOf('return new RoleDispatcher({'));
  assert.match(dispatcher.slice(0, 400), /\n {6}configMirrorGate,\n/, 'role dispatcher must receive the halt gate');
  const registry = source.slice(source.indexOf('new RiskControllerRegistry('));
  assert.match(registry.slice(0, 900), /\n {4}mirrorStale: \(/, 'risk registry must pass the staleness reader through');
  const preview = source.slice(source.indexOf('createRolePromptProvider('));
  assert.match(preview.slice(0, 1600), /publishPreviewBuilders: PUBLISH_PREVIEW_BUILDERS/, 'prompt preview must receive the publish builders');
  assert.match(preview.slice(0, 1600), /imagePromptPreviewBuilders: IMAGE_PROMPT_PREVIEW_BUILDERS/, 'prompt preview must receive the image builders');
});
