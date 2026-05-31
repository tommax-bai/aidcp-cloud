import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PublishService,
  PublishTrigger,
  ContentGenerator,
  PostProcessor,
  PUBLISH_SCHEMA_SQL,
} from '../src/publish/index.js';
import type {
  ChatModel,
  GenerateInput,
  PublishRecord,
  PublishStatus,
  PublishLogSink,
  TriggerMetrics,
} from '../src/publish/index.js';
import type { EdgePusher } from '../src/comm/ws-server.js';
import type { Envelope, PublishRequestPayload } from '../src/comm/protocol.js';
import type { Soul } from '../src/soul/index.js';

const soul: Soul = {
  identity: { name: '小林', role: 'AI研发', background: '3年', tone: '理性' },
  interests: { primary: ['LLM'], secondary: [], seed_keywords: ['RAG'] },
  engagement_rules: {
    quality_threshold: { min_likes: 50, min_collects: 20 },
    like: [], skip: [], comment_trigger: [],
  },
  browse_patterns: {
    mode: 'state_machine',
    states: { browse: { action: 'x', transitions: [] } },
    session: { max_duration_min: 10, max_likes: 8, max_searches: 3, cooldown_between_actions_sec: [3, 8] },
  },
};

const input: GenerateInput = {
  concepts: [{ keyword: 'RAG 重排' }, { keyword: 'vLLM 量化' }, { keyword: 'KV cache' }],
  likedContents: [{ id: 7, title: 'RAG 实战', summary: '分块关键' }, { id: 9, title: 'vLLM', summary: 'OOM' }],
  soul,
  recentPosts: [],
};

class FakePusher implements EdgePusher {
  readonly pushed: { env: Envelope; edgeId?: string }[] = [];
  constructor(private readonly count = 1) {}
  pushToEdges(env: Envelope, edgeId?: string): number {
    this.pushed.push({ env, edgeId });
    return this.count;
  }
  edgeCount(): number { return this.count; }
}

class FakeStore implements PublishLogSink {
  readonly inserted: PublishRecord[] = [];
  readonly statusUpdates: { id: number; status: PublishStatus }[] = [];
  readonly postIds: { id: number; postId: string }[] = [];
  private seq = 0;
  async insert(record: PublishRecord): Promise<number> {
    this.inserted.push(record);
    return ++this.seq;
  }
  async updateStatus(id: number, status: PublishStatus): Promise<void> {
    this.statusUpdates.push({ id, status });
  }
  async updatePostId(id: number, postId: string): Promise<void> {
    this.postIds.push({ id, postId });
  }
}

function makeService(modelOutput: string, opts?: { rewrite?: (c: string, f: string[]) => Promise<string>; needsReviewThreshold?: number; store?: FakeStore }) {
  const store = opts?.store ?? new FakeStore();
  const model: ChatModel = { chat: async () => modelOutput };
  const svc = new PublishService({
    trigger: new PublishTrigger(),
    generator: new ContentGenerator({ model }),
    postProcessor: new PostProcessor({ rewriteThreshold: 2, rewrite: opts?.rewrite }),
    store,
    clock: () => 1000,
    idGen: () => 'pub-1',
    needsReviewThreshold: opts?.needsReviewThreshold,
  });
  return { svc, store };
}

const okMetrics: TriggerMetrics = { hoursSinceLastPublish: 30, newConceptCount: 3, likedSinceLastPublish: 20 };

test('PUBLISH_SCHEMA_SQL 含 publish_log 表', () => {
  assert.match(PUBLISH_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS publish_log/);
  assert.match(PUBLISH_SCHEMA_SQL, /source_concepts/);
  assert.match(PUBLISH_SCHEMA_SQL, /needs_review/);
});

test('触发不满足 → 不生成不下发不落库', async () => {
  const { svc, store } = makeService('{"title":"t","content":"c","tags":[]}');
  const pusher = new FakePusher(1);
  const res = await svc.run({ hoursSinceLastPublish: 5, newConceptCount: 0, likedSinceLastPublish: 0 }, input, pusher);
  assert.equal(res.dispatched, false);
  assert.equal(res.recordId, null);
  assert.equal(store.inserted.length, 0);
  assert.equal(pusher.pushed.length, 0);
});

test('正常流程：生成 → 后处理干净 → 落库 draft → 下发 publish.request', async () => {
  const { svc, store } = makeService('{"title":"调 RAG 踩坑","content":"昨天分块切碎召回一坨，改了就好","tags":["RAG","踩坑"]}');
  const pusher = new FakePusher(2);
  const res = await svc.run(okMetrics, input, pusher);

  assert.equal(res.decision.shouldPublish, true);
  assert.equal(res.dispatched, true);
  assert.equal(res.edgeCount, 2);
  assert.equal(res.status, 'draft');
  assert.equal(res.recordId, 1);

  // 落库内容正确
  assert.equal(store.inserted.length, 1);
  assert.deepEqual(store.inserted[0].sourceConcepts, ['RAG 重排', 'vLLM 量化', 'KV cache']);
  assert.deepEqual(store.inserted[0].sourceLikedIds, [7, 9]);
  assert.equal(store.inserted[0].status, 'draft');

  // 下发信封正确
  assert.equal(pusher.pushed.length, 1);
  const env = pusher.pushed[0].env;
  assert.equal(env.type, 'publish.request');
  assert.equal(env.id, 'pub-1');
  const payload = env.payload as PublishRequestPayload;
  assert.equal(payload.title, '调 RAG 踩坑');
  assert.deepEqual(payload.tags, ['RAG', '踩坑']);
  assert.match(payload.content, /分块/);
});

test('定向 edgeId 透传', async () => {
  const { svc } = makeService('{"title":"t","content":"昨天踩了个坑记录下","tags":["a"]}');
  const pusher = new FakePusher(1);
  await svc.run(okMetrics, input, pusher, 'edge-local');
  assert.equal(pusher.pushed[0].edgeId, 'edge-local');
});

test('生成 AI 味重 + 重写器修不好 → needs_review，不下发', async () => {
  const { svc, store } = makeService(
    '{"title":"科普","content":"首先，其次，综上所述众所周知","tags":["a"]}',
    { rewrite: async () => '首先，其次，综上所述', needsReviewThreshold: 0.5 },
  );
  const pusher = new FakePusher(1);
  const res = await svc.run(okMetrics, input, pusher);
  assert.equal(res.status, 'needs_review');
  assert.equal(res.dispatched, false);
  assert.equal(pusher.pushed.length, 0);
  assert.equal(store.inserted[0].status, 'needs_review');
  assert.ok(res.flaggedPhrases.length >= 2);
});

test('生成 AI 味重但重写器修好 → draft 并下发', async () => {
  const { svc, store } = makeService(
    '{"title":"科普","content":"首先，其次，综上所述","tags":["a"]}',
    { rewrite: async () => '昨天试了三种方案，这个最稳，记一下', needsReviewThreshold: 0.5 },
  );
  const pusher = new FakePusher(1);
  const res = await svc.run(okMetrics, input, pusher);
  assert.equal(res.status, 'draft');
  assert.equal(res.dispatched, true);
  assert.equal(store.inserted[0].status, 'draft');
  assert.match(store.inserted[0].content, /三种方案/);
});

test('软上限放宽路径也能正常发布', async () => {
  const { svc } = makeService('{"title":"t","content":"很久没发了，随手记个事","tags":["a"]}');
  const pusher = new FakePusher(1);
  const res = await svc.run({ hoursSinceLastPublish: 60, newConceptCount: 1, likedSinceLastPublish: 0 }, input, pusher);
  assert.equal(res.decision.relaxed, true);
  assert.equal(res.dispatched, true);
});