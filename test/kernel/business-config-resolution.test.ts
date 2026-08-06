/**
 * 三个业务配置的「快照 + 账号 → 生效值」纯判定段（change split-cloud-automation-production-runtime 批 E-2 步骤 1）。
 *
 * 为什么要有这一层：拆仓后同一个问题有两个提问方——api 进程按自己的内存镜像问，
 * automation 进程按同步读快照问。判定各写一份的现形方式**不是报错**，
 * 而是两个进程对同一个账号算出不同的生效时段 / 不同的过滤阈值 / 不同的正文来源，而两侧测试都会绿。
 *
 * 故本文件分两半：**行为**（判定本身对不对）+ **结构**（判定只有一份）。
 * 后者守的东西前者一条都守不住，见文末那条用例的注释。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveEffectiveActiveWeekMask,
  resolveEffectiveContentActiveMask,
  resolveEffectiveContentSchedule,
} from '@kernel/kernel/content-schedule-resolution.js';
import {
  DEFAULT_HOT_LEAD_GATE_CONFIG,
  resolveHotLeadGateConfig,
} from '@kernel/kernel/hot-lead-gate-config.js';
import {
  coerceFacebookCommentMode,
  facebookCommentModeFromWire,
  facebookCommentModeToWire,
  resolveEffectiveFacebookCommentConfig,
} from '@kernel/kernel/facebook-comment-config-types.js';

const FULL_MASK = '1'.repeat(168);
const NIGHT_MASK = '0'.repeat(84) + '1'.repeat(84);

/* ─────────────────────────── 内容排期 ─────────────────────────── */

test('无账号行 → 完全不自动，但两条掩码照旧按全局解析', () => {
  const schedule = resolveEffectiveContentSchedule(null, {
    activeWeekMask: FULL_MASK,
    contentActiveMask: NIGHT_MASK,
  });
  assert.equal(schedule.autoEnabled, false);
  assert.equal(schedule.postMode, 'off');
  assert.equal(schedule.postEnabled, false);
  assert.equal(schedule.postDailyCap, 0);
  // 「这个账号没配排期」MUST NOT 连带把全局时段也答成缺失。
  assert.equal(schedule.effectiveActiveWeekMask, FULL_MASK);
  assert.equal(schedule.effectiveMask, NIGHT_MASK);
});

test('活跃掩码：脏覆盖视作缺失并回落全局，绝不因坏值绕过更严格的全局闸', () => {
  assert.equal(resolveEffectiveActiveWeekMask('1010', NIGHT_MASK), NIGHT_MASK);
  assert.equal(resolveEffectiveActiveWeekMask(FULL_MASK, NIGHT_MASK), FULL_MASK);
  // 全局本身脏 → 也不作数（null = 全周活跃由调用方另行 fail-closed）。
  assert.equal(resolveEffectiveActiveWeekMask(null, 'garbage'), null);
});

test('内容掩码与活跃掩码**不同口径**：脏非空值原样透传，交调度器 fail-closed 校验', () => {
  // 这条刻意与上一条相反。两者被「统一」掉过一次就会让脏值静静变成全局值，
  // 而全局值可能比运营配错的那串更宽松。
  assert.equal(resolveEffectiveContentActiveMask('garbage', FULL_MASK), 'garbage');
  assert.equal(resolveEffectiveContentActiveMask(null, FULL_MASK), FULL_MASK);
  assert.equal(resolveEffectiveContentActiveMask(null, null), null);
});

test('动作开关恒由模式算出，不另收一个可能漂开的 enabled 字段', () => {
  const schedule = resolveEffectiveContentSchedule(
    {
      autoEnabled: true,
      postMode: 'auto_approve',
      postDailyCap: 3,
      commentMode: 'review',
      commentDailyCap: 5,
      contactCommentMode: 'off',
      contactCommentDailyCap: 2,
      activeWeekMask: null,
      contentActiveMask: null,
    },
    { activeWeekMask: null, contentActiveMask: null },
  );
  assert.equal(schedule.postEnabled, true);
  assert.equal(schedule.commentEnabled, true);
  // 模式关着但日上限非 0：开关必须答「关」，别被上限带跑。
  assert.equal(schedule.contactCommentEnabled, false);
  assert.equal(schedule.contactCommentDailyCap, 2);
});

/* ─────────────────────────── 热帖过滤闸 ─────────────────────────── */

test('热帖阈值：缺行 / 0 / 负数 / 非整数一律逐项回落写死默认，且 floorHours 永不可配', () => {
  assert.deepEqual(resolveHotLeadGateConfig(null), DEFAULT_HOT_LEAD_GATE_CONFIG);
  const partial = resolveHotLeadGateConfig({
    postAgeMaxHours: 0, // 0 视作缺
    velocityMin: '120', // 字符串数字合法
    minLikeFloor: 1.5, // 非整数视作缺
  });
  assert.equal(partial.maxAgeHours, DEFAULT_HOT_LEAD_GATE_CONFIG.maxAgeHours);
  assert.equal(partial.velocityMin, 120);
  assert.equal(partial.minLikeFloor, DEFAULT_HOT_LEAD_GATE_CONFIG.minLikeFloor);
  assert.equal(partial.floorHours, DEFAULT_HOT_LEAD_GATE_CONFIG.floorHours);
});

/* ─────────────────────── Facebook 评论正文来源 ─────────────────────── */

test('未显式配过正文模式 → 一律按模板，绝不因列默认值替运营选了生成式', () => {
  assert.equal(resolveEffectiveFacebookCommentConfig(null).commentMode, 'template');
  const unconfigured = resolveEffectiveFacebookCommentConfig({
    keywords: [],
    containers: [],
    commentMode: 'generated',
    commentModeConfigured: false,
    commentTemplates: [],
  });
  assert.equal(unconfigured.commentMode, 'template');
  const configured = resolveEffectiveFacebookCommentConfig({
    keywords: ['a'],
    containers: [{ url: 'u' }],
    commentMode: 'generated',
    commentModeConfigured: true,
    commentTemplates: [],
  });
  assert.equal(configured.commentMode, 'generated');
});

test('线缆写法与领域写法是**不同字面量**，跨进程消费方必须经具名出口还原', () => {
  // 这条钉的是一个不会报错的坑：快照上写的是复数 templates，领域类型是单数 template。
  // 消费方顺手写 `mode === 'template'` 恒 false，结果不是崩溃，
  // 而是运营配好的模板被静静换成 AI 生成正文。
  assert.equal(facebookCommentModeToWire('template'), 'templates');
  assert.notEqual(facebookCommentModeToWire('template'), 'template');
  assert.equal(facebookCommentModeFromWire('templates'), 'template');
  assert.equal(facebookCommentModeFromWire('generated'), 'generated');
  // 两个方向往返恒等。
  for (const mode of ['generated', 'template'] as const) {
    assert.equal(facebookCommentModeFromWire(facebookCommentModeToWire(mode)), mode);
  }
  // 库列只认单数；其余一切（含复数线缆写法）都是生成式。
  assert.equal(coerceFacebookCommentMode('template'), 'template');
  assert.equal(coerceFacebookCommentMode('templates'), 'generated');
  assert.equal(coerceFacebookCommentMode(undefined), 'generated');
});

/* ─────────────────────────── 结构：只许一份 ─────────────────────────── */

/**
 * 三个判定各自只许有一份：**每个取数口的方法体 MUST 真的调到 kernel 那个符号**。
 *
 * **这条守的东西，上面所有行为用例一条都守不住**：第二份副本在写出来那一刻行为完全一致，
 * 要等两份漂开、且恰好在该判准的那一刻才现形。本 change 已实测过三次同一形态
 * （出口闸豁免名单 / 失败映射表 / 注册表准入闸），三次都是行为用例全绿、只有结构断言红。
 *
 * ⚠️ **判据刻意不是「文件里没有同名的本地定义」**——那一版本文件写过、当场被变异绕过：
 * 把本地副本改名成 `localResolveEffectiveContentActiveMask` 就躲开了同名检查，
 * 8 条用例与 typecheck 全绿。真正管用的是**正向**判据：调用点必须落在 kernel 那个符号上，
 * 且按词边界匹配，任何改名的第二份都进不了这个位置。**别当冗余删掉。**
 */
test('三个业务配置的生效判定只有一份：每个取数口都真的委托给 kernel 那个符号', async () => {
  const { readFile } = await import('node:fs/promises');
  // 事实源翻转后按属主仓现读：kernel/** 在 aidcp-kernel，config/** 归 api。
  const { ownedSourcePath } = await import('../helpers/sibling-repos.js');
  const read = (path: string) =>
    readFile(ownedSourcePath(path.startsWith('kernel/') ? 'kernel' : 'api', path), 'utf8');

  /** 取出类方法体（2 空格缩进的类成员，到同缩进的收尾大括号为止）。 */
  const methodBody = (source: string, method: string): string => {
    const start = source.search(new RegExp(`^  ${method}\\(`, 'm'));
    assert.notEqual(start, -1, `找不到取数口 ${method}`);
    const rest = source.slice(start);
    const end = rest.search(/^  \}/m);
    assert.notEqual(end, -1, `${method} 的方法体没有收尾`);
    return rest.slice(0, end);
  };

  const kernelModules = {
    schedule: 'kernel/content-schedule-resolution.ts',
    hotLead: 'kernel/hot-lead-gate-config.ts',
    facebookComment: 'kernel/facebook-comment-config-types.ts',
  } as const;

  // ① kernel 那一份 MUST 是唯一定义处。
  const definitions: Record<keyof typeof kernelModules, readonly string[]> = {
    schedule: [
      'resolveEffectiveContentSchedule',
      'resolveEffectiveActiveWeekMask',
      'resolveEffectiveContentActiveMask',
    ],
    hotLead: ['resolveHotLeadGateConfig', 'hotLeadOverrideValue'],
    facebookComment: [
      'resolveEffectiveFacebookCommentConfig',
      'coerceFacebookCommentMode',
      'facebookCommentModeToWire',
      'facebookCommentModeFromWire',
    ],
  };
  for (const [key, symbols] of Object.entries(definitions)) {
    const source = await read(kernelModules[key as keyof typeof kernelModules]);
    for (const symbol of symbols) {
      assert.match(
        source,
        new RegExp(`export function ${symbol}\\b`),
        `${kernelModules[key as keyof typeof kernelModules]} MUST 是 ${symbol} 的唯一定义处`,
      );
    }
  }

  // ② 每个取数口的方法体 MUST 落在 kernel 那个符号上（正向判据，改名的第二份进不来）。
  const delegations: ReadonlyArray<{
    file: string;
    method: string;
    symbol: string;
  }> = [
    {
      file: 'config/content-schedule-store.ts',
      method: 'effectiveScheduleFor',
      symbol: 'resolveEffectiveContentSchedule',
    },
    {
      file: 'config/content-schedule-store.ts',
      method: 'effectiveActiveWeekMaskFor',
      symbol: 'resolveEffectiveActiveWeekMask',
    },
    {
      file: 'config/content-schedule-store.ts',
      method: 'effectiveContentActiveMaskFor',
      symbol: 'resolveEffectiveContentActiveMask',
    },
    {
      file: 'config/hot-lead-config-store.ts',
      method: 'getGateConfig',
      symbol: 'resolveHotLeadGateConfig',
    },
    {
      file: 'config/facebook-comment-config-store.ts',
      method: 'effectiveConfigFor',
      symbol: 'resolveEffectiveFacebookCommentConfig',
    },
  ];
  for (const { file, method, symbol } of delegations) {
    const body = methodBody(await read(file), method);
    assert.match(
      body,
      new RegExp(`\\b${symbol}\\s*\\(`),
      `${file} 的 ${method} 没有调到 kernel 的 ${symbol} —— 那意味着这里又有了第二份判定，`
        + '它在写出来当天与 kernel 那份完全等价，只有某一份被改过才看得出对不上',
    );
  }

  // ③ 快照发布方：两条判定都 MUST 经 kernel 出口，且不得就地写线缆字面量或回落默认值。
  const publisher = await read('config/api-sync-read-source.ts');
  for (const symbol of ['resolveHotLeadGateConfig', 'facebookCommentModeToWire']) {
    assert.match(
      publisher,
      new RegExp(`\\b${symbol}\\s*\\(`),
      `api-sync-read-source.ts MUST 经 ${symbol} 发布，不得自带一份判定`,
    );
  }
  assert.doesNotMatch(
    publisher,
    /'templates'/,
    'api-sync-read-source.ts 里出现了线缆字面量 templates —— MUST 经 facebookCommentModeToWire 出口',
  );
  // 回落默认值只许在 kernel 那份判定里读到：发布方一旦碰它，就说明它又在本地拼一份生效值。
  assert.doesNotMatch(
    publisher,
    /\bDEFAULT_HOT_LEAD_GATE_CONFIG\b/,
    'api-sync-read-source.ts 直接读了回落默认值 —— 那是第二份逐项回落判定的形态',
  );
});
