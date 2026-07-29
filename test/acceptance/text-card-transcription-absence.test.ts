/**
 * AC-TCT-3：转写能力**缺席**（依赖没接上）与**旗标关闭**（运营选择）必须可分辨。
 *
 * 拆仓前这两态在代码里长得一模一样（`transcriber?.enabled()` 在缺席时整个表达式为 undefined、判定为假），
 * 于是图内文字整段消失、调用方一路拿到「评估成功」——正是红线点名的静默假成功。
 * 本例钉两件事：缺席**必须**具名留痕且带上原因；缺席**不得**改成抛出（本角色 fire-and-forget，
 * 抛出会打断浏览闭环），评估仍照常按 DOM 正文诚实完成。
 *
 * **为什么单独一个文件**：这条守的是「拆进程之后组合根漏装」这个失败态，它只可能发生在
 * automation 侧的角色上，所以它必须跟着角色一起进 automation 仓才有意义。测试归属由 import 派生，
 * 与它同源的另外两条（AC-TCT-1 / AC-TCT-2）依赖视觉客户端与生成提示（content），
 * 合在一个文件里就是跨属主、只能留守 cloud —— 那样这条断言永远到不了它要保护的那个仓。
 * 故此处只**搬**不抄：本文件的 import 面全部落在 automation + kernel，不得再引入任何 content 依赖。
 */
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
        // Sink 三个方法都必选（task 0.6d）：本例不走这两条，桩如实回答「库里没这条 / 没缓存」。
        refreshReferenceImages: async () => 0,
        getTextCardContext: async () => null,
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

  // 缺席的留痕是**两条**、各有各的用处，必须分别钉住：
  //   ① 构造期一条 —— 装配一漏就当场喊，不用等到有笔记进来；
  //   ② 首次真跳过一条 —— 证明确有内容因缺席没被转写，并点出在哪一步、哪条笔记。
  // 若只断言「至少还有一条含『未接线』」，删掉其中任意一条另一条都还在、用例照样全绿 —— 那正是这里要防的。
  const constructionComplaints = absent.lines.filter(
    (line) => line.includes('图内文字卡转写能力未接线') && line.includes('请检查组合根装配'),
  );
  const skipComplaints = absent.lines.filter(
    (line) => line.includes('跳过图内文字卡转写') && line.includes('stage=admission_eval'),
  );
  assert.equal(constructionComplaints.length, 1, '构造期必须当场喊一次装配缺陷，缺了就没人知道组合根漏装了');
  assert.equal(skipComplaints.length, 1, '首次真跳过必须单独留痕，缺了就看不出确有笔记因缺席丢掉了图内文字');
  assert.ok(
    constructionComplaints[0].includes('not_wired_by_composition_root'),
    '构造期留痕必须带上缺席原因，否则现场无从定位是哪一处装配漏了',
  );
  assert.ok(
    skipComplaints[0].includes('not_wired_by_composition_root') && skipComplaints[0].includes('note=n-tct3'),
    '跳过留痕必须带上缺席原因与被跳过的笔记，否则只知道「跳过了」、不知道跳的是什么、为什么',
  );

  // 缺席只跳过转写，绝不抛、绝不吃掉评估：两条路径都照常落库，且正文如实保持 DOM 原值。
  assert.equal(flagOff.upserts.length, 1, '旗标关闭时评估照常完成');
  assert.equal(absent.upserts.length, 1, '能力缺席时评估仍须完成（fire-and-forget，抛出会打断浏览闭环）');
  assert.equal(absent.upserts[0].body, 'DOM 正文', '缺席时正文只有 DOM 原值，绝不伪造图内文字');
});
