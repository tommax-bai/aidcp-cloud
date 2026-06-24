import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RiskController } from '../src/risk/risk-controller.js';
import { deriveWindowQuotas, scaleWindowQuotas, zeroInteractionQuotas } from '../src/risk/quotas.js';
import type { QuotaProvider, RiskQuotaLevel, RiskState, RiskStatus, WindowQuotas } from '../src/risk/types.js';

const state = (status: RiskStatus, quotaLevel: RiskQuotaLevel): RiskState => ({
  accountId: 't', status, quotaLevel, signalCount: 0, lastSignalAt: null, statusSince: 0, updatedAt: 0,
});

/** provider 桩：基于 deriveWindowQuotas，但把每档 day.like 改成标记值，便于断言「确实用了 provider」。 */
function markedProvider(markByLevel: Record<RiskQuotaLevel, number>): QuotaProvider {
  return {
    windowQuotasFor(level: RiskQuotaLevel): WindowQuotas {
      const d = deriveWindowQuotas(level);
      return { minute: { ...d.minute }, hour: { ...d.hour }, day: { ...d.day, like: markByLevel[level] } };
    },
  };
}

test('零回归：无 provider → effectiveQuotas 与历史写死行为逐位一致', () => {
  const normal = new RiskController({ initialState: state('normal', 'normal') });
  assert.deepEqual(normal.effectiveQuotas(), deriveWindowQuotas('normal'));
  const warned = new RiskController({ initialState: state('warned', 'aggressive') });
  assert.deepEqual(warned.effectiveQuotas(), scaleWindowQuotas(deriveWindowQuotas('conservative'), 0.7));
  const restricted = new RiskController({ initialState: state('restricted', 'aggressive') });
  assert.deepEqual(restricted.effectiveQuotas(), zeroInteractionQuotas(deriveWindowQuotas('conservative')));
  const frozen = new RiskController({ initialState: state('frozen', 'aggressive') });
  assert.deepEqual(frozen.effectiveQuotas(), scaleWindowQuotas(deriveWindowQuotas('conservative'), 0));
});

test('normal 用 provider(state.quotaLevel) 的数字', () => {
  const provider = markedProvider({ conservative: 11, normal: 22, aggressive: 33 });
  const c = new RiskController({ initialState: state('normal', 'aggressive'), quotaProvider: provider });
  assert.equal(c.effectiveQuotas().day.like, 33); // 用 aggressive 档 provider 值
});

test('warned/restricted/frozen 基准固定 conservative（经 provider），缩放/清零语义不变', () => {
  const provider = markedProvider({ conservative: 100, normal: 22, aggressive: 33 });
  const warned = new RiskController({ initialState: state('warned', 'aggressive'), quotaProvider: provider });
  // 基准取 provider('conservative').day.like=100，再 *0.7 floor = 70（不是 aggressive 的 33）
  assert.equal(warned.effectiveQuotas().day.like, Math.floor(100 * 0.7));
  const frozen = new RiskController({ initialState: state('frozen', 'aggressive'), quotaProvider: provider });
  assert.equal(frozen.effectiveQuotas().day.like, 0);
  const restricted = new RiskController({ initialState: state('restricted', 'normal'), quotaProvider: provider });
  assert.equal(restricted.effectiveQuotas().day.like, 0); // 互动类清零
  assert.equal(restricted.effectiveQuotas().day.view, deriveWindowQuotas('conservative').day.view); // view 不清零=conservative 派生
});

test('热加载：改 provider 返回值后下一次 effectiveQuotas / canDo 立即按新值', () => {
  let dayLike = 1;
  const provider: QuotaProvider = {
    windowQuotasFor: (level: RiskQuotaLevel): WindowQuotas => {
      const d = deriveWindowQuotas(level);
      return { minute: { ...d.minute, like: 999 }, hour: { ...d.hour, like: 999 }, day: { ...d.day, like: dayLike } };
    },
  };
  const c = new RiskController({ initialState: state('normal', 'normal'), quotaProvider: provider });
  assert.equal(c.effectiveQuotas().day.like, 1);
  assert.equal(c.canDo('like'), true); // 0 次 like < 上限 1 → 允许
  dayLike = 0; // 模拟后台 PUT 把每日 like 改成 0（禁止）
  assert.equal(c.effectiveQuotas().day.like, 0);
  assert.equal(c.canDo('like'), false); // 立即生效：count 0 >= 上限 0 → 拒
});
