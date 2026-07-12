export type PlatformId = 'xiaohongshu' | 'facebook';

export type PlatformCapability =
  | 'browse'
  | 'comment'
  | 'publish'
  | 'interact'
  | 'patrol'
  | 'notification'
  // 'join'：Facebook 加群编排能力（change facebook-group-join-and-commenting）。加入是为了与 edge Facebook
  // driver 的能力词表对齐（change facebook-browse-and-like-loop task 5.4：消除 join 词表错配）。
  | 'join';

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
  capabilities: readonly PlatformCapability[];
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

export const PLATFORM_REGISTRY: Record<'xiaohongshu', PlatformRegistryEntry> &
  Partial<Record<PlatformId, PlatformRegistryEntry>> = {
  xiaohongshu: {
    platform: 'xiaohongshu',
    app: 'xhs',
    displayName: '小红书',
    capabilities: ['browse', 'comment', 'publish', 'interact', 'patrol', 'notification'],
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
    // 声明 'browse'/'interact'（change facebook-browse-and-like-loop）：edge 侧已原子同落 FacebookBrowseSession，
    // 装配闸解析到 FB 浏览会话而非 xhs BrowseSession，session-start 平台闸（canStartSession，见 role-dispatcher）
    // 靠 `capabilities.includes('browse')` 放行 FB 账号起浏览闭环。'comment'/'join' 为既有定向评论/加群编排能力。
    // 'publish' 与 edge FacebookPublishExecutor 同落（facebook-post-publish）。
    // 与 edge Facebook driver 的【编排能力子集】{browse, comment, publish, interact, join} 逐字对齐；
    // edge 另有 'identity'/'overlay' 为 driver 运行时能力（读身份 / 监测浮层），非编排词表、不进本 registry。
    capabilities: ['browse', 'comment', 'publish', 'interact', 'join'],
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
