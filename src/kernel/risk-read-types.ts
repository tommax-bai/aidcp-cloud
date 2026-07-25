/**
 * 风控的**账号维只读投影**纯类型端口（kernel 段）。
 *
 * 只放 api 侧「展示用」的读接口与其返回类型——供后台仪表盘 / 面板组装账号风控视图。
 * **绝不含任何写方法**（applySignal / recoverRestricted / setQuotaLevel / record 都不在此），
 * 也不含记账、状态迁移、配额消耗等副作用面：那些留在 src/risk/ 的实现内部，本文件永不感知。
 *
 * 载荷结构（WindowQuotas、SlowStartView 视图）在本 kernel 文件定义为纯类型，结构照 risk-controller
 * 现有返回逐字对齐；本文件不 import src/risk/ 任何模块，风控实现也不 import 本契约（结构兼容即可）。
 * 这样取数方进程按本端口取风控展示投影时，拿不到任何存储 / 状态机实现。
 *
 * **四个词表联合已于 change cloud-kernel-collapse-duplicate-risk-enums 收口成别名**（2026-07-26）。
 * 此前它们在本文件「逐字重定义」了一遍：那在词表还住在业务层时是**必要的**（kernel 不能反向依赖），
 * 但 Phase 2 把词表整体提进了 `./risk-contract.ts` 之后，两份就都在 kernel 里了 ——
 * **kernel → kernel 是允许方向，门禁对这种重复完全无感**，谁加一个动作只改一边，编译全绿、
 * 后台配额表悄悄少一格。别名让「重复」这件事在结构上不可能发生。
 *
 * kernel 门禁（§4.7）：纯类型 + 接口。无 SQL / 无 fetch / 无 LLM 标识符 / 无实现类名（不出现
 * RiskController 之类）/ 无模块级活状态 / 无 setTimeout。
 */

import type { RiskAction, RiskQuotaLevel, RiskStatus, RiskWindow } from './risk-contract.js';

// 四个只读投影的词表**恒等于**权威词表，不再各留一份。名字保留是为了让调用点一行不改，
// 也保留「这是只读展示面」的语义标记。
/** 风控状态机四态。 */
export type RiskStatusView = RiskStatus;

/** 配额档位三档。 */
export type RiskQuotaLevelView = RiskQuotaLevel;

/** 限频窗口。 */
export type RiskWindowView = RiskWindow;

/** 受配额约束的动作全集。只作为配额结构的键集使用，展示端不据此下发命令；顺序不承载语义。 */
export type RiskActionView = RiskAction;

/** 某窗口下逐动作的生效上限数字。 */
export type ActionQuotaView = Record<RiskActionView, number>;

/** 三窗口 × 逐动作的生效配额（effectiveQuotas 的返回结构）。 */
export type WindowQuotasView = Record<RiskWindowView, ActionQuotaView>;

/**
 * 账号风控状态的只读快照（照 RiskState 逐字重定义）。
 * 时间戳为 epoch ms；lastSignalAt 缺失为 null（区别真实 0）。
 */
export interface RiskStateView {
  accountId: string;
  status: RiskStatusView;
  quotaLevel: RiskQuotaLevelView;
  signalCount: number;
  lastSignalAt: number | null;
  statusSince: number;
  updatedAt: number;
}

/** 慢启动不合格原因（照 SlowStartIneligibleReason 逐字重定义）。 */
export type SlowStartIneligibleReasonView =
  | 'platform_unsupported'
  | 'platform_unknown'
  | 'globally_disabled'
  | 'binding_unknown'
  | 'binding_conflict';

/**
 * 慢启动对外投影（照 SlowStartView 逐字重定义）。
 * active 时 day 为 1..totalDays；binding=false 表示「勾了但当前档位已更严、不额外收紧」。
 */
export interface SlowStartViewData {
  state: 'off' | 'active' | 'graduated';
  day?: number;
  totalDays: number;
  since?: number;
  binding?: boolean;
  eligible: boolean;
  ineligibleReason?: SlowStartIneligibleReasonView;
}

/**
 * 风控**只读投影端口**：api 侧展示用，全部方法按账号入参、只读、无副作用。
 *
 * 方法为 Promise 返回：底层按账号 materialize 是异步的，且本端口意在可被内部 HTTP 化
 * （取数方进程 → 托管风控的进程），故一律异步以对齐传输。返回类型全为本文件的纯 kernel 视图类型。
 *
 * **载荷不确定处收窄**：如某方法未来需返回结构未定的附加投影，用 `unknown` 或窄 record，
 * 绝不在本 kernel 文件回引 src/risk/ 的具体类型。
 */
export interface RiskReadPort {
  /** 账号当前风控状态快照。 */
  getState(accountId: string): Promise<RiskStateView>;
  /** 账号当前生效配额（已叠风控缩放 + 慢启动 clamp）。 */
  effectiveQuotas(accountId: string): Promise<WindowQuotasView>;
  /** 账号慢启动投影（徽章天数 / binding / eligible）。 */
  slowStartView(accountId: string): Promise<SlowStartViewData>;
}
