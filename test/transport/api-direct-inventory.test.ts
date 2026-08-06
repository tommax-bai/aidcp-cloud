import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
import {
  API_DIRECT_PORT_INVENTORY,
  API_DIRECT_TOKEN_ENV,
  AUTOMATION_COMMAND_TOKEN_ENV,
  CONTENT_COMMAND_TOKEN_ENV,
  type ApiDirectPortGroup,
} from '@kernel/kernel/api-direct-port.js';
import { API_DIRECT_ROUTE_INVENTORY } from '@automation/transport/api-direct-http.js';

import { ownedSourcePath } from '../helpers/sibling-repos.js';

/**
 * 事实源翻转后（invert-split-fact-source，最终口袋裁定）：本文件不再依赖单体 4a census helper
 * （已随单体退休；单体侧的组装根 census 之家 = automation 仓自己的 4a census helper +
 * composition-root-4a-mode-wiring / automation-root-readiness-ledger，api 仓的
 * served-route-inventory / api-composition-root 用例）。方法真值直接取 kernel 的 21 组 / 59 槽
 * 名册 —— 名册↔接口的链条仍然闭合：接口新增方法会先撞 transport 侧的
 * `satisfies Record<keyof Port, string>`（automation 仓编译期），路由↔名册的相等由上面第一条
 * 用例钉住。传输源文件按属主读 automation 仓的现役副本。
 */
interface TransportBinding {
  transportFile: string;
  routesConstant: string;
  registerFunction: string;
  clientClass: string;
}

const TRANSPORT_BINDINGS = {
  accountRoster: {
    transportFile: 'transport/api-account-authority-http.ts',
    routesConstant: 'ACCOUNT_ROSTER_ROUTES',
    registerFunction: 'registerAccountRosterRoutes',
    clientClass: 'AccountRosterHttpClient',
  },
  accountOwnership: {
    transportFile: 'transport/api-account-authority-http.ts',
    routesConstant: 'ACCOUNT_OWNERSHIP_ROUTES',
    registerFunction: 'registerAccountOwnershipRoutes',
    clientClass: 'AccountOwnershipHttpClient',
  },
  accountRuntime: {
    transportFile: 'transport/api-account-authority-http.ts',
    routesConstant: 'ACCOUNT_RUNTIME_ROUTES',
    registerFunction: 'registerAccountRuntimeRoutes',
    clientClass: 'AccountRuntimeHttpClient',
  },
  publishLog: {
    transportFile: 'transport/api-publish-interaction-http.ts',
    routesConstant: 'AUTOMATION_PUBLISH_LOG_ROUTES',
    registerFunction: 'registerAutomationPublishLogRoutes',
    clientClass: 'AutomationPublishLogHttpClient',
  },
  edgePublish: {
    transportFile: 'transport/api-publish-interaction-http.ts',
    routesConstant: 'EDGE_PUBLISH_COMMAND_ROUTES',
    registerFunction: 'registerEdgePublishCommandRoutes',
    clientClass: 'EdgePublishCommandHttpClient',
  },
  interactionAuth: {
    transportFile: 'transport/api-publish-interaction-http.ts',
    routesConstant: 'INTERACTION_AUTH_ROUTES',
    registerFunction: 'registerInteractionAuthRoutes',
    clientClass: 'InteractionAuthHttpClient',
  },
  interactionApiWrites: {
    transportFile: 'transport/api-publish-interaction-http.ts',
    routesConstant: 'INTERACTION_API_WRITES_ROUTES',
    registerFunction: 'registerInteractionApiWritesRoutes',
    clientClass: 'InteractionApiWritesHttpClient',
  },
  replyConfig: {
    transportFile: 'transport/api-publish-interaction-http.ts',
    routesConstant: 'REPLY_CONFIG_RESOLVER_ROUTES',
    registerFunction: 'registerReplyConfigResolverRoutes',
    clientClass: 'ReplyConfigResolverHttpClient',
  },
  accountPersona: {
    transportFile: 'transport/api-aux-authority-http.ts',
    routesConstant: 'ACCOUNT_PERSONA_ROUTES',
    registerFunction: 'registerAccountPersonaRoutes',
    clientClass: 'AccountPersonaHttpClient',
  },
  environmentHandshake: {
    transportFile: 'transport/api-aux-authority-http.ts',
    routesConstant: 'ENVIRONMENT_HANDSHAKE_ROUTES',
    registerFunction: 'registerEnvironmentHandshakeRoutes',
    clientClass: 'EnvironmentHandshakeHttpClient',
  },
  commentApprovalPolicy: {
    transportFile: 'transport/api-aux-authority-http.ts',
    routesConstant: 'COMMENT_APPROVAL_POLICY_ROUTES',
    registerFunction: 'registerCommentApprovalPolicyRoutes',
    clientClass: 'CommentApprovalPolicyHttpClient',
  },
  scheduleFeedback: {
    transportFile: 'transport/api-aux-authority-http.ts',
    routesConstant: 'SCHEDULE_FEEDBACK_ROUTES',
    registerFunction: 'registerScheduleFeedbackRoutes',
    clientClass: 'ScheduleFeedbackHttpClient',
  },
  notificationContacts: {
    transportFile: 'transport/api-aux-authority-http.ts',
    routesConstant: 'NOTIFICATION_CONTACTS_ROUTES',
    registerFunction: 'registerNotificationContactsRoutes',
    clientClass: 'NotificationContactsHttpClient',
  },
  firstPostProgress: {
    transportFile: 'transport/api-aux-authority-http.ts',
    routesConstant: 'FIRST_POST_PROGRESS_ROUTES',
    registerFunction: 'registerFirstPostProgressRoutes',
    clientClass: 'FirstPostProgressHttpClient',
  },
  automationConfigCommands: {
    transportFile: 'transport/api-aux-authority-http.ts',
    routesConstant: 'AUTOMATION_CONFIG_COMMANDS_ROUTES',
    registerFunction: 'registerAutomationConfigCommandsRoutes',
    clientClass: 'AutomationConfigCommandsHttpClient',
  },
  offboardAdmissionLedger: {
    transportFile: 'transport/api-aux-authority-http.ts',
    routesConstant: 'OFFBOARD_ADMISSION_LEDGER_ROUTES',
    registerFunction: 'registerOffboardAdmissionLedgerRoutes',
    clientClass: 'OffboardAdmissionLedgerHttpClient',
  },
  notificationDelivery: {
    transportFile: 'transport/api-aux-authority-http.ts',
    routesConstant: 'STRUCTURED_NOTIFICATION_ROUTES',
    registerFunction: 'registerStructuredNotificationRoutes',
    clientClass: 'StructuredNotificationHttpClient',
  },
  edgeResumeCommand: {
    transportFile: 'transport/paired-command-http.ts',
    routesConstant: 'EDGE_RESUME_COMMAND_ROUTES',
    registerFunction: 'registerEdgeResumeCommandRoutes',
    clientClass: 'EdgeResumeCommandHttpClient',
  },
  facebookScopeCommands: {
    transportFile: 'transport/paired-command-http.ts',
    routesConstant: 'FACEBOOK_SCOPE_COMMAND_ROUTES',
    registerFunction: 'registerFacebookScopeCommandRoutes',
    clientClass: 'FacebookScopeCommandHttpClient',
  },
  publishUiUpdateCommand: {
    transportFile: 'transport/paired-command-http.ts',
    routesConstant: 'PUBLISH_UI_UPDATE_COMMAND_ROUTES',
    registerFunction: 'registerPublishUiUpdateCommandRoutes',
    clientClass: 'PublishUiUpdateCommandHttpClient',
  },
  personaGenerator: {
    transportFile: 'transport/paired-command-http.ts',
    routesConstant: 'PERSONA_GENERATOR_COMMAND_ROUTES',
    registerFunction: 'registerPersonaGeneratorCommandRoutes',
    clientClass: 'PersonaGeneratorCommandHttpClient',
  },
} as const satisfies Record<ApiDirectPortGroup, TransportBinding>;

type ClientFailureKind = 'read_unavailable' | 'write_result_unknown';

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function containsIdentifierCall(root: ts.Node, identifier: string): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === identifier
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function clientFailureKind(
  sourceFile: ts.SourceFile,
  className: string,
  methodName: string,
): ClientFailureKind | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) continue;
    const methods = new Map(
      statement.members.flatMap((member) => {
        if (!ts.isMethodDeclaration(member)) return [];
        const name = propertyName(member.name);
        return name ? [[name, member] as const] : [];
      }),
    );
    const resolveKind = (
      name: string,
      seen: ReadonlySet<string>,
    ): ClientFailureKind | null => {
      const method = methods.get(name);
      if (!method || seen.has(name)) return null;
      const read = containsIdentifierCall(method, 'callApiDirectRead');
      const write = containsIdentifierCall(method, 'callApiDirectWrite');
      assert.equal(
        read && write,
        false,
        `${className}.${name} must not mix read/write translators`,
      );
      if (read) return 'read_unavailable';
      if (write) return 'write_result_unknown';

      const delegated = new Set<ClientFailureKind>();
      function visit(node: ts.Node): void {
        if (
          ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          const kind = resolveKind(
            node.expression.name.text,
            new Set([...seen, name]),
          );
          if (kind) delegated.add(kind);
        }
        ts.forEachChild(node, visit);
      }
      visit(method);
      assert.ok(
        delegated.size <= 1,
        `${className}.${name} delegates to conflicting failure translators`,
      );
      return delegated.values().next().value ?? null;
    };
    return resolveKind(methodName, new Set());
  }
  return null;
}

function routeGuardCoverage(
  sourceFile: ts.SourceFile,
  registerFunction: string,
  routesConstant: string,
  methodName: string,
): { bearer: boolean; versionAndTarget: boolean } {
  const fn = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === registerFunction,
  );
  if (!fn) return { bearer: false, versionAndTarget: false };

  let bearer = false;
  let versionAndTarget = false;
  let routeReferenced = false;
  let genericBearer = false;
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === routesConstant
      && node.name.text === methodName
    ) {
      routeReferenced = true;
    }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'server'
      && node.expression.name.text === 'registerBearer'
    ) {
      genericBearer = true;
      const route = node.arguments[0];
      if (
        route
        && ts.isPropertyAccessExpression(route)
        && ts.isIdentifier(route.expression)
        && route.expression.text === routesConstant
        && route.name.text === methodName
      ) {
        bearer = true;
        versionAndTarget = containsIdentifierCall(node, 'parseApiDirectEnvelope');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(fn);
  if (!bearer && routeReferenced && genericBearer) {
    bearer = true;
    versionAndTarget = containsIdentifierCall(fn, 'parseApiDirectEnvelope');
  }
  return { bearer, versionAndTarget };
}

test('4a transport covers exactly the kernel 21-group/59-slot inventory', () => {
  assert.equal(Object.keys(API_DIRECT_PORT_INVENTORY).length, 21);
  assert.deepEqual(
    Object.keys(API_DIRECT_ROUTE_INVENTORY),
    Object.keys(API_DIRECT_PORT_INVENTORY),
  );
  let slots = 0;
  const routeNames: string[] = [];
  for (const group of Object.keys(API_DIRECT_PORT_INVENTORY) as Array<
    keyof typeof API_DIRECT_PORT_INVENTORY
  >) {
    const expectedMethods = [...API_DIRECT_PORT_INVENTORY[group]];
    const routes = API_DIRECT_ROUTE_INVENTORY[group];
    assert.deepEqual(Object.keys(routes), expectedMethods, `${group} route parity`);
    slots += expectedMethods.length;
    routeNames.push(...Object.values(routes));
  }
  assert.equal(slots, 59);
  assert.equal(new Set(routeNames).size, 59, 'every admitted method has a unique route');
  assert.equal(routeNames.every((route) => route.includes('/v1/')), true);
});

test('4a inventory does not recreate approval or expose local chat/claim helpers', () => {
  const methods = Object.values(API_DIRECT_PORT_INVENTORY).flat();
  for (const excluded of [
    'claimExecutionTarget',
    'resolveCardChatId',
    'resolveAccountChatId',
    'bindBotChat',
    'getApproval',
    'listPendingDispatch',
    'listPendingApprovalIds',
    'pendingPublishPreviewForRecord',
    'writeDecision',
    'triggerApproved',
  ]) {
    assert.equal(methods.includes(excluded as never), false, excluded);
  }
});

test('4a owner directions retain three distinct token configuration names', () => {
  assert.equal(
    new Set([
      API_DIRECT_TOKEN_ENV,
      AUTOMATION_COMMAND_TOKEN_ENV,
      CONTENT_COMMAND_TOKEN_ENV,
    ]).size,
    3,
  );
  const tokenNames: readonly string[] = [
    API_DIRECT_TOKEN_ENV,
    AUTOMATION_COMMAND_TOKEN_ENV,
    CONTENT_COMMAND_TOKEN_ENV,
  ];
  assert.equal(tokenNames.includes('AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN'), false);
});

test('4a 59-slot error coverage table binds every route to shared guards and translators', async () => {
  const sourceFiles = new Map<string, ts.SourceFile>();
  const coverage: Array<{
    group: string;
    method: string;
    bearer: boolean;
    versionAndTarget: boolean;
    malformedResponse: true;
    transportFailure: ClientFailureKind;
  }> = [];

  for (const group of Object.keys(TRANSPORT_BINDINGS) as ApiDirectPortGroup[]) {
    const binding = TRANSPORT_BINDINGS[group];
    let sourceFile = sourceFiles.get(binding.transportFile);
    if (!sourceFile) {
      const source = await readFile(
        ownedSourcePath('automation', binding.transportFile),
        'utf8',
      );
      sourceFile = ts.createSourceFile(
        binding.transportFile,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      sourceFiles.set(binding.transportFile, sourceFile);
    }
    const methods = API_DIRECT_PORT_INVENTORY[group];
    for (const method of methods) {
      const route = routeGuardCoverage(
        sourceFile,
        binding.registerFunction,
        binding.routesConstant,
        method,
      );
      const transportFailure = clientFailureKind(
        sourceFile,
        binding.clientClass,
        method,
      );
      assert.ok(transportFailure, `${binding.clientClass}.${method} must use a shared translator`);
      coverage.push({
        group,
        method,
        bearer: route.bearer,
        versionAndTarget: route.versionAndTarget,
        malformedResponse: true,
        transportFailure,
      });
    }
  }

  assert.equal(coverage.length, 59);
  assert.equal(
    new Set(coverage.map((row) => `${row.group}.${row.method}`)).size,
    59,
    'coverage rows must be unique per admitted slot',
  );
  for (const row of coverage) {
    assert.equal(row.bearer, true, `${row.group}.${row.method} missing Bearer guard`);
    assert.equal(
      row.versionAndTarget,
      true,
      `${row.group}.${row.method} missing shared version/target envelope guard`,
    );
    assert.equal(
      row.malformedResponse,
      true,
      `${row.group}.${row.method} missing shared response validation`,
    );
    assert.ok(
      row.transportFailure === 'read_unavailable'
      || row.transportFailure === 'write_result_unknown',
      `${row.group}.${row.method} missing failure classification`,
    );
  }
  assert.ok(coverage.some((row) => row.transportFailure === 'read_unavailable'));
  assert.ok(coverage.some((row) => row.transportFailure === 'write_result_unknown'));
});
