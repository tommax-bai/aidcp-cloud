import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';
import type { CaptchaAssistIncidentView } from '../src/comm/captcha-assist.js';

const silentLogger = { log() {}, warn() {}, error() {} };

const incident: CaptchaAssistIncidentView = {
  incidentId: 'cap-1',
  edgeId: 'edge-1',
  accountId: 'acc-1',
  kind: 'captcha',
  status: 'ready',
  detectedAt: 100,
  updatedAt: 200,
  expiresAt: 10_000,
  snapshot: {
    incidentId: 'cap-1',
    edgeId: 'edge-1',
    snapshotId: 'snap-1',
    capturedAt: 150,
    kind: 'captcha',
    viewport: { width: 100, height: 100 },
    crop: { x: 0, y: 0, width: 100, height: 100 },
    image: { mime: 'image/png', data: 'base64-image', width: 100, height: 100 },
  },
};

function makeConfig(over: Partial<PanelConfig> = {}): PanelConfig {
  return {
    port: 0,
    jwtSecret: 'test-secret',
    users: parsePanelUsers('alice:pw1'),
    jwtTtlSeconds: 3600,
    forbiddenPorts: [8787, 5432, 8788],
    logger: silentLogger,
    ...over,
  };
}

async function loginAuth(base: string): Promise<Record<string, string>> {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'pw1' }),
  });
  const { token } = (await login.json()) as { token: string };
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

test('captcha assist API accepts scoped Feishu token and panel JWT with incident scoping', async () => {
  const calls: Array<{ op: string; actor: string; points?: unknown[] }> = [];
  const deps = {
    edgeServer: { edgeCount: () => 0, onlineEdgeCount: () => 0 },
    eventBus: { onAny: () => () => {} },
    publishOrchestrator: { getStatus: () => ({ status: 'idle', snapshot: null }) },
    captchaAssist: {
      verifyToken: (token: string | undefined) =>
        token === 'good'
          ? ({ ok: true, incidentId: 'cap-1', iat: 1, exp: 9999 } as const)
          : ({ ok: false, reason: 'bad_signature' } as const),
      getIncident: (id: string) => (id === 'cap-1' ? incident : null),
      requestCapture: async (id: string, actor: string) => {
        calls.push({ op: 'capture', actor });
        return { ok: true, sent: 1, incident: { ...incident, incidentId: id } } as const;
      },
      submitClick: async (input: { actor: string; points: unknown[] }) => {
        calls.push({ op: 'click', actor: input.actor, points: input.points });
        return { ok: true, sent: 1, incident } as const;
      },
    },
  } as unknown as PanelDeps;

  const h = await startPanelApi(deps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const scopedRead = await fetch(`${base}/api/captcha-assist/cap-1?token=good`);
    assert.equal(scopedRead.status, 200);
    assert.equal(((await scopedRead.json()) as { incident: CaptchaAssistIncidentView }).incident.snapshot?.snapshotId, 'snap-1');

    const wrongScope = await fetch(`${base}/api/captcha-assist/cap-other?token=good`);
    assert.equal(wrongScope.status, 403);
    assert.equal(((await wrongScope.json()) as { reason: string }).reason, 'token_scope_mismatch');

    const capture = await fetch(`${base}/api/captcha-assist/cap-1/capture?token=good`, { method: 'POST' });
    assert.equal(capture.status, 200);
    assert.deepEqual(calls[0], { op: 'capture', actor: 'captcha-assist-token' });

    const auth = await loginAuth(base);
    const click = await fetch(`${base}/api/captcha-assist/cap-1/click`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ snapshotId: 'snap-1', points: [{ x: 0.25, y: 0.75 }] }),
    });
    assert.equal(click.status, 200);
    assert.equal(calls[1].op, 'click');
    assert.equal(calls[1].actor, 'panel:alice');
  } finally {
    await h.close();
  }
});

test('captcha assist API returns 503 when service is not injected', async () => {
  const deps = {
    eventBus: { onAny: () => () => {} },
    publishOrchestrator: { getStatus: () => ({ status: 'idle', snapshot: null }) },
  } as unknown as PanelDeps;
  const h = await startPanelApi(deps, makeConfig());
  assert.equal(h.started, true);
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/captcha-assist/cap-1?token=good`);
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { error: string }).error, 'captcha_assist_unavailable');
  } finally {
    await h.close();
  }
});
