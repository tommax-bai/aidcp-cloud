/**
 * 面板 API 层的注入依赖与配置类型。
 *
 * 面板是进程内 BFF：只读组合现有存储 + 进程内活态，加薄命令外观。
 * 注入镜像 DefaultMessageHandler 的构造方式（main() 已接好的单例）。
 * task 1（骨架）仅用到 edgeServer；其余依赖留待 task 5 只读接口与 task 4 写接口。
 */

import type { RiskController, RiskQuotaLevel, RiskAction, SessionInteractionBudget } from '../risk/index.js';
import type { ConceptStore, BotChatStore } from '../cache/index.js';
import type { CuratedContentType, CuratedPanelListResult, CuratedFacets } from '../cache/index.js';
import type { PublishLogStore } from '../publish-agent/publish-log-store.js';
import type { EventBus } from '../event-bus/index.js';
import type { PanelUser } from './auth.js';
import type { PanelStoreReader } from './panel-store.js';
import type { PublishApprovalPayload, ApprovalWriteResult } from '../feishu/index.js';
import type { LlmUsageQuery, LlmUsagePayload } from '../metrics/token-usage-store.js';
import type { NotificationContact, NotificationContactManual } from '../cache/notification-contact-store.js';

export interface PanelDeps {
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
   * 单场会话上限配置（全局单例，change restore-auto-resume-and-global-safety-config）。未注入则 /api/session-limits 返回 503。
   * 全局编辑单场时长 + 六项互动预算、对所有账号生效；写非乐观回真态；非法整块拒（invalid_value），绝不部分落库；
   * 只动 session_config_global，不碰风控状态单写路径、不经协议。
   */
  sessionLimits?: PanelSessionLimits;
  /**
   * 自动续场护栏 + 看门狗阈值配置（全局单例，change restore-auto-resume-and-global-safety-config）。未注入则 /api/resume-config 返回 503。
   * 全局编辑 rest_ratio / 活跃时段窗口 / 每日上限 / 看门狗两阈值、对所有账号生效；写非乐观回真态；非法整块拒，绝不部分落库；
   * 只动 resume_config_global，不碰风控状态单写路径、不经协议。
   */
  resumeConfig?: PanelResumeConfig;
  /**
   * token 用量只读查询（change llm-token-usage-stats）。未注入则 /api/llm-usage 返回 503。
   * 纯只读预聚合表（按账号/角色/模型/10 分钟桶）；缺表回落空；不写、不碰风控/发布/edge。
   */
  tokenUsage?: { usage(query: LlmUsageQuery): Promise<LlmUsagePayload> };
  /**
   * 通知联系人名册（change notification-contact-registry）。未注入则 /api/notification/contacts* 返回 503。
   * 读=联系人列表（accountId 给定＝按账号；缺省＝全账号合并视图，每行带 accountId）；
   * 写=人工字段（微信/标签/备注）只动侧表、按行账号路由、绝不碰事件流水。
   */
  notificationContact?: {
    listContacts(accountId?: string, limit?: number, offset?: number): Promise<NotificationContact[]>;
    setManual(
      accountId: string,
      senderKey: string,
      manual: NotificationContactManual,
      updatedBy: string | null,
    ): Promise<void>;
  };
  /**
   * 精选创作灵感语料的后台管理面（change curated-content-admin-page）。未注入则 /api/curated/* 返回 503。
   * 读=分页列表 + 筛选面（accountId 给定＝按账号；缺省＝全账号合并视图，每行带 account_id）；
   * 写=删单条 / 清空正文壳行（account_id 强制进 WHERE 防越权，删除按行账号路由）。
   * 删除非持久（仅清当前快照，达标会重新纳入），honest 回真实条数。
   */
  curatedContent?: PanelCuratedContent;
}

// ── 精选内容后台管理（change curated-content-admin-page）────────────────────────
// 直接复用 CuratedContentStore 的方法形状作面板 dep（store 自有 curated_content 表，不塞 PgPanelStore）。

export interface PanelCuratedContent {
  /** 分页只读列表（accountId 缺省＝全账号；可选类型 / 纳入原因过滤）；含一致 total。缺表 store 内回落空。 */
  listForPanel(
    accountId: string | undefined,
    opts: { contentType?: CuratedContentType; admitReason?: string; limit: number; offset: number },
  ): Promise<CuratedPanelListResult>;
  /** 筛选面（accountId 缺省＝全账号）：纳入原因去重 + 计数 + 高权重行数 + 笔记/评论计数。缺表回落空。 */
  facetsForPanel(accountId?: string): Promise<CuratedFacets>;
  /** 删单条（account_id 进 WHERE 防越权）；回真实删除行数 0|1。 */
  deleteOne(accountId: string, id: number): Promise<number>;
  /** 清空正文壳行（按账号）；回真实清理条数。 */
  clearEmptyBody(accountId: string): Promise<number>;
}

/**
 * 单厂商凭据视图（永不含明文）。source：db=库内加密凭据 / env=回退环境变量 / none=未配置。
 * change model-config-volcengine-provider：按厂商分别回报，新增 provider。
 */
export interface ModelConfigCredentialView {
  provider: string;
  field: string;
  configured: boolean;
  maskedHint: string | null;
  source: 'db' | 'env' | 'none';
}

/** 可选文本厂商（GET /api/config/model 的下拉项 + 只读 baseUrl）。 */
export interface TextProviderView {
  id: string;
  displayName: string;
  baseUrl: string;
}

/** 可选图片厂商（GET /api/config/model 的图片厂商下拉项）。change image-provider-volcengine-seedream。 */
export interface ImageProviderView {
  id: string;
  displayName: string;
}

/**
 * GET /api/config/model 的形状（永不含明文密钥）。
 * change model-config-volcengine-provider：多厂商——textProvider 选中的全局文本厂商、providers 可选项、
 * credentials 按厂商凭据态。
 * change image-provider-volcengine-seedream：imageProvider 也可选（万相 dashscope / 即梦 Seedream volcengine），
 * imageProviders 为下拉项；图片厂商独立于文本厂商。
 */
export interface ModelConfigView {
  textProvider: string;
  imageProvider: string;
  textModel: string;
  imageModel: string;
  providers: TextProviderView[];
  imageProviders: ImageProviderView[];
  credentials: ModelConfigCredentialView[];
  /** 主加密密钥是否就位——凭据能否在后台编辑。 */
  canEditCredential: boolean;
}

export type SetCredentialResult =
  | { ok: true; provider: string; field: string; maskedHint: string }
  | { ok: false; reason: 'cred_key_missing' };

/** PUT /api/config/model 结果（探活/厂商校验可失败，绝不假成功）。 */
export type SetModelResult =
  | { ok: true; view: ModelConfigView }
  | { ok: false; reason: 'model_invalid' | 'provider_key_missing' | 'unknown_provider' };

export interface PanelModelConfig {
  getView(): Promise<ModelConfigView>;
  /**
   * 改全局文本厂商/模型名/图片模型名。文本模型变更或厂商变更时由服务端按所选厂商探活后才写（热加载即时生效）。
   * 探活不过 / 厂商未知以 {ok:false} 诚实可辨，绝不落库。
   */
  setModel(
    patch: { textProvider?: string; textModel?: string; imageModel?: string; imageProvider?: string },
    updatedBy: string,
  ): Promise<SetModelResult>;
  /** 按厂商加密保存密钥（重启生效）；主密钥缺失返回 {ok:false}，明文绝不回传。 */
  setCredential(provider: string, field: string, value: string, updatedBy: string): Promise<SetCredentialResult>;
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
  /**
   * 当前生效厂商（change model-config-volcengine-provider）：取自贡献了生效模型那一层的同行 provider；
   * 文本类回落 dashscope，图像类恒 dashscope（万相）。供前端展示 + 保存时按此 provider 探活。
   */
  effectiveProvider: string;
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
  /** 厂商（change model-config-volcengine-provider）：跟 model 同发；写 model 时按此 provider 探活并落库。 */
  provider?: string | null;
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
        | 'model_invalid'
        | 'provider_key_missing';
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
  /** 该分类默认模型的生效厂商（change model-config-volcengine-provider）：分类覆盖则用其同行 provider、否则回落全局文本厂商。 */
  effectiveProvider: string;
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
      reason: 'unknown_category' | 'category_not_configurable' | 'model_invalid' | 'provider_key_missing';
    };

export interface PanelCategoryConfig {
  /** 分类目录 + 分类默认生效值（白名单制，只含可设默认的分类）。 */
  getCatalog(): CategoryConfigCatalogView;
  /** 写某分类默认模型 + 厂商（null/'' = 清除覆盖回落全局）。探活不过以 {ok:false} 诚实可辨，绝不落库。写后回真态视图。 */
  setCategoryConfig(
    categoryId: string,
    model: string | null,
    provider: string | null,
    updatedBy: string,
  ): Promise<CategoryConfigSetResult>;
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
  /**
   * 本次预览所用账号（change prompt-preview-persona-selector，可选）：给定 `?accountId=` 时回显；
   * 缺省（不传 accountId）则不附此字段，行为与扩展前一致。
   */
  accountId?: string;
  /**
   * 选定账号未配人设、回落系统默认人设的诚实标志（change prompt-preview-persona-selector，可选）：
   * true=该账号无人设行、下示为默认人设（绝不把默认人设冒充为该账号人设）。
   */
  personaFallback?: boolean;
}

export interface PanelRolePromptPreview {
  /**
   * 取某角色 prompt 的只读预览（纯读，无写）。
   * 可选 `accountId`（change prompt-preview-persona-selector）：给定则按该账号人设渲染；
   * 缺省则按系统默认人设（行为与扩展前一致）。
   */
  get(roleId: string, accountId?: string): RolePromptView;
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

// ── 单场会话上限配置（全局单例，change restore-auto-resume-and-global-safety-config）──
// 单份全局配置：单场时长（分钟）+ 六项互动预算（likes/collects/follows/searches/comments/comment_likes）。
// 对所有账号生效。库无行处以写死默认合成（overridden:false = 显示的是写死默认，即当前真生效）。

/** 全局单场上限生效值 + 来源/审计（GET /api/session-limits 形状）。 */
export interface SessionLimitView {
  /** 单场时长上限（分钟）。 */
  maxDurationMin: number;
  /** 单场互动预算（六项）。 */
  budget: SessionInteractionBudget;
  /** 收藏质量闸：收藏:赞 比例的分母 N（即 1:N；默认 3）。 */
  collectSaveLikeDenom: number;
  /** 关注质量闸：粉丝:赞藏 比例的分母 N（即 1:N；默认 8）。 */
  followFansDenom: number;
  /** 「可活跃时间」周历掩码（168 格 '0'/'1'，周一起头×24h；按服务器本地时间）。null = 未配置 / 全天活跃。 */
  activeWeekMask: string | null;
  /** 是否存在库内覆盖（false=显示的是写死默认，即当前真生效）。 */
  overridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** PUT /api/session-limits 入参补丁（全局，无账号）。未传的字段保持原值（无原值则回落写死默认）。 */
export interface SessionLimitPatchInput {
  maxDurationMin?: number;
  likes?: number;
  collects?: number;
  follows?: number;
  searches?: number;
  comments?: number;
  comment_likes?: number;
  /** 收藏质量闸分母 N（1:N，需 >= 1）。 */
  collectSaveLikeDenom?: number;
  /** 关注质量闸分母 N（1:N，需 >= 1）。 */
  followFansDenom?: number;
  /** 「可活跃时间」周历掩码（168 格 '0'/'1'，周一起头×24h）。 */
  activeWeekMask?: string;
}

export type SessionLimitSetResult =
  | { ok: true; view: SessionLimitView }
  | { ok: false; reason: 'invalid_value' | 'no_valid_fields' };

export interface PanelSessionLimits {
  /** 全局单场时长 + 互动预算生效值 + 审计（库无行以写死默认合成回显）。 */
  getView(): SessionLimitView;
  /** 写全局单场上限。校验不过整块拒（绝不部分落库 / 假成功）。写后回真态。 */
  set(patch: SessionLimitPatchInput, updatedBy: string): Promise<SessionLimitSetResult>;
}

/** 全局续场护栏 + 看门狗阈值生效值 + 来源/审计（GET /api/resume-config 形状）。 */
export interface ResumeConfigView {
  /** 休息比例（百分比，如 10 = 单场时长的 10%）。 */
  restRatioPct: number;
  /** 活跃时段窗口起/止（自午夜分钟数，0..1440；0..1440 = 全天不限）。 */
  activeWindowStartMin: number;
  activeWindowEndMin: number;
  /** 每日自动续场上限（场数 / 累计分钟）；0 = 不限。 */
  dailyMaxSessions: number;
  dailyMaxMinutes: number;
  /** 看门狗两段阈值（毫秒）：恢复轻推 / 放弃结束。 */
  idleNudgeMs: number;
  idleEndMs: number;
  /** 是否存在库内覆盖（false=显示的是写死默认）。 */
  overridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** PUT /api/resume-config 入参补丁（全局，无账号）。未传的字段保持原值（无原值则回落写死默认）。 */
export interface ResumeConfigPatchInput {
  restRatioPct?: number;
  activeWindowStartMin?: number;
  activeWindowEndMin?: number;
  dailyMaxSessions?: number;
  dailyMaxMinutes?: number;
  idleNudgeMs?: number;
  idleEndMs?: number;
}

export type ResumeConfigSetResult =
  | { ok: true; view: ResumeConfigView }
  | { ok: false; reason: 'invalid_value' | 'no_valid_fields' };

export interface PanelResumeConfig {
  /** 全局续场护栏 + 看门狗阈值生效值 + 审计（库无行以写死默认合成回显）。 */
  getView(): ResumeConfigView;
  /** 写全局续场配置。校验不过整块拒（绝不部分落库 / 假成功）。写后回真态。 */
  set(patch: ResumeConfigPatchInput, updatedBy: string): Promise<ResumeConfigSetResult>;
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
