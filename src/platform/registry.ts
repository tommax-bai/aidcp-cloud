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
