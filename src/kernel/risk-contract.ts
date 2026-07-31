export const RISK_ACTIONS = ['like', 'collect', 'comment', 'follow', 'publish', 'view', 'search', 'comment_like', 'join_group', 'dm_reply'] as const;

export type RiskAction = (typeof RISK_ACTIONS)[number];

// 注意：search / comment_like / join_group / dm_reply 刻意不进 InteractionAction —— 它们没有「每笔记一次」语义，
// 故不落 risk_interactions 去重表、不进 likedNoteStore；只走 risk_counters 配额计数（独立一档）。
export type InteractionAction = Extract<RiskAction, 'like' | 'collect' | 'comment'>;

export const RISK_QUOTA_LEVELS = ['conservative', 'normal', 'aggressive'] as const;
export type RiskQuotaLevel = (typeof RISK_QUOTA_LEVELS)[number];

export const RISK_STATUSES = ['normal', 'warned', 'restricted', 'frozen'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export type RiskWindow = 'minute' | 'hour' | 'day';

export type ActionQuota = Record<RiskAction, number>;

export type WindowQuotas = Record<RiskWindow, ActionQuota>;

/**
 * 配额数字提供者（change safety-quota-config，stream D）：按档位给出三窗口生效数字。
 * 由 `QuotaConfigStore`（config 层）实现（同步读内存镜像、缺值回落写死默认、永不抛），
 * 注入 `RiskController` 供 `effectiveQuotas()` 热加载。风控层只持接口、不依赖 config 层实现。
 */
export interface QuotaProvider {
  windowQuotasFor(level: RiskQuotaLevel): WindowQuotas;
}

/**
 * 账号养号事实提供者（change account-level-slow-start）：冷启动 / 慢启动 clamp 的**现读**输入。
 * 由 `AccountStore`（account 层）实现（同步读内存镜像、永不抛），注入 `RiskController` 供
 * `effectiveQuotas()` 每次现算。风控层只持接口、不依赖 account 层实现。
 *
 * **契约与 QuotaProvider 逐字同款：同步、零 IO、永不抛**——`effectiveQuotas()` 是同步热路径
 * （canDo / explain / dailyRemaining 全同步调用，canDo 在浏览闭环每个动作都调），绝不能 await PG。
 *
 * **为什么是现读而非构造期快照**：RiskControllerRegistry 的 controller Map 永不驱逐（全文无
 * delete / invalidate / TTL），controller 活到进程结束；面板仪表盘还会为每个有计数的账号
 * materialize controller。构造期读入 → 勾选会「写库成功、HTTP 回 200、行为纹丝不动到重启，且零日志」。
 * 现读做对之后，「Map 永不驱逐」从一个需要被绕开的坑变成一个不再相关的事实。
 */
export interface AccountNurtureProvider {
  /**
   * 账号平台。**缺失 → undefined（未知），MUST NOT 回落 xiaohongshu**：回落一次就是 FB 号按
   * 小红书曲线跑（D1 view=50 而非 20，差 2.5 倍）。调用方据此判 eligible=false、不 clamp。
   */
  platformFor(accountId: string): string | undefined;
  /**
   * 当前唯一绑定环境的慢启动起点（epoch ms，已对齐上海日起点）；null = 环境关/无绑定/绑定歧义。
   * 签名仍以 accountId 查询是因为 RiskController 按账号单写；事实所有权属于环境，MUST NOT 回读账号旧列。
   */
  slowStartSinceFor(accountId: string): number | null;
  /**
   * 当前执行目标下的环境慢启动毕业时刻。null = 尚未毕业或无唯一环境。
   * 毕业事实是粘滞的；只有显式重新开启慢启动才会清除。
   */
  slowStartCompletedAtFor?(accountId: string): number | null;
  /**
   * Facebook 当前执行目标的慢启动总天数与逐日上限。缺省保留编译默认。
   * 返回值必须是同步内存快照；调用方不得在风控热路径做 IO。
   */
  facebookSlowStartPolicy?(): {
    totalDays: number;
    dailyCaps: ActionQuota[];
  };
  /**
   * 账号入库时刻（epoch ms）。**仅供 env 全局旁路 `AIDCP_COLDSTART_RAMP=true` 这条历史路径**，
   * 且仅在账号级未开启时才被查询（见 RiskController 的 anchor 解析优先级）。
   * MUST NOT 用作慢启动起点——它记的是「第一次连上本云端库」，不是平台注册时间。
   */
  createdAtFor(accountId: string): number | undefined;
}

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
  // 注意：不含 'quota_exceeded'——撞自己的速率配额是节奏背压、不是风控信号（change
  // decouple-quota-hit-from-risk）。威胁态只由平台可观测信号 + 运营手动信号驱动。
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
