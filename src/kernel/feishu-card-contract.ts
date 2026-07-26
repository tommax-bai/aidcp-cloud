/**
 * 飞书卡 / 命令回执的结构化合同（change feishu-contract-seam / 定稿 §4.6.2；
 * change cloud-coupling-phase5 从 `src/comm/feishu-card-contract.ts` 抬入 kernel）。
 *
 * 拆仓边界：`src/feishu/**` 归 aidcp-api，其它域 MUST NOT 直接 import 飞书模块。
 * 「发方要发什么（审批卡入参、命令结果、命令回执）」是发方域的概念；
 * 「api 侧如何把它渲染成飞书交互卡」由 `src/feishu/cards.ts` 的 `buildXxxCard` 承担。
 * 由发布出口角色（content）、边云消息处理器与评论调度器（automation）消费；
 * 组合根（`src/server.ts`）把这些结构交给 api 侧 builder + messenger，
 * 完成「发方交出结构化事件 → api 构卡」的接缝。
 *
 * **抬入 kernel 的理由**：生产方横跨 content 与 automation 两域、渲染方在 api，三层共导。
 * 原落点 `src/comm/` 归 automation，会让 content 侧的发布出口角色为一组纯载荷类型跨服务边界。
 * 零 import、纯接口，满足 §4.7 kernel 准入。
 *
 * `src/feishu/types.ts` / `src/feishu/commands.ts` / `src/feishu/ws-receiver.ts` 保留自己的同名副本
 * （api 渲染侧的入参 / 回执形状）。两侧在组合根相遇：把本合同的结构交给 `buildPublishApprovalCard`
 * / `buildCommandResultCard` 时，结构不兼容会当场被 typecheck 挡下（漂移守卫落在组合缝、非静默）。
 *
 * 注：`CommandResult` 在此**不含** api 专属的 `card?: FeishuCard` / `silent?` 字段（automation 侧的
 * 生产者从不设它们）；本合同类型是 api 侧同名类型的可赋值子集，故组合根直传 builder 成立。
 */

/**
 * 回执配色级别：success=绿 ✅、warning=黄 ⚠️（未触发/未产出等「没成功但非崩」）、error=红 ❌（失败/异常）。
 */
export type CommandResultLevel = 'success' | 'warning' | 'error';

/** 指令回执卡片数据（automation 侧生产的子集；api 侧 `buildCommandResultCard` 渲染）。 */
export interface CommandResult {
  /** 原始指令文本，如 "/pause acc-01" */
  command: string;
  /** 执行是否成功 */
  ok: boolean;
  /** 配色级别（可选，缺省按 ok 推导）。 */
  level?: CommandResultLevel;
  /** 回执标题 */
  title: string;
  /** 回执正文（lark_md） */
  message: string;
  /** 相关账号 id */
  accountId?: string;
  /** 账号展示名。仅用于卡片文案；路由与审计仍使用 accountId。 */
  accountName?: string;
  /** 发布/命令平台展示名。 */
  platformName?: string;
}

/** 发布授权 payload（授权签名主体：卡片构建时烤入、随授权落盘）。 */
export interface PublishApprovalPayload {
  title: string;
  content: string;
  tags: string[];
  /** 授权所载内容版本号；缺省（老卡片/老签名）按 0 处理，向后兼容。 */
  contentVersion?: number;
}

/** 发布审批卡数据（automation 侧生产；api 侧 `buildPublishApprovalCard` 渲染）。 */
export interface PublishApprovalCardData extends PublishApprovalPayload {
  requestId: string;
  /** 发布账号 id；仅用于审批卡展示兜底，不进入授权 payload。 */
  accountId?: string;
  /** 发布账号展示名/昵称；展示优先级高于 accountId。 */
  accountName?: string;
  /** 发布平台展示名。 */
  platformName?: string;
  /** 已选择的发帖素材数量（FB 素材池等手工素材）。 */
  mediaCount?: number;
  /** 飞书图片资源 key；用于在审批卡中展示已选素材缩略图。 */
  mediaImageKeys?: string[];
}

/** 授权写入结果（first-writer-wins；与 api 侧 `ApprovalWriteResult` 同构）。 */
export interface ApprovalWriteResult {
  /** 本次是否写入成功（首个写者）。 */
  written: boolean;
  /** 若已被先前决定，返回其 approved 值（first-writer-wins）。 */
  alreadyDecided?: boolean;
  /**
   * 当前活跃授权轮次。持久 authority writer 必须返回；旧文件型测试/过渡适配可暂缺，
   * 但缺失时调用方不得伪造一次无 revision 的人工重批 trigger。
   */
  revision?: number;
}

/**
 * /comment 执行层回执（automation 侧命令面合同）：执行层据**触发结果**自判 ok/level。
 * - ok=true + 'success'：任务已成功触发开跑。
 * - ok=false + 'warning'：未触发（未解析到账号 / 已有任务在跑等，没成功但非崩）。
 * - ok=false + 'error'：触发失败（边端离线 / 异常）。
 */
export interface CommentCommandReceipt {
  ok: boolean;
  level: CommandResultLevel;
  title: string;
  message: string;
  /**
   * 机器可读的未触发原因（仅瞬时、值得同一小时格内重试的原因才置位）。缺省 = 不可重试。
   */
  code?: string;
}
