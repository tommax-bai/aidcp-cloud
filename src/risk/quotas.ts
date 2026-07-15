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
    join_group: 1,
    dm_reply: 0,
  },
  normal: {
    view: 150,
    like: 50,
    collect: 25,
    comment: 8,
    follow: 15,
    publish: 1,
    comment_like: 6,
    join_group: 3,
    dm_reply: 0,
  },
  aggressive: {
    view: 300,
    like: 100,
    collect: 50,
    comment: 15,
    follow: 30,
    publish: 2,
    comment_like: 12,
    join_group: 5,
    dm_reply: 0,
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
  join_group: 1,
  dm_reply: 0,
};

export const HOUR_BURST_CAP: ActionQuota = {
  view: 60,
  like: 20,
  collect: 10,
  comment: 4,
  follow: 8,
  publish: 2,
  comment_like: 3,
  join_group: 2,
  dm_reply: 0,
};

export function deriveWindowQuotasFromDaily(day: ActionQuota): WindowQuotas {
  return {
    minute: mapQuota(day, (action, daily) => daily <= 0 ? 0 : Math.max(1, Math.min(MINUTE_BURST_CAP[action], Math.ceil(daily / 20)))),
    hour: mapQuota(day, (action, daily) => daily <= 0 ? 0 : Math.max(1, Math.min(HOUR_BURST_CAP[action], Math.ceil(daily / 4)))),
    day: { ...day },
  };
}

export function deriveWindowQuotas(level: RiskQuotaLevel): WindowQuotas {
  return deriveWindowQuotasFromDaily(DAILY_QUOTAS[level]);
}

/**
 * Element-wise min of two window-quota sets (change account-nurture-discipline-spine).
 * 用于把「账号年龄冷启动天花板」与「风控档缩放配额」在每窗口每动作取较紧者——
 * min 语义保证年龄爬坡与风控降速(warned/restricted)两条闸同时生效、互不架空。
 */
export function minWindowQuotas(a: WindowQuotas, b: WindowQuotas): WindowQuotas {
  return {
    minute: mapQuota(a.minute, (action, value) => Math.min(value, b.minute[action])),
    hour: mapQuota(a.hour, (action, value) => Math.min(value, b.hour[action])),
    day: mapQuota(a.day, (action, value) => Math.min(value, b.day[action])),
  };
}

export function scaleWindowQuotas(quotas: WindowQuotas, factor: number): WindowQuotas {
  return {
    minute: mapQuota(quotas.minute, (_action, value) => Math.max(0, Math.ceil(value * factor))),
    hour: mapQuota(quotas.hour, (_action, value) => Math.max(0, Math.ceil(value * factor))),
    day: mapQuota(quotas.day, (_action, value) => Math.max(0, Math.ceil(value * factor))),
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
