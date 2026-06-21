import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps, ModelConfigView, SetCredentialResult } from '../src/panel/types.js';

const silentLogger = { log() {}, warn() {}, error() {} };

/** 可变 mock modelConfig 外观；canEdit 可切换以测主密钥缺失分支。 */
function makeModelConfig(opts: { canEdit: boolean }) {
  const state = { textModel: 'qwen-turbo', imageModel: 'wan2.7-image-pro', credConfigured: false, maskedHint: null as string | null };
  const view = (): ModelConfigView => ({
    provider: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    textModel: state.textModel,
    imageModel: state.imageModel,
    credential: {
      field: 'dashscope_api_key',
      configured: state.credConfigured,
      maskedHint: state.maskedHint,
      source: state.credConfigured ? 'db' : 'none',
    },
    canEditCredential: opts.canEdit,
  });
  return {
    state,
    getView: async () => view(),
    setModel: async (patch: { textModel?: string; imageModel?: string }) => {
      if (patch.textModel) state.textModel = patch.textModel;
      if (patch.imageModel) state.imageModel = patch.imageModel;
      return view();
    },
    setCredential: async (field: string, value: string): Promise<SetCredentialResult> => {
      if (!opts.canEdit) return { ok: false, reason: 'cred_key_missing' };
      state.credConfigured = true;
      state.maskedHint = `${value.slice(0, 4)}****${value.slice(-4)}`;
      return { ok: true, field, maskedHint: state.maskedHint };
    },
  };
}

function makeDeps(canEdit: boolean) {
  const modelConfig = makeModelConfig({ canEdit });
  const deps = {
    eventBus: { onAny: () => () => {} },
    modelConfig,
  } as unknown as PanelDeps;
  return { deps, modelConfig };
}

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

async function loginToken(base: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'pw1' }),
  });
  return ((await r.json()) as { token: string }).token;
}

test('config 路由：GET 形状无明文、PUT model 改名回真态、PUT credential 加密回掩码', async () => {
  const { deps } = makeDeps(true);
  const h = await startPanelApi(deps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    // 未鉴权 → 401
    assert.equal((await fetch(`${base}/api/config/model`)).status, 401);

    const token = await loginToken(base);
    const auth = { authorization: `Bearer ${token}` };

    // GET：含模型名/凭据状态，绝不含明文密钥字段
    const g = await fetch(`${base}/api/config/model`, { headers: auth });
    assert.equal(g.status, 200);
    const view = (await g.json()) as ModelConfigView & Record<string, unknown>;
    assert.equal(view.provider, 'dashscope');
    assert.equal(view.textModel, 'qwen-turbo');
    assert.equal(view.canEditCredential, true);
    assert.equal(view.credential.configured, false);
    const raw = JSON.stringify(view);
    assert.ok(!raw.includes('apiKey'));
    assert.ok(!('value' in view));

    // PUT model：改文本模型名 → 回写后真态
    const pm = await fetch(`${base}/api/config/model`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ textModel: 'qwen-plus' }),
    });
    assert.equal(pm.status, 200);
    assert.equal(((await pm.json()) as ModelConfigView).textModel, 'qwen-plus');

    // PUT model 全空 → 400
    const pmEmpty = await fetch(`${base}/api/config/model`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(pmEmpty.status, 400);

    // PUT credential：加密保存 → 回掩码，绝不回明文
    const pc = await fetch(`${base}/api/config/credential`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'dashscope_api_key', value: 'sk-abcdefghijkl' }),
    });
    assert.equal(pc.status, 200);
    const pcBody = (await pc.json()) as { field: string; configured: boolean; maskedHint: string };
    assert.equal(pcBody.configured, true);
    assert.equal(pcBody.maskedHint, 'sk-a****ijkl');
    assert.ok(!JSON.stringify(pcBody).includes('sk-abcdefghijkl'));

    // PUT credential 未知 field → 400
    const pcBad = await fetch(`${base}/api/config/credential`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'evil', value: 'x' }),
    });
    assert.equal(pcBad.status, 400);
  } finally {
    await h.close();
  }
});

test('主密钥缺失：PUT credential 诚实 503 cred_key_missing，绝不假成功', async () => {
  const { deps } = makeDeps(false);
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const token = await loginToken(base);
    const auth = { authorization: `Bearer ${token}` };

    const g = await fetch(`${base}/api/config/model`, { headers: auth });
    assert.equal(((await g.json()) as ModelConfigView).canEditCredential, false);

    const pc = await fetch(`${base}/api/config/credential`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'dashscope_api_key', value: 'sk-whatever-1234' }),
    });
    assert.equal(pc.status, 503);
    assert.equal(((await pc.json()) as { error: string }).error, 'cred_key_missing');
  } finally {
    await h.close();
  }
});

test('未注入 modelConfig → /api/config/* 返回 503 model_config_unavailable', async () => {
  const deps = { eventBus: { onAny: () => () => {} } } as unknown as PanelDeps;
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const token = await loginToken(base);
    const g = await fetch(`${base}/api/config/model`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(g.status, 503);
    assert.equal(((await g.json()) as { error: string }).error, 'model_config_unavailable');
  } finally {
    await h.close();
  }
});
