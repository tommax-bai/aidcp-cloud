import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostImageFormProfileService } from '../../src/publish-agent/post-image-form-profile.js';
import type { CoverFormSenseRef, CoverFormSenseResult } from '../../src/publish-agent/cover-form-sensor.js';
import type { ReferenceImageSnapshot } from '../../src/publish-agent/types.js';
import type { CuratedReferenceImageFormGuess } from '../../src/cache/curated-content-store.js';

function img(over: Partial<ReferenceImageSnapshot> = {}): ReferenceImageSnapshot {
  return {
    index: 0,
    sourceUrl: 'https://img.test/s.jpg',
    ossUrl: 'https://oss.test/c.jpg',
    captureStatus: 'stored',
    capturedAt: 1_700_000_000_000,
    ...over,
  };
}

function makeRef(images: ReferenceImageSnapshot[]): CoverFormSenseRef {
  return { curatedContentId: 1, accountId: 'a', sourceId: 'n', images };
}

function detected(form: CuratedReferenceImageFormGuess['form'], confidence: number, cached = false): CoverFormSenseResult {
  return {
    status: 'detected',
    cached,
    guess: { form, confidence, detectedAt: 1, detectedFor: 1, model: 'm', provider: 'p' },
  };
}

/** senseAt 假实现：按 index→结果映射返回，记录调用数与实时并发峰值。 */
function fakeSenseAt(byIndex: Record<number, CoverFormSenseResult>, opts: { delayMs?: number } = {}) {
  const calls: number[] = [];
  let active = 0;
  let maxActive = 0;
  const senseAt = async (_ref: CoverFormSenseRef, arrayIndex: number): Promise<CoverFormSenseResult> => {
    calls.push(arrayIndex);
    active++;
    maxActive = Math.max(maxActive, active);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    active--;
    return byIndex[arrayIndex] ?? { status: 'error', cached: false };
  };
  return { senseAt, calls, get maxActive() { return maxActive; } };
}

test('封面非文字卡 → generative，零内页判定调用', async () => {
  const fake = fakeSenseAt({});
  const svc = createPostImageFormProfileService({ senseAt: fake.senseAt, enabled: () => true });
  const out = await svc.compute({
    ref: makeRef([img(), img(), img()]),
    coverSense: detected('photo', 0.95),
  });
  assert.equal(out.profile, 'generative');
  assert.equal(out.gateReason, 'generative_cover_not_card');
  assert.equal(out.innerSensed, 0);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(out.perImageForms, [{ index: 0, form: 'photo', source: 'vision' }]);
});

test('纯文字卡轮播（封面 + 全内页高置信文字卡）→ all_text_card', async () => {
  const fake = fakeSenseAt({ 1: detected('text_card', 0.9), 2: detected('text_card', 0.88, true) });
  const svc = createPostImageFormProfileService({ senseAt: fake.senseAt, enabled: () => true });
  const out = await svc.compute({
    ref: makeRef([img(), img(), img()]),
    coverSense: detected('text_card', 0.95),
  });
  assert.equal(out.profile, 'all_text_card');
  assert.equal(out.gateReason, 'all_text_card');
  assert.equal(out.innerSensed, 2);
  assert.deepEqual(out.perImageForms, [
    { index: 0, form: 'text_card', source: 'vision' },
    { index: 1, form: 'text_card', source: 'vision' },
    { index: 2, form: 'text_card', source: 'cached' },
  ]);
});

test('混合源（封面卡 + 某内页照片）→ card_cover / downgrade_inner_not_unanimous，绝不猜全卡', async () => {
  const fake = fakeSenseAt({ 1: detected('text_card', 0.9), 2: detected('photo', 0.92) });
  const svc = createPostImageFormProfileService({ senseAt: fake.senseAt, enabled: () => true });
  const out = await svc.compute({
    ref: makeRef([img(), img(), img()]),
    coverSense: detected('text_card', 0.95),
  });
  assert.equal(out.profile, 'card_cover');
  assert.equal(out.gateReason, 'downgrade_inner_not_unanimous');
});

test('内页出错/低置信 → card_cover / downgrade_unknown_or_error（不确定一律降级）', async () => {
  const fake = fakeSenseAt({ 1: detected('text_card', 0.9), 2: { status: 'error', cached: false } });
  const svc = createPostImageFormProfileService({ senseAt: fake.senseAt, enabled: () => true });
  const out = await svc.compute({
    ref: makeRef([img(), img(), img()]),
    coverSense: detected('text_card', 0.95),
  });
  assert.equal(out.profile, 'card_cover');
  assert.equal(out.gateReason, 'downgrade_unknown_or_error');

  // 低置信文字卡同样不算「高置信文字卡」→ 降级 unknown_or_error。
  const fake2 = fakeSenseAt({ 1: detected('text_card', 0.5) });
  const svc2 = createPostImageFormProfileService({ senseAt: fake2.senseAt, enabled: () => true });
  const out2 = await svc2.compute({ ref: makeRef([img(), img()]), coverSense: detected('text_card', 0.95) });
  assert.equal(out2.profile, 'card_cover');
  assert.equal(out2.gateReason, 'downgrade_unknown_or_error');
});

test('超上限 K → card_cover / downgrade_over_cap，零内页判定（不多判不瞎猜）', async () => {
  const fake = fakeSenseAt({ 1: detected('text_card', 0.9), 2: detected('text_card', 0.9) });
  const svc = createPostImageFormProfileService({ senseAt: fake.senseAt, enabled: () => true, cap: 2 });
  const out = await svc.compute({
    ref: makeRef([img(), img(), img()]), // 3 usable > cap 2
    coverSense: detected('text_card', 0.95),
  });
  assert.equal(out.profile, 'card_cover');
  assert.equal(out.gateReason, 'downgrade_over_cap');
  assert.equal(fake.calls.length, 0);
});

test('单张文字卡封面（无内页）→ all_text_card（空内页 vacuous），innerSensed=0', async () => {
  const fake = fakeSenseAt({});
  const svc = createPostImageFormProfileService({ senseAt: fake.senseAt, enabled: () => true });
  const out = await svc.compute({ ref: makeRef([img()]), coverSense: detected('text_card', 0.9) });
  assert.equal(out.profile, 'all_text_card');
  assert.equal(out.innerSensed, 0);
  assert.equal(fake.calls.length, 0);
});

test('内页判定并发有界 + senseAt 抛错被兜底（不炸发布）', async () => {
  const byIndex: Record<number, CoverFormSenseResult> = {
    1: detected('text_card', 0.9),
    2: detected('text_card', 0.9),
    3: detected('text_card', 0.9),
    4: detected('text_card', 0.9),
  };
  const fake = fakeSenseAt(byIndex, { delayMs: 5 });
  const throwing = async (ref: CoverFormSenseRef, i: number): Promise<CoverFormSenseResult> => {
    if (i === 3) throw new Error('boom');
    return fake.senseAt(ref, i);
  };
  const svc = createPostImageFormProfileService({ senseAt: throwing, enabled: () => true, concurrency: 2 });
  const out = await svc.compute({
    ref: makeRef([img(), img(), img(), img(), img()]),
    coverSense: detected('text_card', 0.95),
  });
  // index 3 抛错被当 error → 不再是全卡 → 降级（不抛、不猜全卡）。
  assert.equal(out.profile, 'card_cover');
  assert.equal(out.gateReason, 'downgrade_unknown_or_error');
  assert.ok(fake.maxActive <= 2, `并发应 ≤2，实测 ${fake.maxActive}`);
  assert.equal(out.innerSensed, 4);
});

test('旗标关 → enabled() 反映为 false（消费端据此不调 compute）', () => {
  const fake = fakeSenseAt({});
  const svc = createPostImageFormProfileService({ senseAt: fake.senseAt, enabled: () => false });
  assert.equal(svc.enabled(), false);
});
