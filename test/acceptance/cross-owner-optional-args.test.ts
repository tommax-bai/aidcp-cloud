/**
 * 跨属主可选实参的静默缺席（change split-cloud-automation-production-runtime · task 2.7）。
 *
 * 这一类问题的形状是固定的：某个能力经**可选**参数 / 可选方法注入，单体里那个实参恒被传，
 * 于是 `undefined` 分支**生产上从未执行过**；拆进程之后漏接一次，能力就悄悄消失，
 * 而调用方一路拿到看起来正常的结果。现有测试永远覆盖不到它，因为在单体里它不可能发生。
 *
 * 四层的处置各不相同，这里只钉那些**可以在本仓跑**的那部分：
 *   ① 转写器句柄 —— 由 `text-card-transcription-absence.test.ts` 的 AC-TCT-3 覆盖（缺席必须具名留痕）。
 *   ② Sink 的三个方法 —— 0.6d 已把 `?` 全删；本文件用类型级断言钉住它不许回来。
 *   ③ `CoverFormSensor.senseAt` —— 本 task 删 `?`；本文件钉「不许回来」+ 两个调用点不许再兜底。
 *   ④ `ContentRoleOptions` 的人设两选一 —— 检查提到构造期，行为用例在
 *      `test/agents/content-role-soul-contract.test.ts`（它只依赖 automation + kernel，
 *      要跟着角色进 automation 仓才有意义，故不放这里）。
 *   ⑤（校准样本）`PublishDispatcher` 的素材端口 —— 2.4d 已补计数 + 具名 error，
 *      两个方向都在 `publish-dispatcher.test.ts` 里，不重复。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import type { CuratedNoteSink } from '@automation/agents/curated-note-evaluator.js';
import {
  createCoverFormSensor,
  type CoverFormSensor,
} from '@content/publish-agent/cover-form-sensor.js';

import { ownedSourcePath } from '../helpers/sibling-repos.js';

/** T 上**必选**键的集合：可选键映射成 never 被过滤掉。 */
type RequiredKeysOf<T> = {
  // eslint-disable-next-line @typescript-eslint/ban-types
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

/** 双向 extends：只有两个键集完全相同才是 true，少一个或多一个都编译红。 */
type AssertSameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// ── ② 与 ③ 的类型级闸：任一方法重新变成可选，下面两行当场编译失败 ──────────────────────
// 类型级比源码文本可靠得多：它认的是「这个键在类型上是不是可选」，
// 不会被换行、重命名、加注释这些无关改动骗过，也不会因为改了写法而假红。
const CURATED_SINK_ALL_REQUIRED: AssertSameKeys<RequiredKeysOf<CuratedNoteSink>, keyof CuratedNoteSink> = true;
const COVER_FORM_SENSOR_ALL_REQUIRED: AssertSameKeys<RequiredKeysOf<CoverFormSensor>, keyof CoverFormSensor> = true;

test('AC-XOPT-1：判形口两个方法都必选，且真实实现两个都给', () => {
  assert.equal(CURATED_SINK_ALL_REQUIRED, true);
  assert.equal(COVER_FORM_SENSOR_ALL_REQUIRED, true);

  // 类型闸挡不住 `as unknown as CoverFormSensor` 这类强转，所以再问一次真实产物。
  const sensor = createCoverFormSensor({
    vision: { chatVision: async () => '{}' },
    enabled: () => false,
    getModel: () => 'm',
    getProvider: () => 'dashscope',
  });
  assert.equal(typeof sensor.sense, 'function');
  assert.equal(typeof sensor.senseAt, 'function');
});

test('AC-XOPT-2：两个调用点不得再给 senseAt 兜底或非空断言', async () => {
  const transcriber = await readFile(
    ownedSourcePath('content', 'publish-agent/text-card-transcriber.ts'),
    'utf8',
  );
  // 曾经的写法：`deps.formSensor.senseAt ? await … : { status: 'error', … }`。
  // 后果不是报错 —— 是每张图都判成错误态、一张文字卡都选不出、产出恒空且不抛不告警。
  assert.ok(
    !/formSensor\.senseAt\s*\n?\s*\?/.test(transcriber),
    '转写器不得再对 senseAt 做在场判断：缺席应当是编译期错误，不是一次静默的空产出',
  );
  assert.ok(
    !transcriber.includes('senseAt unavailable'),
    '那个兜底错误态是缺席的伪装，不得回来',
  );

  // 事实源翻转后（invert-split-fact-source 5.6 re-anchor）：转写链的属主组装根在
  // aidcp-content 的 src/server.ts —— 单体那份已冻结、不再部署，读它等于读死照片。
  const server = await readFile(ownedSourcePath('content', 'server.ts'), 'utf8');
  // 曾经的写法是用非空断言把「接口上可选」硬撑过去，缺席即运行时 TypeError，而不是编译期就说清楚。
  // ⚠️ 源码扫描**连注释一起扫**：这一条第一次跑就被组装根里一句复述该写法的注释判红。
  // 所以被禁的写法在这里只出现一次（就是下面那个 includes 的实参），别在任何注释里复述它。
  assert.ok(
    !server.includes('senseAt!('),
    '组装根不得用非空断言撑住 senseAt：那是把编译期能发现的事推到运行时',
  );
  assert.ok(
    server.includes('coverFormSensor.senseAt(ref, arrayIndex)'),
    '帖级形态档服务仍须真的接上判形口（这半边掉了，上面那条只会一片安静地通过）',
  );
});
