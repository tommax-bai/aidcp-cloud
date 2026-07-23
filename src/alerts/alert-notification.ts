/**
 * 告警的 automation 侧结构化合同（change feishu-contract-seam / 定稿 §4.6.2）。
 *
 * 拆仓边界：`src/feishu/**` 归 aidcp-api，automation MUST NOT 直接 import 飞书模块。
 * 告警 severity / 数据模型是 automation 域（alerts 表属主，见 boundaries §4.7「alerts 表 owner」）
 * 自己的概念——「发生了什么、多严重」，与「api 侧如何渲染成飞书卡片」是两件事。
 * 故把 automation 需要的告警类型放在这里（alerts 域，automation 层），由 alert 落库与验证码协调器消费；
 * 真正的飞书卡由 api 侧 `buildAlertCard` 渲染，automation 只把结构化 `AlertData` 交给注入的下发口。
 *
 * `src/feishu/types.ts` 保留自己的同名副本（api 渲染侧的入参形状），两侧在组合根（`src/server.ts`）
 * 相遇：组合根把本合同的 `AlertData` 交给 `buildAlertCard`，结构不兼容会当场被 typecheck 挡下
 * （即漂移守卫落在组合缝，而非静默）。纯类型 + 一个常量，无任何 import，满足 kernel-free 的同层引用。
 */

/** 异常严重度（与 risk-control.md §7 / product-exception.md §1 对齐）。 */
export const ALERT_SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** 告警卡片数据（automation 侧结构化事件；api 侧据此渲染实时通知卡）。 */
export interface AlertData {
  severity: AlertSeverity;
  /** 告警标题，如 "验证码弹出" */
  title: string;
  /** 涉及账号 id */
  accountId?: string;
  /** 账号展示名 */
  accountName?: string;
  /** 详细描述（lark_md） */
  detail: string;
  /** 引导动作按钮文案，默认"去处理" */
  actionText?: string;
  /** 引导动作链接（去 Web） */
  actionUrl?: string;
}
