// 纯类型契约已提到 kernel（src/kernel/platform-types.ts），供三边 type-only 共导；
// 本文件保留注册表数据 + 读表函数（§9：平台能力由 aidcp-automation 单写）。以下 re-export 保持
// 既有 `from '../platform/registry'` / `from '../platform/index'` 的类型导入面逐字不变。
export type {
  PlatformId,
  ScheduledAutomationAction,
  ScheduledAutomationMode,
  ScheduledAutomationSupport,
  AvailableScheduledAutomationAction,
  Surface,
  NoteScopedAction,
  OrchestrationCapability,
  DelegatedAction,
  DelegatedActionSupport,
  NoteSupport,
  IdentityCaptureCommand,
  IdentityCaptureStrategy,
  CommentPlatformProfile,
  PlatformRegistryEntry,
} from '../kernel/platform-types.js';
import type {
  PlatformId,
  ScheduledAutomationAction,
  AvailableScheduledAutomationAction,
  DelegatedAction,
  DelegatedActionSupport,
  NoteScopedAction,
  NoteSupport,
  IdentityCaptureStrategy,
  CommentPlatformProfile,
  PlatformRegistryEntry,
} from '../kernel/platform-types.js';

/**
 * 账号排期动作全集：Cloud 目录投影与写入校验共同消费，不能从其它能力词推导。
 * `satisfies` 与 kernel 的 ScheduledAutomationAction 联合逐字对齐（增删动作两处同改，编译期兜底）。
 */
export const SCHEDULED_AUTOMATION_ACTIONS = [
  'post',
  'comment',
  'contact_comment',
  'join_group',
] as const satisfies readonly ScheduledAutomationAction[];

/** 内容动作与敏感联系评论动作的服务端硬上限。 */
export const SCHEDULED_CONTENT_DAILY_CAP_MAX = 50;
export const SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX = 10;
export const SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX = 10;

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
  },
  publish_post: {
    level: 'beta',
    reason: 'real_machine_and_client_capability_gate',
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
      search: { supported: true },
      // 小红书没有「群」这个东西——不是没实装，是平台上不存在。
      group_join: { supported: false, reason: 'no_group_concept' },
    },
    identityCapture: {
      supported: true,
      command: 'identity.read_self_profile',
      restore: 'feed',
      capability: 'identity_read_self_profile_v1',
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
      join_group: { supported: false, reason: 'no_group_concept' },
    },
    delegatedActions: XHS_DELEGATED_ACTIONS,
    comment: XHS_COMMENT_PROFILE,
  },
  facebook: {
    platform: 'facebook',
    app: 'fb',
    displayName: 'Facebook',
    // edge Facebook driver 的【编排能力子集】= {browse, search, comment, publish, interact, join}；本 registry 的
    // capabilities 只登记**有云端消费者**的编排词（browse / feed_refresh / search / group_join），comment/publish/interact
    // 的编排接线各在其专属路径（定向评论调度器 / FacebookPublishExecutor / 互动闸），不作零消费者声明。
    // search / group_join 的消费者是**非闸**的客户端指标投影（决定界面上有没有对应进度格）；动作闸与执行仍在
    // 各自专属路径。别把它们当零消费者声明删掉，也别把这张表误接成动作放行闸。
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
      // FB 全站/容器搜索均有真实执行器；此声明只供客户端今日进展塑形。
      search: { supported: true },
      // FB 群是真做的：调度器每天真点加入、风控计数器 join_group 真记账（含待审批）、
      // 后台用量表真在按「加群 用了/上限」显示。这条声明只让客户端也看得见同一个数。
      group_join: { supported: true },
    },
    identityCapture: {
      supported: true,
      command: 'identity.read_current',
      restore: 'none',
      capability: 'identity_read_current_v1',
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
      join_group: {
        supported: true,
        allowedModes: [],
        maxDailyCap: SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX,
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
      search: { supported: false, reason: 'interaction_inbox_only' },
      group_join: { supported: false, reason: 'interaction_inbox_only' },
    },
    identityCapture: { supported: false, reason: 'interaction_auth_identity_only' },
    pacing: {},
    scheduler: { comment: { enabled: false, defaultSort: 'none', defaultTimeWindow: 'none' } },
    scheduledAutomation: {
      post: { supported: false, reason: 'interaction_inbox_only' },
      comment: { supported: false, reason: 'interaction_inbox_only' },
      contact_comment: { supported: false, reason: 'interaction_inbox_only' },
      join_group: { supported: false, reason: 'interaction_inbox_only' },
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

export function identityCaptureStrategyForPlatform(
  platform: string | null | undefined,
): IdentityCaptureStrategy {
  return platformRegistryEntry(platform).identityCapture;
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
