import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

import { EDGE_RESUME_COMMAND_ROUTES } from '../../src/transport/paired-command-http.js';
import { RISK_COMMAND_ROUTES } from '../../src/transport/risk-command-http.js';

async function serverSource(): Promise<string> {
  return readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');
}

async function apiFeishuOwnerSource(): Promise<string> {
  return readFile(
    new URL('../../src/feishu/api-owner-composition.ts', import.meta.url),
    'utf8',
  );
}

function between(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `composition marker missing: ${startMarker}`);
  assert.ok(end > start, `composition end marker missing: ${endMarker}`);
  return source.slice(start, end);
}

function containingFunctionName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text ?? null;
    current = current.parent;
  }
  return null;
}

function namedPropertyTexts(
  sourceFile: ts.SourceFile,
  propertyName: string,
): string[] {
  const matches: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node)
      && (
        (ts.isIdentifier(node.name) && node.name.text === propertyName)
        || (ts.isStringLiteral(node.name) && node.name.text === propertyName)
      )
    ) {
      matches.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return matches;
}

test('4a composition: automation roster projection is sourced from the API HTTP port', async () => {
  const source = await serverSource();
  const rosterWiring = between(
    source,
    'const rosterMode = serviceModeFromEnv();',
    'try {\n      if (segmentsForMode(rosterMode).segC) {',
  );
  const automationBranch = between(
    rosterWiring,
    "rosterMode === 'automation'",
    ": rosterMode === 'api'",
  );

  assert.match(automationBranch, /new AccountRosterHttpClient\(/);
  assert.match(automationBranch, /requireDirectInternalToken\('AIDCP_API_INTERNAL_TOKEN'\)/);
  assert.match(automationBranch, /deploymentTarget/);
  assert.doesNotMatch(
    automationBranch,
    /store\.listAccountIdentities|accountStore/,
    'automation roster must not silently fall back to the API owner store',
  );

  const projection = between(
    source,
    'const projection = new PgAccountProjectionStore({',
    'await projection.init();',
  );
  assert.match(projection, /source:\s*accountRosterSource/);
  assert.doesNotMatch(
    projection,
    /source:\s*(?:store|accountStore)/,
    'automation projection source must remain the mode-selected port',
  );
});

test('4a composition: automation handshake account writes/reads use AccountRuntime only', async () => {
  const source = await serverSource();
  const automation = between(
    source,
    'async function segCAutomation(',
    'async function segDApiServing(',
  );
  const runtimeCallbacks = between(
    automation,
    'buildDispatcher,\n    ensureAccount:',
    'onConfigError,',
  );

  assert.match(
    runtimeCallbacks,
    /const accountRuntime = apiDirectPorts\.accountRuntime;[\s\S]*accountRuntime\.ensureAccount\(/,
  );
  assert.match(
    runtimeCallbacks,
    /getAccountPlatform:[\s\S]*apiDirectPorts\.accountRuntime[\s\S]*accountRuntime\.getPlatformOrNull\(/,
  );
  assert.match(
    runtimeCallbacks,
    /recordNickname:[\s\S]*apiDirectPorts\.accountRuntime[\s\S]*accountRuntime\.recordNickname\(/,
  );
  assert.doesNotMatch(
    runtimeCallbacks,
    /accountStore|apiPool/,
    'handshake callbacks must not regain an API owner store/pool path',
  );
});

test('4a composition: API mode owns reply resolution and delegates persona generation to content', async () => {
  const source = await serverSource();
  const foundation = between(
    source,
    'async function segAApiFoundation(',
    'async function segBContent(',
  );
  const apiAuthorities = between(
    foundation,
    "if (serviceModeFromEnv() === 'api') {",
    '\n  const publishUiUpdateProducer = createPublishUiUpdateProducer({',
  );

  assert.match(apiAuthorities, /new ReplyConfigScopeStore\(\{\s*pool:\s*apiPool\s*\}\)/);
  assert.match(apiAuthorities, /apiReplyConfigAuthority = new ReplyConfigResolver\(/);
  assert.match(apiAuthorities, /new PersonaGeneratorCommandHttpClient\(/);
  assert.match(apiAuthorities, /requireDirectInternalToken\('AIDCP_CONTENT_INTERNAL_TOKEN'\)/);
  assert.match(apiAuthorities, /apiAccountPersonaAuthority = new AccountPersonaService\(/);
  assert.match(apiAuthorities, /generator:\s*personaGenerator/);
  assert.doesNotMatch(
    apiAuthorities,
    /new PersonaGenerator\(/,
    'API mode must not construct the content owner generator/LLM implementation',
  );
});

test('4a composition: exact-environment slow-start arbitration is wired in segA for API policy writes', async () => {
  const source = await serverSource();
  const foundation = between(
    source,
    'async function segAApiFoundation(',
    'async function segBContent(',
  );
  const operationPolicy = between(
    foundation,
    'const facebookOperationPolicyStore = new FacebookOperationPolicyStore({',
    '\n  const facebookGroupCommentPolicyStore =',
  );
  assert.match(operationPolicy, /environmentSlowStartResolver:\s*async \(\{ since \}\)/);
  assert.match(operationPolicy, /AIDCP_SLOW_START_DISABLED/);
  assert.match(operationPolicy, /SLOW_START_TOTAL_DAYS \* 86_400_000/);

  const automation = between(
    source,
    'async function segCAutomation(',
    'async function segDApiServing(',
  );
  assert.doesNotMatch(
    automation,
    /bindEnvironmentSlowStartResolver/,
    'split API mode skips segC, so exact-environment arbitration must not be wired there',
  );
});

test('4a composition: Publish UI command has automation route/receiver and API client/producer', async () => {
  const source = await serverSource();
  const automationInternal = between(
    source,
    'async function startAutomationInternalApi(',
    'async function startContentReadApi(',
  );
  assert.match(
    automationInternal,
    /registerPublishUiUpdateCommandRoutes\([\s\S]{0,260}ctx\.automationPublishUiUpdateAuthority[\s\S]{0,260}directToken[\s\S]{0,120}ctx\.deploymentTarget/,
  );

  const automation = between(
    source,
    'async function segCAutomation(',
    'async function segDApiServing(',
  );
  assert.match(
    automation,
    /new PublishUiUpdateCommandReceiver\(\{\s*uiSnapshot:\s*uiSnapshotService/,
  );
  assert.match(automation, /ctx\.automationPublishUiUpdateAuthority = publishUiUpdateReceiver/);

  const api = between(source, 'async function segDApiServing(', '\nmain().catch(');
  assert.match(
    api,
    /mode === 'api'[\s\S]{0,180}new PublishUiUpdateCommandHttpClient\([\s\S]{0,240}automationDirectToken[\s\S]{0,120}deploymentTarget/,
  );

  const foundation = between(
    source,
    'async function segAApiFoundation(',
    'async function segBContent(',
  );
  const producer = between(
    foundation,
    'const publishUiUpdateProducer = createPublishUiUpdateProducer({',
    '\n  const apiPublishLogAuthority:',
  );
  assert.match(
    producer,
    /loadPreview:[\s\S]{0,120}publishLogStore\.pendingPublishPreviewForRecord\(recordId\)/,
  );
  assert.match(
    producer,
    /applyPublishUiUpdate:[\s\S]{0,180}ctx\.publishUiUpdateCommand[\s\S]{0,180}command\.applyPublishUiUpdate\(input\)/,
  );
  assert.match(producer, /publishUiUpdateProducer\.pushPreview\(recordId\)/);
  assert.match(producer, /publish_ui_preview_no_record:/);
  assert.doesNotMatch(
    producer,
    /automationPublishLog/,
    'preview must be generated from the API owner record before the one-way UI command',
  );
});

test('4a composition: panel and customer edit branches push API-owned previews remotely', async () => {
  const source = await serverSource();
  const api = between(source, 'async function segDApiServing(', '\nmain().catch(');

  const panelBranch = between(
    api,
    'notifyPublishPreviewChanged: (recordId) => {',
    '\n          // 面板与 Feishu 共用上方 segD 的同一个 API command face。',
  );
  assert.match(panelBranch, /if \(mode === 'api'\)/);
  assert.match(panelBranch, /ctx\.pushApiOwnedPublishPreview/);
  assert.match(panelBranch, /pushPreview\(recordId\)/);
  assert.match(panelBranch, /refreshPublishPreview/);

  const customerBranch = between(
    api,
    'publishDraftActions: {',
    '\n          draftRefinements:',
  );
  assert.match(customerBranch, /if \(mode === 'api'\)/);
  assert.match(customerBranch, /ctx\.pushApiOwnedPublishPreview/);
  assert.match(customerBranch, /await pushPreview\(recordId\)/);
  assert.match(customerBranch, /refreshPublishPreview/);
});

test('4a composition: every admitted route is exposed only by its owner internal server', async () => {
  const source = await serverSource();
  const sourceFile = ts.createSourceFile(
    'src/server.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const expectedOwnerServer = new Map<string, string>([
    ['registerAccountRosterRoutes', 'startApiInternalApi'],
    ['registerAccountOwnershipRoutes', 'startApiInternalApi'],
    ['registerAccountRuntimeRoutes', 'startApiInternalApi'],
    ['registerAutomationPublishLogRoutes', 'startApiInternalApi'],
    ['registerEdgePublishCommandRoutes', 'startApiInternalApi'],
    ['registerInteractionAuthRoutes', 'startApiInternalApi'],
    ['registerInteractionApiWritesRoutes', 'startApiInternalApi'],
    ['registerReplyConfigResolverRoutes', 'startApiInternalApi'],
    ['registerAccountPersonaRoutes', 'startApiInternalApi'],
    ['registerEnvironmentHandshakeRoutes', 'startApiInternalApi'],
    ['registerCommentApprovalPolicyRoutes', 'startApiInternalApi'],
    ['registerNotificationContactsRoutes', 'startApiInternalApi'],
    ['registerFirstPostProgressRoutes', 'startApiInternalApi'],
    ['registerAutomationConfigCommandsRoutes', 'startApiInternalApi'],
    ['registerOffboardAdmissionLedgerRoutes', 'startApiInternalApi'],
    ['registerStructuredNotificationRoutes', 'startApiInternalApi'],
    ['registerEdgeResumeCommandRoutes', 'startAutomationInternalApi'],
    ['registerFacebookScopeCommandRoutes', 'startAutomationInternalApi'],
    ['registerPublishUiUpdateCommandRoutes', 'startAutomationInternalApi'],
    ['registerPersonaGeneratorCommandRoutes', 'startContentReadApi'],
  ]);
  const actualCalls = new Map<string, string[]>();

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && expectedOwnerServer.has(node.expression.text)
    ) {
      const callers = actualCalls.get(node.expression.text) ?? [];
      callers.push(containingFunctionName(node) ?? '<top-level>');
      actualCalls.set(node.expression.text, callers);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  assert.equal(actualCalls.size, 20, 'all 20 admitted route groups must be registered');
  for (const [registerFunction, ownerServer] of expectedOwnerServer) {
    assert.deepEqual(
      actualCalls.get(registerFunction),
      [ownerServer],
      `${registerFunction} must be registered exactly once by ${ownerServer}, never by panel/customer/public servers`,
    );
  }
});

test('4a composition: content internal capabilities register independently', async () => {
  const source = await serverSource();
  const contentApi = between(
    source,
    'async function startContentReadApi(',
    '\n/**\n * outbox 通知唤醒接线',
  );

  assert.match(contentApi, /if \(ctx\.contentPersonaGeneratorAuthority\) \{/);
  assert.match(contentApi, /registerPersonaGeneratorCommandRoutes\(/);
  assert.match(contentApi, /if \(store\) \{[\s\S]*registerCuratedContentRoutes\(httpServer, store\)/);
  assert.match(contentApi, /if \(contentPublishOrchestrator\) \{/);
  assert.doesNotMatch(
    contentApi,
    /if \(!store\) \{[\s\S]{0,260}\breturn;/,
    'missing curated content must not disable persona or publish capabilities',
  );
});

test('4a composition: committed publish mutations are not rewritten by UI delivery failures', async () => {
  const source = await serverSource();
  const authority = between(
    source,
    'const apiPublishLogAuthority: AutomationPublishLogPort = {',
    '\n\n  const apiDirectAuthorities:',
  );

  assert.match(
    authority,
    /const result = await publishLogStore\.editDraft\([\s\S]*void pushApiOwnedPublishPreview\(recordId\)\.catch\([\s\S]*return result;/,
  );
  assert.match(
    authority,
    /const rejected = await publishLogStore\.rejectPendingApproval\(recordId\);[\s\S]*void pushApiOwnedPublishState\([\s\S]*\)\.catch\([\s\S]*return rejected;/,
  );
  assert.match(authority, /UI preview 投递失败/);
  assert.match(authority, /UI state 投递失败/);
});

test('4a composition: generic Edge resume is disjoint from 3b restricted recovery', async () => {
  const source = await serverSource();
  const sourceFile = ts.createSourceFile(
    'src/server.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const api = between(source, 'async function segDApiServing(', '\nmain().catch(');
  const genericResume = between(
    api,
    "const resumeEdgesForAccount: CommandFaceDeps['account']['resumeEdgesForAccount']",
    '\n  const managementChatIds = new Set(',
  );
  assert.match(genericResume, /edgeResumeCommand\.resumeEdgesForAccount\(\{/);
  assert.doesNotMatch(
    genericResume,
    /riskCommands|riskCommandService|submitRestrictedRecovery|restrictedRecoveryOutcomeOf|riskRegistry/,
    'generic resume must not mutate risk or enter the restricted-recovery authority chain',
  );
  const sharedCommandFace = between(
    api,
    'const commandFace: CommandFace = feishuOwner.createCommandFace({',
    '\n  ctx.commandFace = commandFace;',
  );
  assert.match(sharedCommandFace, /resume:\s*\(accountId\) => ctx\.accountState\.resume\(accountId\)/);
  assert.match(sharedCommandFace, /\n\s*resumeEdgesForAccount,/);
  assert.match(api, /commandActions:\s*commandFace\.panelCommandActions/);

  const restrictedSubmit = namedPropertyTexts(sourceFile, 'submitRestrictedRecovery').find((text) =>
    text.includes('riskCommands.submitRestrictedRecovery'));
  assert.ok(restrictedSubmit, '3b restricted recovery wiring must remain present');
  assert.match(restrictedSubmit, /riskCommands\.submitRestrictedRecovery\(/);
  assert.doesNotMatch(
    restrictedSubmit,
    /edgeResumeCommand|resumeEdgesForAccount|ctx\.accountState\.resume/,
    'restricted recovery must not reuse or be bypassed by the generic Edge resume command',
  );

  assert.notEqual(
    EDGE_RESUME_COMMAND_ROUTES.resumeEdgesForAccount,
    RISK_COMMAND_ROUTES.submitRestrictedRecovery,
  );
  assert.notEqual(
    EDGE_RESUME_COMMAND_ROUTES.resumeEdgesForAccount,
    RISK_COMMAND_ROUTES.restrictedRecoveryOutcomeOf,
  );
});

test('4a composition: Feishu SDK, cards, chat routing, and ingress stay in API owner composition', async () => {
  const [source, feishuOwner] = await Promise.all([
    serverSource(),
    apiFeishuOwnerSource(),
  ]);
  const foundation = between(
    source,
    'async function segAApiFoundation(',
    'async function segBContent(',
  );
  const automation = between(
    source,
    'async function segCAutomation(',
    'async function segDApiServing(',
  );

  assert.doesNotMatch(source, /from ['"]@larksuiteoapi\/node-sdk['"]/);
  assert.match(
    foundation,
    /if \(ownsApiFeishuForMode\(serviceMode\)\)[\s\S]{0,620}await import\([\s\S]{0,120}\.\/feishu\/api-owner-composition\.js/,
  );
  assert.match(automation, /new StructuredNotificationHttpClient\(/);
  assert.match(automation, /kind:\s*'operational_text'/);
  assert.doesNotMatch(
    automation,
    /FeishuMessenger|FeishuWsReceiver|FeishuBotChatEventHandler|CommandRouter|lark\.WSClient|BotChatStore|buildPublishApprovalCard|buildCommandResultCard|resolveChatIdForAccount|resolveCardTarget/,
  );

  assert.match(feishuOwner, /from ['"]@larksuiteoapi\/node-sdk['"]/);
  assert.match(feishuOwner, /new BotChatStore\(/);
  assert.match(feishuOwner, /new FeishuMessenger\(/);
  assert.match(feishuOwner, /new FeishuWsReceiver\(/);
  assert.match(feishuOwner, /new lark\.WSClient\(/);
  assert.match(feishuOwner, /buildPublishApprovalCard/);
  assert.match(feishuOwner, /resolveChatIdForAccount/);
  assert.match(feishuOwner, /resolveCardTarget/);
});

test('4a composition: best-effort notification failures warn and config authority absence is visible', async () => {
  const source = await serverSource();
  const automation = between(
    source,
    'async function segCAutomation(',
    'async function segDApiServing(',
  );
  const dispatchNotice = between(
    automation,
    'notifyDispatchEvent: (notice) => {',
    '\n    facebookPublishMedia:',
  );
  assert.match(dispatchNotice, /deliverStructuredNotification\(\{/);
  assert.match(
    dispatchNotice,
    /\.catch\(\(error\) => \{[\s\S]*console\.warn\([\s\S]*运维通知发送失败/,
  );
  assert.doesNotMatch(
    dispatchNotice,
    /\.catch\(\(\) => \{\}\)/,
    'operational notification failure must never disappear silently',
  );

  const contactAttempt = between(
    automation,
    'const configCommands = apiDirectPorts.automationConfigCommands;',
    '\n                } catch (e) {',
  );
  assert.match(
    contactAttempt,
    /if \(!configCommands\) \{[\s\S]*throw new Error\('automation_config_commands_authority_unavailable'\)/,
  );
  assert.match(
    contactAttempt,
    /await configCommands\.recordContactCommentAttempt\(accountId\)/,
  );
});
