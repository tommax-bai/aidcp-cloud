/**
 * 发布下发段：把发布输入翻译成边云协议命令序列。
 *
 * 平台档案本体（`PublishPlatformProfile` / 两个常量 / `publishProfileForPlatform`）已析出到
 * `src/kernel/publish-platform-profile.ts`（change cloud-coupling-phase5）——它零协议依赖、三域可读；
 * 本文件只留真正引边云协议的那一段。跨属主消费方 MUST 直指 kernel，MUST NOT 从这里再导出。
 */
import type { PlatformId } from '../kernel/platform-types.js';
import type { PublishCommandKind, PublishCommandParams, PublishCommandPayload } from '../comm/protocol.js';
import { computeFillTimeoutMs, DEFAULT_FILL_BUDGET, type FillBudgetConfig } from './fill-budget.js';
import type { PublishMetadata } from '../kernel/publish-pipeline-types.js';
import { publishProfileForPlatform } from '../kernel/publish-platform-profile.js';

/** Edge uses this as the total home-trigger + composer-open deadline. */
const FACEBOOK_COMPOSER_OPEN_TIMEOUT_MS = 40_000;

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
