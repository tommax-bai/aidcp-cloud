import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptchaCoordinator } from '../src/comm/captcha-coordinator.js';
import { FB_THROTTLE_PHRASES, isFacebookThrottleText } from '../src/comm/facebook-throttle-signals.js';
import { RiskController } from '../src/risk/index.js';
import type { RiskQuotaLevel, RiskState, RiskStatus } from '../src/risk/index.js';
import type { CaptchaDetectedPayload } from '../src/comm/protocol.js';

// change account-nurture-discipline-spine §3：FB 软阻断/限流浮层 → 激进退避（restricted）。
// 纯云端、复用既有 CaptchaDetectedPayload/overlay.text、不改协议。

const NOW = 1_000_000_000_000;

const state = (status: RiskStatus, quotaLevel: RiskQuotaLevel): RiskState => ({
  accountId: 'a',
  status,
  quotaLevel,
  signalCount: 0,
  lastSignalAt: null,
  statusSince: 0,
  updatedAt: 0,
});

test('isFacebookThrottleText：命中 FB 限流文案（大小写/智能引号/多空格无关）', () => {
  assert.equal(isFacebookThrottleText('Action Blocked'), true);
  assert.equal(isFacebookThrottleText('We limit how often you can do this.'), true);
  assert.equal(isFacebookThrottleText("You can't use this feature right now"), true);
  assert.equal(isFacebookThrottleText('You’re temporarily blocked'), true); // 智能引号
  assert.equal(isFacebookThrottleText('It looks like you were misusing this feature'), true);
  assert.equal(isFacebookThrottleText('你暂时无法使用此功能'), true);
  assert.equal(isFacebookThrottleText('ACTION   BLOCKED'), true); // 多空格 + 大写
});

test('isFacebookThrottleText：非限流文案与空值 → false（不臆断）', () => {
  assert.equal(isFacebookThrottleText('请完成拼图验证'), false);
  assert.equal(isFacebookThrottleText('Log in to continue'), false);
  assert.equal(isFacebookThrottleText(''), false);
  assert.equal(isFacebookThrottleText(undefined), false);
  assert.equal(isFacebookThrottleText(null), false);
});

test('词库非空且均为归一化小写（无撇号）', () => {
  assert.ok(FB_THROTTLE_PHRASES.length > 0);
  for (const p of FB_THROTTLE_PHRASES) {
    assert.equal(p, p.toLowerCase());
    assert.ok(!p.includes("'"), `phrase 含撇号未归一: ${p}`);
  }
});

function makeCoordinator(controller: RiskController): CaptchaCoordinator {
  return new CaptchaCoordinator({
    resolveController: async () => controller,
    resolveChatId: async () => '',
    logger: { error() {}, warn() {}, log() {} },
    clock: () => NOW,
  });
}

const detected = (over: Partial<CaptchaDetectedPayload>): CaptchaDetectedPayload => ({
  kind: 'unknown',
  accountId: 'a',
  ...over,
});

const overlay = (text: string) => ({ kind: 'unknown' as const, capturedAt: NOW, text, candidates: [] });

test('协调器：unknown 阻断 + FB 限流文案 → 升级 restricted（激进退避）', async () => {
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const coord = makeCoordinator(controller);
  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay("You can't use this feature right now") }),
    { edgeId: 'e', accountId: 'a' } as never,
  );
  assert.equal(controller.getState().status, 'restricted');
});

test('协调器：unknown 阻断 + 非限流文案 → 仍 warned（回归护栏，不误升级）', async () => {
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const coord = makeCoordinator(controller);
  await coord.onDetected(
    detected({ kind: 'unknown', overlay: overlay('请完成拼图验证') }),
    { edgeId: 'e', accountId: 'a' } as never,
  );
  assert.equal(controller.getState().status, 'warned');
});

test('协调器：kind=captcha → restricted（既有行为不变）', async () => {
  const controller = new RiskController({ initialState: state('normal', 'normal'), clock: () => NOW });
  const coord = makeCoordinator(controller);
  await coord.onDetected(detected({ kind: 'captcha' }), { edgeId: 'e', accountId: 'a' } as never);
  assert.equal(controller.getState().status, 'restricted');
});
