import { RISK_ACTIONS, type ActionQuota, type RiskAction, type RiskQuotaLevel, type WindowQuotas } from './types.js';

export const DAILY_QUOTAS: Record<RiskQuotaLevel, ActionQuota> = {
  conservative: {
    view: 80,
    like: 20,
    collect: 10,
    comment: 3,
    follow: 5,
    publish: 1,
    comment_like: 3,
  },
  normal: {
    view: 150,
    like: 50,
    collect: 25,
    comment: 8,
    follow: 15,
    publish: 1,
    comment_like: 6,
  },
  aggressive: {
    view: 300,
    like: 100,
    collect: 50,
    comment: 15,
    follow: 30,
    publish: 2,
    comment_like: 12,
  },
};

/** 限额数字的合理上限（校验用，防误填天文数字击穿滑动窗比较）。 */
export const QUOTA_MAX = 100_000;

export const MINUTE_BURST_CAP: ActionQuota = {
  view: 8,
  like: 4,
  collect: 3,
  comment: 1,
  follow: 1,
  publish: 1,
  comment_like: 1,
};

export const HOUR_BURST_CAP: ActionQuota = {
  view: 60,
  like: 20,
  collect: 10,
  comment: 4,
  follow: 8,
  publish: 2,
  comment_like: 3,
};

export function deriveWindowQuotas(level: RiskQuotaLevel): WindowQuotas {
  const day = DAILY_QUOTAS[level];
  return {
    minute: mapQuota(day, (action, daily) => Math.max(1, Math.min(MINUTE_BURST_CAP[action], Math.ceil(daily / 20)))),
    hour: mapQuota(day, (action, daily) => Math.max(1, Math.min(HOUR_BURST_CAP[action], Math.ceil(daily / 4)))),
    day: { ...day },
  };
}

export function scaleWindowQuotas(quotas: WindowQuotas, factor: number): WindowQuotas {
  return {
    minute: mapQuota(quotas.minute, (_action, value) => Math.max(0, Math.floor(value * factor))),
    hour: mapQuota(quotas.hour, (_action, value) => Math.max(0, Math.floor(value * factor))),
    day: mapQuota(quotas.day, (_action, value) => Math.max(0, Math.floor(value * factor))),
  };
}

export function zeroInteractionQuotas(base: WindowQuotas): WindowQuotas {
  return {
    minute: zeroInteractions(base.minute),
    hour: zeroInteractions(base.hour),
    day: zeroInteractions(base.day),
  };
}

function zeroInteractions(quota: ActionQuota): ActionQuota {
  return mapQuota(quota, (action, value) => (action === 'view' ? value : 0));
}

function mapQuota(quota: ActionQuota, mapper: (action: RiskAction, value: number) => number): ActionQuota {
  return Object.fromEntries(RISK_ACTIONS.map((action) => [action, mapper(action, quota[action])])) as ActionQuota;
}