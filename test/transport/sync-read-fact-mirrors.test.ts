import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiSyncReadMirrors } from '../../src/config/api-sync-read-mirrors.js';
import { makeSyncReadFactEnvelope } from '../../src/kernel/sync-read-facts.js';
import { AutomationSyncReadMirrors } from '../../src/transport/automation-sync-read-mirrors.js';
import { RISK_ACTIONS, type ActionQuota } from '../../src/kernel/risk-contract.js';

test('A3/A4 distinguish known zero/empty from unknown and stale evidence', () => {
  let now = 100;
  const mirrors = new ApiSyncReadMirrors('dev', () => now);
  assert.equal(mirrors.presence().state, 'unknown');
  assert.equal(mirrors.presence().asOf, null);
  assert.equal(mirrors.presence().edgeCount, null);
  assert.equal(mirrors.presence().onlineEdgeCount, null);
  assert.equal(mirrors.inFlightEvidence().recordIds, null);

  assert.equal(
    mirrors.apply(
      makeSyncReadFactEnvelope({
        executionTarget: 'dev',
        stream: 'edge_presence',
        cursor: '1',
        asOf: 90,
        freshUntil: 150,
        value: { edgeCount: 0, onlineEdgeCount: 0, accountEdges: [] },
      }),
      'owner_fetch',
    ).outcome,
    'applied',
  );
  assert.equal(
    mirrors.apply(
      makeSyncReadFactEnvelope({
        executionTarget: 'dev',
        stream: 'publish_in_flight',
        cursor: '1',
        asOf: 90,
        freshUntil: 150,
        value: { recordIds: [] },
      }),
      'owner_fetch',
    ).outcome,
    'applied',
  );
  assert.equal(mirrors.presence().edgeCount, 0);
  assert.deepEqual([...mirrors.inFlightEvidence().recordIds!], []);

  now = 151;
  assert.equal(mirrors.presence().state, 'stale');
  assert.equal(mirrors.presence().edgeCount, null);
  assert.equal(mirrors.inFlightEvidence().state, 'stale');
  assert.equal(mirrors.inFlightEvidence().recordIds, null);
});

test('A5 preserves explicit disabled/unavailable while source loss becomes unknown', () => {
  let now = 100;
  const mirrors = new ApiSyncReadMirrors('dev', () => now);
  for (const [cursor, state] of [
    ['1', 'disabled'],
    ['2', 'unavailable'],
  ] as const) {
    assert.equal(
      mirrors.apply(
        makeSyncReadFactEnvelope({
          executionTarget: 'dev',
          stream: 'captcha_availability',
          cursor,
          asOf: Number(cursor) * 10,
          freshUntil: 150,
          value: { state },
        }),
        'owner_fetch',
      ).outcome,
      'applied',
    );
    assert.equal(mirrors.captcha().capability, state);
    assert.equal(
      mirrors.readiness().blockers.some(
        (blocker) => blocker.stream === 'captcha_availability',
      ),
      state === 'unavailable',
    );
  }
  now = 151;
  assert.deepEqual(mirrors.captcha(), {
    state: 'stale',
    asOf: 20,
    capability: 'unknown',
  });
});

test('A6 stale delivery clears old fresh entries and keeps source evidence', () => {
  let now = 100;
  const mirrors = new ApiSyncReadMirrors('dev', () => now);
  mirrors.apply(
    makeSyncReadFactEnvelope({
      executionTarget: 'dev',
      stream: 'automation_config_mirror_health',
      cursor: '1',
      asOf: 90,
      freshUntil: 150,
      value: {
        sourceService: 'automation',
        asOf: 80,
        enabled: true,
        pollMs: 1_000,
        entries: [
          {
            mirrorKey: 'session_config_global',
            tier: 'gate',
            version: 1,
            lastComparedAt: 80,
            lastReloadedAt: 70,
            reloadFailingSince: null,
            state: 'fresh',
            staleMs: 0,
            observeStaleMs: 5_000,
            haltsOnStale: true,
            staleForMs: 0,
          },
        ],
      },
    }),
    'owner_fetch',
  );
  assert.equal(mirrors.automationConfigMirrorHealth().entries.length, 1);
  now = 151;
  assert.deepEqual(mirrors.automationConfigMirrorHealth(), {
    sourceService: 'automation',
    asOf: 90,
    deliveryState: 'stale',
    entries: [],
  });
});

test('B1 complete fresh absence is unbound, while stale is unknown', () => {
  let now = 100;
  const mirrors = new AutomationSyncReadMirrors('dev', () => now);
  mirrors.apply(
    makeSyncReadFactEnvelope({
      executionTarget: 'dev',
      stream: 'account_persona',
      cursor: '1',
      asOf: 90,
      freshUntil: 150,
      value: {
        accounts: [
          { accountId: 'bound', personaText: 'persona', soul: { name: 'soul' } },
        ],
      },
    }),
    'owner_fetch',
  );
  assert.equal(mirrors.personaFor('missing').value?.binding, 'unbound');
  assert.equal(mirrors.personaFor('bound').value?.binding, 'bound');
  now = 151;
  assert.deepEqual(mirrors.personaFor('missing'), {
    state: 'stale',
    value: null,
    asOf: 90,
  });
});

test('B2 missing, ambiguous and stale slow-start evidence never collapse into known-none', () => {
  let now = 100;
  const mirrors = new AutomationSyncReadMirrors('dev', () => now);
  mirrors.apply(
    makeSyncReadFactEnvelope({
      executionTarget: 'dev',
      stream: 'client_environment_automation',
      cursor: '1',
      asOf: 90,
      freshUntil: 150,
      value: {
        blockedEnvironmentKeys: ['blocked'],
        slowStartAnchors: [
          {
            accountId: 'known',
            envKey: 'env-known',
            slowStartSince: null,
            slowStartCompletedAt: null,
            ambiguous: false,
          },
          {
            accountId: 'ambiguous',
            envKey: null,
            slowStartSince: null,
            slowStartCompletedAt: null,
            ambiguous: true,
          },
        ],
      },
    }),
    'owner_fetch',
  );
  assert.equal(mirrors.automationGateForEdgeId('ads-blocked'), 'blocked');
  assert.equal(mirrors.automationGateForEdgeId('ads-open'), 'allowed');
  assert.equal(mirrors.slowStartForAccount('known').resolution, 'known');
  assert.equal(
    mirrors.slowStartForAccount('known').slowStartCompletedAt,
    null,
  );
  assert.equal(mirrors.slowStartForAccount('missing').resolution, 'missing');
  assert.equal(
    mirrors.slowStartForAccount('ambiguous').resolution,
    'ambiguous',
  );
  now = 151;
  assert.equal(mirrors.automationGateForEdgeId('ads-open'), 'unknown');
  assert.equal(mirrors.slowStartForAccount('known').resolution, 'unknown');
});

test('B4 and B5 retain last-good parameters but mark gates stale', () => {
  let now = 100;
  const mirrors = new AutomationSyncReadMirrors('dev', () => now);
  const accountEnvelope = makeSyncReadFactEnvelope({
    executionTarget: 'dev',
    stream: 'automation_account_projection',
    cursor: '1',
    asOf: 90,
    freshUntil: 150,
    value: {
      accounts: [
        {
          accountId: 'a',
          platform: 'facebook',
          groupLabel: null,
          createdAt: null,
          status: 'paused',
        },
      ],
    },
  });
  mirrors.apply(accountEnvelope, 'owner_fetch');
  assert.deepEqual(Object.keys(accountEnvelope.value.accounts[0]!).sort(), [
    'accountId',
    'createdAt',
    'groupLabel',
    'platform',
    'status',
  ]);
  assert.equal(mirrors.accountFor('a').value?.status, 'paused');

  mirrors.apply(
    makeSyncReadFactEnvelope({
      executionTarget: 'dev',
      stream: 'hot_lead_config',
      cursor: '1',
      asOf: 90,
      freshUntil: 150,
      value: {
        maxAgeHours: 24,
        velocityMin: 3,
        minLikeFloor: 10,
        floorHours: 2,
      },
    }),
    'owner_fetch',
  );
  assert.equal(mirrors.businessConfig('hot_lead_config').state, 'fresh');
  assert.equal(
    mirrors.configFreshnessRuntime().readiness(['hot_lead_config']).state,
    'ready',
  );

  now = 151;
  assert.equal(mirrors.accountFor('a').state, 'stale');
  const staleParameter = mirrors.businessConfig('hot_lead_config');
  assert.equal(staleParameter.state, 'stale');
  assert.equal(staleParameter.value?.velocityMin, 3);
  assert.deepEqual(
    mirrors.configFreshnessRuntime().readiness(['hot_lead_config']),
    {
      state: 'not_ready',
      serviceMode: 'automation',
      authorityMode: 'remote-mirror',
      blockers: ['hot_lead_config'],
    },
  );
});

/**
 * Facebook 慢启动曲线的取用（批 H 第 3 片）。三态各钉一条，因为三者的下游处置**互不相同**：
 * 新鲜用它 / 陈旧沿用上一份 / 一次都没收到过则调用方整个不提供这个能力。
 *
 * 特别是中间那条：**陈旧 ≠ 没有**。把陈旧当没有、回落写死默认，方向很可能正好反了 ——
 * 这是参数档不是闸门档，编译默认很可能比运营配的更松，一陈旧就悄悄放宽。
 */
test('慢启动曲线取用：没收到过 → null；新鲜 → 用它；陈旧 → 沿用上一份，绝不回落默认', () => {
  let now = 100;
  const mirrors = new AutomationSyncReadMirrors('dev', () => now);
  const caps = (value: number) =>
    Object.fromEntries(RISK_ACTIONS.map((action) => [action, value])) as ActionQuota;

  const unseen = mirrors.facebookSlowStartPolicy();
  assert.equal(unseen.state, 'unknown', '一次都没收到过 → unknown（不是 stale）');
  assert.equal(
    unseen.value,
    null,
    '一次都没收到过 MUST 是 null —— 调用方据此整个不提供该能力，'
      + '而不是喂一份空曲线（那等于宣称这个号没有任何逐日上限）',
  );

  const slowStart = { totalDays: 3, dailyCaps: [caps(5), caps(9)] };
  assert.equal(
    mirrors.apply(
      makeSyncReadFactEnvelope({
        executionTarget: 'dev',
        stream: 'facebook_operation_policy',
        cursor: '1',
        asOf: 90,
        freshUntil: 150,
        value: { environments: [], slowStart },
      }),
      'owner_fetch',
    ).outcome,
    'applied',
    '慢启动曲线随运营基线同流下来 —— 被拒说明载荷校验器与生产者对不上',
  );
  const fresh = mirrors.facebookSlowStartPolicy();
  assert.equal(fresh.state, 'fresh');
  assert.deepEqual(fresh.value, slowStart);

  now = 151;
  const stale = mirrors.facebookSlowStartPolicy();
  assert.equal(stale.state, 'stale');
  assert.deepEqual(
    stale.value,
    slowStart,
    '陈旧 MUST 沿用上一份：回落写死默认很可能比运营配的更松，一陈旧就悄悄放宽',
  );
});
