export type PlatformId = 'xiaohongshu' | 'facebook';

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
 * - follow        消费者 = FollowAgent（注入 canFollow：不支持则跳过关注、仍产 profile.done 保返回链）。
 * **不变量**：follow ⇒ profile_visit ⇒ browse（关注前必先访主页；主页访问是浏览的子能力）。v1 两平台皆满足
 * （小红书四词全支持 / Facebook 四词全不支持）；新增「访主页但不关注」类平台时须保 follow⇒profile_visit。
 */
export type OrchestrationCapability =
  | 'browse'
  | 'feed_refresh'
  | 'follow'
  | 'profile_visit'
  | 'patrol'
  | 'notification';

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
  comment: CommentPlatformProfile;
}

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
  // FB 的帖子多为当地语言（英/泰/越/印尼…）。浏览闭环撰写器此前无任何语言约束、prompt 全中文 ⇒ 会往
  // 当地语言的群里丢中文评论。定向评论路径（server.ts facebookCompose）早有这条规则，此处补齐同口径。
  composeLanguageRule:
    '**用与帖子正文 / 现有评论相同的语言写**（当地语言）；除非原文本来就是中文，否则绝不要用中文',
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

export const PLATFORM_REGISTRY: Record<'xiaohongshu', PlatformRegistryEntry> &
  Partial<Record<PlatformId, PlatformRegistryEntry>> = {
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
      profile_visit: { supported: true },
      patrol: { supported: true },
      notification: { supported: true },
    },
    pacing: {},
    scheduler: {
      comment: {
        enabled: true,
        defaultSort: XHS_COMMENT_PROFILE.search.defaultSort,
        defaultTimeWindow: XHS_COMMENT_PROFILE.search.defaultTimeWindow,
      },
    },
    comment: XHS_COMMENT_PROFILE,
  },
  facebook: {
    platform: 'facebook',
    app: 'fb',
    displayName: 'Facebook',
    // edge Facebook driver 的【编排能力子集】= {browse, comment, publish, interact, join}；本 registry 的
    // capabilities 只登记**有云端消费者**的编排词（browse / feed_refresh），comment/publish/interact/join 的
    // 编排接线各在其专属路径（定向评论调度器 / FacebookPublishExecutor / 互动闸），不作零消费者声明。
    noteActions: FB_NOTE_ACTIONS,
    // 就地读/赞已开（change facebook-feed-inline-browse 灰度「开关打开」）：read/like='feed'（首页就地展开读全文 +
    // 逐帖 react），comment 留 'detail'（评论必进详情页，P5 已证 ⇒ 读=feed 与评=detail 不等 ⇒ 回执驱动两步迁移）。
    // 版本偏斜闸（effectiveReadSurface）：仅对声明 inline_targeting 的边缘生效，老边端 / 未重打包回落 detail=今天。
    // 注：like 的实际执行 surface 由边缘按 DOM 作用域自判（dialog→detail / feed→feed），云端归账键 read_content；
    // 本 like 值当前无独立云端消费者（无 resolveLikeSurface），设 'feed' 仅为语义一致 + 未来预留。
    // 回滚（不需重发桌面客户端）：把值改回 'detail' 重部署 cloud，或边缘启动器 AIDCP_FB_BROWSE_AUTO≠on 停真互动。
    noteSurfaces: { read_content: 'feed', like: 'feed', comment: 'detail' },
    // feed_refresh 声明 supported（=今天 FeedScroller 对 FB 照常发 refresh）；FB 的「受控重新导航」实现在 C2。
    // C4：FB 不做通知巡视（不上报 notification.detected）/ 不访作者主页 / 不关注（edge FB driver 无 profile/follow 执行器）
    // ⇒ patrol/notification/profile_visit/follow 显式不支持 + reason；据此不注册 12 巡视角色 + ProfileOpener，
    // 且 AuthorEvaluator 短路只产 profile.skipped（主页子链结构不触发）。ProfileBrowser/AuthorEvaluator/FollowAgent
    // 仍注册：AuthorEvaluator 是评论后返回 feed 的桥、FollowAgent 的 profile.done 是主页子链返回信号（皆须常在）；
    // ProfileBrowser 恒注册纯为无害（FB 经 canVisitProfile 结构不访作者主页；本人昵称采集另由永久接线的
    // NicknameEnricher 独立消费，ProfileBrowser 对本人 early-return，两者不相干）。
    capabilities: {
      browse: { supported: true },
      feed_refresh: { supported: true },
      follow: { supported: false, reason: 'no_follow_actuator' },
      profile_visit: { supported: false, reason: 'no_profile_actuator' },
      patrol: { supported: false, reason: 'no_notification_patrol' },
      notification: { supported: false, reason: 'no_notification_surface' },
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
    comment: FB_COMMENT_PROFILE,
  },
};

export function normalizePlatformId(raw: string | null | undefined): PlatformId {
  const value = (raw ?? 'xiaohongshu').trim().toLowerCase();
  if (!value || value === 'xhs' || value === 'redbook' || value === 'xiaohongshu') return 'xiaohongshu';
  if (value === 'facebook' || value === 'fb') return 'facebook';
  throw new Error(`unsupported platform=${raw}`);
}

export function platformRegistryEntry(platform: string | null | undefined): PlatformRegistryEntry {
  const id = normalizePlatformId(platform);
  const entry = PLATFORM_REGISTRY[id];
  if (!entry) throw new Error(`platform=${id} has no cloud registry entry`);
  return entry;
}

export function commentProfileForPlatform(platform: string | null | undefined): CommentPlatformProfile {
  return platformRegistryEntry(platform).comment;
}

export function defaultCommentSearchLabel(profile: CommentPlatformProfile = XHS_COMMENT_PROFILE): string {
  return `${profile.search.defaultTimeWindowLabel}·${profile.search.defaultSortLabel}`;
}
