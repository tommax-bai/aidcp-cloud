/**
 * 面板对 automation 域的**只读投影**纯类型端口（kernel 段，Block③ 物理拆库 L3）。
 *
 * 背景：面板只读组合层（src/panel/panel-store.ts，api 属主）历史里**直接 SELECT** 了 automation
 * 属主的 risk_counters / risk_state / alerts / interaction_feed / interaction_target_meta。
 * 物理拆库后 api 进程/库不再拥有这些表 —— 面板 MUST 经本端口向 automation 域取投影，
 * **绝不直连 automation 的库、也绝不知道其表结构**。
 *
 * 同进程期（Block③ 单进程三池）：本端口由 automation 侧的实现（跑在 automation 自己的连接池上）满足，
 * 逐字节等价现状。拆进程后（Block②）同一端口换 HTTP 客户端指向 automation 服务，面板侧零改动。
 *
 * 与 RiskReadPort（账号维风控**状态**投影：getState / effectiveQuotas / slowStartView）互补：
 * 本端口是**面板专用的跨表聚合读**（今日计数聚合、批量风控态、告警、互动流），形状按面板需要定。
 *
 * kernel 门禁（§4.7）：纯类型 + 接口。无 SQL / 无 fetch / 无 LLM 标识符 / 无实现类名 /
 * 无模块级活状态 / 无 setTimeout。时间戳一律 epoch ms（HTTP 化友好，Date 不过网）。
 */

/** 今日某动作的全局计数（SUM(count)，跨账号）。action 为裸串；动作词表的收窄与映射留给面板侧。 */
export interface PanelActionTotal {
  action: string;
  total: number;
}

/** 今日某账号某动作的计数（GROUP BY account_id, action）。 */
export interface PanelAccountActionTotal {
  accountId: string;
  action: string;
  total: number;
}

/** 今日点赞 / 浏览计数（likeRate 用）。 */
export interface PanelLikeViewTotal {
  likes: number;
  views: number;
}

/**
 * 账号风控态投影（原 `accounts LEFT JOIN risk_state` 的 risk 侧）。
 * **无风控行的账号不在返回集内**：面板据缺失映射 null，逐字等价 LEFT JOIN。
 */
export interface PanelRiskStateProjection {
  accountId: string;
  status: string | null;
  quotaLevel: string | null;
  signalCount: number | null;
}

/** 告警行（面板 listAlerts）。时间戳 epoch ms；severity/type 为裸串，收窄留给面板侧。 */
export interface PanelAlertProjection {
  alertId: number;
  severity: string;
  type: string;
  accountId: string | null;
  title: string;
  detail: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

/** 互动流行（面板 listInteractions；feed LEFT JOIN target_meta）。title/url 缺失为 null。 */
export interface PanelInteractionProjection {
  accountId: string;
  targetId: string;
  action: string;
  title: string | null;
  url: string | null;
  interactedAt: number;
}

/**
 * 面板对 automation 域的只读投影端口。全部方法**只读、无副作用、异步**（对齐未来 HTTP 传输）。
 *
 * 缺表（表未迁移）等降级策略由**面板侧**决定：面板对 listAlerts / listInteractions 的
 * `42P01`（关系不存在）历史降级为空数组，该策略保留在面板层（本端口只如实抛/传数据）。
 */
export interface PanelAutomationReader {
  /** 今日各动作全局计数（risk_counters 聚合）。 */
  todayActionTotals(): Promise<PanelActionTotal[]>;
  /** 今日各账号 × 动作计数（risk_counters 聚合）。 */
  todayActionTotalsByAccount(): Promise<PanelAccountActionTotal[]>;
  /** 今日点赞 / 浏览计数（risk_counters 聚合）。 */
  todayLikeViewTotal(): Promise<PanelLikeViewTotal>;
  /**
   * 批量风控态投影：`accountIds` 省略=全部账号，给定=仅这些账号。
   * 返回集只含**有风控行**的账号（面板据缺失映射 null）。
   */
  riskStateProjection(accountIds?: string[]): Promise<PanelRiskStateProjection[]>;
  /** 告警列表（默认仅未解决）。 */
  listAlerts(options?: { limit?: number; includeResolved?: boolean }): Promise<PanelAlertProjection[]>;
  /** 互动流（feed + 元数据）；可按账号过滤。 */
  listInteractions(options?: { limit?: number; accountId?: string }): Promise<PanelInteractionProjection[]>;
}
