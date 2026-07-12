import { normalizePlatformId, type PlatformId } from '../platform/index.js';
import type { PublishCommandKind, PublishCommandParams, PublishCommandPayload } from '../comm/protocol.js';
import type { PublishMetadata } from './types.js';

export type PublishImageSource = 'generated' | 'account_pool';
export type PublishTargetKind = 'xhs_note' | 'facebook_personal_timeline';

export interface PublishPlatformProfile {
  platform: PlatformId;
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
  return normalizePlatformId(platform) === 'facebook' ? FACEBOOK_PUBLISH_PROFILE : XHS_PUBLISH_PROFILE;
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
}

export function buildPublishCommandPlan(input: BuildPublishCommandPlanInput): PublishCommandPayload[] {
  const profile = publishProfileForPlatform(input.platform);
  const cmds: PublishCommandPayload[] = [];
  let seq = 0;
  const add = (kind: PublishCommandKind, params: PublishCommandParams = {}) => {
    cmds.push({
      taskId: input.taskId,
      recordId: input.recordId,
      seq: seq++,
      kind,
      params,
      platform: profile.platform,
    });
  };

  add('navigate_entry');
  add('select_mode', { optionKind: 'target', optionValue: profile.target });
  for (const url of input.images) add('upload_image', { imageUrl: url });

  if (profile.platform === 'facebook') {
    add('fill_field', { fieldType: 'content', value: input.content });
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
  add('capture_postId');
  return cmds;
}
