/**
 * 平台能力声明的**纯类型契约**（kernel 段）。
 *
 * 只含类型/接口声明 + 两样不读注册表的判定件（见下）。**判据是「读不读 PLATFORM_REGISTRY」，
 * 不是「名字里有没有 platform」**：注册表数据（PLATFORM_REGISTRY、*_COMMENT_PROFILE 常量）与真正的
 * 读表函数（platformRegistryEntry / commentProfileForPlatform / availableScheduledAutomationActionsForPlatform
 * 等）按 §9「平台能力由 aidcp-automation 单写」留在 src/platform/registry.ts（automation）。
 *
 * 例外两项（change cloud-coupling-phase4-runtime-ports，实现体零 PLATFORM_REGISTRY 引用）：
 *   - `normalizePlatformId` —— 纯字符串别名映射，值域 PlatformId 本来就住在本文件；
 *   - 三个 `SCHEDULED_*_DAILY_CAP_MAX` —— 与平台无关的服务端防御性硬上界，registry 只是引用者。
 * registry.ts 仍等值再导出这四个名字，automation 侧导入面逐字不变。
 *
 * 本文件供 api / content / automation 三边共导，不让任何一边直接拿到注册表数据。
 */

export type PlatformId = 'xiaohongshu' | 'facebook' | 'wechat_channels';

/**
 * 账号排期动作全集：Cloud 目录投影与写入校验共同消费，不能从其它能力词推导。
 * 运行时 tuple 与静态 catalog 位于 scheduled-automation-catalog.ts；`satisfies` 拒绝 tuple
 * 多余成员，`Exclude<ScheduledAutomationAction, tuple[number]>` 拒绝联合遗漏成员。
 */
export type ScheduledAutomationAction = 'post' | 'comment' | 'contact_comment' | 'join_group';
export type ScheduledAutomationMode = 'review' | 'auto_approve';

export type ScheduledAutomationSupport =
  | {
      supported: true;
      allowedModes: readonly ScheduledAutomationMode[];
      maxDailyCap: number;
    }
  | { supported: false; reason: string };

/** 面板目录只投影 supported 动作；数组是副本，调用方不能改 registry。 */
export interface AvailableScheduledAutomationAction {
  action: ScheduledAutomationAction;
  allowedModes: ScheduledAutomationMode[];
  maxDailyCap: number;
}

/**
 * Surface = 编排是否**离开列表**，不是页面形态。dialog / drawer / modal / overlay / profile
 * 都是 driver 内部细节，**绝不进本 enum**（change platform-registry-shape §不做）。
 */
export type Surface = 'feed' | 'detail';

/** 云端逐帖（note-scoped）动作全集：registry 对每个平台**全覆盖**表态，typecheck 逼每格声明。 */
export type NoteScopedAction =
  | 'read_content'
  | 'like'
  | 'collect'
  | 'comment'
  | 'comment_like'
  | 'browse_images'
  | 'scroll_comments';

/**
 * 编排能力词：只保留**有真消费者**的词（唯一消费者铁律，避免「声明了没人读」）。
 * 逐词消费者说明见 registry.ts 的 PLATFORM_REGISTRY 注释与 surface.ts。
 * **不变量**：普通主页 follow ⇒ profile_visit ⇒ browse。Reel 内联关注走 reel_follow，绝不能为了它翻转普通 follow。
 */
export type OrchestrationCapability =
  | 'browse'
  | 'feed_refresh'
  | 'follow'
  | 'reel_follow'
  | 'profile_visit'
  | 'patrol'
  | 'notification'
  | 'search'
  | 'group_join';

export type IdentityCaptureCommand = 'identity.read_current' | 'identity.read_self_profile';

export type IdentityCaptureStrategy =
  | {
      supported: true;
      command: IdentityCaptureCommand;
      restore: 'none' | 'feed';
      capability: 'identity_read_current_v1' | 'identity_read_self_profile_v1';
    }
  | { supported: false; reason: string };

/** Phase-1 user delegated business actions. This is control-plane metadata, not a protocol enum. */
export type DelegatedAction =
  | 'comment_batch'
  | 'publish_post'
  | 'publish_from_inspiration'
  | 'comment_curated'
  | 'generate_candidates'
  | 'approve_candidate'
  | 'reject_candidate'
  | 'modify_candidate'
  | 'facebook_group_comment';

export type DelegatedActionSupport =
  | { level: 'supported' }
  | { level: 'beta' | 'unsupported'; reason: string };

/** 支持声明：不支持必带非空 reason（治「靠数值巧合不发」）。 */
export type NoteSupport = { supported: true } | { supported: false; reason: string };

export interface CommentPlatformProfile {
  platform: PlatformId;
  siteName: string;
  contentName: string;
  maxCommentLength: number;
  /**
   * 撰写语言约束：只在「内容语言 ≠ 账号母语」的平台声明；缺省 = 不渲染该条（小红书 prompt 逐字不变）。
   * 单一词表铁律：这是 profile 的一个字段，绝不为语言另开第二张表。
   */
  composeLanguageRule?: string;
  metrics: {
    like: string;
    collect: string;
  };
  search: {
    defaultSort: string;
    defaultSortLabel: string;
    defaultTimeWindow: string;
    defaultTimeWindowLabel: string;
    targetedSearchTermMaxLength: number;
    targetedSearchFallbackLength: number;
  };
}

export interface PlatformRegistryEntry {
  platform: PlatformId;
  app: string;
  displayName: string;
  /** 概念1：逐帖动作是否支持（全覆盖 Record）。唯一消费者 = dispatcher 的 sendNoteScopedCommand（唯一拒绝点 + 审计）。 */
  noteActions: Record<NoteScopedAction, NoteSupport>;
  /**
   * 概念2：动作在哪个 surface 执行（只对「离不离开列表是真问题」的 3 个动作建模；给 collect/browse_images
   * 编造 surface = 假抽象）。唯一读者 = surface.ts 的 resolveReadSurface / resolveCommentSurface 纯函数。
   */
  noteSurfaces: Record<'read_content' | 'like' | 'comment', Surface>;
  /** 编排能力（只保留有真消费者的词）。 */
  capabilities: Record<OrchestrationCapability, NoteSupport>;
  /** 启动期本人身份二次采集的固定副作用命令；每个平台必须显式声明，绝不默认回落。 */
  identityCapture: IdentityCaptureStrategy;
  /** 节奏平台参数：feed 翻页停留地板（消费者 = dispatcher 泛化后的 feedScrollDwellMs，替代旧的 facebook 裸分支）。 */
  pacing: { feedScrollDwellFloorMs?: number };
  scheduler: {
    comment: {
      enabled: boolean;
      defaultSort: string;
      defaultTimeWindow: string;
    };
  };
  /** 账号排期动作准入；唯一消费者 = content-schedule 目录投影与写前校验。 */
  scheduledAutomation: Record<ScheduledAutomationAction, ScheduledAutomationSupport>;
  /** User-delegated action admission. Cloud is authoritative; edge mirrors this only for UX. */
  delegatedActions: Record<DelegatedAction, DelegatedActionSupport>;
  comment: CommentPlatformProfile;
}

/**
 * 账号平台读端口（api 属主 accounts.platform 的窄读接口）。
 * 跨 owner 消费方（content 的发布媒体存储在发媒体前校验账号是 facebook 账号）MUST 经本接口向 api 域要，
 * MUST NOT 直连 api 库。getPlatformOrNull 缺账号返 null（供调用方区分 account_not_found 与 platform 不符）。
 * 实现方 = api 的账号主数据存储；拆进程后换 HTTP 客户端，接口不变。
 */
export interface AccountPlatformReader {
  getPlatformOrNull(accountId: string): Promise<PlatformId | null>;
}

/* ── 不读注册表的判定件（change cloud-coupling-phase4-runtime-ports） ─────────── */

/**
 * 平台别名归一。**实现体零注册表引用**——纯字符串映射，值域就是本文件的 PlatformId。
 * 未知平台抛错（fail closed）；调用方要「未知也不抛」时用 registry 的 normalizePlatformForCatalog。
 */
export function normalizePlatformId(raw: string | null | undefined): PlatformId {
  const value = (raw ?? 'xiaohongshu').trim().toLowerCase();
  if (!value || value === 'xhs' || value === 'redbook' || value === 'xiaohongshu') return 'xiaohongshu';
  if (value === 'facebook' || value === 'fb') return 'facebook';
  if (value === 'wechat_channels' || value === 'wechat-channels' || value === 'channels') return 'wechat_channels';
  throw new Error(`unsupported platform=${raw}`);
}

/**
 * 内容动作与敏感联系评论动作的**服务端硬上限**（与平台无关的防御性上界）。
 * api 侧两张配置表在建表 CHECK 与写入边界校验里**导入期**就要它们，故必须是常量、不能走端口注入。
 */
export const SCHEDULED_CONTENT_DAILY_CAP_MAX = 50;
/**
 * 联系评论的硬上限**刻意与其余动作分开**，与发帖 / 评论的 50 无关（content-schedule 规格逐字写死
 * 「联系评论日上限硬上限 SHALL 为 10（越界整块拒；与发帖 / 评论的 50 刻意分开）」）。
 * 它与下面的加群常量相邻、历史上同值 10——change raise-facebook-group-join-cap-ceiling 只抬加群那条，
 * **本条保持 10**。改动一律按符号名定位、禁止按行号；测试侧另有一条回归断言专门挡这个误改。
 */
export const SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX = 10;
/**
 * 自动加群硬上限（change raise-facebook-group-join-cap-ceiling：10 → 50）。
 *
 * 本常量是**事实源**：写前边界校验、后台输入框上限下发、配置表 CHECK 三处全部由它派生或与它逐字一致。
 * 数据库那条 CHECK 由 `migrations/0098_facebook_group_join_daily_cap_50.sql` 显式换掉——
 * store 的自愈建表模板只在**表不存在**时才执行，对已存在的表不生效，
 * **只改本常量而不跑那条迁移，写入会在数据库层失败**（校验放行 51、库拒收，报错无业务含义）。
 *
 * 抬高本值 MUST NOT 被读作放宽风控：每日准入仍取 `min(账号配置 dailyCap, RiskController 当日
 * join_group 额度)`，每次执行另需通过 `canDo('join_group')` 与剩余会话 join_groups 预算；
 * 账号配置 MUST NOT 提高后两者（content-schedule 既有要求）。因此单抬本值时线上加群量不变。
 */
export const SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX = 50;

/**
 * 排期自动化目录的窄读端口（change cloud-coupling-phase4-runtime-ports）。
 *
 * 三个方法逐一对应 api 侧内容排期存储今天的三处直调。刻意保持**同步**：三处都在目录逐行映射
 * 与写前校验的热路径上，改成 Promise 会把整条链染成 async；注册表是静态源码数据，
 * 拆进程后按启动期快照注入即可。实现单写在 automation 的 src/platform/registry.ts。
 */
export interface ScheduledAutomationCatalogReader {
  /** 面板 catalog 的平台值：已知别名归一，未知值保留可诊断事实（不抛）。 */
  normalizeForCatalog(platform: string | null | undefined): string;
  /** 该平台可用的排期动作（未知平台与无声明平台均 fail closed 为空数组）。 */
  availableActions(platform: string | null | undefined): AvailableScheduledAutomationAction[];
  /** 该平台的排期动作声明全表；未知平台返回 null（调用方据此按「不支持」处理）。 */
  declarationsFor(platform: string | null | undefined): Record<ScheduledAutomationAction, ScheduledAutomationSupport> | null;
}
