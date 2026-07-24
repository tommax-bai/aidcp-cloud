// 全部 prompt 构建符号均从 kernel 直接导入：纯构建段已抬入 kernel（change decouple-behavior-class-ports），
// 各业务角色文件从 kernel 等值再导出、运行时行为逐字不变；本 api 侧预览直连 kernel 以消去跨边界依赖。
import { buildFacebookGroupJoinJudgePrompt } from '../kernel/facebook-group-join-prompt.js';
import { buildFacebookCommentComposerPrompt } from '../kernel/facebook-comment-composer-prompt.js';
import { buildInteractionReplyPrompt } from '../kernel/interaction-reply-prompt.js';
import type {
  IntentClassifierInput,
  MinimalInbound,
  PolisherInput,
  RiskReviewerInput,
} from '../kernel/interaction-types.js';
import type { Soul } from '../kernel/soul-types.js';
import { buildCoverFormSensePrompt } from '../kernel/cover-form-sense-prompt.js';
import { buildCoverCardCopyPrompt } from '../kernel/cover-card-copy-prompt.js';
import { buildVisualFidelityAuditPrompt } from '../kernel/visual-fidelity-audit-prompt.js';
import {
  buildVisualReferenceSetPrompt,
  buildVisualReferenceSpecialistPrompt,
} from '../kernel/visual-reference-prompts.js';

export interface StaticRolePromptPreview {
  build: (soul?: Soul) => string;
  note: string;
  usesPersona?: boolean;
}

const INTERACTION_NOTE = '视频号收件箱角色的真实 prompt；收件内容、账号与策略均为明示示例占位，不使用账号人设。';
const INDEPENDENT_BROWSE_NOTE = '独立业务角色的真实 prompt；页面数据为明示示例占位，不使用账号人设。';
const PERSONA_BROWSE_NOTE = '独立业务角色的真实 prompt；帖子数据为明示示例占位，人设为示例人设。';
const PUBLISH_NO_PERSONA_NOTE = '发布角色的真实 prompt；标题、正文与标签为明示示例占位，不使用账号人设。';
const VISION_NOTE = '视觉模型的真实文本指令；图片为明示示例占位，预览不会读取任何真实业务图片。';
const MULTI_STAGE_VISION_NOTE = '多阶段视觉模型的真实文本指令合集；每段单独发送，图片为明示示例占位，预览不会读取真实业务图片。';

const EXAMPLE_INBOUND: MinimalInbound = {
  channel: 'comment',
  messageType: 'text',
  text: '<示例用户留言：这个分享很实用，已经收藏啦！>',
  userName: '<示例用户昵称>',
  videoTitle: '<示例视频标题>',
  recentMessages: [
    { direction: 'inbound', text: '<示例历史消息：很喜欢你的视频风格>' },
    { direction: 'outbound', text: '<示例历史回复：谢谢喜欢呀>' },
  ],
};

const EXAMPLE_CLASSIFIER_INPUT: IntentClassifierInput = {
  role: 'reply_intent_classifier',
  requestId: '<示例请求ID>',
  accountId: '<示例账号ID>',
  inbound: EXAMPLE_INBOUND,
};

const EXAMPLE_POLISHER_INPUT: PolisherInput = {
  role: 'reply_polisher',
  requestId: '<示例请求ID>',
  accountId: '<示例账号ID>',
  inbound: EXAMPLE_INBOUND,
  intent: 'gratitude',
  renderedText: '<示例模板回复：谢谢喜欢，很开心这个分享对你有帮助。>',
  profile: {
    tone: ['friendly', 'concise'],
    maxLength: 120,
    allowEmoji: false,
    allowLinks: false,
    blockedPhrases: ['<示例禁用短语>'],
    requiredDisclaimer: '<示例必要说明>',
    knowledgeDocument: '# 内容说明\n- <示例主题>适合<示例人群>。\n- 更多细节以私信沟通为准。',
  },
};

const EXAMPLE_REVIEWER_INPUT: RiskReviewerInput = {
  role: 'reply_risk_reviewer',
  requestId: '<示例请求ID>',
  accountId: '<示例账号ID>',
  inbound: EXAMPLE_INBOUND,
  renderedText: '<示例模板回复：谢谢喜欢，很开心这个分享对你有帮助。>',
  candidateText: '<示例候选回复：谢谢喜欢呀，很开心能帮到你。>',
  meaningChanged: false,
  introducedClaims: [],
  policy: { mode: 'review_before_send', hardRiskTags: ['order', 'shipping', 'unknown'] },
};

const EXAMPLE_FACEBOOK_SOUL: Pick<Soul, 'identity'> = {
  identity: {
    name: '<示例 Facebook 账号>',
    role: '<示例账号定位>',
    background: '<示例背景>',
    tone: '<示例语气>',
  },
};

export const STATIC_ROLE_PROMPT_PREVIEWS: Record<string, StaticRolePromptPreview> = {
  reply_intent_classifier: {
    build: () => buildInteractionReplyPrompt(EXAMPLE_CLASSIFIER_INPUT),
    note: INTERACTION_NOTE,
  },
  reply_polisher: {
    build: () => buildInteractionReplyPrompt(EXAMPLE_POLISHER_INPUT),
    note: INTERACTION_NOTE,
  },
  reply_risk_reviewer: {
    build: () => buildInteractionReplyPrompt(EXAMPLE_REVIEWER_INPUT),
    note: INTERACTION_NOTE,
  },
  'browse:facebook_group_join_judge': {
    build: () => buildFacebookGroupJoinJudgePrompt('pre_click', {
      groupUrl: '<示例群组URL>',
      pageUrl: '<示例页面URL>',
      title: '<示例 Facebook 群组名>',
      mainCtaText: '<示例加入按钮文案>',
      mainCtaAria: '<示例加入按钮 aria>',
      headerText: '<示例群组页头文本>',
      modalText: null,
      membershipSignals: [],
      loginRequired: false,
      captchaDetected: false,
      questionnaireRequired: false,
      pendingRequest: false,
      navError: null,
      composerPresent: false,
      joinCtaPresent: true,
    }),
    note: INDEPENDENT_BROWSE_NOTE,
  },
  facebook_comment_composer: {
    build: (soul) => buildFacebookCommentComposerPrompt({
      soul: soul ?? EXAMPLE_FACEBOOK_SOUL,
      writingLanguage: 'zh-CN',
      keyword: '<示例话题>',
      postText: '<示例 Facebook 帖子正文>',
      comments: ['<示例他人评论一>', '<示例他人评论二>'],
    }),
    note: PERSONA_BROWSE_NOTE,
    usesPersona: true,
  },
  'publish:CoverCardWriter': {
    build: () => buildCoverCardCopyPrompt(
      '<示例笔记标题>',
      '<示例笔记正文：这里是洗稿后的正文内容，仅用于展示封面文字卡角色实际收到的 prompt。>',
      ['<示例标签一>', '<示例标签二>'],
    ),
    note: PUBLISH_NO_PERSONA_NOTE,
  },
  'publish:CoverFormSensor': {
    build: () => buildCoverFormSensePrompt(),
    note: VISION_NOTE,
  },
  'publish:VisualReferenceAnalyzer': {
    build: () => [
      '【阶段 1：整组视觉语言与顺序角色】',
      buildVisualReferenceSetPrompt(),
      '',
      '【阶段 2：示例 photo 视觉结构专家，sourceArrayIndex=0】',
      buildVisualReferenceSpecialistPrompt('photo', [0]),
    ].join('\n'),
    note: MULTI_STAGE_VISION_NOTE,
  },
  'publish:VisualFidelityAuditor': {
    build: () => [
      '【有主参考图：视觉保真模式】',
      buildVisualFidelityAuditPrompt({
        accountId: '<示例账号ID>',
        referenceUrl: '<示例主参考图URL>',
        generatedUrl: '<示例生成图URL>',
      }),
      '',
      '【无主参考图：正文一致性模式】',
      buildVisualFidelityAuditPrompt({
        accountId: '<示例账号ID>',
        generatedUrl: '<示例生成图URL>',
        expectedKind: 'scene_photo',
        slotRole: 'cover_hook',
      }),
    ].join('\n'),
    note: MULTI_STAGE_VISION_NOTE,
  },
};
