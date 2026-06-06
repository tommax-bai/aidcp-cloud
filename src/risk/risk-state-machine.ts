import type { RiskSignal, RiskState, RiskStatus } from './types.js';

export const WARNED_RECOVERY_MS = 7 * 24 * 60 * 60_000;
export const RESTRICTED_RECOVERY_MS = 3 * 24 * 60 * 60_000;

export function createRiskState(accountId: string, now = Date.now()): RiskState {
  return {
    accountId,
    status: 'normal',
    quotaLevel: 'normal',
    signalCount: 0,
    lastSignalAt: null,
    statusSince: now,
    updatedAt: now,
  };
}

export class RiskStateMachine {
  transition(state: RiskState, signal: RiskSignal, now = signal.at ?? Date.now()): RiskState {
    const nextStatus = this.nextStatus(state, signal, now);
    const isRiskSignal = signal.kind === 'light' || signal.kind === 'quota_exceeded' || signal.kind === 'confirmed' || signal.kind === 'fatal';
    return {
      ...state,
      status: nextStatus,
      signalCount: isRiskSignal ? state.signalCount + 1 : state.signalCount,
      lastSignalAt: isRiskSignal ? now : state.lastSignalAt,
      statusSince: nextStatus === state.status ? state.statusSince : now,
      updatedAt: now,
    };
  }

  recoverIfEligible(state: RiskState, now = Date.now()): RiskState {
    if (state.lastSignalAt && now - state.lastSignalAt < this.recoveryWindow(state.status)) {
      return { ...state, updatedAt: now };
    }
    if (state.status === 'warned') return { ...state, status: 'normal', signalCount: 0, statusSince: now, updatedAt: now };
    if (state.status === 'restricted') return { ...state, status: 'warned', signalCount: 0, statusSince: now, updatedAt: now };
    return { ...state, updatedAt: now };
  }

  private nextStatus(state: RiskState, signal: RiskSignal, now: number): RiskStatus {
    if (signal.kind === 'fatal') return 'frozen';
    if (signal.kind === 'manual_unfreeze' && state.status === 'frozen') return 'restricted';
    if (signal.kind === 'recovered') return this.recoverIfEligible(state, now).status;
    if (signal.kind === 'confirmed') return state.status === 'normal' ? 'restricted' : state.status === 'frozen' ? 'frozen' : 'restricted';
    if (signal.kind === 'light' || signal.kind === 'quota_exceeded') {
      if (state.status === 'normal') return 'warned';
      if (state.status === 'warned') return 'restricted';
    }
    return state.status;
  }

  private recoveryWindow(status: RiskStatus): number {
    if (status === 'warned') return WARNED_RECOVERY_MS;
    if (status === 'restricted') return RESTRICTED_RECOVERY_MS;
    return Number.POSITIVE_INFINITY;
  }
}