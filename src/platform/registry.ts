export type PlatformId = 'xiaohongshu' | 'facebook';

export type PlatformCapability =
  | 'browse'
  | 'comment'
  | 'publish'
  | 'interact'
  | 'patrol'
  | 'notification';

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
    // 刻意只声明 'comment'，绝不含 'browse'：否则 edge 装配闸会把 xhs 浏览会话挂到 FB edge，
    // 且云端 session-start 平台闸（canStartSession）正是靠「capabilities 不含 browse」拦下 FB 账号起 xhs 浏览循环。
    capabilities: ['comment'],
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
