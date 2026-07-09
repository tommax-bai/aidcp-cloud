/**
 * 精选笔记行级定向动作端点单测（change curated-note-actions）。
 * 覆盖：未注入 curatedActions → 503；坏 id/缺账号 → 400；跨账号/不存在 → 404（同形状不泄露）；
 * 视频/评论行洗稿 → image_text_only；评论行评论 → source_post_only；壳行 create-post → empty_body（不触发）；无标题 comment → empty_title；
 * 触发透传（create-post 带行、comment 带 withContact）；域内拒绝原因码透传；JWT 闸。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';
import type { CuratedPanelRow } from '../src/cache/curated-content-store.js';

const silentLogger = { log() {}, warn() {}, error() {} };

const baseDeps = {
  edgeServer: { edgeCount: () => 0, onlineEdgeCount: () => 0 },
  eventBus: { onAny: () => () => {} },
  publishOrchestrator: { getStatus: () => ({ status: 'idle', snapshot: null }) },
} as unknown as PanelDeps;

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

function row(over: Partial<CuratedPanelRow> = {}): CuratedPanelRow {
  return {
    id: 7,
    accountId: 'acc-1',
    contentType: 'image_text',
    sourceId: 'note-42',
    title: '好用的收纳技巧',
    body: '正文内容',
    author: '博主甲',
    sourceUrl: null,
    topics: ['收纳'],
    likeCount: 10,
    collectCount: 5,
    commentCount: null,
    countsCapturedAt: null,
    botLiked: false,
    botCollected: true,
    admitReason: 'bot_collect',
    firstSeenAt: 1,
    updatedAt: 2,
    referenceImages: [],
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

test('HTTP 精选行级动作：503/400/404/类型约束/empty_body/empty_title/触发透传', async () => {
  // ① 注入 curatedContent 但未注入 curatedActions → 503。
  const rows = new Map<string, CuratedPanelRow | null>();
  const curatedMock = {
    listForPanel: async () => ({ items: [], total: 0 }),
    facetsForPanel: async () => ({ admitReasons: [], imageTextCount: 0, videoCount: 0, noteCount: 0, commentCount: 0 }),
    deleteOne: async () => 0,
    clearEmptyBody: async () => 0,
    getOneForAccount: async (id: number, accountId: string) => rows.get(`${id}:${accountId}`) ?? null,
  };
  const noActions = await startPanelApi({ ...(baseDeps as object), curatedContent: curatedMock } as unknown as PanelDeps, makeConfig());
  try {
    const base = `http://127.0.0.1:${noActions.port}`;
    const auth = await loginAuth(base);
    const r = await fetch(`${base}/api/curated/contents/7/create-post`, { method: 'POST', headers: auth, body: JSON.stringify({ accountId: 'acc-1' }) });
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { error: string }).error, 'curated_actions_unavailable');
  } finally {
    await noActions.close();
  }

  // ② 完整注入：透传与各拒绝路径。
  const actionCalls: Array<{ fn: string; accountId: string; rowId: number; withContact?: boolean; useReferenceImages?: boolean }> = [];
  const actionsMock = {
    createPostFromNote: async (accountId: string, r2: CuratedPanelRow, options?: { useReferenceImages?: boolean }) => {
      const call: { fn: string; accountId: string; rowId: number; useReferenceImages?: boolean } = { fn: 'create', accountId, rowId: r2.id };
      if (typeof options?.useReferenceImages === 'boolean') call.useReferenceImages = options.useReferenceImages;
      actionCalls.push(call);
      return { triggered: true };
    },
    commentOnNote: async (accountId: string, r2: CuratedPanelRow, withContact: boolean) => {
      actionCalls.push({ fn: 'comment', accountId, rowId: r2.id, withContact });
      return withContact ? { triggered: false, reason: 'contact_info_missing' } : { triggered: true };
    },
  };
  const h = await startPanelApi(
    { ...(baseDeps as object), curatedContent: curatedMock, curatedActions: actionsMock } as unknown as PanelDeps,
    makeConfig(),
  );
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await loginAuth(base);
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

    // 无 token → 401（JWT 闸）。
    assert.equal((await fetch(`${base}/api/curated/contents/7/create-post`, { method: 'POST', body: '{}' })).status, 401);

    // 坏 id → 400 invalid_id；缺账号 → 400 account_required。
    assert.equal((await post('/api/curated/contents/abc/create-post', { accountId: 'acc-1' })).status, 400);
    assert.equal((await post('/api/curated/contents/7/create-post', {})).status, 400);

    // 行不存在/跨账号 → 404（同形状，不泄露他账号行存在性）。
    assert.equal((await post('/api/curated/contents/7/create-post', { accountId: 'acc-other' })).status, 404);

    // 评论行 → 洗稿 image_text_only、评论 source_post_only，动作不被调用。
    rows.set('8:acc-1', row({ id: 8, contentType: 'comment' }));
    const commentCreate = await post('/api/curated/contents/8/create-post', { accountId: 'acc-1' });
    assert.equal(commentCreate.status, 200);
    assert.deepEqual(await commentCreate.json(), { triggered: false, reason: 'image_text_only' });
    const commentComment = await post('/api/curated/contents/8/comment', { accountId: 'acc-1' });
    assert.equal(commentComment.status, 200);
    assert.deepEqual(await commentComment.json(), { triggered: false, reason: 'source_post_only' });

    // 视频行 → 洗稿 image_text_only；定向评论仍是源帖能力，后面单独覆盖可触发。
    rows.set('11:acc-1', row({ id: 11, contentType: 'video' }));
    const videoCreate = await post('/api/curated/contents/11/create-post', { accountId: 'acc-1' });
    assert.equal(videoCreate.status, 200);
    assert.deepEqual(await videoCreate.json(), { triggered: false, reason: 'image_text_only' });

    // 壳行（空正文）create-post → 200 triggered:false empty_body，动作不被调用。
    rows.set('9:acc-1', row({ id: 9, body: '' }));
    const shell = await post('/api/curated/contents/9/create-post', { accountId: 'acc-1' });
    assert.equal(shell.status, 200);
    assert.deepEqual(await shell.json(), { triggered: false, reason: 'empty_body' });

    // 无标题 comment → 200 triggered:false empty_title（搜索定位无从搜起）。
    rows.set('10:acc-1', row({ id: 10, title: '  ' }));
    const noTitle = await post('/api/curated/contents/10/comment', { accountId: 'acc-1' });
    assert.equal(noTitle.status, 200);
    assert.deepEqual(await noTitle.json(), { triggered: false, reason: 'empty_title' });
    assert.equal(actionCalls.length, 0, '以上拒绝路径都不该触达动作实现');

    // 正常触发：create-post 透传行；comment 透传 withContact 与域内拒绝原因码。
    rows.set('7:acc-1', row());
    const created = await post('/api/curated/contents/7/create-post', { accountId: 'acc-1' });
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), { triggered: true });
    rows.set('12:acc-1', row({
      id: 12,
      referenceImages: [{ index: 0, sourceUrl: 'https://img.test/a.jpg', captureStatus: 'url_only', capturedAt: 1 }],
    }));
    const createdTextOnly = await post('/api/curated/contents/12/create-post', { accountId: 'acc-1', useReferenceImages: false });
    assert.equal(createdTextOnly.status, 200);
    assert.deepEqual(await createdTextOnly.json(), { triggered: true });

    const contentComment = await post('/api/curated/contents/7/comment', { accountId: 'acc-1' });
    assert.deepEqual(await contentComment.json(), { triggered: true });

    const contactComment = await post('/api/curated/contents/7/comment', { accountId: 'acc-1', withContact: true });
    assert.deepEqual(await contactComment.json(), { triggered: false, reason: 'contact_info_missing' });

    const videoComment = await post('/api/curated/contents/11/comment', { accountId: 'acc-1' });
    assert.deepEqual(await videoComment.json(), { triggered: true });

    assert.deepEqual(actionCalls, [
      { fn: 'create', accountId: 'acc-1', rowId: 7 },
      { fn: 'create', accountId: 'acc-1', rowId: 12, useReferenceImages: false },
      { fn: 'comment', accountId: 'acc-1', rowId: 7, withContact: false },
      { fn: 'comment', accountId: 'acc-1', rowId: 7, withContact: true },
      { fn: 'comment', accountId: 'acc-1', rowId: 11, withContact: false },
    ]);
  } finally {
    await h.close();
  }
});
