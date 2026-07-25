import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCuratedReferenceImages,
  type TextCardTranscription,
} from '../../src/cache/curated-content-store.js';
import { normalizeTextCardTranscription } from '../../src/kernel/text-card-transcription.js';
import type { VisionCallOpts, VisionChatMessage, VisionLlmClient } from '../../src/llm/vision.js';
import type { CoverFormSensor } from '../../src/publish-agent/cover-form-sensor.js';
import {
  createTextCardTranscriber,
  mergeBodyWithTextCardTranscription,
  textCardTranscriptionAnchor,
} from '../../src/publish-agent/text-card-transcriber.js';

const NOW = 1_700_000_000_000;
const rawImages = [0, 1, 2].map((index) => ({ index: index + 10, url: `https://img.test/${index}.jpg` }));

function formSensor(forms: Array<'text_card' | 'photo' | 'illustration' | 'other'>, calls: number[]): CoverFormSensor {
  return {
    sense: async () => ({ status: 'error', cached: false }),
    senseAt: async (_ref, sourceArrayIndex) => {
      calls.push(sourceArrayIndex);
      return {
        status: 'detected',
        cached: false,
        guess: {
          form: forms[sourceArrayIndex],
          confidence: 0.95,
          detectedAt: NOW,
          detectedFor: NOW,
          model: 'form-model',
          provider: 'dashscope',
        },
      };
    },
  };
}

describe('TextCardTranscriber', () => {
  test('只选高置信文字卡，一次批量调用；模型乱序返回仍按来源下标记录', async () => {
    const formCalls: number[] = [];
    const visionCalls: Array<{ messages: VisionChatMessage[]; opts?: VisionCallOpts }> = [];
    const vision: VisionLlmClient = {
      chatVision: async (messages, opts) => {
        visionCalls.push({ messages, opts });
        return JSON.stringify({
          cards: [
            { sourceArrayIndex: 2, text: '第三张文字' },
            { sourceArrayIndex: 0, text: '第一张文字' },
          ],
        });
      },
    };
    const service = createTextCardTranscriber({
      vision,
      formSensor: formSensor(['text_card', 'photo', 'text_card'], formCalls),
      enabled: () => true,
      getModel: () => 'ocr-model',
      getProvider: () => 'dashscope',
      clock: () => NOW,
    });

    const result = await service.transcribe({ accountId: 'a1', sourceId: 'n1', images: rawImages, snapshotAt: NOW });
    assert.deepEqual(formCalls, [0, 1, 2]);
    assert.equal(visionCalls.length, 1, '一条笔记只发一次批量转写');
    assert.equal(visionCalls[0].opts?.maxTokens, 8192);
    assert.equal(visionCalls[0].opts?.role, 'browse:text_card_transcriber');
    const parts = visionCalls[0].messages[0].content;
    assert.ok(Array.isArray(parts));
    assert.equal(parts.filter((part) => part.type === 'image_url').length, 2, '照片不进入 OCR 请求');
    assert.deepEqual(result.transcription?.cards.map((card) => [card.sourceArrayIndex, card.text]), [
      [0, '第一张文字'],
      [2, '第三张文字'],
    ]);
    assert.equal(result.transcription?.status, 'complete');
    assert.equal(result.images[1].formGuess?.form, 'photo', '形态信息随图片记录');
  });

  test('旗标关闭时形态识别、转写和转写结果均为零', async () => {
    const formCalls: number[] = [];
    let visionCalls = 0;
    const service = createTextCardTranscriber({
      vision: { chatVision: async () => { visionCalls++; return '{}'; } },
      formSensor: formSensor(['text_card', 'text_card', 'text_card'], formCalls),
      enabled: () => false,
      getModel: () => 'ocr-model',
      getProvider: () => 'dashscope',
    });
    const result = await service.transcribe({ accountId: 'a1', sourceId: 'n1', images: rawImages, snapshotAt: NOW });
    assert.deepEqual(formCalls, []);
    assert.equal(visionCalls, 0);
    assert.equal(result.transcription, undefined);
  });

  test('同锚命中数据库缓存时零视觉调用', async () => {
    const normalized = normalizeCuratedReferenceImages(rawImages, { now: NOW });
    const cached: TextCardTranscription = {
      version: 1,
      status: 'complete',
      anchor: textCardTranscriptionAnchor(normalized),
      provider: 'dashscope',
      model: 'ocr-model',
      transcribedAt: NOW,
      cards: [{ sourceArrayIndex: 0, sourceIndex: 10, capturedAt: NOW, status: 'transcribed', text: '缓存文字' }],
    };
    let calls = 0;
    const service = createTextCardTranscriber({
      vision: { chatVision: async () => { calls++; return '{}'; } },
      formSensor: { sense: async () => { calls++; return { status: 'error', cached: false }; } },
      enabled: () => true,
      getModel: () => 'ocr-model',
      getProvider: () => 'dashscope',
    });
    const result = await service.transcribe({
      accountId: 'a1',
      sourceId: 'n1',
      images: rawImages,
      snapshotAt: NOW + 1,
      cached: { referenceImages: normalized, transcription: cached },
    });
    assert.equal(calls, 0);
    assert.equal(result.cacheHit, true);
    assert.equal(result.transcription?.cards[0].text, '缓存文字');
  });

  test('并发同源同锚共享一次判形和一次转写', async () => {
    const formCalls: number[] = [];
    let visionCalls = 0;
    const service = createTextCardTranscriber({
      vision: {
        chatVision: async () => {
          visionCalls++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return '{"cards":[{"sourceArrayIndex":0,"text":"同一次"}]}';
        },
      },
      formSensor: formSensor(['text_card', 'photo', 'photo'], formCalls),
      enabled: () => true,
      getModel: () => 'ocr-model',
      getProvider: () => 'dashscope',
    });
    const input = { accountId: 'a1', sourceId: 'n1', images: rawImages, snapshotAt: NOW };
    const [a, b] = await Promise.all([service.transcribe(input), service.transcribe(input)]);
    assert.equal(visionCalls, 1);
    assert.equal(formCalls.length, 3);
    assert.deepEqual(a, b);
  });

  test('缺卡结果标 partial，不拿相邻卡补；正文只合并成功卡一次', async () => {
    const service = createTextCardTranscriber({
      vision: { chatVision: async () => '{"cards":[{"sourceArrayIndex":0,"text":"第一卡"}]}' },
      formSensor: formSensor(['text_card', 'photo', 'text_card'], []),
      enabled: () => true,
      getModel: () => 'ocr-model',
      getProvider: () => 'dashscope',
      clock: () => NOW,
    });
    const result = await service.transcribe({ accountId: 'a1', sourceId: 'n1', images: rawImages, snapshotAt: NOW });
    assert.equal(result.transcription?.status, 'partial');
    assert.equal(result.transcription?.cards[1].status, 'failed');
    assert.equal(result.transcription?.cards[1].text, undefined);
    assert.equal(mergeBodyWithTextCardTranscription('DOM 正文', result.transcription), 'DOM 正文\n\n第一卡');
    assert.equal(mergeBodyWithTextCardTranscription('DOM 正文 第一卡', result.transcription), 'DOM 正文 第一卡');
  });
});

test('转写 JSONB 严格归一：按来源槽排序，重复槽或状态矛盾整包拒绝', () => {
  const base = {
    version: 1,
    status: 'complete',
    anchor: `sha256:${'a'.repeat(64)}`,
    provider: 'dashscope',
    model: 'ocr-model',
    transcribedAt: NOW,
    cards: [
      { sourceArrayIndex: 2, sourceIndex: 12, capturedAt: NOW, status: 'transcribed', text: '三' },
      { sourceArrayIndex: 0, sourceIndex: 10, capturedAt: NOW, status: 'transcribed', text: '一' },
    ],
  };
  assert.deepEqual(normalizeTextCardTranscription(base)?.cards.map((card) => card.sourceArrayIndex), [0, 2]);
  assert.equal(normalizeTextCardTranscription({ ...base, cards: [base.cards[0], base.cards[0]] }), undefined);
  assert.equal(normalizeTextCardTranscription({ ...base, status: 'partial' }), undefined);
});
