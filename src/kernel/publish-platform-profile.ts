/**
 * 发布平台档案的**纯数据模型 + 纯查表函数**
 * （change cloud-coupling-phase5 从 `src/publish-agent/platform-profile.ts` 析出）。
 *
 * 析出而非整文件移动：原文件里 `buildPublishCommandPlan` 产出的是边云协议命令载荷
 * （`PublishCommandPayload`，引 `src/comm/protocol.ts`），那一段是货真价实的下发段代码、留 automation。
 * 而档案本身（平台标识、显示名、配图来源、是否必须配图、目标形态、支持哪些字段）零协议依赖，
 * 只查 kernel 自己的 `platform-types`，是三域都可能读的常量表。
 *
 * 直接诱因：发布出口角色（`roles/publish-executor.ts`）只为取一个 `displayName` 就引了整个下发段文件，
 * 该角色按 §4.6.3 自己的机械判据归 content——那条边是「为一个显示名跨服务」。
 *
 * 零 SQL、零 HTTP、零 LLM、无进程内活状态（两个常量是对象字面量、非 Map/Set），满足 §4.7 kernel 准入。
 */
import { normalizePlatformId, type PlatformId } from './platform-types.js';

export type PublishImageSource = 'generated' | 'account_pool';
export type PublishTargetKind = 'xhs_note' | 'facebook_personal_timeline';

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
