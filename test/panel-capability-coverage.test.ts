import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_CAPABILITY_KEYS,
  findPanelCapabilityCoverageProblems,
  type PanelCapabilityAbsences,
} from '../src/panel/capability-coverage.js';

/**
 * 这道闸的**唯一**存在理由是「少装一项要当场炸」。所以用例必须先喂违规输入——
 * 只跑全对路径的闸，跑绿了也没人能证明它还在。
 */

const allWired = new Set<string>(PANEL_CAPABILITY_KEYS);

test('全装上、无缺席声明 ⇒ 无问题', () => {
  assert.deepEqual(findPanelCapabilityCoverageProblems(allWired, {}), []);
});

test('少装一项且未具名 ⇒ 指名报 unwired', () => {
  const wired = new Set(allWired);
  wired.delete('modelConfig');
  const problems = findPanelCapabilityCoverageProblems(wired, {});
  assert.deepEqual(problems, [{ key: 'modelConfig', kind: 'unwired' }]);
});

test('少装多项 ⇒ 逐条列全，不止报第一条', () => {
  const wired = new Set(allWired);
  wired.delete('modelConfig');
  wired.delete('roleConfig');
  wired.delete('tokenUsage');
  const problems = findPanelCapabilityCoverageProblems(wired, {});
  assert.deepEqual(
    problems.map((p) => p.key).sort(),
    ['modelConfig', 'roleConfig', 'tokenUsage'],
  );
});

test('少装但已具名并写了理由 ⇒ 放行', () => {
  const wired = new Set(allWired);
  wired.delete('rolePromptPreview');
  const absences: PanelCapabilityAbsences = {
    rolePromptPreview: '预览渲染闭包在内容域，本进程不提供；后台角色页的提示词预览会显示不可用。',
  };
  assert.deepEqual(findPanelCapabilityCoverageProblems(wired, absences), []);
});

test('具名了但理由是空串 ⇒ 报 empty_reason（空理由等于没写）', () => {
  const wired = new Set(allWired);
  wired.delete('rolePromptPreview');
  for (const blank of ['', '   ']) {
    const problems = findPanelCapabilityCoverageProblems(wired, { rolePromptPreview: blank });
    assert.deepEqual(problems, [{ key: 'rolePromptPreview', kind: 'empty_reason' }]);
  }
});

test('已装上却仍留在缺席表里 ⇒ 报 stale_absence（缺席表是棘轮，不许留骗人的条目）', () => {
  const problems = findPanelCapabilityCoverageProblems(allWired, {
    modelConfig: '早先没装，后来装上了但忘了删这条',
  });
  assert.deepEqual(problems, [{ key: 'modelConfig', kind: 'stale_absence' }]);
});

test('名册覆盖本次事故里全部漏装项', () => {
  // 2026-08-05 dev 实测出的缺口（含两项不走路由、连 503 都不会给的静默缺失）。
  // 名册漏掉其中任何一项，这道闸就抓不到同类复发。
  const observedGap = [
    'modelConfig',
    'roleConfig',
    'categoryConfig',
    'rolePromptPreview',
    'hotLeadConfig',
    'facebookGroupCommentPolicy',
    'interactionPermissions',
    'tokenUsage',
    'billingPriceRefresh',
    'curatedContent',
    'curatedActions',
    'captchaAssist',
    'facebookPublishMedia',
    'publishDraft',
    'preflightApprovePublish',
    'publishDispatcher',
    'notifyPublishPreviewChanged',
    'onClientOffboardCreated',
    'interactionInternalApi',
    'configMirrorHealth',
    'botChats',
  ] as const;
  for (const key of observedGap) {
    assert.ok(
      (PANEL_CAPABILITY_KEYS as readonly string[]).includes(key),
      `名册缺 ${key}：这道闸对该项的漏装将完全无感`,
    );
  }
});
