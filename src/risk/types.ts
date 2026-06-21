export const RISK_ACTIONS = ['like', 'collect', 'comment', 'follow', 'publish', 'view', 'comment_like'] as const;

export type RiskAction = (typeof RISK_ACTIONS)[number];

// 注意：comment_like 刻意不进 InteractionAction —— 它没有「每笔记一次」语义（按评论锚点，不按 noteId 去重），
// 故不落 risk_interactions 去重表、不进 likedNoteStore；它只走 risk_counters 配额计数（独立一档）。
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
  | 'manual_unfreeze'
  // 运营手动信号（V1 task 8.2）：非检测信号，不 bump signalCount
  | 'manual_restrict' // normal/warned → restricted
  | 'manual_freeze' // any → frozen
  | 'operator_override_recover'; // 绕过恢复窗口强制 → normal（特权，需审计理由）

export interface RiskSignal {
  kind: RiskSignalKind;
  at?: number;
  /** 运营操作的审计理由（operator_override_recover 等特权操作必填）。 */
  reason?: string;
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