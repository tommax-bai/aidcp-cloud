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
export const SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX = 10;
export const SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX = 10;

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
