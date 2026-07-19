import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCoverFormSensor,
  buildCoverFormSensePrompt,
  COVER_FORM_SENSOR_ROLE,
  type CoverFormSensorDeps,
  type CoverFormSenseRef,
} from '../../src/publish-agent/cover-form-sensor.js';
import type { VisionChatMessage, VisionCallOpts } from '../../src/llm/vision.js';
import type { ReferenceImageSnapshot } from '../../src/publish-agent/types.js';
import type { CuratedReferenceImageFormGuess } from '../../src/cache/curated-content-store.js';

/** 视觉客户端桩：记录每次调用的 messages/opts，按注入函数返回输出或抛错。 */
function stubVision(reply: (messages: VisionChatMessage[], opts?: VisionCallOpts) => string | Promise<string>) {
  const calls: Array<{ messages: VisionChatMessage[]; opts?: VisionCallOpts }> = [];
  return {
    calls,
    client: {
      chatVision: async (messages: VisionChatMessage[], opts?: VisionCallOpts) => {
        calls.push({ messages, opts });
        return reply(messages, opts);
      },
    },
  };
}

function makeImage(over: Partial<ReferenceImageSnapshot> = {}): ReferenceImageSnapshot {
  return {
    index: 0,
    sourceUrl: 'https://img.test/src.jpg',
    ossUrl: 'https://oss.test/cover.jpg',
    captureStatus: 'stored',
    capturedAt: 1_700_000_000_000,
    ...over,
  };
}

function makeRef(images: ReferenceImageSnapshot[], over: Partial<CoverFormSenseRef> = {}): CoverFormSenseRef {
  return { curatedContentId: 42, accountId: 'acc-1', sourceId: 'note-9', images, ...over };
}

const GOOD_JSON = '{"form":"text_card","confidence":0.92,"reason":"排版文字卡"}';

function makeDeps(over: Partial<CoverFormSensorDeps> = {}): CoverFormSensorDeps {
  return {
    vision: stubVision(() => GOOD_JSON).client,
    enabled: () => true,
    getModel: () => 'qwen-vl-test',
    getProvider: () => 'dashscope',
    clock: () => 1_700_000_500_000,
    ...over,
  };
}

test('旗标关 → disabled，零视觉调用零回写', async () => {
  const vision = stubVision(() => GOOD_JSON);
  const annotates: unknown[] = [];
  const sensor = createCoverFormSensor(
    makeDeps({
      vision: vision.client,
      enabled: () => false,
      annotate: async (...a) => {
        annotates.push(a);
        return true;
      },
    }),
  );
  const out = await sensor.sense(makeRef([makeImage()]));
  assert.deepEqual(out, { status: 'disabled', cached: false });
  assert.equal(vision.calls.length, 0);
  assert.equal(annotates.length, 0);
});

test('无参照图 / 全部 URL 不可用 → no_image 诚实短路，零调用', async () => {
  const vision = stubVision(() => GOOD_JSON);
  const sensor = createCoverFormSensor(makeDeps({ vision: vision.client }));
  const empty = await sensor.sense(makeRef([]));
  assert.equal(empty.status, 'no_image');
  assert.equal(empty.cached, false);

  const unusable = await sensor.sense(
    makeRef([makeImage({ ossUrl: '   ', sourceUrl: '' }), makeImage({ ossUrl: undefined, sourceUrl: '  ' })]),
  );
  assert.equal(unusable.status, 'no_image');
  assert.equal(vision.calls.length, 0);
});

test('缓存命中（detectedFor === capturedAt）→ 直接消费缓存，零视觉调用零回写', async () => {
  const cachedGuess: CuratedReferenceImageFormGuess = {
    form: 'photo',
    confidence: 0.8,
    detectedAt: 1_699_999_999_000,
    detectedFor: 1_700_000_000_000,
    model: 'qwen-vl-old',
  };
  const vision = stubVision(() => GOOD_JSON);
  const annotates: unknown[] = [];
  const sensor = createCoverFormSensor(
    makeDeps({
      vision: vision.client,
      annotate: async (...a) => {
        annotates.push(a);
        return true;
      },
    }),
  );
  const out = await sensor.sense(makeRef([makeImage({ formGuess: cachedGuess })]));
  assert.equal(out.status, 'detected');
  assert.equal(out.cached, true);
  assert.deepEqual(out.guess, cachedGuess);
  assert.equal(vision.calls.length, 0);
  assert.equal(annotates.length, 0);
});

test('注解过期（detectedFor ≠ capturedAt，图已重抓）→ 视为 miss，发起视觉调用', async () => {
  const staleGuess: CuratedReferenceImageFormGuess = {
    form: 'photo',
    confidence: 0.8,
    detectedAt: 1,
    detectedFor: 1_600_000_000_000, // 旧锚
    model: 'qwen-vl-old',
  };
  const vision = stubVision(() => GOOD_JSON);
  const sensor = createCoverFormSensor(makeDeps({ vision: vision.client }));
  const out = await sensor.sense(makeRef([makeImage({ formGuess: staleGuess })]));
  assert.equal(out.status, 'detected');
  assert.equal(out.cached, false);
  assert.equal(vision.calls.length, 1);
  assert.equal(out.guess?.form, 'text_card'); // 新判定，不是旧缓存。
});

test('视觉成功：单次调用（ossUrl 优先入图、role 记账、超时透传），盖章 model/provider/时钟，回写按数组下标', async () => {
  const vision = stubVision(() => GOOD_JSON);
  const annotates: Array<[number, number, CuratedReferenceImageFormGuess]> = [];
  const sensor = createCoverFormSensor(
    makeDeps({
      vision: vision.client,
      timeoutMs: 12_345,
      annotate: async (rowId, index, guess) => {
        annotates.push([rowId, index, guess]);
        return true;
      },
    }),
  );
  // 首图 URL 全空 → 跳过；第二张（数组下标 1）可用。
  const out = await sensor.sense(makeRef([makeImage({ ossUrl: undefined, sourceUrl: '' }), makeImage()]));
  assert.equal(out.status, 'detected');
  assert.equal(out.cached, false);
  assert.deepEqual(out.guess, {
    form: 'text_card',
    confidence: 0.92,
    detectedAt: 1_700_000_500_000, // 注入时钟
    detectedFor: 1_700_000_000_000, // = item.capturedAt 锚
    model: 'qwen-vl-test',
    provider: 'dashscope',
  });
  // 单次调用；消息含文字指令 + image_url（ossUrl 优先）。
  assert.equal(vision.calls.length, 1);
  const content = vision.calls[0].messages[0].content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0]?.type, 'text');
  assert.equal(content[0]?.type === 'text' ? content[0].text : '', buildCoverFormSensePrompt(), '运行时与后台预览必须共用同一 builder');
  const imagePart = content.find((p) => p.type === 'image_url');
  assert.deepEqual(imagePart, { type: 'image_url', image_url: { url: 'https://oss.test/cover.jpg' } });
  assert.equal(vision.calls[0].opts?.role, COVER_FORM_SENSOR_ROLE);
  assert.equal(vision.calls[0].opts?.accountId, 'acc-1');
  assert.equal(vision.calls[0].opts?.timeoutMs, 12_345);
  // 回写：rowId + 被感知图的数组下标（1，非首位）。
  assert.equal(annotates.length, 1);
  assert.equal(annotates[0][0], 42);
  assert.equal(annotates[0][1], 1);
  assert.deepEqual(annotates[0][2], out.guess);
});

test('存量缺 capturedAt → detectedFor 用归一化 now（annotate 同条语句落锚）', async () => {
  const sensor = createCoverFormSensor(makeDeps());
  const out = await sensor.sense(makeRef([makeImage({ capturedAt: undefined })]));
  assert.equal(out.status, 'detected');
  assert.equal(out.guess?.detectedFor, 1_700_000_500_000); // = clock()
  assert.equal(out.guess?.detectedAt, 1_700_000_500_000);
});

test('脏 JSON / 缺 form / 越界 confidence → error，绝不持久化、绝不猜形态', async () => {
  const dirtyOutputs = [
    '好的，这是一张文字卡片图', // 无 JSON
    '{"confidence":0.9}', // 缺 form
    '{"form":"poster","confidence":0.9}', // 枚举外
    '{"form":"text_card"}', // 缺 confidence
    '{"form":"text_card","confidence":1.7}', // 越界
    '{"form":"text_card","confidence":"high"}', // 类型不符
    '{broken json', // 不可解析
  ];
  for (const dirty of dirtyOutputs) {
    const annotates: unknown[] = [];
    const sensor = createCoverFormSensor(
      makeDeps({
        vision: stubVision(() => dirty).client,
        annotate: async (...a) => {
          annotates.push(a);
          return true;
        },
      }),
    );
    const out = await sensor.sense(makeRef([makeImage()]));
    assert.equal(out.status, 'error', `should be error for: ${dirty}`);
    assert.equal(out.cached, false);
    assert.equal(out.guess, undefined); // 绝不猜形态。
    assert.equal(annotates.length, 0, `must not persist for: ${dirty}`); // error 不持久化（无负缓存）。
  }
});

test('视觉调用抛错/超时 → error 带诚实 detail，不抛出、不持久化', async () => {
  const annotates: unknown[] = [];
  const sensor = createCoverFormSensor(
    makeDeps({
      vision: stubVision(() => {
        throw new Error('This operation was aborted');
      }).client,
      annotate: async (...a) => {
        annotates.push(a);
        return true;
      },
    }),
  );
  const out = await sensor.sense(makeRef([makeImage()]));
  assert.equal(out.status, 'error');
  assert.equal(out.cached, false);
  assert.match(out.detail!, /aborted/);
  assert.equal(annotates.length, 0);
});

test('低置信判定原样返回（阈值在消费端，感知不过滤）且照常回写（存观测不存策略）', async () => {
  const annotates: unknown[] = [];
  const sensor = createCoverFormSensor(
    makeDeps({
      vision: stubVision(() => '{"form":"text_card","confidence":0.3,"reason":"不太确定"}').client,
      annotate: async (...a) => {
        annotates.push(a);
        return true;
      },
    }),
  );
  const out = await sensor.sense(makeRef([makeImage()]));
  assert.equal(out.status, 'detected');
  assert.equal(out.guess?.confidence, 0.3); // 原样带出，不在此弃权。
  assert.equal(annotates.length, 1); // 原样持久化。
});

test('回写失败（reject / 锚不符 false）→ 只记日志，判定结果不受影响', async () => {
  const warns: string[] = [];
  const logger = { warn: (m: string) => warns.push(m) };

  const rejecting = createCoverFormSensor(
    makeDeps({
      annotate: async () => {
        throw new Error('pg down');
      },
      logger,
    }),
  );
  const out1 = await rejecting.sense(makeRef([makeImage()]));
  assert.equal(out1.status, 'detected');
  assert.equal(out1.guess?.form, 'text_card');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /pg down/);

  const mismatched = createCoverFormSensor(makeDeps({ annotate: async () => false, logger }));
  const out2 = await mismatched.sense(makeRef([makeImage()]));
  assert.equal(out2.status, 'detected');
  assert.equal(warns.length, 2);
  assert.match(warns[1], /anchor mismatch/);
});

test('curatedContentId 为 null（无落库素材行）→ 不回写，判定照常返回', async () => {
  const annotates: unknown[] = [];
  const sensor = createCoverFormSensor(
    makeDeps({
      annotate: async (...a) => {
        annotates.push(a);
        return true;
      },
    }),
  );
  const out = await sensor.sense(makeRef([makeImage()], { curatedContentId: null }));
  assert.equal(out.status, 'detected');
  assert.equal(annotates.length, 0);
});

test('超时缺省链：deps.timeoutMs 缺省时读 env AIDCP_COVER_FORM_TIMEOUT_MS，再缺省 30s', async () => {
  const prev = process.env.AIDCP_COVER_FORM_TIMEOUT_MS;
  try {
    process.env.AIDCP_COVER_FORM_TIMEOUT_MS = '9000';
    const viaEnv = stubVision(() => GOOD_JSON);
    await createCoverFormSensor(makeDeps({ vision: viaEnv.client })).sense(makeRef([makeImage()]));
    assert.equal(viaEnv.calls[0].opts?.timeoutMs, 9000);

    delete process.env.AIDCP_COVER_FORM_TIMEOUT_MS;
    const viaDefault = stubVision(() => GOOD_JSON);
    await createCoverFormSensor(makeDeps({ vision: viaDefault.client })).sense(makeRef([makeImage()]));
    assert.equal(viaDefault.calls[0].opts?.timeoutMs, 30_000);
  } finally {
    if (prev === undefined) delete process.env.AIDCP_COVER_FORM_TIMEOUT_MS;
    else process.env.AIDCP_COVER_FORM_TIMEOUT_MS = prev;
  }
});
