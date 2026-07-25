/**
 * 账号暂停态的窄读端口（change cloud-coupling-phase4-runtime-ports）。
 *
 * 三态判据：`unknown` = 配置副本陈旧、无法确认，调用方 MUST 按停手处理（不是「没暂停」）。
 * 端口只暴露纯取值口；暂停 / 恢复 / 初始化 / 权威回填 / 状态导出全部留在实现侧（api）。
 */
export type AccountPauseState = 'paused' | 'active' | 'unknown';

export interface AccountPausePort {
  pauseStateOf(accountId: string): AccountPauseState;
}
