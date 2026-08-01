/**
 * Facebook 运营基线取用的纯判定段 + 它的跨进程通道
 * （change split-cloud-automation-production-runtime 批 E-2 步骤 2）。
 *
 * 这条判定**决定整个 Facebook 浏览模式**：答不出基线，下游就是这个账号永远不开始浏览。
 * 它是本批唯一「拿不到输入就只能编一个」的地方，所以三类不可用一律具名，
 * 且 MUST NOT 存在任何回落到默认基线的出路。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FACEBOOK_OPERATION_ENVIRONMENT_BLOCKER_PREFIX,
  FACEBOOK_OPERATION_POLICY_UNAVAILABLE_BLOCKER,
  FACEBOOK_PRIMARY_BROWSE_SURFACE_UNAVAILABLE_BLOCKER,
  resolveFacebookOperationBase,
  type FacebookOperationPolicyBaseProjection,
} from '../../src/kernel/facebook-operation-policy-resolution.js';
import { isSyncReadFactPayload } from '../../src/kernel/sync-read-facts.js';

const BASELINE: FacebookOperationPolicyBaseProjection = {
  envKey: 'env-1',
  primarySurface: 'reels',
  surfaceRevision: 3,
  baseMode: 'rule',
  policyRevision: 7,
  cadenceSource: 'environment',
  rule: { viewsPerLike: 5, joinEveryNRounds: 2 },
  consumption: {
    viewsPerLike: 4,
    confirmedLikesPerJoin: 3,
    confirmedJoinsPerComment: 2,
  },
  reels: {
    persona: { viewsPerLike: 6, viewsPerFollow: 12 },
    slowStart: { viewsPerFollow: 20 },
    rule: { viewsPerFollow: 15 },
    consumption: { viewsPerFollow: 10 },
  },
  updatedAt: '2026-08-01T00:00:00.000Z',
  updatedBy: 'ops',
};

const boundTo = (envKey: string) => () => ({ ok: true as const, envKey });

test('事实源未就绪 → 具名 blocker，MUST NOT 回落到任何默认基线', () => {
  const resolution = resolveFacebookOperationBase(
    {
      ready: false,
      resolveEnvironment: boundTo('env-1'),
      baselineForEnv: () => BASELINE,
    },
    'acc-1',
  );
  assert.equal(resolution.ok, false);
  assert.equal(
    resolution.ok === false && resolution.blocker,
    FACEBOOK_OPERATION_POLICY_UNAVAILABLE_BLOCKER,
  );
});

test('账号绑不到环境 → blocker 带上具体理由，三种理由分得开', () => {
  for (const reason of [
    'binding_unknown',
    'binding_conflict',
    'binding_unavailable',
  ] as const) {
    const resolution = resolveFacebookOperationBase(
      {
        ready: true,
        resolveEnvironment: () => ({ ok: false, reason }),
        baselineForEnv: () => BASELINE,
      },
      'acc-1',
    );
    assert.equal(
      resolution.ok === false && resolution.blocker,
      `${FACEBOOK_OPERATION_ENVIRONMENT_BLOCKER_PREFIX}${reason}`,
    );
  }
});

test('环境没配浏览面 → 具名 blocker，绝不替它选一个面', () => {
  const resolution = resolveFacebookOperationBase(
    {
      ready: true,
      resolveEnvironment: boundTo('env-nosurface'),
      baselineForEnv: () => null,
    },
    'acc-1',
  );
  assert.equal(
    resolution.ok === false && resolution.blocker,
    FACEBOOK_PRIMARY_BROWSE_SURFACE_UNAVAILABLE_BLOCKER,
  );
});

test('拿到基线时逐字段交出，且改返回值改不动属主那份', () => {
  const resolution = resolveFacebookOperationBase(
    {
      ready: true,
      resolveEnvironment: boundTo('env-1'),
      baselineForEnv: () => BASELINE,
    },
    'acc-1',
  );
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  assert.equal(resolution.primarySurface, 'reels');
  assert.equal(resolution.baseMode, 'rule');
  assert.equal(resolution.rule.viewsPerLike, 5);
  assert.equal(resolution.reels.slowStart.viewsPerFollow, 20);
  // 深拷贝：调用方改了不许回写到属主缓存（那会让另一个账号读到被改过的节奏）。
  resolution.rule.viewsPerLike = 99;
  resolution.reels.persona.viewsPerFollow = 99;
  assert.equal(BASELINE.rule.viewsPerLike, 5);
  assert.equal(BASELINE.reels.persona.viewsPerFollow, 12);
});

test('账号标识两侧修剪一致：空白串按「问不到」处理而不是当成合法账号', () => {
  const seen: string[] = [];
  resolveFacebookOperationBase(
    {
      ready: true,
      resolveEnvironment: (id) => {
        seen.push(id);
        return { ok: false, reason: 'binding_unknown' };
      },
      baselineForEnv: () => null,
    },
    '  acc-1  ',
  );
  assert.deepEqual(seen, ['acc-1']);
});

/* ───────────────────── 跨进程载荷校验 ───────────────────── */

test('基线载荷校验：三个枚举按取值表判，缺字段 / 越界值一律拒收', () => {
  const payload = { environments: [BASELINE] };
  assert.equal(isSyncReadFactPayload('facebook_operation_policy', payload), true);
  // 空表是合法的（一台没有 Facebook 环境的机器）。
  assert.equal(
    isSyncReadFactPayload('facebook_operation_policy', { environments: [] }),
    true,
  );
  // 枚举越界。
  assert.equal(
    isSyncReadFactPayload('facebook_operation_policy', {
      environments: [{ ...BASELINE, primarySurface: 'stories' }],
    }),
    false,
  );
  assert.equal(
    isSyncReadFactPayload('facebook_operation_policy', {
      environments: [{ ...BASELINE, baseMode: 'slow_start' }],
    }),
    false,
  );
  // 少一个节奏字段：**这类缺失最危险**——收下就等于按 undefined 跑节奏。
  assert.equal(
    isSyncReadFactPayload('facebook_operation_policy', {
      environments: [
        { ...BASELINE, rule: { viewsPerLike: 5 } },
      ],
    }),
    false,
  );
  assert.equal(
    isSyncReadFactPayload('facebook_operation_policy', {
      environments: [
        {
          ...BASELINE,
          reels: { ...BASELINE.reels, slowStart: {} },
        },
      ],
    }),
    false,
  );
  // 同一个环境键出现两次：谁覆盖谁没有定义，直接拒收。
  assert.equal(
    isSyncReadFactPayload('facebook_operation_policy', {
      environments: [BASELINE, BASELINE],
    }),
    false,
  );
});

/* ───────────────────── 结构：判定与合成各只有一份 ───────────────────── */

/**
 * 两条正向委托判据。**行为用例守不住它们**：第二份在写出来那天与第一份完全等价，
 * 要等两份漂开、且恰好在该拦住的那一刻才现形 —— 而这里「漂开」的表现是
 * 两个进程按不同浏览面 / 不同节奏跑同一个环境，两侧都不报错。**别当冗余删掉。**
 */
test('基线判定与基线合成各只有一份：属主与快照消费方都委托过去', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (path: string) =>
    readFile(new URL(`../../src/${path}`, import.meta.url), 'utf8');

  const kernelSource = await read('kernel/facebook-operation-policy-resolution.ts');
  assert.match(
    kernelSource,
    /export function resolveFacebookOperationBase\b/,
    'kernel MUST 是基线判定的唯一定义处',
  );

  // ① 属主存储的现读口委托给 kernel 判定。
  const store = await read('config/facebook-operation-policy-store.ts');
  const storeBody = store.slice(store.indexOf('  resolveBaseForAccount('));
  assert.match(
    storeBody.slice(0, storeBody.search(/^  \}/m)),
    /\bresolveFacebookOperationBase\s*\(/,
    'resolveBaseForAccount MUST 委托 kernel 判定',
  );

  // ② 自动化侧的取用口也委托同一个符号（而不是就地展开一份等价判断）。
  const mirrors = await read('transport/automation-sync-read-mirrors.ts');
  const mirrorBody = mirrors.slice(mirrors.indexOf('  facebookOperationBaseFor('));
  assert.match(
    mirrorBody.slice(0, mirrorBody.search(/^  \}/m)),
    /\bresolveFacebookOperationBase\s*\(/,
    '自动化侧取用口 MUST 委托 kernel 判定，不得自带一份',
  );

  // ③ 合成口只有一份：属主的两个出口都走 baselineForEnv，快照发布方取 baselineProjections。
  for (const method of ['getBaseForEnv', 'baselineProjections']) {
    const body = store.slice(store.indexOf(`  ${method}(`));
    assert.match(
      body.slice(0, body.search(/^  \}/m)),
      /\bbaselineForEnv\s*\(/,
      `${method} MUST 走同一个合成口 —— 另写一份合成会让两个进程按不同节奏跑`,
    );
  }

  // ④ 快照发布方 MUST NOT 用 SQL 自行重算基线（那正是第二份合成的形态）。
  const publisher = await read('config/api-sync-read-source.ts');
  assert.match(
    publisher,
    /this\.facebookOperationBaselines\(\)/,
    '发布方 MUST 经注入的取用口拿基线',
  );
  assert.doesNotMatch(
    publisher,
    /facebook_operation_policy\b(?![^\n]*versionCursor)[^\n]*FROM/i,
    '发布方出现了直查运营策略表的 SQL —— 合成规则只许在属主存储里有一份',
  );
});
