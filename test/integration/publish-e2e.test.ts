/**
 * Publish Agent 端到端集成测试。
 *
 * 与单元测试（test/publish-*.test.ts，全程 mock）不同，本文件真实跑通发布链路：
 *   trigger（触发判定） → generator（真实调 Qwen） → post-processor（去 AI 味检测）
 *   → publisher（落库，PG 用 mock Pool）。
 *
 * ── 运行前提 ──────────────────────────────────────────────────────────────
 * 真实调 Qwen 的用例需要设置环境变量 DASHSCOPE_API_KEY 才会执行：
 *   - 推荐在项目根目录放一个 .env 文件：DASHSCOPE_API_KEY=sk-xxxx（本文件会自动读取）；
 *   - 或直接在进程环境里导出 DASHSCOPE_API_KEY。
 * 未设置时，"integration - real Qwen" 这组用例会被跳过（其余用例照常运行）。
 *
 * PG 说明：真实 PG 部署在 ECS（本地连不上），因此 publisher 落库用 mock pg.Pool 验证
 * SQL 语句与参数是否正确，不依赖真实数据库。
 * ────────────────────────────────────────────────────────────────────────
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { QwenClient } from '../../src/llm/index.js';
import {
  PublishTrigger,
  ContentGenerator,
  PostProcessor,
  PublishLogStore,
  detectBannedPhrases,
  type GenerateInput,
  type GenerateOutput,
  type PublishRecord,
  type TriggerMetrics,
} from '../../src/publish/index.js';
import type { Soul } from '../../src/soul/index.js';

// ── 测试常量 ──────────────────────────────────────────────────────────────

/** 触发器最小新概念数（与本测试的 anchors 数量约束对应）。 */
const MIN_ANCHORS = 5;
/** 标题字数上限（任务要求 <= 30 字）。 */
const MAX_TITLE_LENGTH = 30;
/** 正文字数上限（与 prompt 中 200-500 字区间一致，留出冗余）。 */
const MAX_BODY_LENGTH = 800;
/** 真实调 Qwen 的超时（毫秒）。 */
const QWEN_TIMEOUT_MS = 30_000;

// ── .env 读取（无第三方 dotenv 依赖，手动解析） ──────────────────────────────

/** 把项目根目录的 .env 读进 process.env（已存在的键不覆盖）。 */
function loadDotEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // test/integration → 上溯两级到项目根。
  const envPath = join(here, '..', '..', '.env');
  let raw: string;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return; // 没有 .env 就算了，依赖进程环境变量。
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

// ── 测试夹具：人设 + 生成素材（>= MIN_ANCHORS 个概念） ────────────────────────

const soul: Soul = {
  identity: { name: '小林', role: 'AI研发工程师', background: '3年大厂 LLM 落地', tone: '理性、偶尔幽默' },
  interests: { primary: ['LLM', 'RAG'], secondary: ['推理优化'], seed_keywords: ['向量检索', 'vLLM'] },
  engagement_rules: {
    quality_threshold: { min_likes: 50, min_collects: 20 },
    like: [],
    skip: [],
    comment_trigger: [],
  },
  browse_patterns: {
    mode: 'state_machine',
    states: { browse: { action: '浏览', transitions: [] } },
    session: { max_duration_min: 10, max_likes: 8, max_searches: 3, cooldown_between_actions_sec: [3, 8] },
  },
};

/** 生成素材：concepts 数量 >= MIN_ANCHORS（满足正常触发路径的内容门槛）。 */
const generateInput: GenerateInput = {
  concepts: [
    { keyword: 'RAG 分块策略', sourceNote: '某篇知识库问答实战' },
    { keyword: 'vLLM 显存优化' },
    { keyword: 'KV cache 撑爆' },
    { keyword: 'max_model_len 调参' },
    { keyword: 'embedding 召回质量' },
    { keyword: 'prompt 一步步思考' },
  ],
  likedContents: [
    { id: 7, title: 'RAG 实战踩坑', summary: '文档切块切太碎语义断裂，改按标题分块后召回正常', author: '老王' },
    { id: 9, title: 'vLLM 部署', summary: 'max_model_len 默认拉满把 KV cache 撑爆，调到 8k 才起来' },
  ],
  soul,
  recentPosts: [],
};

/** 满足正常触发路径的度量（新概念与点赞均达标）。 */
const okMetrics: TriggerMetrics = {
  hoursSinceLastPublish: 30,
  newConceptCount: generateInput.concepts.length,
  likedSinceLastPublish: 20,
};

// ── mock pg.Pool：记录每次 query 的 SQL 与参数 ───────────────────────────────

interface RecordedQuery {
  sql: string;
  params: unknown[] | undefined;
}

/** 仿造 pg.Pool 的最小实现：query 返回固定 RETURNING id，并记录调用。 */
function makeMockPool(returningId = 42) {
  const calls: RecordedQuery[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{ id: returningId }] };
    },
    end: async () => {},
  };
  // PublishLogStore 只用到 pool.query/end；用 unknown 转型注入。
  return { pool: pool as unknown as import('pg').Pool, calls };
}

// ── Trigger：足够 anchors 时 shouldPublish=true ────────────────────────────

describe('integration - trigger', () => {
  test(`>= ${MIN_ANCHORS} 个新概念时触发判定为 true`, () => {
    const trigger = new PublishTrigger();
    assert.ok(generateInput.concepts.length >= MIN_ANCHORS, '夹具应提供 >= MIN_ANCHORS 个概念');
    const decision = trigger.evaluate(okMetrics);
    assert.equal(decision.shouldPublish, true, decision.reason);
    assert.equal(decision.relaxed, false);
  });

  test('概念不足 + 未到软上限 → 不发布', () => {
    const trigger = new PublishTrigger();
    const decision = trigger.evaluate({
      hoursSinceLastPublish: 30,
      newConceptCount: 1,
      likedSinceLastPublish: 2,
    });
    assert.equal(decision.shouldPublish, false);
  });
});

// ── Publisher：mock Pool 验证落库 SQL 正确 ──────────────────────────────────

describe('integration - publisher (mock PG)', () => {
  test('insert 写入 publish_log，SQL 与参数正确', async () => {
    const { pool, calls } = makeMockPool(101);
    const store = new PublishLogStore({ pool });

    const record: PublishRecord = {
      title: '调 RAG 踩坑实录',
      content: '昨天分块切太碎召回一坨，改成按标题分块就正常了',
      sourceConcepts: ['RAG 分块策略', 'vLLM 显存优化'],
      sourceLikedIds: [7, 9],
      status: 'draft',
    };

    const id = await store.insert(record);

    assert.equal(id, 101, 'insert 应返回 RETURNING 的 id');
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.match(call.sql, /INSERT INTO publish_log/);
    assert.match(call.sql, /title, content, source_concepts, source_liked_ids, status, platform_post_id/);
    assert.match(call.sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6\)/);
    assert.match(call.sql, /RETURNING id/);
    assert.deepEqual(call.params, [
      '调 RAG 踩坑实录',
      '昨天分块切太碎召回一坨，改成按标题分块就正常了',
      ['RAG 分块策略', 'vLLM 显存优化'],
      [7, 9],
      'draft',
      null, // platformPostId 缺省落 null
    ]);
  });

  test('init 执行建表 DDL（幂等）', async () => {
    const { pool, calls } = makeMockPool();
    const store = new PublishLogStore({ pool });
    await store.init();
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /CREATE TABLE IF NOT EXISTS publish_log/);
  });
});

// ── 真实调 Qwen：generator + post-processor + publisher 全链路 ─────────────────

const hasApiKey = !!process.env.DASHSCOPE_API_KEY;

describe('integration - real Qwen', { skip: hasApiKey ? false : '未设置 DASHSCOPE_API_KEY，跳过真实 Qwen 测试' }, () => {
  let generator: ContentGenerator;
  let generated: GenerateOutput;

  before(async () => {
    const model = new QwenClient({ model: 'qwen-turbo', temperature: 0.8, timeoutMs: QWEN_TIMEOUT_MS });
    generator = new ContentGenerator({ model });
    generated = await generator.generate(generateInput);
  }, { timeout: QWEN_TIMEOUT_MS });

  test('生成的 title 非空且 <= 30 字', { timeout: QWEN_TIMEOUT_MS }, () => {
    assert.equal(typeof generated.title, 'string');
    assert.ok(generated.title.trim().length > 0, 'title 不应为空');
    assert.ok(
      [...generated.title].length <= MAX_TITLE_LENGTH,
      `title 应 <= ${MAX_TITLE_LENGTH} 字，实际「${generated.title}」(${[...generated.title].length} 字)`,
    );
  });

  test('生成的 body 非空且未超长', { timeout: QWEN_TIMEOUT_MS }, () => {
    assert.ok(generated.content.trim().length > 0, 'body 不应为空');
    assert.ok(
      [...generated.content].length <= MAX_BODY_LENGTH,
      `body 应 <= ${MAX_BODY_LENGTH} 字，实际 ${[...generated.content].length} 字`,
    );
  });

  test('生成的 tags 数组非空', { timeout: QWEN_TIMEOUT_MS }, () => {
    assert.ok(Array.isArray(generated.tags));
    assert.ok(generated.tags.length > 0, 'tags 应非空');
    for (const t of generated.tags) {
      assert.equal(typeof t, 'string');
      assert.ok(t.trim().length > 0);
    }
  });

  test('后处理检测 + 去 AI 味流程：最终正文不含 BANNED_PHRASES', { timeout: QWEN_TIMEOUT_MS }, async () => {
    // 后处理器接真实 generator.rewrite：命中禁用词时调 Qwen 重写一轮。
    // LLM 输出非确定性，偶尔会带禁用词（如「最后」），这正是后处理要兜住的场景。
    const postProcessor = new PostProcessor({
      rewriteThreshold: 1, // 命中任意 1 个即重写，最大化复检覆盖
      rewrite: async (content, flagged) => {
        const out = await generator.rewrite(content, flagged);
        return out.content;
      },
    });
    const processed = await postProcessor.process(generated.content);

    // 经过（必要时的）重写后，最终正文应不再命中禁用项。
    const finalHits = detectBannedPhrases(processed.content);
    assert.deepEqual(
      finalHits,
      [],
      `去 AI 味后正文仍命中：${finalHits.join('、')}（重写前命中：${detectBannedPhrases(generated.content).join('、') || '无'}）`,
    );
    assert.equal(processed.aiScore, 0, '最终 aiScore 应为 0');
    assert.ok(processed.content.trim().length > 0, '后处理后正文不应为空');
  });

  test('全链路：真实生成 → 后处理 → 落库（mock PG）', { timeout: QWEN_TIMEOUT_MS }, async () => {
    const trigger = new PublishTrigger();
    const decision = trigger.evaluate(okMetrics);
    assert.equal(decision.shouldPublish, true);

    const postProcessor = new PostProcessor({ rewriteThreshold: 2 });
    const processed = await postProcessor.process(generated.content);

    const { pool, calls } = makeMockPool(777);
    const store = new PublishLogStore({ pool });

    const record: PublishRecord = {
      title: generated.title || null,
      content: processed.content,
      sourceConcepts: generateInput.concepts.map((c) => c.keyword),
      sourceLikedIds: generateInput.likedContents.map((n) => n.id),
      status: processed.aiScore >= 0.5 ? 'needs_review' : 'draft',
    };
    const id = await store.insert(record);

    assert.equal(id, 777);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO publish_log/);
    const params = calls[0].params as unknown[];
    assert.deepEqual(params[2], generateInput.concepts.map((c) => c.keyword));
    assert.deepEqual(params[3], [7, 9]);
    assert.equal(params[4], 'draft');
  });
});
