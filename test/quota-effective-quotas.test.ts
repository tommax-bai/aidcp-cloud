import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RiskController } from '../src/risk/risk-controller.js';
import { deriveWindowQuotas, scaleWindowQuotas, zeroInteractionQuotas } from '../src/risk/quotas.js';
import type { QuotaProvider, RiskQuotaLevel, RiskState, RiskStatus, WindowQuotas } from '../src/risk/types.js';

const state = (status: RiskStatus, quotaLevel: RiskQuotaLevel): RiskState => ({
  accountId: 't',
  status,
  quotaLevel,
  signalCount: 0,
  lastSignalAt: null,
  statusSince: 0,
  updatedAt: 0,
});

function markedProvider(markByLevel: Record<RiskQuotaLevel, number>): QuotaProvider {
  return {
    windowQuotasFor(level: RiskQuotaLevel): WindowQuotas {
      const d = deriveWindowQuotas(level);
      return { minute: { ...d.minute }, hour: { ...d.hour }, day: { ...d.day, like: markByLevel[level] } };
    },
  };
}

test('no provider: effectiveQuotas matches built-in quota derivation', () => {
  const normal = new RiskController({ initialState: state('normal', 'normal') });
  assert.deepEqual(normal.effectiveQuotas(), deriveWindowQuotas('normal'));

  const warned = new RiskController({ initialState: state('warned', 'aggressive') });
  assert.deepEqual(warned.effectiveQuotas(), scaleWindowQuotas(deriveWindowQuotas('conservative'), 0.7));

  const restricted = new RiskController({ initialState: state('restricted', 'aggressive') });
  assert.deepEqual(restricted.effectiveQuotas(), zeroInteractionQuotas(deriveWindowQuotas('conservative')));

  const frozen = new RiskController({ initialState: state('frozen', 'aggressive') });
  assert.deepEqual(frozen.effectiveQuotas(), scaleWindowQuotas(deriveWindowQuotas('conservative'), 0));
});

test('normal uses provider numbers for state.quotaLevel', () => {
  const provider = markedProvider({ conservative: 11, normal: 22, aggressive: 33 });
  const c = new RiskController({ initialState: state('normal', 'aggressive'), quotaProvider: provider });
  assert.equal(c.effectiveQuotas().day.like, 33);
});

test('warned/restricted/frozen use conservative baseline through provider', () => {
  const provider = markedProvider({ conservative: 101, normal: 22, aggressive: 33 });
  const warned = new RiskController({ initialState: state('warned', 'aggressive'), quotaProvider: provider });
  assert.equal(warned.effectiveQuotas().day.like, Math.ceil(101 * 0.7));

  const frozen = new RiskController({ initialState: state('frozen', 'aggressive'), quotaProvider: provider });
  assert.equal(frozen.effectiveQuotas().day.like, 0);

  const restricted = new RiskController({ initialState: state('restricted', 'normal'), quotaProvider: provider });
  assert.equal(restricted.effectiveQuotas().day.like, 0);
  assert.equal(restricted.effectiveQuotas().day.view, deriveWindowQuotas('conservative').day.view);
});

test('warned scaled quotas round up and keep sparse interaction minute windows nonzero', () => {
  const warned = new RiskController({ initialState: state('warned', 'normal') });
  const quotas = warned.effectiveQuotas();

  assert.equal(quotas.minute.like, 1);
  assert.equal(quotas.minute.collect, 1);
  assert.equal(quotas.minute.comment, 1);
  assert.equal(quotas.minute.follow, 1);
  assert.equal(quotas.minute.comment_like, 1);
  assert.equal(warned.canDo('like'), true);
  assert.equal(warned.canDo('comment'), true);
  assert.equal(warned.canDo('follow'), true);
});

test('provider changes are reflected by next effectiveQuotas and canDo call', () => {
  let dayLike = 1;
  const provider: QuotaProvider = {
    windowQuotasFor: (level: RiskQuotaLevel): WindowQuotas => {
      const d = deriveWindowQuotas(level);
      return { minute: { ...d.minute, like: 999 }, hour: { ...d.hour, like: 999 }, day: { ...d.day, like: dayLike } };
    },
  };
  const c = new RiskController({ initialState: state('normal', 'normal'), quotaProvider: provider });

  assert.equal(c.effectiveQuotas().day.like, 1);
  assert.equal(c.canDo('like'), true);
  dayLike = 0;
  assert.equal(c.effectiveQuotas().day.like, 0);
  assert.equal(c.canDo('like'), false);
});
