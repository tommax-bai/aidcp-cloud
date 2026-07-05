import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type {
  PanelConfig,
  PanelDeps,
  ModelConfigView,
  SetCredentialResult,
  SetModelResult,
} from '../src/panel/types.js';

const silentLogger = { log() {}, warn() {}, error() {} };

/** 可变 mock modelConfig 外观（多厂商）；canEdit 可切换以测主密钥缺失分支。 */
function makeModelConfig(opts: { canEdit: boolean }) {
  const credentialDefs: Array<
    Pick<
      ModelConfigView['credentials'][number],
      'provider' | 'field' | 'label' | 'providerLabel' | 'group' | 'groupLabel' | 'secretKind' | 'restartRequired'
    >
  > = [
    {
      provider: 'dashscope',
      field: 'dashscope_api_key',
      label: '阿里百炼 DashScope API Key',
      providerLabel: '阿里百炼 DashScope',
      group: 'model_api',
      groupLabel: '模型 API Key',
      secretKind: 'api_key',
      restartRequired: true,
    },
    {
      provider: 'volcengine',
      field: 'volcengine_api_key',
      label: '火山引擎方舟 Ark API Key',
      providerLabel: '火山引擎方舟 Ark',
      group: 'model_api',
      groupLabel: '模型 API Key',
      secretKind: 'api_key',
      restartRequired: true,
    },
    {
      provider: 'aliyun',
      field: 'access_key_id',
      label: '阿里云平台 AccessKey ID',
      providerLabel: '阿里云平台',
      group: 'billing_access',
      groupLabel: '账单查询 AccessKey',
      secretKind: 'access_key_id',
      restartRequired: true,
    },
    {
      provider: 'aliyun',
      field: 'access_key_secret',
      label: '阿里云平台 AccessKey Secret',
      providerLabel: '阿里云平台',
      group: 'billing_access',
      groupLabel: '账单查询 AccessKey',
      secretKind: 'access_key_secret',
      restartRequired: true,
    },
  ];
  const state = {
    textProvider: 'dashscope',
    textModel: 'qwen-turbo',
    imageModel: 'wan2.7-image-pro',
    imageProvider: 'dashscope',
    creds: new Map<string, { configured: boolean; maskedHint: string | null }>(),
  };
  const credView = (def: typeof credentialDefs[number]): ModelConfigView['credentials'][number] => {
    const c = state.creds.get(`${def.provider}/${def.field}`);
    return {
      ...def,
      configured: !!c?.configured,
      maskedHint: c?.maskedHint ?? null,
      source: c?.configured ? 'db' : 'none',
    };
  };
  const view = (): ModelConfigView => ({
    textProvider: state.textProvider,
    imageProvider: state.imageProvider,
    textModel: state.textModel,
    imageModel: state.imageModel,
    providers: [
      { id: 'dashscope', displayName: '阿里百炼 DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { id: 'volcengine', displayName: '火山引擎方舟 Ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    ],
    imageProviders: [
      { id: 'dashscope', displayName: '阿里百炼 · 通义万相' },
      { id: 'volcengine', displayName: '火山方舟 · 即梦 Seedream' },
    ],
    credentials: credentialDefs.map(credView),
    canEditCredential: opts.canEdit,
  });
  return {
    state,
    getView: async () => view(),
    setModel: async (patch: {
      textProvider?: string;
      textModel?: string;
      imageModel?: string;
      imageProvider?: string;
    }): Promise<SetModelResult> => {
      if (patch.textProvider) state.textProvider = patch.textProvider;
      if (patch.textModel) state.textModel = patch.textModel;
      if (patch.imageModel) state.imageModel = patch.imageModel;
      if (patch.imageProvider) state.imageProvider = patch.imageProvider;
      return { ok: true, view: view() };
    },
    setCredential: async (provider: string, field: string, value: string): Promise<SetCredentialResult> => {
      if (!opts.canEdit) return { ok: false, reason: 'cred_key_missing' };
      const maskedHint = `${value.slice(0, 4)}****${value.slice(-4)}`;
      state.creds.set(`${provider}/${field}`, { configured: true, maskedHint });
      return { ok: true, provider, field, maskedHint };
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

test('config 路由：GET 多厂商形状无明文、PUT model 改厂商/名回真态、PUT credential 按厂商加密回掩码', async () => {
  const { deps } = makeDeps(true);
  const h = await startPanelApi(deps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    // 未鉴权 → 401
    assert.equal((await fetch(`${base}/api/config/model`)).status, 401);

    const token = await loginToken(base);
    const auth = { authorization: `Bearer ${token}` };

    // GET：含选中厂商 + 可选厂商列表 + 各厂商凭据状态，绝不含明文密钥字段
    const g = await fetch(`${base}/api/config/model`, { headers: auth });
    assert.equal(g.status, 200);
    const view = (await g.json()) as ModelConfigView & Record<string, unknown>;
    assert.equal(view.textProvider, 'dashscope');
    assert.equal(view.textModel, 'qwen-turbo');
    assert.equal(view.canEditCredential, true);
    assert.equal(view.providers.length, 2);
    assert.ok(view.providers.some((p) => p.id === 'volcengine'));
    const dsCred = view.credentials.find((c) => c.provider === 'dashscope');
    assert.equal(dsCred?.configured, false);
    const aliyunCred = view.credentials.find((c) => c.provider === 'aliyun' && c.field === 'access_key_id');
    assert.equal(aliyunCred?.group, 'billing_access');
    assert.equal(aliyunCred?.label, '阿里云平台 AccessKey ID');
    const raw = JSON.stringify(view);
    assert.ok(!raw.includes('apiKey'));
    assert.ok(!('value' in view));

    // PUT model：切厂商到火山 + 改文本模型名 → 回写后真态
    const pm = await fetch(`${base}/api/config/model`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ textProvider: 'volcengine', textModel: 'doubao-seed-1-6' }),
    });
    assert.equal(pm.status, 200);
    const pmView = (await pm.json()) as ModelConfigView;
    assert.equal(pmView.textProvider, 'volcengine');
    assert.equal(pmView.textModel, 'doubao-seed-1-6');

    // PUT model 全空 → 400
    const pmEmpty = await fetch(`${base}/api/config/model`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(pmEmpty.status, 400);

    // PUT credential：按厂商加密保存火山 key → 回掩码，绝不回明文
    const pc = await fetch(`${base}/api/config/credential`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'volcengine', field: 'volcengine_api_key', value: 'ark-abcdefghijkl' }),
    });
    assert.equal(pc.status, 200);
    const pcBody = (await pc.json()) as { provider: string; field: string; configured: boolean; maskedHint: string };
    assert.equal(pcBody.provider, 'volcengine');
    assert.equal(pcBody.configured, true);
    assert.equal(pcBody.maskedHint, 'ark-****ijkl');
    assert.ok(!JSON.stringify(pcBody).includes('ark-abcdefghijkl'));

    // PUT credential：平台账单 AccessKey 也走同一加密写入口与白名单
    const billingKey = await fetch(`${base}/api/config/credential`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'aliyun', field: 'access_key_id', value: 'LTAIabcdefghijkl' }),
    });
    assert.equal(billingKey.status, 200);
    const billingBody = (await billingKey.json()) as { provider: string; field: string; configured: boolean; maskedHint: string };
    assert.equal(billingBody.provider, 'aliyun');
    assert.equal(billingBody.field, 'access_key_id');
    assert.equal(billingBody.maskedHint, 'LTAI****ijkl');

    // PUT credential 未知 (provider, field) → 400（白名单制）
    const pcBad = await fetch(`${base}/api/config/credential`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'dashscope', field: 'evil', value: 'x' }),
    });
    assert.equal(pcBad.status, 400);

    // PUT credential 厂商与字段不匹配（错配）→ 400
    const pcMismatch = await fetch(`${base}/api/config/credential`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'volcengine', field: 'dashscope_api_key', value: 'x' }),
    });
    assert.equal(pcMismatch.status, 400);
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
      body: JSON.stringify({ provider: 'dashscope', field: 'dashscope_api_key', value: 'sk-whatever-1234' }),
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
