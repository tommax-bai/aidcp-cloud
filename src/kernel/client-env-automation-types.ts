/**
 * 客户环境生命周期（api 属主 `client-auth/client-user-store.ts`）对 automation 域的
 * **只读投影**纯类型端口（kernel 段，Block③ 物理拆库 L3）。
 *
 * 背景：客户↔环境归属存储（api 属主）历史里**直接 SELECT** 了 automation 属主的
 * `interaction_offboards`（离场记录）/ `interaction_auth_state`（互动授权绑定）/ `risk_state`（风控态）。
 * 物理拆库后 api 进程/库不再拥有这些表 —— 读方 MUST 经本端口向 automation 域取投影，
 * **绝不直连 automation 的库、也绝不知道其表结构**。
 *
 * 同进程期（Block③ 单进程三池）：本端口由 automation 侧实现（跑在 automation 自己的连接池上）满足，
 * 逐字节等价现状。拆进程后（Block②）同一端口换 HTTP 客户端指向 automation 服务，读方零改动。
 *
 * **本端口只覆盖「顶层、无行锁、不在事务内」的那批读**。同文件另有 8 处 automation 读夹在
 * `BEGIN/COMMIT` 里或带 `FOR UPDATE`/`FOR SHARE` 跨库行锁（环境注销关键路径）——**跨库锁与跨库事务
 * 原子性接口化解决不了**，须改最终一致（outbox / 2-phase）并接受语义变化，不在本端口范围内。
 *
 * 与 `PanelAutomationReader`（面板专用跨表聚合读）互补：形状各按消费方需要定，互不复用。
 *
 * kernel 门禁（§4.7）：纯类型 + 接口。无 SQL / 无 fetch / 无 LLM 标识符 / 无实现类名 /
 * 无模块级活状态 / 无 setTimeout。时间戳一律 epoch ms（HTTP 化友好，Date 不过网）。
 */

/** 离场记录状态（automation 属主表的取值域；跨域契约的一部分，读方据此收窄）。 */
export type OffboardProjectionState = 'pending_edge' | 'dispatched' | 'tombstoned' | 'purged';

/** 离场原因（同上）。 */
export type OffboardProjectionReason = 'environment_unbind' | 'customer_terminated' | 'admin_revoked';

/** 一条离场记录投影。时间戳 epoch ms。 */
export interface OffboardProjection {
  offboardId: string;
  envKey: string;
  accountId: string;
  state: OffboardProjectionState;
  reason: OffboardProjectionReason;
  requestedAt: number;
  purgeDueAt: number;
}

/**
 * 账号风控态投影（原 `accounts LEFT JOIN risk_state` 的 risk 侧）。
 * **无风控行的账号不在返回集内**：读方据缺失映射 null，逐字等价 LEFT JOIN。
 */
export interface EnvRiskStateProjection {
  accountId: string;
  status: string | null;
  quotaLevel: string | null;
}

/**
 * 客户环境生命周期对 automation 域的只读投影端口。全部方法**只读、无副作用、异步**（对齐未来 HTTP 传输）。
 *
 * 缺表（`42P01`，首启竞态 / 表未迁移）**不在本端口吞**：如实抛出，由读方按其历史降级策略处理
 * （读方对全局环境注册表读的 42P01 历史降级为空数组，该策略保留在读方层）。
 */
export interface ClientEnvAutomationReader {
  /** 单条离场记录（按 offboardId + 归属客户双条件，归属过滤下推到属主侧）；不存在返回 null。 */
  offboardForUser(offboardId: string, userId: string): Promise<OffboardProjection | null>;
  /**
   * 全部**未清除**（state ≠ purged）的微信离场记录。
   * 属主侧对 (platform, env_key) 在未清除态上唯一 ⇒ 每个环境键至多一条，读方可按 envKey 直接索引。
   */
  activeWechatOffboards(): Promise<OffboardProjection[]>;
  /**
   * 给定环境键中**已有微信互动授权绑定**的那些（原 `JOIN interaction_auth_state` 的存在性侧）。
   * 属主侧 (platform, env_key) 唯一 ⇒ 结果对入参去重后是子集，不会放大基数。空入参返回空。
   */
  wechatBoundEnvKeys(envKeys: string[]): Promise<string[]>;
  /** 某账号当前绑定的微信互动环境键（属主侧 (platform, account_id) 为主键 ⇒ 0 或 1 条）。 */
  wechatEnvKeysForAccount(accountId: string): Promise<string[]>;
  /**
   * 某环境在给定平台上的互动授权绑定账号；**确无绑定**返回 null（属主侧 (platform, env_key) 唯一 ⇒ 0 或 1 条）。
   *
   * **失败方向 MUST 是抛，MUST NOT 降级成 null**：读方把 null 当作「这个环境确实没绑账号」，
   * 据此改走「无绑定」分支（拒绝解绑 / 只挂准入不写台账 / 判定互动请求未授权）。把跨域读失败降级成
   * null，等于让一次连接抖动看起来像一条业务事实 —— 那正是本仓禁止的静默假成功。
   */
  boundAccountForEnv(envKey: string, platform: string): Promise<string | null>;
  /** 批量风控态投影；只返回**有风控行**的账号（读方据缺失映射 null）。空入参返回空。 */
  riskStateProjection(accountIds: string[]): Promise<EnvRiskStateProjection[]>;
}
