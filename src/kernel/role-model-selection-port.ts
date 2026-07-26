/**
 * 「某个角色用哪个厂商 / 哪个模型 / 什么温度 / 思考开不开」的解析口（kernel）。
 *
 * 与图片模型选择那条口同形（同步读 + 异步取源 + 本地镜像），原因也一样：
 * 调用点是**同步**的、在每次模型调用的路径上。但这条口多一条设计决定，值得单独写明：
 *
 * **属主侧把答案算好再送，而不是把三张配置表送过去。**
 * 解析逻辑要读三层（角色覆盖 → 分类默认 → 全局），三张表全是 api 属主，
 * 而分类归属来自 api 侧的角色目录。把表送过去等于要求调用方也持有那份目录并复刻四层回落——
 * 那正是「两侧各写一份、各自编译通过、只有真跑才发现不一致」的形态。
 * 送**预解析结果**则只有一份实现，且调用方查表即可。
 *
 * 未登记角色 / 不带角色 → 用 `fallback`（即全局那一层），与单体下逐字一致：
 * 单体里这两种情况本来就穿过前两层落到全局。
 *
 * `thinkingMode` 内联 `'off' | 'on'` 字面量而不 import 角色目录的同名类型 ——
 * 照 `llm-contract.ts` 的既有判例（kernel MUST NOT 反向依赖 api 属主的角色目录）。
 */

export interface RoleModelSelection {
  /** 文本厂商标识（已归一）。 */
  provider: string;
  model: string;
  /** 未配则 undefined —— 出口据此不发温度字段，与单体零回归。 */
  temperature?: number;
  /** 未配则 undefined —— 出口据此不发思考字段，与单体零回归。 */
  thinkingMode?: 'off' | 'on';
}

export interface RoleModelSelectionSnapshot {
  /** 全局那一层。不带角色、或角色未登记时用它。 */
  fallback: RoleModelSelection;
  /** 已登记角色的**预解析**结果（属主侧算好）。 */
  byRole: Record<string, RoleModelSelection>;
}

/** 异步取源：属主侧实现，可跨进程。镜像刷新器调它。 */
export interface RoleModelSelectionSource {
  fetchRoleModelSelections(): Promise<RoleModelSelectionSnapshot>;
}

/** 同步读：调用点持有的那一口。单体 = 就地解析；拆进程 = 本地镜像查表。 */
export interface RoleModelSelectionReader {
  forRole(role?: string): RoleModelSelection;
}
