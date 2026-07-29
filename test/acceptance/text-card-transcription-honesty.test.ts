import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CuratedNoteEvaluator } from '../../src/agents/curated-note-evaluator.js';
import { EventBus } from '../../src/event-bus/index.js';
import type { CuratedObservation } from '../../src/kernel/curated-content-types.js';
import type { NoteDetailData } from '../../src/kernel/note-detail.js';
import type { Soul } from '../../src/kernel/soul-types.js';
import type {
  TextCardTranscriber,
  TextCardTranscriberCapability,
} from '../../src/kernel/text-card-transcriber-port.js';
import { mergeBodyWithTextCardTranscription } from '../../src/kernel/text-card-transcription.js';
import { OpenAiCompatVisionClient } from '../../src/llm/vision.js';
import { buildCardSetPrompt } from '../../src/publish-agent/prompts.js';
import { createTextCardTranscriber } from '../../src/publish-agent/text-card-transcriber.js';

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

/**
 * AC-TCT-3：转写能力**缺席**（依赖没接上）与**旗标关闭**（运营选择）必须可分辨。
 *
 * 拆仓前这两态在代码里长得一模一样（`transcriber?.enabled()` 在缺席时整个表达式为 undefined、判定为假），
 * 于是图内文字整段消失、调用方一路拿到「评估成功」——正是红线点名的静默假成功。
 * 本例钉两件事：缺席**必须**具名留痕且带上原因；缺席**不得**改成抛出（本角色 fire-and-forget，
 * 抛出会打断浏览闭环），评估仍照常按 DOM 正文诚实完成。
 */
const AC_TCT3_SOUL: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: [], seed_keywords: [] },
};

const AC_TCT3_DETAIL: NoteDetailData = {
  noteId: 'n-tct3',
  title: '标题',
  content: 'DOM 正文',
  author: '作者A',
  likeCount: 10,
  // 收藏地板（50）以上，确保过第一段共鸣预筛、真正走到转写分支。
  collectCount: 60,
  url: 'https://xhs/n-tct3',
  images: [{ index: 0, url: 'https://img.test/0.jpg' }],
};

async function runEvaluatorCapturingLogs(
  textCardTranscriber: TextCardTranscriber | TextCardTranscriberCapability,
): Promise<{ lines: string[]; upserts: CuratedObservation[] }> {
  const lines: string[] = [];
  const upserts: CuratedObservation[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    const bus = new EventBus();
    const role = new CuratedNoteEvaluator({
      eventBus: bus,
      soul: AC_TCT3_SOUL,
      // 回退「仅共鸣」，本例不评模型；模型一旦被调即为回归。
      llmEvalEnabled: false,
      llm: {
        complete: async () => {
          throw new Error('AC-TCT-3 不应触发模型评估');
        },
      },
      curatedStore: {
        upsertObservation: async (obs) => {
          upserts.push(obs);
        },
      },
      getAccountId: () => 'acc-tct3',
      textCardTranscriber,
    });
    role.subscribe();
    bus.emit('note.detail.arrived', { detail: AC_TCT3_DETAIL, accountId: 'acc-tct3', ts: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    role.unsubscribe();
  } finally {
    console.log = originalLog;
  }
  return { lines, upserts };
}

test('AC-TCT-3：转写能力缺席必须具名留痕，绝不与「旗标关了」同形，且不打断评估', async () => {
  const flagOff = await runEvaluatorCapturingLogs({
    enabled: () => false,
    transcribe: async () => {
      throw new Error('旗标关闭时不应发起转写');
    },
  });
  const absent = await runEvaluatorCapturingLogs({
    state: 'unavailable',
    reason: 'not_wired_by_composition_root',
  });

  const wiringComplaints = (lines: string[]): string[] => lines.filter((line) => line.includes('未接线'));
  assert.equal(wiringComplaints(flagOff.lines).length, 0, '旗标关闭是运营选择，不得报成装配缺陷');
  assert.ok(wiringComplaints(absent.lines).length > 0, '依赖没接上必须留痕，绝不静默退化成「旗标关了」');
  assert.ok(
    absent.lines.some((line) => line.includes('not_wired_by_composition_root')),
    '留痕必须带上缺席原因，否则现场无从定位是哪一处装配漏了',
  );

  // 缺席只跳过转写，绝不抛、绝不吃掉评估：两条路径都照常落库，且正文如实保持 DOM 原值。
  assert.equal(flagOff.upserts.length, 1, '旗标关闭时评估照常完成');
  assert.equal(absent.upserts.length, 1, '能力缺席时评估仍须完成（fire-and-forget，抛出会打断浏览闭环）');
  assert.equal(absent.upserts[0].body, 'DOM 正文', '缺席时正文只有 DOM 原值，绝不伪造图内文字');
});
