import { test } from 'node:test';
import { ensureCapabilitySchema } from '../../src/schema/schema-capability.js';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  CuratedContentStore,
  normalizeCuratedReferenceImages,
  normalizeCuratedReferenceImageFormGuess,
  isCuratedCoverForm,
  type CuratedReferenceImageFormGuess,
} from '../../src/cache/curated-content-store.js';

/** 可控返回 rowCount、记录 (sql, params) 的 pool 桩（不依赖真 PG）。 */
function controllablePool(handler: (sql: string, params: unknown[]) => { rows?: unknown[]; rowCount?: number }): {
  pool: pg.Pool;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const r = handler(sql, params);
      return { rows: r.rows ?? [], rowCount: r.rowCount };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

const validGuess: CuratedReferenceImageFormGuess = {
  form: 'text_card',
  confidence: 0.88,
  detectedAt: 1_700_000_100_000,
  detectedFor: 1_700_000_000_000,
  model: 'qwen-vl-test',
  provider: 'dashscope',
};

// ── 白名单归一：读写双向 round-trip ─────────────────────────────────────────────

test('formGuess 白名单 round-trip：合法注解经 normalize 原样保留（含 provider）', () => {
  const out = normalizeCuratedReferenceImages([
    { index: 0, sourceUrl: 'https://img.test/a.jpg', capturedAt: 1_700_000_000_000, formGuess: validGuess },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].formGuess, validGuess);
  // 二次归一（模拟 DB 读回 → 再写）仍逐字一致——读写双向兼容。
  const again = normalizeCuratedReferenceImages(JSON.parse(JSON.stringify(out)));
  assert.deepEqual(again[0].formGuess, validGuess);
});

test('formGuess provider 可缺：缺省时不编造字段', () => {
  const { provider: _p, ...noProvider } = validGuess;
  const out = normalizeCuratedReferenceImages([
    { sourceUrl: 'https://img.test/a.jpg', formGuess: noProvider },
  ]);
  assert.deepEqual(out[0].formGuess, noProvider);
  assert.ok(!('provider' in out[0].formGuess!));
});

test('非法 formGuess 只丢注解、保图片本体（枚举外 form / 越界置信 / 非正整数时间戳 / 空 model）', () => {
  const badGuesses: unknown[] = [
    { ...validGuess, form: 'screenshot' }, // 枚举外
    { ...validGuess, confidence: 1.5 }, // 越界
    { ...validGuess, confidence: -0.1 }, // 越界
    { ...validGuess, confidence: Number.NaN }, // 非有限数
    { ...validGuess, confidence: '0.9' }, // 类型不符
    { ...validGuess, detectedAt: 0 }, // 非正
    { ...validGuess, detectedFor: -5 }, // 非正
    { ...validGuess, detectedFor: 1.5 }, // 非整数
    { ...validGuess, model: '' }, // 空 model
    { ...validGuess, model: undefined }, // 缺 model
    'not-an-object', // 非对象
    null,
  ];
  for (const bad of badGuesses) {
    const out = normalizeCuratedReferenceImages([
      { index: 3, sourceUrl: 'https://img.test/a.jpg', width: 640, capturedAt: 111, formGuess: bad },
    ]);
    // 图片本体照常返回（不报错不丢图），只剥 formGuess。
    assert.equal(out.length, 1, `image dropped for ${JSON.stringify(bad)}`);
    assert.equal(out[0].sourceUrl, 'https://img.test/a.jpg');
    assert.equal(out[0].index, 3);
    assert.equal(out[0].width, 640);
    assert.equal(out[0].capturedAt, 111);
    assert.equal(out[0].formGuess, undefined, `formGuess kept for ${JSON.stringify(bad)}`);
  }
});

test('normalizeCuratedReferenceImageFormGuess：provider 非法只丢 provider，注解本体保留', () => {
  const out = normalizeCuratedReferenceImageFormGuess({ ...validGuess, provider: 42 });
  assert.ok(out);
  assert.equal(out.form, 'text_card');
  assert.ok(!('provider' in out));
});

test('isCuratedCoverForm 枚举守卫穷举', () => {
  assert.equal(isCuratedCoverForm('text_card'), true);
  assert.equal(isCuratedCoverForm('photo'), true);
  assert.equal(isCuratedCoverForm('illustration'), true);
  assert.equal(isCuratedCoverForm('other'), true);
  assert.equal(isCuratedCoverForm('screenshot'), false);
  assert.equal(isCuratedCoverForm(''), false);
  assert.equal(isCuratedCoverForm(undefined), false);
});

test('写路径 round-trip：upsertObservation 落库的 JSONB 含合法 formGuess、剥非法 formGuess', async () => {
  const { pool, calls } = controllablePool(() => ({}));
  const store = new CuratedContentStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.upsertObservation({
    accountId: 'acc-1',
    contentType: 'image_text',
    sourceId: 'note-9',
    body: '正文',
    topics: [],
    admitReason: 'ok',
    referenceImages: [
      { index: 0, sourceUrl: 'https://img.test/a.jpg', formGuess: validGuess },
      { index: 1, sourceUrl: 'https://img.test/b.jpg', formGuess: { ...validGuess, form: 'nonsense' } },
    ],
  });
  const stored = JSON.parse(calls[0].params[9] as string) as Array<{ sourceUrl: string; formGuess?: unknown }>;
  assert.equal(stored.length, 2);
  assert.deepEqual(stored[0].formGuess, validGuess);
  assert.equal(stored[1].formGuess, undefined); // 非法注解写路径同样剥离，图片保留。
});

// ── annotateReferenceImageFormGuess：单条守卫 UPDATE 定点回写 ────────────────────

test('annotate：单条 UPDATE + jsonb_set 定点写 formGuess，WHERE 内嵌 capturedAt 锚守卫，绝不触碰 updated_at', async () => {
  const { pool, calls } = controllablePool(() => ({ rowCount: 1 }));
  const store = new CuratedContentStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const ok = await store.annotateReferenceImageFormGuess(42, 0, validGuess);
  assert.equal(ok, true);

  // 单条语句：绝不 JS 读-改-整数组回写（无 SELECT、无第二条写）。
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0];
  assert.match(sql, /^\s*UPDATE curated_content/);
  assert.doesNotMatch(sql, /SELECT/i);
  // jsonb_set 定点写目标 item 的 formGuess（非整列替换 $n::jsonb 赋值）。
  assert.match(sql, /jsonb_set\(/);
  assert.match(sql, /'formGuess'/);
  assert.doesNotMatch(sql, /SET reference_images = \$\d+::jsonb/);
  // WHERE 内嵌锚守卫：item 存在 且（无 capturedAt 或 = 判定锚）。
  assert.match(sql, /WHERE id = \$1/);
  assert.match(sql, /jsonb_typeof\(reference_images #> ARRAY\[\$2::text\]\) = 'object'/);
  assert.match(sql, /'capturedAt'\] IS NULL\s+OR reference_images #> ARRAY\[\$2::text, 'capturedAt'\] = to_jsonb\(\$4::bigint\)/);
  // 红线：绝不 bump 行 updated_at（selectForCreation 按其排序）。
  assert.doesNotMatch(sql, /updated_at/);
  // 参数：rowId / 数组下标 / 归一化注解 JSON / 判定锚。
  assert.equal(params[0], 42);
  assert.equal(params[1], '0');
  assert.deepEqual(JSON.parse(params[2] as string), validGuess);
  assert.equal(params[3], validGuess.detectedFor);
});

test('annotate：存量缺 capturedAt 的 item 同一条语句顺带落锚（COALESCE 写 detectedFor，缓存下次可命中）', async () => {
  const { pool, calls } = controllablePool(() => ({ rowCount: 1 }));
  const store = new CuratedContentStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.annotateReferenceImageFormGuess(42, 2, validGuess);
  const { sql } = calls[0];
  // 同一条 UPDATE 内：capturedAt 缺失时用判定锚补写（COALESCE 既有值优先，绝不改写已有锚）。
  assert.match(
    sql,
    /jsonb_set\(\s*reference_images,\s*ARRAY\[\$2::text, 'capturedAt'\],\s*COALESCE\(reference_images #> ARRAY\[\$2::text, 'capturedAt'\], to_jsonb\(\$4::bigint\)\),\s*true\s*\)/,
  );
  assert.equal(calls.length, 1); // 仍是单条语句。
});

test('annotate：锚不符/行缺失 → 0 行 → 诚实返回 false（弃写，绝不覆盖新图集）', async () => {
  const { pool } = controllablePool(() => ({ rowCount: 0 }));
  const store = new CuratedContentStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.equal(await store.annotateReferenceImageFormGuess(42, 0, validGuess), false);
});

test('annotate：guess 不过白名单 / index 非法 → 不发 SQL、返回 false、只记日志', async () => {
  const warns: string[] = [];
  const { pool, calls } = controllablePool(() => ({ rowCount: 1 }));
  const store = new CuratedContentStore({ schemaEnsurer: ensureCapabilitySchema, pool, logger: { warn: (m: string) => warns.push(m) } });
  assert.equal(
    await store.annotateReferenceImageFormGuess(42, 0, { ...validGuess, confidence: 9 }),
    false,
  );
  assert.equal(await store.annotateReferenceImageFormGuess(42, -1, validGuess), false);
  assert.equal(await store.annotateReferenceImageFormGuess(42, 0.5, validGuess), false);
  assert.equal(calls.length, 0); // 零 SQL。
  assert.equal(warns.length, 3);
});

test('读路径 round-trip：selectForCreation 读回的行剥非法 formGuess、保留合法 formGuess', async () => {
  const cannedRows = [
    {
      source_id: 'note-1',
      content_type: 'image_text',
      title: 'T',
      body: 'B',
      author: null,
      topics: [],
      like_count: null,
      collect_count: null,
      bot_liked: false,
      bot_collected: false,
      reference_images: [
        { index: 0, sourceUrl: 'https://img.test/a.jpg', capturedAt: 111, formGuess: validGuess },
        { index: 1, sourceUrl: 'https://img.test/b.jpg', capturedAt: 222, formGuess: { form: 'bad' } },
      ],
    },
  ];
  const { pool } = controllablePool(() => ({ rows: cannedRows }));
  const store = new CuratedContentStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const out = await store.selectForCreation('acc-1', 'source_post', 5);
  assert.equal(out[0].referenceImages.length, 2);
  assert.deepEqual(out[0].referenceImages[0].formGuess, validGuess);
  assert.equal(out[0].referenceImages[1].formGuess, undefined);
  assert.equal(out[0].referenceImages[1].sourceUrl, 'https://img.test/b.jpg'); // 图不丢。
});
