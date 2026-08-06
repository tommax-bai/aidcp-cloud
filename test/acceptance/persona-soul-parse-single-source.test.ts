/**
 * AC-PERSONA-PARSE-* 人设解析**只许有一份**。
 *
 * 背景（2026-08-04 dev 切流演练实测）：同步读 `account_persona` 流在同一个游标 902 上，
 * 单体与派生接口服务发出的载荷摘要不同，消费方按「同游标必同载荷」整条拒收 ——
 * 根因是两个组装根各注入了一份不同的解析：一份只认人设闭子集、失败回 null，
 * 另一份用通用装载器、且不带兜底。**两侧各自的行为测试当时全绿**，因为
 * 「第二份实现」在行为测试上原理不可见。
 *
 * 故本组不测「解析对不对」，只测「是不是同一份」：按引用断 + 载荷摘要钉死。
 * 摘要常量同时钉在派生接口服务仓的同名用例里 —— 任一侧漂移，一侧当场红。
 */
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';

import { PERSONA_SOUL_CODEC } from '@content/agents/persona-soul-codec.js';
import { parseSyncReadPersonaSoul } from '@kernel/kernel/persona-soul-parse.js';
import { syncReadPayloadDigest } from '@kernel/kernel/sync-read-snapshot.js';

import { derivedCompositionRoots, siblingRepoRoot } from '../helpers/sibling-repos.js';

/**
 * 事实源翻转后（invert-split-fact-source，双实例判例）：content 仓的编解码器在**它自己的宇宙**里
 * 经包说明符解析 kernel —— 即 content 仓 node_modules 里装的 aidcp-kernel dist。按引用断言
 * 必须装载**同一份**模块实例，否则「kernel 源码那份 ≠ content 装到的那份」会被误读成第二实现。
 * realpath 是必要的：Node 按 realpath 缓存 ESM 模块，路径带 symlink 时会拿到第二个实例。
 */
async function contentKernelPersonaParse(): Promise<{
  parsePersonaSoulValue: unknown;
  parsePersonaSoulYaml: unknown;
}> {
  const dist = realpathSync(
    join(
      siblingRepoRoot('aidcp-content'),
      'node_modules',
      'aidcp-kernel',
      'dist',
      'kernel',
      'persona-soul-parse.js',
    ),
  );
  return (await import(pathToFileURL(dist).href)) as {
    parsePersonaSoulValue: unknown;
    parsePersonaSoulYaml: unknown;
  };
}

/**
 * 摘要基准人设：**刻意带上 api 段自管的三个字段**（engagement_rules /
 * mandatory_interactions / browse_patterns）。当初两侧分叉正是分在这里 ——
 * 闭子集解析把它们丢掉，通用装载器把它们留下，同一份文本于是解出两种结构。
 */
const REFERENCE_PERSONA = [
  'identity:',
  '  name: "小林"',
  '  role: "美食博主"',
  '  background: "在上海开过三年小面馆"',
  '  tone: "松弛、口语"',
  'writing_language: "zh-CN"',
  'interests:',
  '  primary:',
  '    - "家常菜"',
  '  secondary:',
  '    - "厨具"',
  '  seed_keywords:',
  '    - "一人食"',
  'behavior_guidelines:',
  '  style: "短句"',
  '  privacy: "不谈住址"',
  '  collection_principle: "只收自己做过的"',
  '  like_principle: "真觉得好才点"',
  '  like_affinity: "like_more"',
  'engagement_rules:',
  '  like:',
  '    - "家常菜"',
  '  skip:',
  '    - "营销号"',
  '  comment_trigger:',
  '    - "问做法"',
  '',
].join('\n');

/**
 * 同步读 `account_persona` 载荷的摘要基准。**MUST 与派生接口服务仓的同名常量逐字相同**。
 * 改这个值即等于改跨进程契约：同游标发出不同摘要会被消费方整条拒收，
 * 故只有在同批改掉另一侧、且明确要让游标前进时才允许动。
 */
const REFERENCE_PAYLOAD_DIGEST =
  'sha256:4656ea2c31b128c69cf172718b36061c05dbe1e92380072d9b541691ab971b07';

test('AC-PERSONA-PARSE-01 内容段编解码器的解析两方法就是 kernel 那一份（按引用，content 运行时宇宙）', async () => {
  const kernelAsContentResolvesIt = await contentKernelPersonaParse();
  assert.equal(PERSONA_SOUL_CODEC.parseValue, kernelAsContentResolvesIt.parsePersonaSoulValue);
  assert.equal(PERSONA_SOUL_CODEC.parseYaml, kernelAsContentResolvesIt.parsePersonaSoulYaml);
});

test('AC-PERSONA-PARSE-02 同步读取值口只认人设闭子集，api 段自管字段一律不进载荷', () => {
  const soul = parseSyncReadPersonaSoul(REFERENCE_PERSONA);
  assert.ok(soul && typeof soul === 'object' && !Array.isArray(soul));
  assert.deepEqual(Object.keys(soul as Record<string, unknown>), [
    'identity',
    'interests',
    'writing_language',
    'behavior_guidelines',
  ]);
});

test('AC-PERSONA-PARSE-03 解不出来的人设回 null，MUST NOT 抛穿整条快照', () => {
  assert.equal(parseSyncReadPersonaSoul('identity: 不是对象结构'), null);
  assert.equal(parseSyncReadPersonaSoul(''), null);
});

test('AC-PERSONA-PARSE-04 载荷摘要钉死（跨仓同值）', () => {
  const digest = syncReadPayloadDigest({
    accounts: [
      {
        accountId: 'acct-reference',
        personaText: REFERENCE_PERSONA,
        soul: parseSyncReadPersonaSoul(REFERENCE_PERSONA),
      },
    ],
  });
  assert.equal(digest, REFERENCE_PAYLOAD_DIGEST);
});

test('AC-PERSONA-PARSE-05 组装根 MUST 按引用注入，MUST NOT 就地再写一份', () => {
  // 现役落点：account_persona 流的属主是 api，注入点在 api 仓的组装根（5.6 派生根并集判例）。
  const apiRoot = readFileSync(join(siblingRepoRoot('aidcp-api'), 'src', 'server.ts'), 'utf8');
  assert.match(
    apiRoot,
    /parseSoul:\s*parseSyncReadPersonaSoul,/,
    'api 组装根必须直接把 kernel 那一份传下去',
  );
  // 负向面扫全部派生组装根：任何一个根就地再写一份 parseSoul，就是当初分叉的形态。
  for (const root of derivedCompositionRoots()) {
    assert.doesNotMatch(
      readFileSync(root.path, 'utf8'),
      /parseSoul:\s*(?:\(|async|function)/,
      `${root.label} 里出现就地实现的 parseSoul —— 那正是两侧分叉的形态`,
    );
  }
});
