import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { PgPanelStore } from '../src/panel/panel-store.js';

/** 用注入 fake pool 测查询的行映射/聚合逻辑，不依赖真 PG。 */
function poolReturning(rows: unknown[]): pg.Pool {
  return { query: async () => ({ rows }) } as unknown as pg.Pool;
}

/** 模拟某表未迁移：query 抛 PG 错误码 code。 */
function poolThrowing(code: string): pg.Pool {
  return {
    query: async () => {
      throw Object.assign(new Error('relation does not exist'), { code });
    },
  } as unknown as pg.Pool;
}

test('todayTotals 把行映射成全 action 记录并补 0', async () => {
  const store = new PgPanelStore({ pool: poolReturning([
    { action: 'like', total: 10 },
    { action: 'view', total: 40 },
  ]) });
  const totals = await store.todayTotals();
  assert.equal(totals.like, 10);
  assert.equal(totals.view, 40);
  assert.equal(totals.collect, 0); // 缺失补 0
  assert.equal(totals.follow, 0);
});

test('todayTotals 忽略未知 action', async () => {
  const store = new PgPanelStore({ pool: poolReturning([{ action: 'bogus', total: 99 }]) });
  const totals = await store.todayTotals();
  assert.equal(Object.values(totals).every((v) => v === 0), true);
});

test('today 面板查询显式使用 Asia/Shanghai 自然日下界', async () => {
  const seen: string[] = [];
  const pool = {
    query: async (sql: string) => {
      seen.push(sql);
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const store = new PgPanelStore({ pool });

  await store.todayTotals();
  await store.todayTotalsByAccount();
  await store.todayPublishCount();
  await store.likeRate();

  assert.equal(seen.length, 4);
  for (const sql of seen) assert.match(sql, /AT TIME ZONE 'Asia\/Shanghai'/);
});

test('likeRate 计算 rate 与健康区间（15%-35%）', async () => {
  const healthy = await new PgPanelStore({ pool: poolReturning([{ likes: 10, views: 40 }]) }).likeRate();
  assert.equal(healthy.rate, 0.25);
  assert.equal(healthy.healthy, true);

  const over = await new PgPanelStore({ pool: poolReturning([{ likes: 20, views: 40 }]) }).likeRate();
  assert.equal(over.rate, 0.5);
  assert.equal(over.healthy, false); // > 35%
});

test('likeRate views=0 时 rate/healthy 为 null（不除零、不假成功）', async () => {
  const r = await new PgPanelStore({ pool: poolReturning([{ likes: 0, views: 0 }]) }).likeRate();
  assert.equal(r.rate, null);
  assert.equal(r.healthy, null);
});

test('listAccounts 映射 accounts⨝risk_state（operator vs risk 状态分开）', async () => {
  const store = new PgPanelStore({ pool: poolReturning([
    {
      account_id: 'default', label: 'default', platform: 'xiaohongshu',
      group_label: null, machine_label: null, operator_status: 'paused',
      paused_at: new Date(1000), risk_status: 'warned', risk_quota_level: 'conservative', signal_count: 3,
    },
  ]) });
  const [a] = await store.listAccounts();
  assert.equal(a.accountId, 'default');
  assert.equal(a.operatorStatus, 'paused');
  assert.equal(a.pausedAt, 1000);
  assert.equal(a.riskStatus, 'warned');
  assert.equal(a.riskQuotaLevel, 'conservative');
  assert.equal(a.signalCount, 3);
});

test('getAccount 无行返回 null', async () => {
  const store = new PgPanelStore({ pool: poolReturning([]) });
  assert.equal(await store.getAccount('nope'), null);
});

test('listAccounts 无 risk_state 行时风控字段为 null（账号无风控行）', async () => {
  const store = new PgPanelStore({ pool: poolReturning([
    {
      account_id: 'x', label: null, platform: 'xiaohongshu', group_label: null, machine_label: null,
      operator_status: 'active', paused_at: null, risk_status: null, risk_quota_level: null, signal_count: null,
    },
  ]) });
  const [a] = await store.listAccounts();
  assert.equal(a.riskStatus, null);
  assert.equal(a.riskQuotaLevel, null);
  assert.equal(a.pausedAt, null);
});

test('todayTotalsByAccount 按账号分桶 + 每桶补全 action（V1 9.6）', async () => {
  const store = new PgPanelStore({ pool: poolReturning([
    { account_id: 'default', action: 'like', total: 10 },
    { account_id: 'default', action: 'view', total: 40 },
    { account_id: 'acc-2', action: 'follow', total: 3 },
  ]) });
  const byAcc = await store.todayTotalsByAccount();
  const d = byAcc.find((b) => b.accountId === 'default')!;
  assert.equal(d.totals.like, 10);
  assert.equal(d.totals.view, 40);
  assert.equal(d.totals.collect, 0); // 补 0
  const a2 = byAcc.find((b) => b.accountId === 'acc-2')!;
  assert.equal(a2.totals.follow, 3);
  assert.equal(a2.totals.like, 0);
});

test('listAlerts 映射行；表未迁移降级为空（V1 9.5）', async () => {
  const store = new PgPanelStore({ pool: poolReturning([
    { alert_id: '7', severity: 'P0', type: 'captcha', account_id: 'default', title: '验证码弹出', detail: null, created_at: new Date(100), resolved_at: null },
  ]) });
  const [al] = await store.listAlerts();
  assert.equal(al.id, 7);
  assert.equal(al.severity, 'P0');
  assert.equal(al.createdAt, 100);
  assert.equal(al.resolvedAt, null);

  // 表不存在 → []（不让 dashboard 整体 500）
  const empty = await new PgPanelStore({ pool: poolThrowing('42P01') }).listAlerts();
  assert.deepEqual(empty, []);
});

test('listInteractions 映射行；表未迁移降级为空（V1 9.2 / change interaction-feed-enrichment）', async () => {
  const store = new PgPanelStore({ pool: poolReturning([
    { account_id: 'default', target_id: 'note-1', action: 'like', title: '一篇笔记标题', url: 'https://www.xiaohongshu.com/explore/note-1?xsec_token=x', occurred_at: new Date(200) },
  ]) });
  const [it] = await store.listInteractions({ accountId: 'default' });
  // AC-PANEL：笔记动作 → targetId=noteId + 标题 + 带 token 详情页链接。
  assert.equal(it.targetId, 'note-1');
  assert.equal(it.action, 'like');
  assert.equal(it.title, '一篇笔记标题');
  assert.equal(it.url, 'https://www.xiaohongshu.com/explore/note-1?xsec_token=x');
  assert.equal(it.interactedAt, 200);

  const empty = await new PgPanelStore({ pool: poolThrowing('42P01') }).listInteractions();
  assert.deepEqual(empty, []);

  // 非 undefined_table 错误应上抛（不静默吞真实故障）
  await assert.rejects(() => new PgPanelStore({ pool: poolThrowing('57014') }).listInteractions());
});

test('listInteractions：关注按作者（targetId=authorId + 昵称 + 主页链接）；title/url 缺失诚实置空不伪造（AC-PANEL）', async () => {
  // 关注行：title=作者昵称、url=作者主页。
  const followStore = new PgPanelStore({ pool: poolReturning([
    { account_id: 'default', target_id: 'author-9', action: 'follow', title: '某位作者', url: 'https://www.xiaohongshu.com/user/profile/author-9', occurred_at: new Date(300) },
  ]) });
  const [f] = await followStore.listInteractions();
  assert.equal(f.targetId, 'author-9');
  assert.equal(f.action, 'follow');
  assert.equal(f.title, '某位作者');
  assert.equal(f.url, 'https://www.xiaohongshu.com/user/profile/author-9');

  // 元数据缺失（join 未命中 / 抓不到）→ title/url 为 undefined，绝不伪造（前端回落裸 id、不渲染死链）。
  const bareStore = new PgPanelStore({ pool: poolReturning([
    { account_id: 'default', target_id: 'note-2', action: 'comment', title: null, url: null, occurred_at: new Date(400) },
  ]) });
  const [b] = await bareStore.listInteractions();
  assert.equal(b.targetId, 'note-2');
  assert.equal(b.action, 'comment');
  assert.equal(b.title, undefined);
  assert.equal(b.url, undefined);
});

test('publishedHistory 映射参照洗稿来稿快照；普通发布来源为 null', async () => {
  const sourceReference = {
    kind: 'curated_reference',
    curatedContentId: 7,
    accountId: 'acc-1',
    sourceId: 'note-42',
    title: '来稿标题',
    body: '来稿正文',
    author: '作者甲',
    topics: ['收纳'],
    sourceUrl: null,
    capturedAt: 1700000000000,
  };
  const store = new PgPanelStore({
    pool: poolReturning([
      {
        id: 1,
        title: '发布标题',
        status: 'published',
        platform_post_id: 'post-1',
        published_at: new Date(500),
        account_id: 'acc-1',
        account_label: '账号标签',
        account_nickname: null,
        content: '发布正文',
        post_url: null,
        content_version: 0,
        images: [],
        image_url: null,
        images_attached_count: 0,
        publish_metadata: {
          referenceImageAudit: {
            requestedCount: 2,
            usableCount: 2,
            status: 'unsupported',
            providerClaimedUsed: false,
            generatedCount: 3,
          },
          visualReferenceAudit: {
            analysisStatus: 'partial',
            analysisCacheKey: 'visual-cache-1',
            bindingMode: 'slot',
            auditEnabled: true,
            slots: [],
          },
        },
        source_reference: sourceReference,
      },
      {
        id: 2,
        title: '普通发布',
        status: 'published',
        platform_post_id: 'post-2',
        published_at: new Date(600),
        account_id: 'acc-1',
        account_label: '账号标签',
        account_nickname: null,
        content: '普通正文',
        post_url: null,
        content_version: 0,
        images: [],
        image_url: null,
        images_attached_count: 0,
        publish_metadata: null,
        source_reference: null,
      },
    ]),
  });

  const rows = await store.publishedHistory(50, 'acc-1');
  assert.equal(rows[0].sourceReference?.curatedContentId, 7);
  assert.equal(rows[0].sourceReference?.body, '来稿正文');
  assert.equal(rows[0].sourceReference?.sourceUrl, null, '缺来源链接保持 null，不伪造');
  assert.deepEqual(rows[0].imageReferenceAudit, {
    requestedCount: 2,
    usableCount: 2,
    status: 'unsupported',
    providerClaimedUsed: false,
    generatedCount: 3,
  });
  assert.deepEqual(rows[0].visualReferenceAudit, {
    analysisStatus: 'partial',
    analysisCacheKey: 'visual-cache-1',
    bindingMode: 'slot',
    auditEnabled: true,
    slots: [],
  });
  assert.equal(rows[1].sourceReference, null);
  assert.equal(rows[1].imageReferenceAudit, null);
  assert.equal(rows[1].visualReferenceAudit, null);
});
