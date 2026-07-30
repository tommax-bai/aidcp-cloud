/**
 * 契约层：动作域、授权级别与「read_only / platform_write」执行分类。
 *
 * design §9：全托管不是一个总开关——API 以动作域保存可见授权，每个动作域取
 * disabled | require_approval | standing_authorized 三级（§24.4 D1/D2：无 override 档、
 * 无能力级审批下限）。
 *
 * 执行分类是期1 准入闸的判据：**期1 执行层只放行 read_only 动作；platform_write
 * 在准入时以 reason_code = 'capability_not_available' 明确拒绝**（不是静默跳过，
 * 不是近似回退）。分类按「是否产生平台外部写入」判定，与 CapabilityDefinition.sideEffect
 * 的 'external_write' 对齐。
 */

/** 动作域全集（design §9 表）。 */
export type ActionDomain =
  | 'research.read'
  | 'interaction.light'
  | 'interaction.proactive_comment'
  | 'interaction.inbound_reply'
  | 'content.create'
  | 'publish.submit'
  | 'message.direct';

export const ACTION_DOMAINS = [
  'research.read',
  'interaction.light',
  'interaction.proactive_comment',
  'interaction.inbound_reply',
  'content.create',
  'publish.submit',
  'message.direct',
] as const satisfies readonly ActionDomain[];

/**
 * 动作域授权级别（design §9）。既有配置 off | review | auto_approve 由适配器映射到
 * 本标准模型，不改变用户当前可见配置。即使 standing_authorized 也不能绕过任何
 * 实时安全闸（Edge/页面身份、平台能力、RiskController、配额冷却、紧急停止、平台确认）。
 */
export type AuthorizationLevel = 'disabled' | 'require_approval' | 'standing_authorized';

export const AUTHORIZATION_LEVELS = [
  'disabled',
  'require_approval',
  'standing_authorized',
] as const satisfies readonly AuthorizationLevel[];

/**
 * 动作执行分类：
 * - `read_only`：不产生平台外部写入（搜索、浏览、深读、评估、导航）；
 * - `platform_write`：产生平台可见副作用（点赞、评论、发布、回复、私信）。
 *   注意 `content.create` 虽不直接写平台，但会消耗 AI/内容预算并产出待发布物，
 *   本分类只回答「平台有没有被写」，故创作请求本身按其落点能力判定。
 */
export type ActionExecutionClass = 'read_only' | 'platform_write';

export const ACTION_EXECUTION_CLASSES = [
  'read_only',
  'platform_write',
] as const satisfies readonly ActionExecutionClass[];

/**
 * 动作域 → 执行分类的冻结映射（纯对象字面量，非活状态）。
 *
 * 裁量说明（design 未显式给出该映射，判据 = 是否触达平台写入面）：
 * - `research.read` 是唯一 read_only 域：期1 只读研究纵切（design Phase 4 对应
 *   persona-refresh-research）全部落在该域；
 * - `content.create` 归 platform_write：它启动的创作子作业最终服务于外部写入链路，
 *   且消耗预算、需要授权域判定，期1 一并拒绝，避免「创作了却永远发不出去」的半截工作。
 */
export const ACTION_DOMAIN_EXECUTION_CLASS = {
  'research.read': 'read_only',
  'interaction.light': 'platform_write',
  'interaction.proactive_comment': 'platform_write',
  'interaction.inbound_reply': 'platform_write',
  'content.create': 'platform_write',
  'publish.submit': 'platform_write',
  'message.direct': 'platform_write',
} as const satisfies Record<ActionDomain, ActionExecutionClass>;

/**
 * 按动作域配置的授权集（ManagedPlan / Task 的授权边界快照形态）。
 * 缺失键按 fail-closed 处理（等同 disabled），由实现层执行该缺省。
 */
export type ActionDomainAuthorization = Partial<Record<ActionDomain, AuthorizationLevel>>;
