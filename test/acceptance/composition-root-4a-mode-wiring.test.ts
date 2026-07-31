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
  assert.match(
    operationPolicy,
    /environmentSlowStartResolver:\s*async \(\{ since, completedAt, totalDays \}\)/,
  );
  assert.match(operationPolicy, /AIDCP_SLOW_START_DISABLED/);
  assert.match(operationPolicy, /totalDays \* 86_400_000/);

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

/**
 * task 2.4a / 2.4b：三条 content 属主端口（概念池、精选召回、精选写）按运行模式取实现。
 *
 * **为什么必须有这条用例（§6.4 的实测结论）**：把任一注入点改回本地属主实例，`npm run typecheck`
 * **全绿**——属主实例结构上就满足那几个窄端口，编译器分不出「本地实例」和「HTTP 客户端」。
 * 而后果只在 `AIDCP_SERVICE=automation` 真跑起来时才现形，且**不是报错**：本进程没有 `concepts` /
 * `curated_content` 两张表 ⇒ segA 那两次 `init()` 失败留 undefined ⇒ 概念抽取角色不注册、
 * 精选素材恒空、自有点赞收藏不入语料、两个精选准入评估角色不注册，
 * 闭环照跑、只多一行降级 warn。「连不上内容域」被读成「内容域是空的」。
 *
 * **别当冗余删掉**：这条是那个失败态**唯一**的机械守卫。
 */
test('4a composition: content ports are mode-selected and never fall back to the owner stores', async () => {
  const source = await serverSource();
  const automation = between(
    source,
    'async function segCAutomation(',
    'async function segDApiServing(',
  );

  // ① automation 分支建三个 HTTP 客户端，共用一条连接与一个令牌，**缺配置响亮抛**。
  const selection = between(
    automation,
    'const contentAuthorityClients = ((): {',
    'const automationPublishLog = apiDirectPorts.publishLog;',
  );
  assert.match(selection, /if \(seamMode !== 'automation'\) return undefined;/);
  assert.match(selection, /new ConceptPoolAuthorityHttpClient\(http, callerToken, deploymentTarget\)/);
  assert.match(selection, /new CuratedSelectionAuthorityHttpClient\(http, callerToken, deploymentTarget\)/);
  assert.match(selection, /new CuratedWriteAuthorityHttpClient\(http, callerToken, deploymentTarget\)/);
  assert.match(
    selection,
    /new FacebookPublishMediaAuthorityHttpClient\(\s*http,\s*callerToken,\s*deploymentTarget,\s*\)/,
  );
  assert.match(selection, /requireDirectInternalToken\('AIDCP_CONTENT_INTERNAL_TOKEN'\)/);
  assert.match(
    selection,
    /if \(!contentUrl \|\| !deploymentTarget\) \{[\s\S]*throw new Error\([\s\S]*content_authority_unavailable/,
    'missing content config must fail closed, not degrade',
  );
  // 变异实测（2026-07-30）：**只断言那句 throw 在文本里是不够的**——在它前面插一句
  // `return undefined;`，整条 fail-closed 就变成静默回落本地属主实例，而上面那条 match
  // **照样绿、typecheck 也照样绿**。所以这里改断结构：本 IIFE 里只许有**一处**提前返回，
  // 且它就是模式守卫那处；缺配置只有 throw 一条出路。**别当冗余删掉。**
  assert.equal(
    (selection.match(/return undefined;/g) ?? []).length,
    1,
    'the seam-mode guard must be the only early return; another one turns fail-closed into silent fallback',
  );
  assert.match(selection, /if \(seamMode !== 'automation'\) return undefined;/);

  // ② 回落只许发生在**非** automation 模式。三元的 automation 侧不得出现属主实例标识符——
  //    `??` 形态（客户端字段意外 undefined → 静默取本地）正是本块要消灭的形状。
  for (const [port, field, local] of [
    ['conceptPoolPort', 'conceptPool', 'conceptStore'],
    ['curatedSelectionPort', 'curatedSelection', 'curatedContentStore'],
    ['curatedWritePort', 'curatedWrite', 'curatedContentStore'],
    ['facebookPublishMediaPort', 'facebookPublishMedia', 'facebookPublishMediaStore'],
  ]) {
    const choice = between(selection, `const ${port}`, ';\n');
    assert.match(
      choice,
      new RegExp(`contentAuthorityClients \\? contentAuthorityClients\\.${field} : ${local}`),
      `${port} must pick the client in automation mode and the owner instance everywhere else`,
    );
    assert.doesNotMatch(
      choice,
      /\?\?/,
      `${port}: a nullish fallback would silently reach the local content store`,
    );
  }

  // ③ 每一个 `conceptStore:` 注入点都喂端口，一个不留。段落无关的全文断言是有意的：
  //    将来在别处再 new 一个概念池消费者、顺手喂了属主实例，也会在这里红。
  //    （segA 的 `ctx` 字段声明是 PropertySignature，不是 PropertyAssignment，不进这张表。）
  const sourceFile = ts.createSourceFile('server.ts', source, ts.ScriptTarget.ES2022, true);
  assert.deepEqual(
    namedPropertyTexts(sourceFile, 'conceptStore').map((text) => text.replace(/\s+/g, ' ')),
    ['conceptStore: conceptPoolPort', 'conceptStore: conceptPoolPort'],
    'RoleDispatcher and PublishScheduler must both receive the mode-selected concept port',
  );
  // 概念池的在场判定也走端口：判属主实例会让 automation 进程按「本地库里没这张表」跳过发帖调度器。
  assert.match(automation, /if \(conceptPoolPort && likedNoteStore\) \{/);

  // ④ 精选两张脸各归各的端口：召回给发帖调度器，**写口给角色调度器**（它那个句柄含写）。
  const scheduler = between(automation, 'ctx.publishScheduler = new PublishScheduler({', '\n    });');
  assert.match(scheduler, /curatedStore: curatedSelectionPort,/);
  const dispatcher = between(automation, 'return new RoleDispatcher({', 'textCardTranscriber,');
  assert.match(
    dispatcher,
    /curatedStore: curatedWritePort,/,
    'the dispatcher sink handle carries writes, so it must be the write port — not the read port, '
      + 'and not the owner instance',
  );

  // ⑤ 评论搜索词那层薄适配：调用转给召回端口，端口缺席仍抛具名 not_configured（task 0.6f 的吞点①）。
  const termSamples = between(automation, 'curatedSelection: {', '\n    },');
  assert.match(termSamples, /curatedSelectionPort\.selectSamplesForSearchTerms\(accountId, type, limit\)/);
  assert.match(
    termSamples,
    /new ContentPortError\(\s*'not_configured'/,
    'an absent curated port must reject by name, never resolve to an empty sample set',
  );

  // ⑥ 写侧两处：自有点赞/收藏并入语料走写口；能力在场判定也判写口。
  //    判本地实例会让 automation 进程把一条接好的跨进程写口读成「精选库没接上」。
  assert.match(automation, /curatedWritePort\.markBotAction\(accountId, evt\.noteId, evt\.action, content\)/);
  assert.match(
    automation,
    /const curatedContentCapability: CuratedContentCapability = curatedWritePort/,
    'the curated capability must be derived from the port, not from the local owner instance',
  );

  // ⑦ FB 素材两处消费点都走端口。**第二处最容易漏**：它不走下发器那个三方法窄口，
  //    是组装根在审批驳回时的直调；只改窄口的话，驳回时那组素材永久停在 reserved 上没人回收。
  assert.match(
    automation,
    /facebookPublishMedia: facebookPublishMediaPort,/,
    'the dispatcher must receive the mode-selected media port',
  );
  assert.match(
    automation,
    /facebookPublishMediaPort\s*\)\s*\{\s*\n\s*await facebookPublishMediaPort\s*\n\s*\.releaseReservation\(/,
    'the approval-rejection release does not go through the dispatcher port — it must be repointed too',
  );

  // ⑧ 角色工厂那两跳窄化的锚点 MUST 是 kernel 写口，MUST NOT 是 content 属主的存储类。
  //    这不是风格问题：那个 content 类型曾是这张工厂表身上最后一个 content 符号
  //    （台账条目 content-role-factories 的证据），且拿单一实现当锚等于用本地实现给跨进程实现打分。
  const factories = between(source, 'const CONTENT_ROLE_FACTORIES', '\n};');
  assert.match(factories, /const noteSink: CuratedNoteSink = curatedStore as CuratedWritePort;/);
  assert.match(factories, /const commentSink: CuratedCommentSink = curatedStore as CuratedWritePort;/);
  assert.doesNotMatch(
    factories,
    /\bCuratedContentStore\b/,
    'the role factory table must contain no content-owned symbol',
  );
});
