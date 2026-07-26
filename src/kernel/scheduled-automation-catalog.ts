import {
  normalizePlatformId,
  SCHEDULED_CONTENT_DAILY_CAP_MAX,
  SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX,
  SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX,
  type ScheduledAutomationAction,
  type ScheduledAutomationCatalogReader,
  type ScheduledAutomationSupport,
} from './platform-types.js';

export const SCHEDULED_AUTOMATION_ACTIONS = [
  'post',
  'comment',
  'contact_comment',
  'join_group',
] as const satisfies readonly ScheduledAutomationAction[];

export const SCHEDULED_AUTOMATION_CATALOG = {
  xiaohongshu: {
    post: supported(['review', 'auto_approve'], SCHEDULED_CONTENT_DAILY_CAP_MAX),
    comment: supported(['review', 'auto_approve'], SCHEDULED_CONTENT_DAILY_CAP_MAX),
    contact_comment: supported(
      ['review', 'auto_approve'],
      SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX,
    ),
    join_group: { supported: false, reason: 'no_group_concept' },
  },
  facebook: {
    post: supported(['review'], SCHEDULED_CONTENT_DAILY_CAP_MAX),
    comment: supported(['review', 'auto_approve'], SCHEDULED_CONTENT_DAILY_CAP_MAX),
    contact_comment: supported(
      ['review', 'auto_approve'],
      SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX,
    ),
    join_group: supported([], SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX),
  },
  wechat_channels: {
    post: { supported: false, reason: 'interaction_inbox_only' },
    comment: { supported: false, reason: 'interaction_inbox_only' },
    contact_comment: { supported: false, reason: 'interaction_inbox_only' },
    join_group: { supported: false, reason: 'interaction_inbox_only' },
  },
} as const satisfies Record<
  'xiaohongshu' | 'facebook' | 'wechat_channels',
  Record<ScheduledAutomationAction, ScheduledAutomationSupport>
>;

export const SCHEDULED_AUTOMATION_CATALOG_READER: ScheduledAutomationCatalogReader = {
  normalizeForCatalog: (platform) => {
    try {
      return normalizePlatformId(platform);
    } catch {
      return platform?.trim().toLowerCase() || 'unknown';
    }
  },
  availableActions: (platform) => {
    const declaration = declarationsFor(platform);
    if (!declaration) return [];
    return SCHEDULED_AUTOMATION_ACTIONS.flatMap((action) => {
      const support = declaration[action];
      return support.supported
        ? [
            {
              action,
              allowedModes: [...support.allowedModes],
              maxDailyCap: support.maxDailyCap,
            },
          ]
        : [];
    });
  },
  declarationsFor,
};

function declarationsFor(
  platform: string | null | undefined,
): Record<ScheduledAutomationAction, ScheduledAutomationSupport> | null {
  try {
    return SCHEDULED_AUTOMATION_CATALOG[normalizePlatformId(platform)];
  } catch {
    return null;
  }
}

function supported(
  allowedModes: readonly ('review' | 'auto_approve')[],
  maxDailyCap: number,
): ScheduledAutomationSupport {
  return { supported: true, allowedModes, maxDailyCap };
}
