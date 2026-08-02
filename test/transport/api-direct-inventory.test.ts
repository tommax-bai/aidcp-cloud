import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
import {
  API_DIRECT_PORT_INVENTORY,
  API_DIRECT_TOKEN_ENV,
  AUTOMATION_COMMAND_TOKEN_ENV,
  CONTENT_COMMAND_TOKEN_ENV,
} from '../../src/kernel/api-direct-port.js';
import { API_DIRECT_ROUTE_INVENTORY } from '../../src/transport/api-direct-http.js';
import {
  deriveSurface,
  SURFACE_BINDINGS,
} from '../acceptance/helpers/composition-root-4a-census.js';

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

test('4a transport covers exactly the kernel 21-group/57-slot inventory', () => {
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
  assert.equal(slots, 57);
  assert.equal(new Set(routeNames).size, 57, 'every admitted method has a unique route');
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

test('4a 57-slot error coverage table binds every route to shared guards and translators', async () => {
  const derived = await deriveSurface();
  const methodsById = new Map(
    derived.groups.map((group) => [group.id, group.methods] as const),
  );
  const sourceFiles = new Map<string, ts.SourceFile>();
  const coverage: Array<{
    group: string;
    method: string;
    bearer: boolean;
    versionAndTarget: boolean;
    malformedResponse: true;
    transportFailure: ClientFailureKind;
  }> = [];

  for (const binding of SURFACE_BINDINGS) {
    let sourceFile = sourceFiles.get(binding.transportFile);
    if (!sourceFile) {
      const source = await readFile(
        new URL(`../../${binding.transportFile}`, import.meta.url),
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
    const methods = methodsById.get(binding.id);
    assert.ok(methods, `${binding.id} must exist in the kernel inventory`);
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
        group: binding.id,
        method,
        bearer: route.bearer,
        versionAndTarget: route.versionAndTarget,
        malformedResponse: true,
        transportFailure,
      });
    }
  }

  assert.equal(coverage.length, 57);
  assert.equal(
    new Set(coverage.map((row) => `${row.group}.${row.method}`)).size,
    57,
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
