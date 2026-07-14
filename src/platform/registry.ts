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
 * 编排能力词：v1 只保留**有真消费者**的两个（唯一消费者铁律，避免「声明了没人读」）。
 * - browse       消费者 = role-dispatcher 会话启动闸（canStartSession）。
 * - feed_refresh 消费者 = FeedScroller 构造（深度到阈值是否改点「刷新」）。
 * follow / profile_visit / patrol / notification 在 C4 追加**并同批接线消费者**，本 change 不含。
 */
export type OrchestrationCapability = 'browse' | 'feed_refresh';

/** 支持声明：不支持必带非空 reason（治「靠数值巧合不发」）。 */
export type NoteSupport = { supported: true } | { supported: false; reason: string };

export interface CommentPlatformProfile {
  platform: PlatformId;
  siteName: string;
  contentName: string;
  maxCommentLength: number;
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
    capabilities: { browse: { supported: true }, feed_refresh: { supported: true } },
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
    // feed_refresh 声明 supported（=今天 FeedScroller 对 FB 照常发 refresh）；FB 的「受控重新导航」实现在 C2，
    // 本 change 只声明能力、不改实现 ⇒ 零行为。
    capabilities: { browse: { supported: true }, feed_refresh: { supported: true } },
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
