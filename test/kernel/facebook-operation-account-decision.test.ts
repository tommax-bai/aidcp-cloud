/**
 * 账号最终模式的纯判定段（change split-cloud-automation-production-runtime 批 G 第四片）。
 *
 * 上一段回答「基线是什么」，这一段回答「叠上慢启动之后按哪个模式跑」。
 * 它必须只有一份的理由很具体：接口进程按属主缓存 + 自己的风控注册表算它，
 * 自动化进程按同步读快照 + 自己的风控注册表算它 —— 输入两套、判定一份。
 * 两份漂开的现形方式不是报错，而是某一侧把还在爬坡的新账号直接按满档跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FACEBOOK_SLOW_START_BLOCKER_PREFIX,
  resolveFacebookOperationAccountDecision,
  resolveFacebookSlowStartFromView,
  type FacebookOperationPolicyBaseProjection,
} from '../../src/kernel/facebook-operation-policy-resolution.js';

const BASE: FacebookOperationPolicyBaseProjection = {
  envKey: 'env-1',
  primarySurface: 'feed',
  surfaceRevision: 2,
  baseMode: 'consumption',
  policyRevision: 9,
  cadenceSource: 'global',
  rule: { viewsPerLike: 5, joinEveryNRounds: 2 },
  consumption: { viewsPerLike: 4, confirmedLikesPerJoin: 3, confirmedJoinsPerComment: 2 },
  reels: {
    persona: { viewsPerLike: 6, viewsPerFollow: 12 },
    slowStart: { viewsPerFollow: 20 },
    rule: { viewsPerFollow: 15 },
    consumption: { viewsPerFollow: 14 },
  },
  updatedAt: null,
  updatedBy: null,
};

const ok = { ok: true as const, ...BASE };

/* ─────────── 慢启动投影 → 解析：`unknown` 与 `off` 不是同一句话 ─────────── */

test('全局停用是确定的「不爬坡」，不算问不到', () => {
  const resolved = resolveFacebookSlowStartFromView({
    state: 'off',
    ineligibleReason: 'globally_disabled',
  });
  assert.equal(resolved.state, 'off');
  assert.equal(resolved.globallyDisabled, true);
});

test('其余不合格原因一律是「问不到」，且原因具名带出去', () => {
  for (const reason of ['binding_unknown', 'platform_unknown', 'platform_unsupported']) {
    const resolved = resolveFacebookSlowStartFromView({ state: 'off', ineligibleReason: reason });
    assert.equal(resolved.state, 'unknown', `${reason} MUST NOT 被压成「不在爬坡」`);
    assert.equal(
      resolved.state === 'unknown' ? resolved.blocker : null,
      `${FACEBOOK_SLOW_START_BLOCKER_PREFIX}${reason}`,
    );
  }
});

/* ─────────── 基线 + 慢启动 → 最终模式 ─────────── */

test('慢启动在跑 → 降到爬坡档；毕业与不在爬坡一律回基线档', () => {
  assert.equal(
    resolveFacebookOperationAccountDecision({
      base: ok,
      slowStart: { state: 'active', since: 1, globallyDisabled: false },
    }).mode,
    'slow_start',
  );
  for (const state of ['graduated', 'off'] as const) {
    assert.equal(
      resolveFacebookOperationAccountDecision({
        base: ok,
        slowStart: { state, since: 1, globallyDisabled: false },
      }).mode,
      'consumption',
      `${state} MUST 回基线档，绝不额外收紧`,
    );
  }
});

test('慢启动问不到 → blocked，但基线字段照实带出（运营要看得见卡在哪个环境）', () => {
  const decision = resolveFacebookOperationAccountDecision({
    base: ok,
    slowStart: {
      state: 'unknown',
      since: null,
      globallyDisabled: false,
      blocker: 'slow_start_binding_unknown',
    },
  });
  assert.equal(decision.mode, 'blocked');
  assert.equal(decision.blocker, 'slow_start_binding_unknown');
  assert.equal(decision.envKey, 'env-1');
  assert.equal(decision.baseMode, 'consumption');
  assert.equal(decision.policyRevision, 9);
});

test('基线拿不到 → 整条 blocked 且字段一律 null —— 半份基线比没有更危险', () => {
  const decision = resolveFacebookOperationAccountDecision({
    base: { ok: false, blocker: 'facebook_operation_policy_unavailable' },
    slowStart: { state: 'active', since: 1, globallyDisabled: false },
  });
  assert.deepEqual(decision, {
    mode: 'blocked',
    primarySurface: null,
    surfaceRevision: null,
    baseMode: null,
    policyRevision: null,
    envKey: null,
    blocker: 'facebook_operation_policy_unavailable',
    rule: null,
    consumption: null,
    reels: null,
  });
});

test('节奏参数是拷贝，调用方改不动属主缓存', () => {
  const decision = resolveFacebookOperationAccountDecision({
    base: ok,
    slowStart: { state: 'off', since: null, globallyDisabled: false },
  });
  decision.reels!.persona.viewsPerLike = 999;
  assert.equal(BASE.reels.persona.viewsPerLike, 6);
});

/* ─────────── 结构：属主 MUST 委托，不许在自己那边再算一遍 ─────────── */

test('接口属主存储的账号决策 MUST 委托到 kernel 那一份，不许自己再实现', () => {
  const source = readFileSync(
    new URL('../../src/config/facebook-operation-policy-store.ts', import.meta.url),
    'utf8',
  );
  const body = source.slice(source.indexOf('async resolveForAccount('));
  const method = body.slice(0, body.indexOf('\n  async ', 1));
  // 正向判据：这个方法体必须调到那个符号。按「没有本地同名定义」写会被改名绕过。
  assert.match(
    method,
    /\bresolveFacebookOperationAccountDecision\s*\(/,
    'resolveForAccount MUST 调 kernel 的账号决策判定',
  );
  // 反向判据：不许在这里就地拼最终模式（那就是第二份实现的样子）。
  assert.equal(
    /['"]slow_start['"]\s*:/.test(method) || /\?\s*['"]slow_start['"]\s*:/.test(method),
    false,
    'MUST NOT 在属主侧就地把 active 映成爬坡档',
  );
});

test('组装根的慢启动映射 MUST 走 kernel 那一份', () => {
  const source = readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
  const at = source.indexOf('bindSlowStartResolver(');
  assert.notEqual(at, -1, 'bindSlowStartResolver 接线点还在');
  const block = source.slice(at, at + 600);
  assert.match(block, /\bresolveFacebookSlowStartFromView\s*\(/);
  assert.equal(
    block.includes(FACEBOOK_SLOW_START_BLOCKER_PREFIX + '$'),
    false,
    'MUST NOT 在组装根里手拼 blocker 串',
  );
});
