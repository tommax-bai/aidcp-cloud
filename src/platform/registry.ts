export type PlatformId = 'xiaohongshu' | 'facebook' | 'wechat_channels';

/** 账号排期动作全集：Cloud 目录投影与写入校验共同消费，不能从其它能力词推导。 */
export const SCHEDULED_AUTOMATION_ACTIONS = ['post', 'comment', 'contact_comment'] as const;
export type ScheduledAutomationAction = (typeof SCHEDULED_AUTOMATION_ACTIONS)[number];
export type ScheduledAutomationMode = 'review' | 'auto_approve';

/** 内容动作与敏感联系评论动作的服务端硬上限。 */
export const SCHEDULED_CONTENT_DAILY_CAP_MAX = 50;
export const SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX = 10;

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
 * - browse        消费者 = role-dispatcher 会话启动闸（canStartSession）。
 * - feed_refresh  消费者 = FeedScroller 构造（深度到阈值是否改点「刷新」）。
 * - patrol/notification 消费者 = role-dispatcher setup() 的 canPatrol()（两者皆支持才注册 12 通知巡视角色）。
 * - profile_visit 消费者 = role-dispatcher setup() 的 canVisitProfile()（gate ProfileOpener 注册 + 注入 AuthorEvaluator：
 *                 不支持则永不产 profile.worth_visiting，只产 profile.skipped，主页子链结构性不触发）。
 * - follow        消费者 = FollowAgent（主页关注；注入 canFollow：不支持则跳过、仍产 profile.done 保返回链）。
 * - reel_follow   消费者 = Reel 呈现概率策略 + 客户端关注指标投影；不依赖 profile_visit。
 * - group_join    消费者 = 客户端指标投影（omitUnsupportedUsageMetrics）——**唯一的非闸消费者**：只决定
 *                 「这个账号的界面上有没有加群这一格」，MUST NOT 下发 / 拒绝 / 取消任何命令。加群本身的
 *                 闸与执行仍全在其专属路径（FacebookGroupJoinScheduler），本词不是第二道闸。
 *                 ⚠️ 读它**绝不能**用 isOrchestrationCapabilitySupported（那条 fail-open 到 true）——
 *                 该词的现状是「客户端根本没有这一格」，fail-open 到 true 会让平台未知的账号凭空长出
 *                 一个加群格，而小红书没有群。详见 declaresCapabilitySupported。
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
  | 'group_join';

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
  | { level: 'beta' | 'unsupported'; reason: string; runtimeGate?: string };

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

const XHS_DELEGATED_ACTIONS: Record<DelegatedAction, DelegatedActionSupport> = {
  comment_batch: { level: 'supported' },
  publish_post: { level: 'supported' },
  publish_from_inspiration: { level: 'supported' },
  comment_curated: { level: 'supported' },
  generate_candidates: { level: 'supported' },
  approve_candidate: { level: 'supported' },
  reject_candidate: { level: 'supported' },
  modify_candidate: { level: 'supported' },
  facebook_group_comment: { level: 'unsupported', reason: 'facebook_only' },
};

const FACEBOOK_DELEGATED_ACTIONS: Record<DelegatedAction, DelegatedActionSupport> = {
  comment_batch: {
    level: 'beta',
    reason: 'configured_targets_only',
    runtimeGate: 'AIDCP_FB_COMMENT_AUTO',
  },
  publish_post: {
    level: 'beta',
    reason: 'real_machine_and_client_capability_gate',
    runtimeGate: 'facebook_publish_capability',
  },
  publish_from_inspiration: {
    level: 'unsupported',
    reason: 'facebook_creation_template_language_media_strategy_not_ready',
  },
  comment_curated: { level: 'unsupported', reason: 'arbitrary_facebook_post_targeting_not_supported' },
  generate_candidates: { level: 'beta', reason: 'facebook_publish_template_beta' },
  approve_candidate: { level: 'beta', reason: 'facebook_publish_delivery_beta' },
  reject_candidate: { level: 'beta', reason: 'facebook_publish_delivery_beta' },
  modify_candidate: { level: 'beta', reason: 'facebook_publish_delivery_beta' },
  facebook_group_comment: {
    level: 'beta',
    reason: 'configured_or_owned_group_targets_only',
    runtimeGate: 'AIDCP_FB_GROUP_JOIN_AUTO',
  },
};

const WECHAT_CHANNELS_DELEGATED_ACTIONS: Record<DelegatedAction, DelegatedActionSupport> = {
  comment_batch: { level: 'unsupported', reason: 'interaction_inbox_only' },
  publish_post: { level: 'unsupported', reason: 'interaction_inbox_only' },
  publish_from_inspiration: { level: 'unsupported', reason: 'interaction_inbox_only' },
  comment_curated: { level: 'unsupported', reason: 'interaction_inbox_only' },
  generate_candidates: { level: 'unsupported', reason: 'interaction_inbox_only' },
  approve_candidate: { level: 'unsupported', reason: 'interaction_inbox_only' },
  reject_candidate: { level: 'unsupported', reason: 'interaction_inbox_only' },
  modify_candidate: { level: 'unsupported', reason: 'interaction_inbox_only' },
  facebook_group_comment: { level: 'unsupported', reason: 'interaction_inbox_only' },
};

export const XHS_COMMENT_PROFILE: CommentPlatformProfile = {
  platform: 'xiaohongshu',
  siteName: '小红书',
  contentName: '笔记',
  maxCommentLength: 50,
  metrics: {
    like: '点赞',
    collect: '收藏',
  },
  search: {
    defaultSort: 'most_collected',
    defaultSortLabel: '最多收藏',
    defaultTimeWindow: 'one_day',
    defaultTimeWindowLabel: '最近一天',
    targetedSearchTermMaxLength: 20,
    targetedSearchFallbackLength: 12,
  },
};

// Facebook v1（facebook-scheduled-comment）：只做定向评论，不做全站搜索。
// search 子对象为满足 CommentPlatformProfile 类型契约的占位（FB v1 不消费搜索语义）。
export const FB_COMMENT_PROFILE: CommentPlatformProfile = {
  platform: 'facebook',
  siteName: 'Facebook',
  contentName: '帖子',
  // 软上界：Facebook 评论无 50 字硬限，这里给一个自然评论的保守上限，真实约束由确定性校验器执行。
  maxCommentLength: 500,
  // FB 评论语言由账号 Soul.writing_language 决定；CommentComposer 缺配置时 fail closed，
  // 不再根据来源帖子临时猜语言，也不在发送前翻译。
  metrics: {
    like: '赞',
    collect: '', // Facebook 无「收藏」概念；FB 定向评论路径不使用该字段，占位满足类型。
  },
  search: {
    // FB v1 不做全站搜索（只浏览配置的 target URL）；以下为占位，不被 FB 路径消费。
    defaultSort: 'recent',
    defaultSortLabel: '最新',
    defaultTimeWindow: 'none',
    defaultTimeWindowLabel: '不限',
    targetedSearchTermMaxLength: 0,
    targetedSearchFallbackLength: 0,
  },
};

/** 视频号只接入新的入站 interaction 域；主动浏览/养号 composer 明确不支持。 */
export const WECHAT_CHANNELS_COMMENT_PROFILE: CommentPlatformProfile = {
  platform: 'wechat_channels',
  siteName: '微信视频号',
  contentName: '视频',
  maxCommentLength: 500,
  metrics: { like: '赞', collect: '' },
  search: {
    defaultSort: 'none', defaultSortLabel: '不支持', defaultTimeWindow: 'none',
    defaultTimeWindowLabel: '不支持', targetedSearchTermMaxLength: 0, targetedSearchFallbackLength: 0,
  },
};

/** 小红书 v1 逐帖动作全支持。 */
const XHS_NOTE_ACTIONS: Record<NoteScopedAction, NoteSupport> = {
  read_content: { supported: true },
  like: { supported: true },
  collect: { supported: true },
  comment: { supported: true },
  comment_like: { supported: true },
  browse_images: { supported: true },
  scroll_comments: { supported: true },
};

/**
 * Facebook v1 逐帖动作。read/like/comment 支持；collect 无「收藏」概念；comment_like / 深读两动作 v1 未实装
 * ——**显式声明不支持 + reason**，dispatcher 侧据此不下发（不再靠 collectCount 恒 0 的数值巧合、不做无效往返/无效 LLM）。
 */
const FB_NOTE_ACTIONS: Record<NoteScopedAction, NoteSupport> = {
  read_content: { supported: true },
  like: { supported: true },
  comment: { supported: true },
  collect: { supported: false, reason: 'no_collect_concept' },
  comment_like: { supported: false, reason: 'v1_unimplemented' },
  browse_images: { supported: false, reason: 'v1_unimplemented' },
  scroll_comments: { supported: false, reason: 'v1_unimplemented' },
};

const WECHAT_CHANNELS_NOTE_ACTIONS: Record<NoteScopedAction, NoteSupport> = {
  read_content: { supported: false, reason: 'interaction_inbox_only' },
  like: { supported: false, reason: 'interaction_inbox_only' },
  collect: { supported: false, reason: 'interaction_inbox_only' },
  comment: { supported: false, reason: 'dedicated_reply_workflow_only' },
  comment_like: { supported: false, reason: 'interaction_inbox_only' },
  browse_images: { supported: false, reason: 'interaction_inbox_only' },
  scroll_comments: { supported: false, reason: 'interaction_inbox_only' },
};

export const PLATFORM_REGISTRY: Record<PlatformId, PlatformRegistryEntry> = {
  xiaohongshu: {
    platform: 'xiaohongshu',
    app: 'xhs',
    displayName: '小红书',
    noteActions: XHS_NOTE_ACTIONS,
    // 小红书 read/like/comment 全在详情页完成（今天的唯一形态）。
    noteSurfaces: { read_content: 'detail', like: 'detail', comment: 'detail' },
    // 小红书四类编排能力全支持（=今天：巡视 / 访主页 / 关注 / 通知俱在）。C4 追加 follow/profile_visit/patrol/notification。
    capabilities: {
      browse: { supported: true },
      feed_refresh: { supported: true },
      follow: { supported: true },
      reel_follow: { supported: false, reason: 'no_reels_surface' },
      profile_visit: { supported: true },
      patrol: { supported: true },
      notification: { supported: true },
      // 小红书没有「群」这个东西——不是没实装，是平台上不存在。
      group_join: { supported: false, reason: 'no_group_concept' },
    },
    pacing: {},
    scheduler: {
      comment: {
        enabled: true,
        defaultSort: XHS_COMMENT_PROFILE.search.defaultSort,
        defaultTimeWindow: XHS_COMMENT_PROFILE.search.defaultTimeWindow,
      },
    },
    scheduledAutomation: {
      post: {
        supported: true,
        allowedModes: ['review', 'auto_approve'],
        maxDailyCap: SCHEDULED_CONTENT_DAILY_CAP_MAX,
      },
      comment: {
        supported: true,
        allowedModes: ['review', 'auto_approve'],
        maxDailyCap: SCHEDULED_CONTENT_DAILY_CAP_MAX,
      },
      contact_comment: {
        supported: true,
        allowedModes: ['review', 'auto_approve'],
        maxDailyCap: SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX,
      },
    },
    delegatedActions: XHS_DELEGATED_ACTIONS,
    comment: XHS_COMMENT_PROFILE,
  },
  facebook: {
    platform: 'facebook',
    app: 'fb',
    displayName: 'Facebook',
    // edge Facebook driver 的【编排能力子集】= {browse, comment, publish, interact, join}；本 registry 的
    // capabilities 只登记**有云端消费者**的编排词（browse / feed_refresh / group_join），comment/publish/interact
    // 的编排接线各在其专属路径（定向评论调度器 / FacebookPublishExecutor / 互动闸），不作零消费者声明。
    // group_join 于 change platform-honest-usage-metrics 登记：它的消费者是**非闸**的客户端指标投影
    // （决定界面上有没有加群格），加群的闸与执行仍在 FacebookGroupJoinScheduler 自己的路径上——
    // 别照本注释的旧版把它当零消费者声明删掉。
    noteActions: FB_NOTE_ACTIONS,
    // 就地读/赞已开（change facebook-feed-inline-browse 灰度「开关打开」）：read/like='feed'（首页就地展开读全文 +
    // 逐帖 react），comment 留 'detail'（评论必进详情页，P5 已证 ⇒ 读=feed 与评=detail 不等 ⇒ 回执驱动两步迁移）。
    // 版本偏斜闸（effectiveReadSurface）：仅对声明 inline_targeting 的边缘生效，老边端 / 未重打包回落 detail=今天。
    // 注：like 的实际执行 surface 由边缘按 DOM 作用域自判（dialog→detail / feed→feed），云端归账键 read_content；
    // 本 like 值当前无独立云端消费者（无 resolveLikeSurface），设 'feed' 仅为语义一致 + 未来预留。
    // 回滚（不需重发桌面客户端）：把值改回 'detail' 重部署 cloud，或边缘启动器 AIDCP_FB_BROWSE_AUTO≠on 停真互动。
    noteSurfaces: { read_content: 'feed', like: 'feed', comment: 'detail' },
    // feed_refresh 声明 supported（=今天 FeedScroller 对 FB 照常发 refresh）；FB 的「受控重新导航」实现在 C2。
    // C4：FB 不做通知巡视（不上报 notification.detected）/ 不访作者主页 / 不做主页关注；Reels 内联关注由
    // 独立 reel_follow 声明与版本能力闸接线，绝不能翻转普通 follow/profile_visit。
    // 且 AuthorEvaluator 短路只产 profile.skipped（主页子链结构不触发）。ProfileBrowser/AuthorEvaluator/FollowAgent
    // 仍注册：AuthorEvaluator 是评论后返回 feed 的桥、FollowAgent 的 profile.done 是主页子链返回信号（皆须常在）；
    // ProfileBrowser 恒注册纯为无害（FB 经 canVisitProfile 结构不访作者主页；本人昵称采集另由永久接线的
    // NicknameEnricher 独立消费，ProfileBrowser 对本人 early-return，两者不相干）。
    capabilities: {
      browse: { supported: true },
      feed_refresh: { supported: true },
      follow: { supported: false, reason: 'no_follow_actuator' },
      reel_follow: { supported: true },
      profile_visit: { supported: false, reason: 'no_profile_actuator' },
      patrol: { supported: false, reason: 'no_notification_patrol' },
      notification: { supported: false, reason: 'no_notification_surface' },
      // FB 群是真做的：调度器每天真点加入、风控计数器 join_group 真记账（含待审批）、
      // 后台用量表真在按「加群 用了/上限」显示。这条声明只让客户端也看得见同一个数。
      group_join: { supported: true },
    },
    // 泛化旧 facebookScrollDwellMs 的 7s 扫屏地板（虚拟化/permalink 水合导致 newCount 常算成 0 时的保底停留）。
    pacing: { feedScrollDwellFloorMs: 7_000 },
    scheduler: {
      comment: {
        enabled: true,
        defaultSort: FB_COMMENT_PROFILE.search.defaultSort,
        defaultTimeWindow: FB_COMMENT_PROFILE.search.defaultTimeWindow,
      },
    },
    scheduledAutomation: {
      // Facebook 自动发帖运行时会跳过 auto_approve；这里只声明真实可执行的 review。
      post: {
        supported: true,
        allowedModes: ['review'],
        maxDailyCap: SCHEDULED_CONTENT_DAILY_CAP_MAX,
      },
      comment: {
        supported: true,
        allowedModes: ['review', 'auto_approve'],
        maxDailyCap: SCHEDULED_CONTENT_DAILY_CAP_MAX,
      },
      contact_comment: {
        supported: true,
        allowedModes: ['review', 'auto_approve'],
        maxDailyCap: SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX,
      },
    },
    delegatedActions: FACEBOOK_DELEGATED_ACTIONS,
    comment: FB_COMMENT_PROFILE,
  },
  wechat_channels: {
    platform: 'wechat_channels',
    app: 'wechat_channels',
    displayName: '微信视频号',
    noteActions: WECHAT_CHANNELS_NOTE_ACTIONS,
    noteSurfaces: { read_content: 'detail', like: 'detail', comment: 'detail' },
    capabilities: {
      browse: { supported: false, reason: 'interaction_inbox_only' },
      feed_refresh: { supported: false, reason: 'interaction_inbox_only' },
      follow: { supported: false, reason: 'interaction_inbox_only' },
      reel_follow: { supported: false, reason: 'interaction_inbox_only' },
      profile_visit: { supported: false, reason: 'interaction_inbox_only' },
      patrol: { supported: false, reason: 'interaction_inbox_only' },
      notification: { supported: false, reason: 'interaction_inbox_only' },
      group_join: { supported: false, reason: 'interaction_inbox_only' },
    },
    pacing: {},
    scheduler: { comment: { enabled: false, defaultSort: 'none', defaultTimeWindow: 'none' } },
    scheduledAutomation: {
      post: { supported: false, reason: 'interaction_inbox_only' },
      comment: { supported: false, reason: 'interaction_inbox_only' },
      contact_comment: { supported: false, reason: 'interaction_inbox_only' },
    },
    delegatedActions: WECHAT_CHANNELS_DELEGATED_ACTIONS,
    comment: WECHAT_CHANNELS_COMMENT_PROFILE,
  },
};

export function normalizePlatformId(raw: string | null | undefined): PlatformId {
  const value = (raw ?? 'xiaohongshu').trim().toLowerCase();
  if (!value || value === 'xhs' || value === 'redbook' || value === 'xiaohongshu') return 'xiaohongshu';
  if (value === 'facebook' || value === 'fb') return 'facebook';
  if (value === 'wechat_channels' || value === 'wechat-channels' || value === 'channels') return 'wechat_channels';
  throw new Error(`unsupported platform=${raw}`);
}

export function platformRegistryEntry(platform: string | null | undefined): PlatformRegistryEntry {
  const id = normalizePlatformId(platform);
  const entry = PLATFORM_REGISTRY[id];
  if (!entry) throw new Error(`platform=${id} has no cloud registry entry`);
  return entry;
}

/**
 * 面板 catalog 的平台值：已知别名走统一归一化；未知值保留可诊断的 trim/lowercase 事实，
 * 绝不回落成小红书或其它已知平台。
 */
export function normalizePlatformForCatalog(raw: string | null | undefined): string {
  try {
    return normalizePlatformId(raw);
  } catch {
    return raw?.trim().toLowerCase() || 'unknown';
  }
}

/** 未知平台与无声明平台均 fail closed 为无动作。 */
export function availableScheduledAutomationActionsForPlatform(
  platform: string | null | undefined,
): AvailableScheduledAutomationAction[] {
  let entry: PlatformRegistryEntry;
  try {
    entry = platformRegistryEntry(platform);
  } catch {
    return [];
  }
  return SCHEDULED_AUTOMATION_ACTIONS.flatMap((action) => {
    const support = entry.scheduledAutomation[action];
    return support.supported
      ? [{ action, allowedModes: [...support.allowedModes], maxDailyCap: support.maxDailyCap }]
      : [];
  });
}

export function commentProfileForPlatform(platform: string | null | undefined): CommentPlatformProfile {
  return platformRegistryEntry(platform).comment;
}

export function delegatedActionSupportForPlatform(
  platform: string | null | undefined,
  action: DelegatedAction,
): DelegatedActionSupport {
  return platformRegistryEntry(platform).delegatedActions[action];
}

export function defaultCommentSearchLabel(profile: CommentPlatformProfile = XHS_COMMENT_PROFILE): string {
  return `${profile.search.defaultTimeWindowLabel}·${profile.search.defaultSortLabel}`;
}
