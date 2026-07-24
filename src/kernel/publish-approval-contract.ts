/**
 * 发布审批的**纯枚举 / 哨兵错误契约**（原定义在 src/publish-agent/publish-approval-store.ts，automation）。
 * 抬入 kernel（change decouple-longtail-sweep）供发布下发编排等跨边界消费方直接引用，
 * 无需 type/value 依赖属主侧的 pg 审批存储类。零 import、零 SQL、无进程内活状态，满足 §4.7 kernel 准入
 * （Error 子类与 kernel/schema-capability-contract 的 SchemaCapabilityError 同一手法；const 数组为字面 tuple、非 Set/Map）。
 */

/** 作废原因枚举——四类既有作废场景各自可区分，MUST NOT 合并为泛化原因。枚举外 MUST 拒绝。 */
export const APPROVAL_VOID_REASONS = [
  'version_stale',
  'edge_offline',
  'preempt_exhausted',
  'lease_unconfirmed',
] as const;
export type ApprovalVoidReason = (typeof APPROVAL_VOID_REASONS)[number];

export function isApprovalVoidReason(value: unknown): value is ApprovalVoidReason {
  return typeof value === 'string' && (APPROVAL_VOID_REASONS as readonly string[]).includes(value);
}

/** 下发阻塞原因（可读、映射到既有五类阻塞）。阻塞解除 MUST 清空。 */
export const APPROVAL_BLOCKED_REASONS = [
  'edge_offline_waiting',
  'browser_slot_waiting',
  'breaker_open',
  'captcha_paused',
  'approval_unreadable',
] as const;
export type ApprovalBlockedReason = (typeof APPROVAL_BLOCKED_REASONS)[number];

/** 审批记录读取失败的哨兵错误（下发段据 instanceof 与 code 区分不可读 vs 其他失败）。 */
export class ApprovalUnreadableError extends Error {
  readonly code = 'approval_unreadable';
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalUnreadableError';
  }
}
