import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';
import type { CaptchaAssistIncidentView } from '../src/panel/captcha-assist-port.js';

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
  let presenceCount = 0;
  const deps = {
    edgeServer: { edgeCount: () => 0, onlineEdgeCount: () => 0 },
    eventBus: { onAny: () => () => {} },
    publishStatus: { getStatus: () => Promise.resolve({ status: 'idle', snapshot: null }) },
    captchaAssist: {
      verifyToken: (token: string | undefined) =>
        token === 'good'
          ? ({ ok: true, incidentId: 'cap-1', iat: 1, exp: 9999 } as const)
          : ({ ok: false, reason: 'bad_signature' } as const),
      getIncident: (id: string) => (id === 'cap-1' ? incident : null),
      noteViewerPresence: () => {
        presenceCount += 1;
      },
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
    // GET 即"运营在场"信号（change captcha-assist-live-snapshot）：必须触达 noteViewerPresence。
    assert.ok(presenceCount >= 1, 'GET incident 应触发 noteViewerPresence 在场信号');

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

test('captcha assist click: 键入答案 HTTP 边界透传 + scoped-token 直接键入 + 能力/畸形拒绝码（change captcha-assist-text-answer）', async () => {
  const calls: Array<{ actor: string; text?: string; submit?: string; points: unknown[] }> = [];
  const deps = {
    edgeServer: { edgeCount: () => 0, onlineEdgeCount: () => 0 },
    eventBus: { onAny: () => () => {} },
    publishStatus: { getStatus: () => Promise.resolve({ status: 'idle', snapshot: null }) },
    captchaAssist: {
      verifyToken: (t: string | undefined) =>
        t === 'good' ? ({ ok: true, incidentId: 'cap-1', iat: 1, exp: 9999 } as const) : ({ ok: false, reason: 'bad_signature' } as const),
      getIncident: () => incident,
      noteViewerPresence: () => {},
      requestCapture: async () => ({ ok: true, sent: 1, incident } as const),
      submitClick: async (input: { actor: string; text?: string; submit?: string; points: unknown[] }) => {
        calls.push({ actor: input.actor, text: input.text, submit: input.submit, points: input.points });
        if (input.text === 'NOCAP') return { ok: false, reason: 'edge_lacks_text_capability', incident } as const;
        if (input.text === '中') return { ok: false, reason: 'invalid_text', incident } as const;
        return { ok: true, sent: 1, incident } as const;
      },
    },
  } as unknown as PanelDeps;

  const h = await startPanelApi(deps, makeConfig());
  const b = `http://127.0.0.1:${h.port}`;
  const jsonHeaders = { 'content-type': 'application/json' };
  try {
    // ① 飞书 scoped token 直接键入（未登录控制台）：actor=captcha-assist-token、200、text/submit 透传到 submitClick。
    const typed = await fetch(`${b}/api/captcha-assist/cap-1/click?token=good`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ snapshotId: 'snap-1', points: [{ x: 0.5, y: 0.5 }], text: 'AB3x', submit: 'enter' }),
    });
    assert.equal(typed.status, 200);
    assert.equal(calls[0].actor, 'captcha-assist-token', '飞书链接凭 scoped token 即可键入，绝不因缺 console 登录而拒（design D9）');
    assert.equal(calls[0].text, 'AB3x', 'text 必须透传到 submitClick（HTTP 边界手写解构的守卫——漏字段=静默丢弃+typecheck 全绿）');
    assert.equal(calls[0].submit, 'enter');

    // ② 纯点击零回归：不带 text ⇒ submitClick 收到 text=undefined、仍 200。
    const clickOnly = await fetch(`${b}/api/captcha-assist/cap-1/click?token=good`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ snapshotId: 'snap-1', points: [{ x: 0.5, y: 0.5 }] }),
    });
    assert.equal(clickOnly.status, 200);
    assert.equal(calls[1].text, undefined, '纯点击提交体与今天一致，不带 text');

    // ③ 能力未声明 ⇒ 409（submitClick 返回 edge_lacks_text_capability，命令未下发由 §6 保证）。
    const noCap = await fetch(`${b}/api/captcha-assist/cap-1/click?token=good`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ snapshotId: 'snap-1', points: [{ x: 0.5, y: 0.5 }], text: 'NOCAP', submit: 'enter' }),
    });
    assert.equal(noCap.status, 409);
    assert.equal(((await noCap.json()) as { error: string }).error, 'edge_lacks_text_capability');

    // ④ 畸形答案 ⇒ 400（整单拒绝）。
    const badText = await fetch(`${b}/api/captcha-assist/cap-1/click?token=good`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ snapshotId: 'snap-1', points: [{ x: 0.5, y: 0.5 }], text: '中', submit: 'enter' }),
    });
    assert.equal(badText.status, 400);
    assert.equal(((await badText.json()) as { error: string }).error, 'invalid_text');
  } finally {
    await h.close();
  }
});

test('captcha assist API returns 503 when service is not injected', async () => {
  const deps = {
    eventBus: { onAny: () => () => {} },
    publishStatus: { getStatus: () => Promise.resolve({ status: 'idle', snapshot: null }) },
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
