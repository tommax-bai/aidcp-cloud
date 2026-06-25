/**
 * 面板 API 层的注入依赖与配置类型。
 *
 * 面板是进程内 BFF：只读组合现有存储 + 进程内活态，加薄命令外观。
 * 注入镜像 DefaultMessageHandler 的构造方式（main() 已接好的单例）。
 * task 1（骨架）仅用到 edgeServer；其余依赖留待 task 5 只读接口与 task 4 写接口。
 */

import type { RiskController, RiskQuotaLevel, RiskAction, SessionInteractionBudget } from '../risk/index.js';
import type { ConceptStore, BotChatStore } from '../cache/index.js';
import type { PublishLogStore } from '../publish-agent/publish-log-store.js';
import type { EventBus } from '../event-bus/index.js';
import type { PanelUser } from './auth.js';
import type { PanelStoreReader } from './panel-store.js';
import type { PublishApprovalPayload, ApprovalWriteResult } from '../feishu/index.js';
import type { LlmUsageQuery, LlmUsagePayload } from '../metrics/token-usage-store.js';
import type { NotificationContact, NotificationContactManual } from '../cache/notification-contact-store.js';

export interface PanelDeps {
  riskController: RiskController;
  publishLogStore: PublishLogStore;
  conceptStore?: ConceptStore;
  botChatStore: BotChatStore;
  eventBus: EventBus;
  /** 在线边缘登记（结构类型，便于测试造桩）。onlineEdgeCount 为 staleness 校验后的真实在线数（D9）。 */
  edgeServer: { edgeCount(): number; onlineEdgeCount(): number };
  /** 只读查询层（dashboard / accounts / content / analytics 聚合）。 */
  panelStore: PanelStoreReader;
  /** 发布编排器 in-flight 队列状态（/api/content/queue）。 */
  publishOrchestrator: { getStatus(): { status: string; snapshot: unknown } };
  /** 发布审批写回（first-writer-wins，与飞书共享信号文件契约 AC-PUB-*）；返回 written/alreadyDecided，绝不 published。 */
  writeApprovalSignal: (
    requestId: string,
    approved: boolean,
    payload: PublishApprovalPayload,
  ) => Promise<ApprovalWriteResult>;
  /** 账号命令（durable，与飞书 actions 共享 accountState 底层）；返回真实结果（resume 带恢复 edge 数）。 */
  commandActions: {
    pause(accountId: string): Promise<{ accountId: string; status: 'paused' }>;
    resume(accountId: string): Promise<{ accountId: string; status: 'active'; resumedEdges: number }>;
    /**
     * 调度启停（V1 task 9.4）：start/stop 现役单全局 RoleDispatcher；回报真实在线 edge 数。
     * 偏离：单账号现实下为全局开关（accountId 信息性）；per-edge 拆分留到真多账号（design 步骤 8）。
     * 未注入则 /dispatch 返回 503（向后兼容）。
     */
    dispatch?(
      accountId: string,
      action: 'start' | 'stop',
    ): Promise<{ accountId: string; dispatch: 'started' | 'stopped'; changed: boolean; edgesOnline: number }>;
    /** 调度引擎当前是否活跃（dashboard summary 读）。 */
    dispatchActive?(): boolean;
  };
  /** 风控注册表（V1 写路由 risk/status、risk/quota 按账号取 controller；单写 PER ACCOUNT）。 */
  riskRegistry: { getController(accountId: string): Promise<RiskController> };
  /**
   * 模型与凭据配置（change console-model-provider-config）。未注入则 /api/config/* 返回 503。
   * 明文密钥绝不经此外观回传；setCredential 主密钥缺失以 {ok:false} 诚实可辨，绝不假成功。
   */
  modelConfig?: PanelModelConfig;
  /**
   * 角色级模型/温度配置（change console-role-model-config）。未注入则 /api/roles* 返回 503。
   * 白名单制：只暴露现役 + 真调大模型的角色；写非乐观回真态；无效模型名探活不过诚实拒绝绝不落库。
   */
  roleConfig?: PanelRoleConfig;
  /**
   * 分类级模型默认配置（change role-model-category-config，item 5/6）。未注入则 /api/categories* 返回 503。
   * 白名单制：只暴露含文本角色的分类；写非乐观回真态；无效模型名探活不过诚实拒绝绝不落库。
   */
  categoryConfig?: PanelCategoryConfig;
  /**
   * 角色 prompt 只读预览（change role-prompt-visibility）。未注入则 `/api/roles/:id/prompt` 返回 503。
   * 纯只读：无任何写路径；单角色渲染失败优雅降级 `available:false`，绝不崩、绝不连累闭环。
   */
  rolePromptPreview?: PanelRolePromptPreview;
  /**
   * 账号人设配置（change account-persona-config，stream F）。未注入则 /api/persona* 返回 503。
   * 写非乐观回真态；非法人设（soul 校验不过）诚实拒绝 persona_invalid，绝不落库；未知账号 404。
   */
  persona?: PanelPersonaConfig;
  /**
   * 安全限额配置（change safety-quota-config，stream D）。未注入则 /api/quotas* 返回 503。
   * 写非乐观回真态；非法数字整块拒（invalid_value），绝不部分落库、绝不假成功；不碰风控状态单写路径。
   */
  quotaConfig?: PanelQuotaConfig;
  /**
   * 单场会话上限配置（change session-limits-to-quota-layer）。未注入则 /api/session-limits 返回 503。
   * 按账号编辑单场时长 + 六项互动预算；写非乐观回真态；非法整块拒（invalid_value），绝不部分落库；
   * 只动 session_config，不碰风控状态单写路径、不经协议。
   */
  sessionLimits?: PanelSessionLimits;
  /**
   * token 用量只读查询（change llm-token-usage-stats）。未注入则 /api/llm-usage 返回 503。
   * 纯只读预聚合表（按账号/角色/模型/10 分钟桶）；缺表回落空；不写、不碰风控/发布/edge。
   */
  tokenUsage?: { usage(query: LlmUsageQuery): Promise<LlmUsagePayload> };
  /**
   * 通知联系人名册（change notification-contact-registry）。未注入则 /api/notification/contacts* 返回 503。
   * 读=按账号联系人列表（accountId 必填）；写=人工字段（微信/标签/备注）只动侧表、绝不碰事件流水。
   * 按账号隔离；不提供全账号合并视图（防把运营各账号粉丝交叉关联的 PII 泄露）。
   */
  notificationContact?: {
    listContacts(accountId: string, limit?: number, offset?: number): Promise<NotificationContact[]>;
    setManual(
      accountId: string,
      senderKey: string,
      manual: NotificationContactManual,
      updatedBy: string | null,
    ): Promise<void>;
  };
}

/** 凭据视图（永不含明文）。source：db=库内加密凭据 / env=回退环境变量 / none=未配置。 */
export interface ModelConfigCredentialView {
  field: string;
  configured: boolean;
  maskedHint: string | null;
  source: 'db' | 'env' | 'none';
}

/** GET /api/config/model 的形状（永不含明文密钥）。 */
export interface ModelConfigView {
  provider: string;
  baseUrl: string;
  textModel: string;
  imageModel: string;
  credential: ModelConfigCredentialView;
  /** 主加密密钥是否就位——凭据能否在后台编辑。 */
  canEditCredential: boolean;
}

export type SetCredentialResult =
  | { ok: true; field: string; maskedHint: string }
  | { ok: false; reason: 'cred_key_missing' };

export interface PanelModelConfig {
  getView(): Promise<ModelConfigView>;
  /** 改模型名（热加载即时生效），返回写后真态视图。 */
  setModel(patch: { textModel?: string; imageModel?: string }, updatedBy: string): Promise<ModelConfigView>;
  /** 加密保存密钥（重启生效）；主密钥缺失返回 {ok:false}，明文绝不回传。 */
  setCredential(field: string, value: string, updatedBy: string): Promise<SetCredentialResult>;
}

// ── 角色级配置（change console-role-model-config）──────────────────────────────

/** 生效模型来源（change role-model-category-config）：覆盖 / 继承分类 / 继承默认 / 图像全局。 */
export type ModelEffectiveSource = 'override' | 'category' | 'default' | 'image';

/** 单角色目录行 + 生效值（GET /api/roles 形状）。 */
export interface RoleConfigRowView {
  roleId: string;
  displayName: string;
  group: 'browse' | 'publish';
  /** 所属分类（稳定 key，与 category_config.category_id 一致）。 */
  category: string;
  llmKind: 'text' | 'image' | 'none';
  tunableTemperature: boolean;
  /** 当前生效模型（文本类=覆盖/分类默认/全局 textModel；图像类=全局 imageModel）。 */
  effectiveModel: string;
  /** 生效模型来源：override=按角色覆盖 / category=继承分类默认 / default=继承全局默认 / image=图像全局。 */
  effectiveSource: ModelEffectiveSource;
  /** 是否存在按角色模型覆盖。 */
  modelOverridden: boolean;
  /** 温度覆盖（null=用代码默认）。 */
  temperatureOverride: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface RoleConfigCatalogView {
  roles: RoleConfigRowView[];
}

/** PUT /api/roles/:roleId/config 的入参补丁。null/'' = 清除覆盖（回落）。 */
export interface RoleConfigPatch {
  model?: string | null;
  temperature?: number | null;
}

export type RoleConfigSetResult =
  | { ok: true; view: RoleConfigCatalogView }
  | {
      ok: false;
      reason:
        | 'unknown_role'
        | 'model_not_configurable'
        | 'temperature_not_tunable'
        | 'temperature_out_of_range'
        | 'model_invalid';
    };

export interface PanelRoleConfig {
  /** 角色目录 + 生效值（白名单制）。 */
  getCatalog(): RoleConfigCatalogView;
  /** 按角色写模型/温度。校验+探活不过以 {ok:false} 诚实可辨，绝不落库。写后回真态视图。 */
  setRoleConfig(roleId: string, patch: RoleConfigPatch, updatedBy: string): Promise<RoleConfigSetResult>;
}

// ── 分类级模型默认（change role-model-category-config，item 5/6）──────────────────

/** 单分类目录行 + 分类默认生效值（GET /api/categories 形状）。 */
export interface CategoryConfigRowView {
  categoryId: string;
  displayName: string;
  order: number;
  /** 该分类默认模型的生效值：分类覆盖则用覆盖、否则回落全局「默认模型」(textModel)。 */
  effectiveModel: string;
  /** 是否存在分类默认覆盖（false=继承全局默认模型）。 */
  modelOverridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface CategoryConfigCatalogView {
  categories: CategoryConfigRowView[];
}

export type CategoryConfigSetResult =
  | { ok: true; view: CategoryConfigCatalogView }
  | {
      ok: false;
      reason: 'unknown_category' | 'category_not_configurable' | 'model_invalid';
    };

export interface PanelCategoryConfig {
  /** 分类目录 + 分类默认生效值（白名单制，只含可设默认的分类）。 */
  getCatalog(): CategoryConfigCatalogView;
  /** 写某分类默认模型（null/'' = 清除覆盖回落全局）。探活不过以 {ok:false} 诚实可辨，绝不落库。写后回真态视图。 */
  setCategoryConfig(categoryId: string, model: string | null, updatedBy: string): Promise<CategoryConfigSetResult>;
}

// ── 角色 prompt 只读预览（change role-prompt-visibility）──────────────────────────

/** prompt 来源分段（change prompt-viewer-persona-source）：role=角色独有指令 / persona=来自账号人设。 */
export interface RolePromptSegment {
  source: 'role' | 'persona';
  text: string;
}

/** GET /api/roles/:roleId/prompt 形状。available=false 时 prompt=null 且 note 说明原因。 */
export interface RolePromptView {
  roleId: string;
  /** 忠实渲染的 prompt（示例数据 + 真实人设）；不可预览时为 null。 */
  prompt: string | null;
  available: boolean;
  /** 占位说明 / 不可预览原因（诚实文案）。 */
  note: string;
  /**
   * 人设来源分段（change prompt-viewer-persona-source，可选）：有则前端按段渲染、给 persona 段加底色；
   * 无（定位不唯一 / 拼接不等 / 角色未实现 personaSegments）则回落扁平展示 `prompt`。绝不瞎标。
   */
  segments?: RolePromptSegment[];
}

export interface PanelRolePromptPreview {
  /** 取某角色 prompt 的只读预览（纯读，无写）。 */
  get(roleId: string): RolePromptView;
}

// ── 账号人设配置（change account-persona-config，stream F）──────────────────────
// reserved-order append 链：C（categories）→ D（quotas）→ F（本块 persona）→ B（nickname）。

/** 人设来源：override=该账号自定义人设 / fallback=回落打包默认 soul.yaml。 */
export type PersonaSource = 'override' | 'fallback';

/** 单账号人设目录行（GET /api/persona 列表形状）。列出所有账号（含无覆盖者）。 */
export interface PersonaConfigRowView {
  accountId: string;
  label: string | null;
  source: PersonaSource;
  /** 当前生效人设的身份摘要（解析结果），列表一眼识别「这是谁」。 */
  identityName: string;
  identityRole: string;
  /** 仅 override 行带审计；fallback 行为 null。 */
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PersonaConfigCatalogView {
  accounts: PersonaConfigRowView[];
}

/** 单账号人设详情（GET /api/persona/:accountId，编辑回显）。 */
export interface PersonaDetailView {
  accountId: string;
  label: string | null;
  source: PersonaSource;
  /** 编辑器内容：override→该账号人设文本；fallback→打包默认 soul.yaml 原文（编辑起点）。 */
  persona: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type PersonaSetResult =
  | { ok: true; view: PersonaConfigCatalogView }
  | { ok: false; reason: 'unknown_account' | 'persona_invalid' };

export interface PanelPersonaConfig {
  /** 账号 + 各自人设生效值/来源/审计（列出所有账号，含回落者）。 */
  getCatalog(): Promise<PersonaConfigCatalogView>;
  /** 单账号人设详情（编辑回显）；未知账号返回 null。 */
  getDetail(accountId: string): Promise<PersonaDetailView | null>;
  /** 写某账号人设。空文本=清除覆盖（回落）；非法人设以 {ok:false,reason:'persona_invalid'} 诚实拒绝绝不落库。写后回真态目录。 */
  setPersona(accountId: string, persona: string, updatedBy: string): Promise<PersonaSetResult>;
}

// ── 安全限额配置（change safety-quota-config，stream D）──────────────────────────
// reserved-order append 链：C（categories）→ D（本块 quotas）→ F（persona）→ B（nickname）。

/** 单 (tier,action) 三窗口生效数字 + 来源/审计（GET /api/quotas 形状）。库缺行处以派生写死默认合成。 */
export interface QuotaConfigRowView {
  tier: RiskQuotaLevel;
  action: RiskAction;
  daily: number;
  perMinute: number;
  perHour: number;
  /** 是否存在库内覆盖（false=显示的是派生写死默认，即当前真生效）。 */
  overridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface QuotaConfigCatalogView {
  quotas: QuotaConfigRowView[];
}

/** PUT /api/quotas 入参补丁。未传的窗口保持原值（或回落派生默认）。 */
export interface QuotaConfigPatchInput {
  tier: RiskQuotaLevel;
  action: RiskAction;
  daily?: number;
  perMinute?: number;
  perHour?: number;
}

export type QuotaConfigSetResult =
  | { ok: true; view: QuotaConfigCatalogView }
  | { ok: false; reason: 'unknown_tier' | 'unknown_action' | 'invalid_value' | 'no_valid_fields' };

export interface PanelQuotaConfig {
  /** 三档 × 全动作 × 三窗口生效值 + 审计（库缺行以写死默认合成回显）。 */
  getCatalog(): QuotaConfigCatalogView;
  /** 写某 (tier,action) 限额。校验不过整块拒（绝不部分落库 / 假成功）。写后回真态目录。 */
  setQuota(patch: QuotaConfigPatchInput, updatedBy: string): Promise<QuotaConfigSetResult>;
}

// ── 单场会话上限配置（change session-limits-to-quota-layer）────────────────────────
// 按账号一行：单场时长（分钟）+ 六项互动预算（likes/collects/follows/searches/comments/comment_likes）。
// 库缺行处以写死默认合成（overridden:false = 显示的是写死默认，即当前真生效）。

/** 单账号单场上限生效值 + 来源/审计（GET /api/session-limits 形状）。 */
export interface SessionLimitRowView {
  accountId: string;
  /** 单场时长上限（分钟）。 */
  maxDurationMin: number;
  /** 单场互动预算（六项）。 */
  budget: SessionInteractionBudget;
  /** 是否存在库内覆盖（false=显示的是写死默认，即当前真生效）。 */
  overridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SessionLimitCatalogView {
  limits: SessionLimitRowView[];
}

/** PUT /api/session-limits 入参补丁。未传的字段保持原值（无原值则回落写死默认）。 */
export interface SessionLimitPatchInput {
  accountId: string;
  maxDurationMin?: number;
  likes?: number;
  collects?: number;
  follows?: number;
  searches?: number;
  comments?: number;
  comment_likes?: number;
}

export type SessionLimitSetResult =
  | { ok: true; view: SessionLimitCatalogView }
  | { ok: false; reason: 'invalid_value' | 'no_valid_fields' };

export interface PanelSessionLimits {
  /** 全账号（含 default）单场时长 + 互动预算生效值 + 审计（库缺行以写死默认合成回显）。 */
  getCatalog(): SessionLimitCatalogView;
  /** 按账号写单场上限。校验不过整块拒（绝不部分落库 / 假成功）。写后回真态目录。 */
  set(patch: SessionLimitPatchInput, updatedBy: string): Promise<SessionLimitSetResult>;
}

export interface PanelConfig {
  /** 面板监听端口（独立于 8787 边-云 ws）；0 表示交由 OS 分配（测试用）。 */
  port: number;
  /** JWT 签名密钥（来自 .env，绝不硬编码）。 */
  jwtSecret: string;
  /** 内置登录用户。 */
  users: PanelUser[];
  /** JWT 有效期（秒）。 */
  jwtTtlSeconds: number;
  /** 启动自检拒绝绑定的保留端口（8787 边-云 / 5432 PG / 8788 调试 / isales 等，部署时经 env 补充）。 */
  forbiddenPorts: number[];
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export type PanelStartReason = 'forbidden_port' | 'missing_secret' | 'no_users' | 'listen_error';

export interface PanelHandle {
  started: boolean;
  /** 未启动时的原因。 */
  reason?: PanelStartReason;
  /** listen_error 时的底层 code/message。 */
  detail?: string;
  /** 实际监听端口（port=0 时为 OS 分配的真实端口）。 */
  port?: number;
  close(): Promise<void>;
}
