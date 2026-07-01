import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PacingSaturationAlerter } from '../src/risk/index.js';
import type { AlertStore } from '../src/alerts/index.js';

function stubStore() {
  const raises: { input: Parameters<AlertStore['raise']>[0]; at?: number }[] = [];
  const store: Pick<AlertStore, 'raise'> = {
    raise: async (input, at) => {
      raises.push({ input, at });
      return { alertId: raises.length };
    },
  };
  return { raises, store };
}

test('突发窗饱和发一条 P2 pacing_saturation 告警（带账号/动作）', () => {
  const { raises, store } = stubStore();
  let now = 0;
  const alerter = new PacingSaturationAlerter({ alertStore: store, clock: () => now });
  assert.equal(alerter.maybe('acc-1', 'view', 'hour'), true);
  assert.equal(raises.length, 1);
  assert.equal(raises[0].input.type, 'pacing_saturation');
  assert.equal(raises[0].input.severity, 'P2');
  assert.equal(raises[0].input.accountId, 'acc-1');
  assert.match(raises[0].input.title, /view/);
  assert.match(raises[0].input.title, /每小时/);
});

test('冷却窗内同账号同动作不重复告警，窗外可再发', () => {
  const { raises, store } = stubStore();
  let now = 0;
  const alerter = new PacingSaturationAlerter({ alertStore: store, clock: () => now, cooldownMs: 20 * 60_000 });
  assert.equal(alerter.maybe('acc-1', 'view', 'hour'), true);
  now += 5 * 60_000; // 冷却窗内
  assert.equal(alerter.maybe('acc-1', 'view', 'hour'), false, '冷却窗内压制');
  now += 16 * 60_000; // 累计 21min，超冷却窗
  assert.equal(alerter.maybe('acc-1', 'view', 'hour'), true, '冷却窗外可再发');
  assert.equal(raises.length, 2);
});

test('不同账号 / 不同动作各自独立冷却', () => {
  const { raises, store } = stubStore();
  const alerter = new PacingSaturationAlerter({ alertStore: store, clock: () => 0 });
  assert.equal(alerter.maybe('acc-1', 'view', 'hour'), true);
  assert.equal(alerter.maybe('acc-2', 'view', 'hour'), true, '不同账号独立');
  assert.equal(alerter.maybe('acc-1', 'like', 'minute'), true, '同账号不同动作独立');
  assert.equal(raises.length, 3);
});
