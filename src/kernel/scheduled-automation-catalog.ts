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

/**
 * 新登记账号的自动化默认配置（change seed-facebook-automation-defaults-on-registration）。
 *
 * 纯数据、按平台声明。**只有列在这里的平台才种入**——没有条目 = 不种。这与目录本身「没声明就是
 * 不支持」的语义一致，也让「新增平台要不要种」成为一次显式决定，而不是一个默认发生的行为。
 *
 * 取值依据（用户 2026-07-29 定）：总开关开、发帖 5、评论 20、加群 20、联系评论 5。
 *
 * **联系评论是有前置条件的一项**（change seed-facebook-contact-comment-default）。它最初被刻意排除，
 * 理由是机制性的：带「先加群再评论」标记的复合动作**只挂在联系评论上**（独立加群动作不带该标记），
 * 种它就等于让新账号具备「加入新群后同一轮立即在该群评论」这一会招致平台警告的形态。
 *
 * 该前置已由 change decouple-scheduled-contact-comment-from-group-join 解除：排期联系评论不再携带
 * 那个标记，改走已加入群账本的选群口，因而受预热期与单群冷却约束。
 *
 * **绑定关系，MUST NOT 删成一句「默认开」**：若将来任何改动让排期联系评论重新携带「先加群」标记，
 * 下面这三项种入取值 MUST 同时撤回。两者是一对前提与结论，不是两件独立的配置。
 *
 * 审批模式：发帖 `review`（Facebook 发帖只允许需人审），评论与联系评论 `auto_approve`（用户 2026-07-29 定）。
 *
 * 小红书与视频号刻意不列：本次诉求是 Facebook；视频号四个动作在上面的目录里全部 unsupported，
 * 给它写任何正日上限都会被写前校验整块拒。
 */
export const NEW_ACCOUNT_AUTOMATION_DEFAULTS = Object.freeze({
  facebook: Object.freeze({
    schedule: Object.freeze({
      autoEnabled: true,
      // 发帖只能是需人审：免审对 Facebook 发帖在规格里就是禁用 / fail-closed，没得选。
      postMode: 'review',
      postDailyCap: 5,
      // 评论取免审（用户 2026-07-29 决定，推翻本 change 初稿的需人审）。
      // 可达性已核：环境级评论审批策略只能把来源模式**升**成免审，缺省 `source_rules` 时逐字沿用来源模式；
      // 只有策略读取失败才 fail-closed 回需人审——失败方向安全。
      // 后果如实记在这里：新账号一旦绑上人设并通过其余各闸，评论会直接发到平台、无人过目。
      commentMode: 'auto_approve',
      commentDailyCap: 20,
      // 联系评论（change seed-facebook-contact-comment-default，前置见上方绑定关系说明）。
      //
      // 日上限取 5、**不取该动作自身的硬上限 10**，两条约束共同决定：
      //  ① 联系评论的自动路径同样要过评论配额闸，与普通评论**竞争同一个池子**（dev 当前普通档评论
      //     日额 8），定高会挤占普通评论；
      //  ② 它是**尝试型**上限——被拒或无目标同样占额度，名义上限与实际发出量之间本就有折损。
      // 这个数字是设计判断而非用户指定，改它只需动这一处。
      //
      // 缺联系方式时排期路径 fail-closed（绝不降级成不带联系方式的普通评论——那条降级只有固定规则
      // 模式会显式声明）。所以新号在补上联系方式之前，每个槽位会诚实不发并回一张提示，日上限 5 已把
      // 这个提示量压在个位数。
      contactCommentMode: 'auto_approve',
      contactCommentDailyCap: 5,
    }),
    joinGroup: Object.freeze({ enabled: true, dailyCap: 20 }),
  }),
} as const);

/** 种入行的写入署名：与运营手工写入区分，便于事后追溯哪些行是自动种出来的。 */
export const NEW_ACCOUNT_AUTOMATION_SEED_ACTOR = 'system:new-account-seed';

/** 该平台的种入默认值；无条目返回 null（= 不种）。 */
export function newAccountAutomationDefaultsFor(
  platform: string | null | undefined,
): (typeof NEW_ACCOUNT_AUTOMATION_DEFAULTS)['facebook'] | null {
  return normalizePlatformForCatalog(platform) === 'facebook'
    ? NEW_ACCOUNT_AUTOMATION_DEFAULTS.facebook
    : null;
}

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
