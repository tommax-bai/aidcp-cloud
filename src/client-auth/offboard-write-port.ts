/**
 * 离场写入窄接口（change offboard-saga）。
 *
 * 拆分方案 §5.1 把互动域离场表（interaction_offboards / interaction_offboard_audit /
 * interaction_auth_state / interaction_runtime_controls）定为 **aidcp-automation 单写**。
 * client-user-store（aidcp-api）历史上在自己的事务里直写这些表——那是跨 owner 单事务，违反单写。
 *
 * 收口范式照抄风控刚落地的 `AccountOwnershipPort` 的**反向**：
 *   - 那里 automation 是消费方、api 是属主/实现方（接口定义在 automation 侧的 risk/ownership.ts）；
 *   - 这里 **api 是消费方、automation 是属主/实现方**，故接口定义在本 api 文件里，
 *     实现方（automation 的 offboard-write-adapter）**只做结构匹配、绝不 import 本接口**，
 *     由组合根 server.ts 把实现注入 ClientUserStore。拆进程时把注入换成一次内部 HTTP 即可，
 *     调用点一行不用改。
 *
 * **原子性口径（本 change 的显式取舍）**：今天三层同进程、同库，本接口的方法接收调用方的事务句柄
 * （`OffboardWriteQueryable`），离场写与 api 侧的 scope 收权仍在**同一事务**里提交——行为与改动前
 * **逐位等价**（本批 #1 铁律：行为 MUST 完全等价）。真正把「跨 owner 单事务」拆成两段独立提交，
 * 属于进程切分那一步（届时 api 侧的 scope 事务提交后，automation 侧经内部命令消费）；
 * 现在先把**写入通道**收口到属主接口，把这一步变成进程切分时的一处局部改动。
 *
 * **Block③ L3 更新**：原先本接口还有三个方法（`markCleanupGrantIssued` / `markCleanupGrantConsumed` /
 * `insertOffboardAudit`）服务「离场清理授权」的签发与烧票。那两笔事务碰的表**全是 automation 属主**、
 * 与任何 api 写都不共事务，故已整体收回属主域（自开事务、跑 automation 池）——见 kernel 端口
 * `offboard-cleanup-grant-types.ts` 与属主实现 `interactions/offboard-cleanup-grant-ops.ts`。
 * 本接口因此只剩**确实与 api 侧归属收权共提交**的那三个方法，它们才是真正待最终一致重设计的部分。
 */
import type pg from 'pg';

/** 与 interaction-store 的 Queryable 同形：既可传连接池也可传事务连接。 */
export type OffboardWriteQueryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/** interaction_offboards 的裸行（属主返回原始行，api 侧自行映射为对外视图，避免把 api 视图类型泄进 automation）。 */
export interface OffboardRow {
  offboard_id: string;
  env_key: string;
  account_id: string;
  state: 'pending_edge' | 'dispatched' | 'tombstoned' | 'purged';
  reason: 'environment_unbind' | 'customer_terminated' | 'admin_revoked';
  requested_at: Date;
  purge_due_at: Date;
}

export interface EnqueueOffboardInput {
  userId: string;
  envKey: string;
  accountId: string;
  reason: OffboardRow['reason'];
  actor: string | null;
}

export interface RevokeInteractionAccessInput {
  accountId: string;
  actor: string | null;
  requireAuthState: boolean;
}

/**
 * automation 属主离场表的写入口（单写者 = automation 的 offboard-write-adapter）。
 * 每个方法都接调用方的事务句柄，故在同库同进程下与改动前同事务、行为等价。
 */
export interface OffboardWritePort {
  revokeInteractionAccess(q: OffboardWriteQueryable, input: RevokeInteractionAccessInput): Promise<void>;
  enqueueOffboard(q: OffboardWriteQueryable, input: EnqueueOffboardInput): Promise<OffboardRow>;
  enqueueProvisionedUnboundOffboard(q: OffboardWriteQueryable, input: { userId: string; envKey: string }): Promise<OffboardRow>;
}
