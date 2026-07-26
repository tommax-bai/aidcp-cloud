import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';

async function serverSource(): Promise<string> {
  return readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');
}

async function apiFeishuOwnerSource(): Promise<string> {
  return readFile(
    new URL('../../src/feishu/api-owner-composition.ts', import.meta.url),
    'utf8',
  );
}

function functionBody(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `组合根分段缺失: ${startMarker}`);
  return source.slice(start, end);
}

test('3b composition: API registers owner ingress/authority independently of config mirror', async () => {
  const source = await serverSource();
  const apiInternal = functionBody(
    source,
    'async function startApiInternalApi(',
    'async function startAutomationInternalApi(',
  );
  assert.match(apiInternal, /registerPanelEventDeliveryRoutes\(/);
  assert.match(apiInternal, /registerPublishApprovalAuthorityRoutes\(/);
  assert.match(
    apiInternal,
    /registerPublishApprovalAuthorityRoutes\([\s\S]{0,220}requirePublishApprovalInternalToken\(\)/,
  );
  assert.match(
    apiInternal,
    /registerPublishApprovalDecisionWriterRoutes\([\s\S]{0,220}requirePublishApprovalInternalToken\(\)/,
  );
  assert.match(
    apiInternal,
    /registerPublishCardExitRoutes\([\s\S]{0,220}requirePublishApprovalInternalToken\(\)/,
  );
  const sinkGuard = apiInternal.slice(
    apiInternal.indexOf('if (sink)'),
    apiInternal.indexOf('\n', apiInternal.indexOf("else console.warn('[aidcp-cloud] api 内部 API：配置镜像")),
  );
  assert.doesNotMatch(
    sinkGuard,
    /register(?:PanelEventDelivery|PublishApprovalAuthority)Routes/,
    'panel ingress 与 approval authority 不能被 config-mirror sink 缺席连带禁用',
  );
});

test('3b composition: automation owns replay/receiver and reaches API owners only through HTTP ports', async () => {
  const source = await serverSource();
  const automationInternal = functionBody(
    source,
    'async function startAutomationInternalApi(',
    'async function startContentReadApi(',
  );
  assert.match(
    automationInternal,
    /registerPublishDispatchTriggerRoutes\([\s\S]{0,220}requirePublishApprovalInternalToken\(\)/,
  );
  const automation = functionBody(
    source,
    'async function segCAutomation(',
    'async function segDApiServing(',
  );
  assert.match(automation, /new PublishApprovalAuthorityHttpClient\(/);
  assert.match(automation, /new PanelEventDeliveryHttpClient\(/);
  assert.match(automation, /createPublishDispatchTriggerReceiver\(/);
  assert.match(automation, /riskCommandConsumer = new RiskCommandConsumer\(/);
  assert.doesNotMatch(
    automation,
    /ctx\.server\?\.resumeEdgesForAccount\(accountId\) \?\? 0/,
    'server 未安装时不得把未执行 resume 记作成功 0',
  );
  const serverInstalled = automation.indexOf('ctx.server = server;');
  const consumerStarted = automation.indexOf('riskCommandConsumer?.start();');
  const serverStarted = automation.indexOf('await server.start();');
  assert.ok(
    serverInstalled >= 0 && serverStarted > serverInstalled && consumerStarted > serverStarted,
    'Edge server handle 可供 4b 启动闸使用，但 risk consumer 必须在真实监听后启动',
  );
  assert.doesNotMatch(automation, /\.claimApprovedCommands\(/, 'automation 不得预消费 API-owned approval outbox');
  assert.doesNotMatch(automation, /emitRiskCommand\(/, '客户恢复不得由组合根直接写 automation outbox');
});

test('3b composition: API panel uses local fanout and restricted recovery uses command/result port', async () => {
  const source = await serverSource();
  const api = functionBody(source, 'async function segDApiServing(', '\nmain().catch(');
  assert.match(api, /const panelEventFanout = mode === 'api' \? new PanelEventFanout/);
  assert.match(api, /eventBus: panelEventFanout \?\? eventBus/);
  const restrictedRecovery = functionBody(
    api,
    '          environmentRisk: {',
    '          persona: {',
  );
  assert.match(restrictedRecovery, /riskCommands\.submitRestrictedRecovery\(/);
  assert.match(restrictedRecovery, /riskCommands\.restrictedRecoveryOutcomeOf\(/);
  assert.doesNotMatch(restrictedRecovery, /recoverRestrictedForAccount:/);
  assert.doesNotMatch(
    restrictedRecovery,
    /edgeResumeCommand|resumeEdgesForAccount|ctx\.accountState\.resume/,
    '3b restricted recovery must remain disjoint from the 4a generic Edge resume command',
  );
});

test('3b composition: approval decision store/writer stays physical to API-containing modes', async () => {
  const [source, feishuOwner] = await Promise.all([
    serverSource(),
    apiFeishuOwnerSource(),
  ]);
  const foundation = functionBody(
    source,
    'async function segAApiFoundation(',
    'async function segBContent(',
  );
  assert.match(
    foundation,
    /if \(ownsPublishApprovalAuthorityForMode\(approvalOwnerMode\) && deploymentTarget\)/,
  );
  assert.match(
    foundation,
    /createPublishApprovalDecisionWriter\(writeApprovalDecision, deploymentTarget\)/,
    'API local writer must retain the outbox relay wake wrapper',
  );
  assert.match(
    foundation,
    /createApiFeishuOwner\(\{[\s\S]{0,360}publishApprovalDecisionWriter,/,
    'API Feishu owner must receive the shared durable decision writer',
  );
  assert.match(
    feishuOwner,
    /writeApprovalSignal:[\s\S]{0,420}deps\.publishApprovalDecisionWriter\.writeDecision\(\{/,
    'schedule approval must enter the validated API writer instead of a second local outlet',
  );

  const content = functionBody(
    source,
    'async function segBContent(',
    'async function segCAutomation(',
  );
  assert.match(content, /serviceModeFromEnv\(\) === 'content'[\s\S]*new PublishCardExitHttpClient\(/);
  assert.match(content, /new PublishCardExitHttpClient\([\s\S]{0,260}requirePublishApprovalInternalToken\(\)/);

  const automation = functionBody(
    source,
    'async function segCAutomation(',
    'async function segDApiServing(',
  );
  assert.match(automation, /new PublishApprovalDecisionWriterHttpClient\(/);
  assert.match(
    automation,
    /new PublishApprovalDecisionWriterHttpClient\([\s\S]{0,260}requirePublishApprovalInternalToken\(\)/,
  );
  assert.match(automation, /approvalDecisionWriterForAutomation\.writeDecision\(\{/);
  assert.doesNotMatch(automation, /new PublishApprovalStore\(/);
});
