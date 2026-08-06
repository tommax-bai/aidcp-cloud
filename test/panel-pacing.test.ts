import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '@api/panel/panel-server.js';
import { parsePanelUsers } from '@api/panel/auth.js';
import type {
  PanelConfig,
  PanelDeps,
  PanelPacingConfig,
  PacingConfigCatalogView,
  PacingConfigSetResult,
  PacingConfigPatchInput,
} from '@api/panel/types.js';
import { BUILTIN_FLOOR, PACING_OPS } from '@automation/risk/pacing.js';

const silentLogger = { log() {}, warn() {}, error() {} };

/** 内存 mock PanelPacingConfig：catalog 用内置默认合成；set 走 facade 同款校验（复刻错误映射）。 */
function makePacing(): { panel: PanelPacingConfig; setCalls: PacingConfigPatchInput[] } {
  const setCalls: PacingConfigPatchInput[] = [];
  const overrides = new Map<string, { minMs: number; maxMs: number }>();
  const build = (): PacingConfigCatalogView => ({
    pacing: PACING_OPS.map((op) => {
      const o = overrides.get(op);
      return {
        operation: op,
        minMs: o?.minMs ?? BUILTIN_FLOOR[op].minMs,
        maxMs: o?.maxMs ?? BUILTIN_FLOOR[op].maxMs,
        overridden: !!o,
        updatedAt: o ? 't' : null,
        updatedBy: o ? 'alice' : null,
      };
    }),
  });
  const panel: PanelPacingConfig = {
    // Remote owner clients resolve this method asynchronously; the panel route MUST await it.
    getCatalog: async () => build(),
    setPacing: async (patch): Promise<PacingConfigSetResult> => {
      if (!(PACING_OPS as readonly string[]).includes(patch.operation)) return { ok: false, reason: 'unknown_operation' };
      const { minMs, maxMs } = patch;
      if (minMs === undefined && maxMs === undefined) return { ok: false, reason: 'no_valid_fields' };
      const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 15000;
      if (!ok(minMs) || !ok(maxMs)) return { ok: false, reason: 'invalid_value' };
      if (maxMs <= minMs || maxMs < minMs * 1.5) return { ok: false, reason: 'invalid_value' };
      setCalls.push(patch);
      overrides.set(patch.operation, { minMs, maxMs });
      return { ok: true, view: build() };
    },
  };
  return { panel, setCalls };
}

function makeConfig(): PanelConfig {
  return {
    port: 0,
    jwtSecret: 'test-secret',
    users: parsePanelUsers('alice:pw1'),
    jwtTtlSeconds: 3600,
    forbiddenPorts: [8787, 5432, 8788],
    logger: silentLogger,
  };
}

async function loginToken(base: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'pw1' }),
  });
  return ((await r.json()) as { token: string }).token;
}

test('未注入 pacingConfig → GET/PUT /api/pacing 返回 503 pacing_unavailable', async () => {
  const deps = { eventBus: { onAny: () => () => {} } } as unknown as PanelDeps;
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const token = await loginToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const g = await fetch(`${base}/api/pacing`, { headers: auth });
    assert.equal(g.status, 503);
    assert.equal(((await g.json()) as { error: string }).error, 'pacing_unavailable');
    const p = await fetch(`${base}/api/pacing`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'action', minMs: 2000, maxMs: 5000 }),
    });
    assert.equal(p.status, 503);
  } finally {
    await h.close();
  }
});

test('pacing 路由：GET catalog、PUT 合法回真态、错误诚实映射（未鉴权 401）', async () => {
  const { panel, setCalls } = makePacing();
  const deps = { eventBus: { onAny: () => () => {} }, pacingConfig: panel } as unknown as PanelDeps;
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    assert.equal((await fetch(`${base}/api/pacing`)).status, 401, '未鉴权 → 401');

    const token = await loginToken(base);
    const auth = { authorization: `Bearer ${token}` };

    // GET catalog：四类操作全列出、生效默认值、overridden=false
    const g = await fetch(`${base}/api/pacing`, { headers: auth });
    assert.equal(g.status, 200);
    const cat = (await g.json()) as PacingConfigCatalogView;
    assert.equal(cat.pacing.length, PACING_OPS.length);
    assert.ok(cat.pacing.every((p) => p.overridden === false));

    // PUT 合法 → 200 回真态、overridden 翻真
    const put = await fetch(`${base}/api/pacing`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'action', minMs: 2000, maxMs: 5000 }),
    });
    assert.equal(put.status, 200);
    const view = (await put.json()) as PacingConfigCatalogView;
    assert.equal(view.pacing.find((p) => p.operation === 'action')!.overridden, true);
    assert.equal(setCalls.length, 1);

    // 未知 operation → 404 unknown_operation
    const unk = await fetch(`${base}/api/pacing`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'bogus', minMs: 2000, maxMs: 5000 }),
    });
    assert.equal(unk.status, 404);
    assert.equal(((await unk.json()) as { error: string }).error, 'unknown_operation');

    // 展宽不足 → 400 invalid_value
    const bad = await fetch(`${base}/api/pacing`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'action', minMs: 2000, maxMs: 2500 }),
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, 'invalid_value');

    // 值类型不对（字符串）→ 400 bad_request
    const badType = await fetch(`${base}/api/pacing`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'action', minMs: 'x', maxMs: 5000 }),
    });
    assert.equal(badType.status, 400);
    assert.equal(((await badType.json()) as { error: string }).error, 'bad_request');

    // operation 缺失/类型不对 → 400 bad_request
    const noOp = await fetch(`${base}/api/pacing`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ minMs: 2000, maxMs: 5000 }),
    });
    assert.equal(noOp.status, 400);
  } finally {
    await h.close();
  }
});
