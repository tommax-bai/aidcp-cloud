export const RISK_ACTIONS = ['like', 'collect', 'comment', 'follow', 'publish', 'view'] as const;

export type RiskAction = (typeof RISK_ACTIONS)[number];

export type InteractionAction = Extract<RiskAction, 'like' | 'collect' | 'comment'>;

export const RISK_QUOTA_LEVELS = ['conservative', 'normal', 'aggressive'] as const;
export type RiskQuotaLevel = (typeof RISK_QUOTA_LEVELS)[number];

export const RISK_STATUSES = ['normal', 'warned', 'restricted', 'frozen'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export type RiskWindow = 'minute' | 'hour' | 'day';

export type ActionQuota = Record<RiskAction, number>;

export type WindowQuotas = Record<RiskWindow, ActionQuota>;

export interface RiskState {
  accountId: string;
  status: RiskStatus;
  quotaLevel: RiskQuotaLevel;
  signalCount: number;
  lastSignalAt: number | null;
  statusSince: number;
  updatedAt: number;
}

export type RiskSignalKind =
  | 'light'
  | 'quota_exceeded'
  | 'confirmed'
  | 'fatal'
  | 'recovered'
  | 'manual_unfreeze';

export interface RiskSignal {
  kind: RiskSignalKind;
  at?: number;
}

export interface CounterEvent {
  action: RiskAction;
  occurredAt: number;
  count: number;
}

export interface RiskStore {
  init?(): Promise<void>;
  loadCounters(accountId: string, since: number): Promise<CounterEvent[]>;
  appendCounter(accountId: string, action: RiskAction, occurredAt: number): Promise<void>;
  loadState(accountId: string): Promise<RiskState | null>;
  saveState(state: RiskState): Promise<void>;
  close?(): Promise<void>;
}

export interface InteractionStore {
  init?(): Promise<void>;
  hasInteraction(accountId: string, noteId: string, action: InteractionAction): Promise<boolean>;
  recordInteraction(accountId: string, noteId: string, action: InteractionAction, interactedAt: number): Promise<void>;
  close?(): Promise<void>;
}