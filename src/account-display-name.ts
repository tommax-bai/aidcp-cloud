export type AccountDisplayNameSource =
  | 'operator_alias'
  | 'platform_nickname'
  | 'label'
  | 'account_id';

export interface AccountDisplayNameInput {
  accountId: string;
  operatorAlias?: string | null;
  nickname?: string | null;
  label?: string | null;
}

export interface AccountDisplayName {
  name: string;
  source: AccountDisplayNameSource;
}

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 人类可见账号名的唯一优先级：运营别名 → 平台真实昵称 → 运营标签 → 稳定账号 ID。
 * label 默认常等于 accountId；这种情况归为 account_id，通知层才能避免把裸 ID 冒充成昵称。
 */
export function resolveAccountDisplayName(input: AccountDisplayNameInput): AccountDisplayName {
  const accountId = clean(input.accountId);
  const operatorAlias = clean(input.operatorAlias);
  const nickname = clean(input.nickname);
  const label = clean(input.label);
  if (operatorAlias) return { name: operatorAlias, source: 'operator_alias' };
  if (nickname) return { name: nickname, source: 'platform_nickname' };
  if (label && label !== accountId) return { name: label, source: 'label' };
  return { name: accountId, source: 'account_id' };
}

/** 飞书等人类通知不得把裸机器 ID 当昵称。 */
export function readableAccountDisplayName(display: AccountDisplayName): string {
  return display.source === 'account_id' ? '（未获取昵称）' : display.name;
}

/**
 * 通知接线统一从账号目录取当前首选名；只有目录暂不可用或尚无可读名时，
 * 才兼容事件中携带的旧名称。这样人工别名不会被长链路里的旧快照盖住。
 */
export function resolveNotificationAccountName(
  accountId: string | null | undefined,
  observedName: string | null | undefined,
  lookup: (accountId: string) => string | undefined,
): string | undefined {
  const id = clean(accountId);
  const resolved = id ? clean(lookup(id)) : '';
  return resolved || clean(observedName) || undefined;
}

/**
 * 人工选号允许命中运营别名、平台昵称或运营标签；账号 ID 永不进入名字候选。
 * 返回值按显示优先级排序并去重。
 */
export function accountDisplayNameCandidates(input: AccountDisplayNameInput): string[] {
  const accountId = clean(input.accountId);
  const values = [clean(input.operatorAlias), clean(input.nickname), clean(input.label)]
    .filter((value) => value && value !== accountId);
  return [...new Set(values)];
}
