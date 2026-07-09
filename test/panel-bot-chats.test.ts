import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';

/**
 * change feishu-bot-chat-name-display：GET /api/bot-chats 响应形状
 * （provider 注入 → 真实群名 + defaultChatId + source=feishu；未注入 → 回落 bot_chats 表、source=store）。
 */

const silentLogger = { log() {}, warn() {}, error() {} };

const baseDeps = {
  edgeServer: { edgeCount: () => 0, onlineEdgeCount: () => 0 },
  eventBus: { onAny: () => () => {} },
  panelStore: {},
  botChatStore: {
    listActive: async () => [
      { chatId: 'oc_a', chatName: null, chatType: 'group', isDefault: true },
      { chatId: 'oc_b', chatName: '客户B群', chatType: 'group', isDefault: false },
    ],
  },
};

function makeConfig(over: Partial<PanelConfig> = {}): PanelConfig {
  return { port: 0, jwtSecret: 'test-secret', users: parsePanelUsers('alice:pw1'), jwtTtlSeconds: 3600, forbiddenPorts: [8787, 5432, 8788], logger: silentLogger, ...over };
}

async function login(base: string): Promise<{ authorization: string }> {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'pw1' }) });
  const { token } = (await r.json()) as { token: string };
  return { authorization: `Bearer ${token}` };
}

test('bot-chats：provider 注入 → 真实群名 + defaultChatId + source=feishu', async () => {
  const deps = {
    ...baseDeps,
    botChats: {
      list: async () => ({
        chats: [
          { chatId: 'oc_a', name: '客户A群', isDefault: true },
          { chatId: 'oc_b', name: '客户B群', isDefault: false },
        ],
        defaultChatId: 'oc_a',
        source: 'feishu' as const,
      }),
    },
  } as unknown as PanelDeps;
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await login(base);
    const r = await fetch(`${base}/api/bot-chats`, { headers: auth });
    assert.equal(r.status, 200);
    const b = (await r.json()) as { chats: Array<{ chatId: string; name: string | null; isDefault: boolean }>; defaultChatId: string | null; source: string };
    assert.equal(b.source, 'feishu');
    assert.equal(b.defaultChatId, 'oc_a');
    assert.equal(b.chats[0].name, '客户A群');
    assert.equal(b.chats[0].isDefault, true);
  } finally {
    await h.close();
  }
});

test('bot-chats：无 provider → 回落 bot_chats 表，source=store，name 来自 chatName（可空）', async () => {
  const deps = { ...baseDeps } as unknown as PanelDeps; // 无 botChats provider
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await login(base);
    const r = await fetch(`${base}/api/bot-chats`, { headers: auth });
    assert.equal(r.status, 200);
    const b = (await r.json()) as { chats: Array<{ chatId: string; name: string | null; isDefault: boolean }>; defaultChatId: string | null; source: string };
    assert.equal(b.source, 'store');
    assert.equal(b.defaultChatId, 'oc_a'); // is_default 行
    assert.equal(b.chats[0].chatId, 'oc_a');
    assert.equal(b.chats[0].name, null); // chatName 为空 → 前端回落显示 id
    assert.equal(b.chats[1].name, '客户B群');
  } finally {
    await h.close();
  }
});
