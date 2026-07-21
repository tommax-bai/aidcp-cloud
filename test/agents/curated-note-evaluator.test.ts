/**
 * CuratedNoteEvaluator 单测（change curated-admission-eval-roles，Phase 3）。
 * 覆盖：成本红线（预筛不过零 LLM）、准入正确、诚实红线（降级/解析失败不纳入）、仅共鸣回退、honest-fail。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { CuratedNoteEvaluator } from '../../src/agents/curated-note-evaluator.js';
import type { CuratedObservation } from '../../src/cache/curated-content-store.js';
import type { NoteDetailData } from '../../src/event-bus/types.js';
import type { Soul } from '../../src/soul/types.js';
import type { TextCardTranscriber } from '../../src/publish-agent/text-card-transcriber.js';

const soul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程'], seed_keywords: ['GPT'] },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const normalizeImagesForTest = () => [0, 1].map((index) => ({
  index,
  sourceUrl: `https://img.test/${index}.jpg`,
  captureStatus: 'url_only' as const,
  capturedAt: 10,
}));

const mkDetail = (over: Partial<NoteDetailData> = {}): NoteDetailData => ({
  noteId: 'n1',
  title: '标题',
  content: '一段扎实的正文内容',
  author: '作者A',
  likeCount: 10,
  collectCount: 0,
  url: 'https://xhs/n1',
  ...over,
});

interface RunOpts {
  llmRaw?: string;
  llmThrows?: boolean;
  llmEvalEnabled?: boolean;
  accountId?: string;
  eventAccountId?: string;
  eventTs?: number;
  textCardTranscriber?: TextCardTranscriber;
}

async function run(detail: NoteDetailData, opts: RunOpts = {}) {
  const bus = new EventBus();
  let llmCalled = false;
  const upserts: CuratedObservation[] = [];
  const role = new CuratedNoteEvaluator({
    eventBus: bus,
    soul,
    llm: {
      complete: async () => {
        llmCalled = true;
        if (opts.llmThrows) throw new Error('llm down');
        return opts.llmRaw ?? '{"admit":true,"relevanceOk":true,"richnessOk":true,"isPromoOrClickbait":false,"reason":"相关扎实"}';
      },
    },
    curatedStore: { upsertObservation: async (obs) => { upserts.push(obs); } },
    getAccountId: () => opts.accountId ?? 'acc-1',
    ...(opts.llmEvalEnabled === undefined ? {} : { llmEvalEnabled: opts.llmEvalEnabled }),
    ...(opts.textCardTranscriber ? { textCardTranscriber: opts.textCardTranscriber } : {}),
  });
  role.subscribe();
  bus.emit('note.detail.arrived', { detail, accountId: opts.eventAccountId, ts: opts.eventTs ?? Date.now() });
  await sleep(30);
  return { llmCalled, upserts };
}

describe('CuratedNoteEvaluator 两段式准入', () => {
  it('成本红线：共鸣预筛不过（无收藏）→ 零 LLM 调用、不纳入', async () => {
    const r = await run(mkDetail({ likeCount: 5, collectCount: 0 }));
    assert.equal(r.llmCalled, false, '预筛不过绝不调 LLM');
    assert.equal(r.upserts.length, 0);
  });

  it('空正文 → 零 LLM 调用、不纳入', async () => {
    const r = await run(mkDetail({ collectCount: 100, content: '   ' }));
    assert.equal(r.llmCalled, false, '空正文不是可用精选素材，绝不调 LLM');
    assert.equal(r.upserts.length, 0);
  });

  it('空 DOM 文字卡先按顺序增补真实转写，再参与丰富度评估并落逐卡记录', async () => {
    const transcription = {
      version: 1 as const,
      status: 'complete' as const,
      anchor: `sha256:${'b'.repeat(64)}`,
      provider: 'dashscope',
      model: 'ocr-model',
      transcribedAt: 10,
      cards: [
        { sourceArrayIndex: 0, sourceIndex: 0, capturedAt: 10, status: 'transcribed' as const, text: '第一张：核心结论' },
        { sourceArrayIndex: 1, sourceIndex: 1, capturedAt: 10, status: 'transcribed' as const, text: '第二张：操作步骤' },
      ],
    };
    const textCardTranscriber: TextCardTranscriber = {
      enabled: () => true,
      transcribe: async () => ({
        images: normalizeImagesForTest(),
        transcription,
        cacheHit: false,
      }),
    };
    const r = await run(
      mkDetail({
        collectCount: 100,
        content: '  ',
        images: [
          { index: 0, url: 'https://img.test/0.jpg' },
          { index: 1, url: 'https://img.test/1.jpg' },
        ],
      }),
      { textCardTranscriber },
    );
    assert.equal(r.llmCalled, true, '空 DOM 不能在转写前短路');
    assert.equal(r.upserts.length, 1);
    assert.equal(r.upserts[0].body, '第一张：核心结论\n\n第二张：操作步骤');
    assert.deepEqual(r.upserts[0].textCardTranscription, transcription);
  });

  it('预筛过(收藏达地板) + 评估准入 → upsert(admitReason=llm_eval)', async () => {
    const eventTs = Date.parse('2026-07-21T07:30:00.000Z');
    const r = await run(mkDetail({ collectCount: 100, publishedAtText: '3小时前' }), { eventTs });
    assert.equal(r.llmCalled, true);
    assert.equal(r.upserts.length, 1);
    assert.equal(r.upserts[0].admitReason, 'llm_eval');
    assert.equal(r.upserts[0].contentType, 'image_text');
    assert.equal(r.upserts[0].sourceId, 'n1');
    assert.equal(r.upserts[0].accountId, 'acc-1');
    assert.equal(r.upserts[0].publishedAtText, '3小时前');
    assert.equal(r.upserts[0].publishedObservedAt, eventTs);
  });

  it('预筛过 + 评估判不相关 → 不纳入', async () => {
    const r = await run(mkDetail({ collectCount: 100 }), {
      llmRaw: '{"admit":false,"relevanceOk":false,"richnessOk":true,"isPromoOrClickbait":false,"reason":"跑题"}',
    });
    assert.equal(r.llmCalled, true);
    assert.equal(r.upserts.length, 0);
  });

  it('预筛过的视频详情 → upsert contentType=video', async () => {
    const r = await run(mkDetail({ collectCount: 100, mediaType: 'video' }));
    assert.equal(r.upserts.length, 1);
    assert.equal(r.upserts[0].contentType, 'video');
  });

  it('预筛过 + 评估判广告/标题党 → 不纳入', async () => {
    const r = await run(mkDetail({ collectCount: 100 }), {
      llmRaw: '{"admit":false,"relevanceOk":true,"richnessOk":true,"isPromoOrClickbait":true,"reason":"广告"}',
    });
    assert.equal(r.upserts.length, 0);
  });

  it('诚实红线：LLM 降级（抛错）→ 不纳入、不抛', async () => {
    const r = await run(mkDetail({ collectCount: 100 }), { llmThrows: true });
    assert.equal(r.llmCalled, true);
    assert.equal(r.upserts.length, 0);
  });

  it('诚实红线：解析失败（坏输出）→ 不纳入', async () => {
    const r = await run(mkDetail({ collectCount: 100 }), { llmRaw: '这不是JSON' });
    assert.equal(r.upserts.length, 0);
  });

  it('诚实红线：缺核心字段（无 relevanceOk）→ 不纳入', async () => {
    const r = await run(mkDetail({ collectCount: 100 }), {
      llmRaw: '{"admit":true,"richnessOk":true,"isPromoOrClickbait":false}',
    });
    assert.equal(r.upserts.length, 0);
  });

  it('开关关(llmEvalEnabled=false)：预筛过 → 直接纳入、不调 LLM（仅共鸣回退）', async () => {
    const r = await run(mkDetail({ collectCount: 100 }), { llmEvalEnabled: false });
    assert.equal(r.llmCalled, false);
    assert.equal(r.upserts.length, 1);
    assert.equal(r.upserts[0].admitReason, 'collect_floor');
  });

  it('honest-fail：账号未绑定占位 → 不纳入、不调 LLM', async () => {
    const r = await run(mkDetail({ collectCount: 100 }), { accountId: '__unbound__' });
    assert.equal(r.llmCalled, false);
    assert.equal(r.upserts.length, 0);
  });

  it('事件携 accountId → 以事件账号落库', async () => {
    const r = await run(mkDetail({ collectCount: 100 }), { eventAccountId: 'acc-evt' });
    assert.equal(r.upserts[0].accountId, 'acc-evt');
  });

  it('图片快照刷新：已有精选行只更新图片，不调 LLM', async () => {
    const bus = new EventBus();
    let llmCalled = false;
    const refreshes: Array<{ accountId: string; sourceId: string; images: unknown[] }> = [];
    const role = new CuratedNoteEvaluator({
      eventBus: bus,
      soul,
      llm: {
        complete: async () => {
          llmCalled = true;
          return '{"admit":true,"relevanceOk":true,"richnessOk":true,"isPromoOrClickbait":false,"reason":"相关扎实"}';
        },
      },
      curatedStore: {
        upsertObservation: async () => {
          throw new Error('refresh existing row should not upsert');
        },
        refreshReferenceImages: async (accountId, sourceId, _contentType, images) => {
          refreshes.push({ accountId, sourceId, images });
          return 1;
        },
      },
      getAccountId: () => 'acc-1',
    });
    role.subscribe();
    bus.emit('note.image_snapshot.arrived', {
      detail: mkDetail({ images: [{ index: 0, url: 'https://img.test/a.jpg' }] }),
      accountId: 'acc-evt',
      ts: Date.now(),
    });
    await sleep(30);

    assert.equal(llmCalled, false);
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0].accountId, 'acc-evt');
    assert.equal(refreshes[0].sourceId, 'n1');
  });

  it('图片快照刷新：未命中已有行时回落准入评估，避免先刷新后入库丢图', async () => {
    const bus = new EventBus();
    let llmCalled = false;
    const upserts: CuratedObservation[] = [];
    const role = new CuratedNoteEvaluator({
      eventBus: bus,
      soul,
      llm: {
        complete: async () => {
          llmCalled = true;
          return '{"admit":true,"relevanceOk":true,"richnessOk":true,"isPromoOrClickbait":false,"reason":"相关扎实"}';
        },
      },
      curatedStore: {
        upsertObservation: async (obs) => {
          upserts.push(obs);
        },
        refreshReferenceImages: async () => 0,
      },
      getAccountId: () => 'acc-1',
    });
    role.subscribe();
    bus.emit('note.image_snapshot.arrived', {
      detail: mkDetail({ collectCount: 100, images: [{ index: 0, url: 'https://img.test/a.jpg' }] }),
      accountId: 'acc-evt',
      ts: Date.now(),
    });
    await sleep(30);

    assert.equal(llmCalled, true);
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].accountId, 'acc-evt');
    assert.deepEqual(upserts[0].referenceImages, [{ index: 0, url: 'https://img.test/a.jpg' }]);
  });
});
