/**
 * change session-auto-resume-with-excursions — 发布让位回调（task 4.5）。
 * 验证 PublishOrchestrator.trigger()：真正开始 → onPublishStart(accountId)；
 * 走完任一终止路径 → finally → onPublishEnd(accountId)；被忽略的触发（已 running）不调 start/end。
 * 自包含：用 duck-typed stub 角色经 scoutDecision 短路收尾，不依赖完整发布管线（规避并发多图 WIP）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PublishOrchestrator } from '../../src/publish-agent/publish-orchestrator.js';
import type { BasePublishRole } from '../../src/publish-agent/roles/base-role.js';
import type { TriggerInput } from '../../src/publish-agent/types.js';

const silent = { log() {}, warn() {}, error() {} };

/** 经 scoutDecision.shouldPublish=false 立即短路（早期终止路径）。同步写，使并发双触发判定确定。 */
function stubShortCircuitScout(): BasePublishRole<unknown, unknown> {
  return {
    register(context: { watch: (k: string, cb: () => void, o?: unknown) => void; write: (k: string, v: unknown) => void }) {
      context.watch('trigger', () => {
        context.write('scoutDecision', { shouldPublish: false, reason: 'test-short-circuit' });
      }, { once: true });
    },
  } as unknown as BasePublishRole<unknown, unknown>;
}

function makeTrigger(accountId?: string): TriggerInput {
  return (accountId !== undefined ? { accountId } : {}) as unknown as TriggerInput;
}

describe('PublishOrchestrator 发布让位回调', () => {
  test('trigger → onPublishStart(accountId) 然后 onPublishEnd(accountId)', async () => {
    const starts: string[] = [];
    const ends: string[] = [];
    const orch = new PublishOrchestrator({
      logger: silent,
      idGen: () => 'run1',
      onPublishStart: (a) => starts.push(a),
      onPublishEnd: (a) => ends.push(a),
    });
    orch.registerRole(stubShortCircuitScout());

    const res = await orch.trigger(makeTrigger('acct-1'));
    assert.equal(res.status, 'skipped', 'scout 短路 → skipped');
    assert.deepEqual(starts, ['acct-1'], '发布开始 → onPublishStart(真实账号)');
    assert.deepEqual(ends, ['acct-1'], '发布结束（含跳过路径）→ onPublishEnd(真实账号)');
  });

  test('accountId 缺省回落 default', async () => {
    const starts: string[] = [];
    const ends: string[] = [];
    const orch = new PublishOrchestrator({
      logger: silent,
      idGen: () => 'run2',
      onPublishStart: (a) => starts.push(a),
      onPublishEnd: (a) => ends.push(a),
    });
    orch.registerRole(stubShortCircuitScout());

    await orch.trigger(makeTrigger());
    assert.deepEqual(starts, ['default']);
    assert.deepEqual(ends, ['default']);
  });

  test('被忽略的触发（已 running）不调 onPublishStart/onPublishEnd', async () => {
    const starts: string[] = [];
    const ends: string[] = [];
    const orch = new PublishOrchestrator({
      logger: silent,
      idGen: () => 'run3',
      onPublishStart: (a) => starts.push(a),
      onPublishEnd: (a) => ends.push(a),
    });
    orch.registerRole(stubShortCircuitScout());

    // p1 同步占住 status='running'（await 前）；p2 同步触发 → 早退 skipped、不 arm。
    const p1 = orch.trigger(makeTrigger('acct-1'));
    const p2 = orch.trigger(makeTrigger('acct-1'));
    const [, r2] = await Promise.all([p1, p2]);

    assert.equal(r2.status, 'skipped', '第二次触发被忽略 → skipped');
    assert.deepEqual(starts, ['acct-1'], 'onPublishStart 只对真正开始的那次调一次');
    assert.deepEqual(ends, ['acct-1'], 'onPublishEnd 只对真正开始的那次调一次（被忽略触发不调）');
  });
});
