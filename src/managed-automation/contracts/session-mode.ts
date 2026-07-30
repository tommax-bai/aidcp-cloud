/**
 * 契约层：任务模式会话契约（session registration mode 字段）。
 *
 * 期1-3 将实现「任务模式通道与调度排除」：以 mode='task' 注册的 Edge 会话专供
 * 托管自动化运行时驱动，被编排调度（RoleDispatcher 等既有编排路径）排除；
 * mode='orchestration'（或缺省）保持今天的编排行为。
 *
 * 滚动兼容（§24.2 C7 裁决：**协议字段**滚动兼容、能力/命令版本锁步）：
 * mode 为可选新字段，旧 Edge 不带该字段 → 视同 'orchestration'，行为与今天一致。
 * 本文件只冻结契约；src/comm/protocol.ts 的 HelloPayload 在期1-3 接线时才引入该字段。
 */

/** 会话模式。缺省（字段缺失/undefined）= 'orchestration'。 */
export type SessionMode = 'task' | 'orchestration';

export const SESSION_MODES = ['task', 'orchestration'] as const satisfies readonly SessionMode[];

/** 会话注册携带的模式声明（并入 hello/注册载荷的形态子集）。 */
export interface SessionModeRegistration {
  /** 可选：旧客户端不发送即走缺省，滚动升级无需锁步。 */
  mode?: SessionMode;
}

/** 缺省归一（纯函数，无活状态）：undefined → 'orchestration'。 */
export function resolveSessionMode(mode: SessionMode | undefined): SessionMode {
  return mode ?? 'orchestration';
}
