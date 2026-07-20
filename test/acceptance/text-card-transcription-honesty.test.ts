import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAiCompatVisionClient } from '../../src/llm/vision.js';
import { buildCardSetPrompt } from '../../src/publish-agent/prompts.js';
import {
  createTextCardTranscriber,
  mergeBodyWithTextCardTranscription,
} from '../../src/publish-agent/text-card-transcriber.js';

test('AC-TCT-1：所选视觉厂商缺密钥时不跨厂商兜底、不编正文、主路径可诚实继续', async () => {
  let fetchCalls = 0;
  const vision = new OpenAiCompatVisionClient({
    getModel: () => 'ocr-model',
    getProvider: () => 'dashscope',
    providerRuntime: { dashscope: { baseUrl: 'https://dashscope.invalid/v1', apiKey: '' } },
    fetchImpl: (async () => {
      fetchCalls++;
      throw new Error('must not fetch');
    }) as unknown as typeof fetch,
  });
  const service = createTextCardTranscriber({
    vision,
    formSensor: {
      sense: async () => ({ status: 'error', cached: false }),
      senseAt: async () => ({
        status: 'detected',
        cached: false,
        guess: {
          form: 'text_card',
          confidence: 0.99,
          detectedAt: 10,
          detectedFor: 10,
          model: 'form-model',
          provider: 'dashscope',
        },
      }),
    },
    enabled: () => true,
    getModel: () => 'ocr-model',
    getProvider: () => 'dashscope',
    clock: () => 10,
    logger: { warn() {} },
  });

  const result = await service.transcribe({
    accountId: 'acc-1',
    sourceId: 'note-1',
    images: [{ index: 0, sourceUrl: 'https://img.test/card.jpg', capturedAt: 10 }],
    snapshotAt: 10,
  });
  assert.equal(fetchCalls, 0, '缺密钥必须在网络请求前失败');
  assert.equal(result.transcription?.status, 'failed');
  assert.equal(result.transcription?.cards[0].text, undefined);
  assert.equal(mergeBodyWithTextCardTranscription('', result.transcription), '', '失败结果不得伪造可准入正文');
  assert.equal(mergeBodyWithTextCardTranscription('原 DOM 正文', result.transcription), '原 DOM 正文');
});

test('AC-TCT-2：生成提示按参考槽顺序提供文字，并锁定终稿事实优先与禁止照搬', () => {
  const prompt = buildCardSetPrompt(
    '改写标题',
    '改写终稿只支持事实 A 和事实 B',
    ['主题'],
    2,
    false,
    [
      { sourceArrayIndex: 3, text: '来源第三槽文字' },
      { sourceArrayIndex: 7, text: '来源第七槽文字' },
    ],
  );
  assert.ok(prompt.indexOf('来源数组下标 3') < prompt.indexOf('来源数组下标 7'));
  assert.match(prompt, /第 i 张生成卡必须承接上面第 i 个来源槽/);
  assert.match(prompt, /若来源槽与终稿冲突，以终稿为准/);
  assert.match(prompt, /绝不逐字搬运来源文字/);
});
