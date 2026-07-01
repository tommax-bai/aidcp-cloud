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
    const isRiskSignal = signal.kind === 'light' || signal.kind === 'confirmed' || signal.kind === 'fatal';
    // operator_override_recover：特权强制 normal，清零信号计数与窗口（绕过恢复窗口）。
    const forcedRecover = signal.kind === 'operator_override_recover';
    return {
      ...state,
      status: nextStatus,
      signalCount: forcedRecover ? 0 : isRiskSignal ? state.signalCount + 1 : state.signalCount,
      lastSignalAt: forcedRecover ? null : isRiskSignal ? now : state.lastSignalAt,
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
    if (signal.kind === 'fatal' || signal.kind === 'manual_freeze') return 'frozen';
    // 特权强制恢复：无视恢复窗口直接 normal（reason 校验在 controller/路由层）
    if (signal.kind === 'operator_override_recover') return 'normal';
    // 手动加严：normal/warned → restricted；已 restricted/frozen 不变（不降级）
    if (signal.kind === 'manual_restrict') {
      return state.status === 'normal' || state.status === 'warned' ? 'restricted' : state.status;
    }
    if (signal.kind === 'manual_unfreeze' && state.status === 'frozen') return 'restricted';
    if (signal.kind === 'recovered') return this.recoverIfEligible(state, now).status;
    if (signal.kind === 'confirmed') return state.status === 'normal' ? 'restricted' : state.status === 'frozen' ? 'frozen' : 'restricted';
    // 软信号（未知阻断浮层）逐级升：normal→warned→restricted。配额饱和不再是软信号（见
    // change decouple-quota-hit-from-risk）——威胁态只由平台可观测信号升级。
    if (signal.kind === 'light') {
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