import {
  normalizePlatformId,
  SCHEDULED_CONTENT_DAILY_CAP_MAX,
  SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX,
  SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX,
  type ScheduledAutomationAction,
  type ScheduledAutomationCatalogReader,
  type ScheduledAutomationSupport,
} from './platform-types.js';

export const SCHEDULED_AUTOMATION_ACTIONS = Object.freeze(
  ['post', 'comment', 'contact_comment', 'join_group'] as const satisfies readonly ScheduledAutomationAction[],
);

type MissingScheduledAutomationAction = Exclude<
  ScheduledAutomationAction,
  (typeof SCHEDULED_AUTOMATION_ACTIONS)[number]
>;
const scheduledAutomationActionUnionIsExhaustive: MissingScheduledAutomationAction extends never
  ? true
  : never = true;
void scheduledAutomationActionUnionIsExhaustive;

export const SCHEDULED_AUTOMATION_CATALOG = Object.freeze({
  xiaohongshu: Object.freeze({
    post: supported(['review', 'auto_approve'], SCHEDULED_CONTENT_DAILY_CAP_MAX),
    comment: supported(['review', 'auto_approve'], SCHEDULED_CONTENT_DAILY_CAP_MAX),
    contact_comment: supported(
      ['review', 'auto_approve'],
      SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX,
    ),
    join_group: unsupported('no_group_concept'),
  }),
  facebook: Object.freeze({
    post: supported(['review'], SCHEDULED_CONTENT_DAILY_CAP_MAX),
    comment: supported(['review', 'auto_approve'], SCHEDULED_CONTENT_DAILY_CAP_MAX),
    contact_comment: supported(
      ['review', 'auto_approve'],
      SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX,
    ),
    join_group: supported([], SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX),
  }),
  wechat_channels: Object.freeze({
    post: unsupported('interaction_inbox_only'),
    comment: unsupported('interaction_inbox_only'),
    contact_comment: unsupported('interaction_inbox_only'),
    join_group: unsupported('interaction_inbox_only'),
  }),
} as const satisfies Record<
  'xiaohongshu' | 'facebook' | 'wechat_channels',
  Record<ScheduledAutomationAction, ScheduledAutomationSupport>
>);

export const SCHEDULED_AUTOMATION_CATALOG_READER: ScheduledAutomationCatalogReader = Object.freeze({
  normalizeForCatalog: normalizePlatformForCatalog,
  availableActions: availableScheduledAutomationActionsForPlatform,
  declarationsFor: scheduledAutomationDeclarationsForPlatform,
});

export function normalizePlatformForCatalog(
  platform: string | null | undefined,
): string {
  try {
    return normalizePlatformId(platform);
  } catch {
    return platform?.trim().toLowerCase() || 'unknown';
  }
}

export function availableScheduledAutomationActionsForPlatform(
  platform: string | null | undefined,
) {
  const declaration = scheduledAutomationDeclarationsForPlatform(platform);
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
}

export function scheduledAutomationDeclarationsForPlatform(
  platform: string | null | undefined,
): Record<ScheduledAutomationAction, ScheduledAutomationSupport> | null {
  try {
    const source = SCHEDULED_AUTOMATION_CATALOG[normalizePlatformId(platform)];
    return Object.fromEntries(
      SCHEDULED_AUTOMATION_ACTIONS.map((action) => {
        const support = source[action];
        return [
          action,
          support.supported
            ? {
                supported: true,
                allowedModes: [...support.allowedModes],
                maxDailyCap: support.maxDailyCap,
              }
            : { supported: false, reason: support.reason },
        ];
      }),
    ) as Record<ScheduledAutomationAction, ScheduledAutomationSupport>;
  } catch {
    return null;
  }
}

function supported(
  allowedModes: readonly ('review' | 'auto_approve')[],
  maxDailyCap: number,
): ScheduledAutomationSupport {
  return Object.freeze({
    supported: true,
    allowedModes: Object.freeze([...allowedModes]),
    maxDailyCap,
  });
}

function unsupported(reason: string): ScheduledAutomationSupport {
  return Object.freeze({ supported: false, reason });
}
