import { normalizePlatformId, type PlatformId } from '../platform/index.js';
import type { PublishCommandKind, PublishCommandParams, PublishCommandPayload } from '../comm/protocol.js';
import { computeFillTimeoutMs, DEFAULT_FILL_BUDGET, type FillBudgetConfig } from './fill-budget.js';
import type { PublishMetadata } from '../kernel/publish-pipeline-types.js';

export type PublishImageSource = 'generated' | 'account_pool';
export type PublishTargetKind = 'xhs_note' | 'facebook_personal_timeline';

/** Edge uses this as the total home-trigger + composer-open deadline. */
const FACEBOOK_COMPOSER_OPEN_TIMEOUT_MS = 40_000;

export interface PublishPlatformProfile {
  platform: Exclude<PlatformId, 'wechat_channels'>;
  displayName: string;
  imageSource: PublishImageSource;
  imageRequired: boolean;
  target: PublishTargetKind;
  supportsTitle: boolean;
  supportsTopics: boolean;
  supportsMetadata: boolean;
}

export const XHS_PUBLISH_PROFILE: PublishPlatformProfile = {
  platform: 'xiaohongshu',
  displayName: '小红书',
  imageSource: 'generated',
  imageRequired: true,
  target: 'xhs_note',
  supportsTitle: true,
  supportsTopics: true,
  supportsMetadata: true,
};

export const FACEBOOK_PUBLISH_PROFILE: PublishPlatformProfile = {
  platform: 'facebook',
  displayName: 'Facebook',
  imageSource: 'account_pool',
  imageRequired: true,
  target: 'facebook_personal_timeline',
  supportsTitle: false,
  supportsTopics: false,
  supportsMetadata: false,
};

export function publishProfileForPlatform(platform: string | null | undefined): PublishPlatformProfile {
  const normalized = normalizePlatformId(platform);
  if (normalized === 'wechat_channels') throw new Error('wechat_channels_publish_uses_interaction_reply_protocol');
  return normalized === 'facebook' ? FACEBOOK_PUBLISH_PROFILE : XHS_PUBLISH_PROFILE;
}

export interface BuildPublishCommandPlanInput {
  taskId: string;
  recordId: number;
  title: string;
  content: string;
  tags: string[];
  images: string[];
  cover?: string;
  metadata?: PublishMetadata;
  approvedByUser: boolean;
  platform?: PlatformId;
  /** Facebook 正文填写的单步预算配置；缺省用 DEFAULT_FILL_BUDGET。小红书路径不受影响。 */
  fillBudget?: FillBudgetConfig;
}

export function buildPublishCommandPlan(input: BuildPublishCommandPlanInput): PublishCommandPayload[] {
  const profile = publishProfileForPlatform(input.platform);
  const cmds: PublishCommandPayload[] = [];
  let seq = 0;
  const add = (kind: PublishCommandKind, params: PublishCommandParams = {}, timeoutMs?: number) => {
    cmds.push({
      taskId: input.taskId,
      recordId: input.recordId,
      seq: seq++,
      kind,
      params,
      platform: profile.platform,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  };

  add('navigate_entry');
  add(
    'select_mode',
    { optionKind: 'target', optionValue: profile.target },
    profile.platform === 'facebook' ? FACEBOOK_COMPOSER_OPEN_TIMEOUT_MS : undefined,
  );
  for (const url of input.images) add('upload_image', { imageUrl: url });

  if (profile.platform === 'facebook') {
    // FB 正文逐字输入（编辑器拒整段灌入）：O(n) 的输入不能撞常数墙，预算随正文长度伸缩下发。
    // 边缘据此自我掐表、超时清场诚实回报；云端只多等一点点兜底（见 CommandSequencer.resultSlackMs）。
    add(
      'fill_field',
      { fieldType: 'content', value: input.content },
      computeFillTimeoutMs(input.content, input.fillBudget ?? DEFAULT_FILL_BUDGET),
    );
    if (!input.approvedByUser) return cmds;
    add('submit_publish');
    add('capture_postId');
    return cmds;
  }

  if (input.cover && input.images.length > 1) add('set_cover', { imageUrl: input.cover });
  add('fill_field', { fieldType: 'title', value: input.title });
  add('fill_field', { fieldType: 'content', value: input.content });
  for (const tag of input.tags) add('add_with_candidate', { candidateKind: 'topic', value: tag, candidates: [tag] });

  const md = input.metadata;
  if (md) {
    for (const mention of md.mentions) {
      add('add_with_candidate', { candidateKind: 'mention', value: mention, candidates: [mention] });
    }
    if (md.location) add('add_with_candidate', { candidateKind: 'location', value: md.location, candidates: [md.location] });
    if (md.collection) add('add_with_candidate', { candidateKind: 'collection', value: md.collection, candidates: [md.collection] });
    add('set_option', { optionKind: 'visibility', optionValue: md.visibility });
    add('set_option', { optionKind: 'comment_permission', optionValue: md.permissions.comment });
    add('set_option', { optionKind: 'save_permission', optionValue: md.permissions.save });
    if (md.compliance.ai) add('set_option', { optionKind: 'declaration_ai', optionValue: 'true' });
    if (md.compliance.ad) add('set_option', { optionKind: 'declaration_ad', optionValue: 'true' });
    if (md.compliance.origin) add('set_option', { optionKind: 'declaration_origin', optionValue: 'true' });
    if (md.mode === 'scheduled' && md.publishTime) add('set_schedule', { publishTime: md.publishTime });
  }

  if (!input.approvedByUser) return cmds;
  add('submit_publish');
  if (md?.mode === 'scheduled' && md.publishTime) {
    add('capture_scheduled', { publishTime: md.publishTime, scheduledTitle: input.title });
  } else {
    add('capture_postId');
  }
  return cmds;
}
