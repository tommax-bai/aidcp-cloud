import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { LlmClient } from '../../src/llm/index.js';
import { ReplyAiService } from '../../src/interactions/reply-ai.js';
import type { InteractionStore } from '../../src/interactions/interaction-store.js';
import type { ReplyConfigStore } from '../../src/interactions/reply-config-store.js';
import { ReplyWorkflow } from '../../src/interactions/reply-workflow.js';
import {
  isReplyPolicy,
  isReplyProfile,
  isReplyRule,
  isReplyTemplate,
  matchReplyRule,
  renderReplyTemplate,
  validateFinalReplyText,
  validateReplyConfig,
} from '../../src/interactions/reply-config.js';
import type { MinimalInbound, ReplyConfigSnapshot, ReplyProfile, ReplyRule, ReplyTemplate, ScopedJobContext } from '../../src/interactions/types.js';

const now = 1784044800000;
const inbound: MinimalInbound = {
  channel: 'comment', messageType: 'text', text: '谢谢分享', userName: '小王', videoTitle: '示例视频',
  recentMessages: [{ direction: 'inbound', text: '谢谢分享' }],
};
const profile = (channel: 'comment' | 'dm'): ReplyProfile => ({
  channel, selfName: '示例视频号', userAddress: '你', tone: ['friendly', 'concise'], maxLength: 500,
  allowEmoji: false, allowLinks: false, blockedPhrases: ['保证'], disallowedClaims: ['现货'],
  requiredDisclaimer: null,
  variableFallbacks: { user_name: '朋友', video_title: '这个视频', account_name: '本账号', support_channel: '客服' },
});
const template: ReplyTemplate = {
  templateId: 'thanks-v1', channel: 'comment', name: '感谢',
  content: '{{ user_name }}，谢谢关注 {{ account_name }}。', enabled: true, archived: false,
  templateVersion: 1, variables: ['user_name', 'account_name'], updatedAt: now, updatedBy: 'admin',
};
const rule = (ruleId: string, priority: number, templateId = template.templateId): ReplyRule => ({
  ruleId, channel: 'comment', name: ruleId, priority, enabled: true,
  conditions: { keywordsAny: [], intentsAny: ['gratitude'], sourceExternalIds: [], messageTypes: ['text'], workHours: null },
  actions: { templateId, polish: true, allowAutoSend: false, forceHumanTags: [] },
  updatedAt: now, updatedBy: 'admin',
});
const snapshot = (): ReplyConfigSnapshot => ({
  accountId: 'acct_wc_demo', platform: 'wechat_channels', configVersion: 2, state: 'published',
  policy: {
    mode: 'review_before_send', generateDrafts: true, sendReplies: true,
    channels: {
      comment: { enabled: true, aiPolishEnabled: true, allowAutoSend: false },
      dm: { enabled: true, aiPolishEnabled: true, allowAutoSend: false },
    },
    rateLimits: { accountPerMinute: 1, accountPerHour: 5, accountPerDay: 20,
      threadCooldownSeconds: 60, newLoginCooldownSeconds: 600, consecutiveFailureLimit: 3 },
  },
  templates: [template], rules: [rule('later', 20), rule('first', 10)], profiles: [profile('comment'), profile('dm')],
  createdAt: now, createdBy: 'admin', publishedAt: now, publishedBy: 'admin',
});

test('rule priority is deterministic and equal-priority conflicts fail closed', () => {
  const config = snapshot();
  assert.equal(matchReplyRule(config, { inbound, intent: 'gratitude', sourceExternalId: null, now })?.ruleId, 'first');

  config.rules = [rule('a', 10, 'thanks-v1'), rule('b', 10, 'other-template')];
  assert.ok(validateReplyConfig(config).some((issue) => issue.code === 'ambiguous_rule'));
  assert.ok(validateReplyConfig(config).some((issue) => issue.code === 'template_unavailable'));
});

test('template rendering only allows the frozen variable whitelist and requires explicit fallbacks', () => {
  assert.equal(renderReplyTemplate(template, profile('comment'), {
    user_name: '小王', video_title: null, account_name: '示例视频号', support_channel: null,
  }), '小王，谢谢关注 示例视频号。');
  assert.throws(() => renderReplyTemplate({ ...template, content: '{{ coupon }}', variables: [] }, profile('comment'), {
    user_name: null, video_title: null, account_name: null, support_channel: null,
  }), /unknown_template_variable/);
  assert.throws(() => renderReplyTemplate(template, { ...profile('comment'), variableFallbacks: {
    ...profile('comment').variableFallbacks, user_name: '',
  } }, { user_name: null, video_title: null, account_name: '账号', support_channel: null }), /missing_template_variable/);
});

test('internal config payload guards reject extra fields and unknown nested values', () => {
  const config = snapshot();
  assert.equal(isReplyPolicy(config.policy), true);
  assert.equal(isReplyTemplate(template), true);
  assert.equal(isReplyRule(config.rules[0]), true);
  assert.equal(isReplyProfile(config.profiles[0]), true);
  assert.equal(isReplyPolicy({ ...config.policy, hidden: true }), false);
  assert.equal(isReplyTemplate({ ...template, variables: ['coupon'] }), false);
  assert.equal(isReplyRule({ ...config.rules[0], actions: { ...config.rules[0].actions, forceHumanTags: ['invented'] } }), false);
  assert.equal(isReplyRule({ ...config.rules[0], conditions: { ...config.rules[0].conditions, keywordsAny: [' '] } }), false);
  assert.equal(isReplyRule({ ...config.rules[0], conditions: { ...config.rules[0].conditions,
    workHours: { timezone: 'Not/A_Timezone', start: '09:00', end: '18:00' } } }), false);
  assert.ok(validateFinalReplyText(profile('comment'), '谢谢 😊').some((issue) => issue.code === 'emoji_forbidden'));
});

test('dedicated AI roles consume frozen fixtures and reject malformed structured output', async () => {
  const names = ['classifier-comment-output.json','polisher-comment-output.json','reviewer-comment-output.json'];
  const outputs = await Promise.all(names.map(async (name) => JSON.parse(await readFile(
    new URL(`../fixtures/wechat-channels-interaction/v1/ai/${name}`, import.meta.url), 'utf8')) as unknown));
  const accountIds: Array<string | undefined> = [];
  const llm: LlmClient = { complete: async (_prompt, options) => {
    accountIds.push(options?.accountId);
    return JSON.stringify(outputs.shift());
  } };
  const ai = new ReplyAiService(llm, 100);
  const classifier = await ai.classify({ role: 'reply_intent_classifier', requestId: 'r1', accountId: 'acct_wc_demo', inbound });
  const polisher = await ai.polish({ role: 'reply_polisher', requestId: 'r2', accountId: 'acct_wc_demo', inbound,
    renderedText: '谢谢。', profile: { tone: ['friendly'], maxLength: 500, allowEmoji: false, allowLinks: false,
      blockedPhrases: [], requiredDisclaimer: null } });
  const reviewer = await ai.review({ role: 'reply_risk_reviewer', requestId: 'r3', accountId: 'acct_wc_demo', inbound,
    renderedText: '谢谢。', candidateText: polisher.value.polishedText, meaningChanged: false, introducedClaims: [],
    policy: { mode: 'review_before_send', hardRiskTags: ['unknown'] } });
  assert.deepEqual([classifier.fallback, polisher.fallback, reviewer.fallback], ['none', 'none', 'none']);
  assert.equal(classifier.value.role, 'reply_intent_classifier');
  assert.equal(reviewer.value.allowAutoSend, false);
  assert.deepEqual(accountIds, ['acct_wc_demo','acct_wc_demo','acct_wc_demo']);

  const malformed = new ReplyAiService({ complete: async () => '{"role":"reply_intent_classifier","intent":"gratitude","extra":true}' }, 100);
  const result = await malformed.classify({ role: 'reply_intent_classifier', requestId: 'bad', accountId: 'acct_wc_demo', inbound });
  assert.equal(result.fallback, 'invalid_schema');
  assert.equal(result.value.intent, 'unknown');
  assert.deepEqual(result.value.riskTags, ['unknown']);
});

test('AI timeout returns explainable fail-closed fallbacks and never emits an empty reply', async () => {
  const hung: LlmClient = { complete: async () => await new Promise<string>(() => {}) };
  const ai = new ReplyAiService(hung, 10);
  const classifier = await ai.classify({ role: 'reply_intent_classifier', requestId: 'timeout', accountId: 'acct_wc_demo', inbound });
  const polisher = await ai.polish({ role: 'reply_polisher', requestId: 'timeout', accountId: 'acct_wc_demo', inbound,
    renderedText: '确定的模板文本', profile: { tone: ['friendly'], maxLength: 500, allowEmoji: false,
      allowLinks: false, blockedPhrases: [], requiredDisclaimer: null } });
  const reviewer = await ai.review({ role: 'reply_risk_reviewer', requestId: 'timeout', accountId: 'acct_wc_demo', inbound,
    renderedText: '确定的模板文本', candidateText: '确定的模板文本', meaningChanged: false, introducedClaims: [],
    policy: { mode: 'auto_safe', hardRiskTags: ['unknown'] } });
  assert.equal(classifier.fallback, 'timeout');
  assert.equal(polisher.fallback, 'timeout');
  assert.equal(polisher.value.polishedText, '确定的模板文本');
  assert.equal(reviewer.fallback, 'timeout');
  assert.equal(reviewer.value.allowAutoSend, false);
  assert.equal(reviewer.value.riskLevel, 'unknown');
});

test('DM AI defaults off and no private-message body reaches classifier, polisher or reviewer', async () => {
  let calls = 0;
  const ai = new ReplyAiService({ complete: async () => { calls += 1; throw new Error('must_not_call'); } }, 100);
  const config = snapshot();
  config.templates = [{ ...template, templateId: 'dm-safe', channel: 'dm', content: '你好 {{ user_name }}，我们已收到。',
    variables: ['user_name'] }];
  config.rules = [{ ...rule('dm-catchall', 1, 'dm-safe'), channel: 'dm',
    conditions: { keywordsAny: [], intentsAny: ['unknown'], sourceExternalIds: [], messageTypes: ['text'], workHours: null },
    actions: { templateId: 'dm-safe', polish: true, allowAutoSend: true, forceHumanTags: [] } }];
  const workflow = new ReplyWorkflow({} as InteractionStore, {} as ReplyConfigStore, ai);
  const preview = await workflow.buildPreview(config, { ...inbound, channel: 'dm', text: '我的订单和手机号是……' }, null);
  assert.equal(calls, 0);
  assert.equal(preview.finalText, '你好 小王，我们已收到。');
  assert.equal(preview.riskLevel, 'unknown');
  assert.equal(preview.requiresApproval, true);
  assert.deepEqual(preview.reviewReasons, ['dm_ai_disabled']);
});

test('deterministic intent-to-risk mapping overrides an under-classified refund reply', async () => {
  const outputs = [
    { role: 'reply_intent_classifier', intent: 'refund', confidence: 0.99, riskTags: [], reasons: [] },
    { role: 'reply_risk_reviewer', riskLevel: 'low', riskTags: [], reasons: [], allowAutoSend: true },
  ];
  const ai = new ReplyAiService({ complete: async () => JSON.stringify(outputs.shift()) }, 100);
  const config = snapshot();
  config.policy.mode = 'auto_safe';
  config.policy.channels.comment.allowAutoSend = true;
  config.rules = [{ ...rule('refund', 1),
    conditions: { keywordsAny: [], intentsAny: ['refund'], sourceExternalIds: [], messageTypes: ['text'], workHours: null },
    actions: { templateId: template.templateId, polish: false, allowAutoSend: true, forceHumanTags: [] } }];
  const workflow = new ReplyWorkflow({} as InteractionStore, {} as ReplyConfigStore, ai);
  const preview = await workflow.buildPreview(config, { ...inbound, text: '怎么退款' }, null);
  assert.equal(preview.riskLevel, 'high');
  assert.ok(preview.riskReasons.includes('refund'));
  assert.equal(preview.requiresApproval, true);
});

test('explicit regenerate can recover a failed job, while inactive auth blocks before CAS mutation', async () => {
  const context: ScopedJobContext = {
    thread: { id: 'thread-a', platform: 'wechat_channels', accountId: 'acct_wc_demo', envKey: 'env-a',
      channel: 'comment', externalThreadId: 'thread-external', sourceExternalId: null, sourceTitle: null,
      sourceCoverUrl: null, participant: null, status: 'waiting_review', lastMessageAt: now, lastSyncedAt: now },
    message: { id: 'message-a', threadId: 'thread-a', direction: 'inbound', externalMessageId: 'message-external',
      externalParentId: null, externalRootId: null, messageType: 'text', contentText: '谢谢分享',
      attachmentMeta: null, lifecycle: 'active', platformCreatedAt: now },
    job: { id: 'job-a', inboundMessageId: 'message-a', state: 'failed', version: 4, matchedRuleId: null,
      configVersion: null, template: { templateId: null, templateVersion: null }, renderedText: null,
      polishedText: null, finalText: null, riskLevel: 'unknown', riskReasons: ['unknown'], approvalActor: null,
      approvedAt: null, idempotencyKey: null, updatedAt: now, meaningChanged: false, introducedClaims: [],
      lastErrorCode: 'INTERACTION_UPSTREAM_UNAVAILABLE' },
  };
  const transitions: Array<{ from: string[]; to: string }> = [];
  const store = {
    getJobContext: async () => context,
    getAuth: async () => ({ envKey: 'env-a', accountId: 'acct_wc_demo', platform: 'wechat_channels' as const,
      status: 'active' as const, browserState: 'closed' as const,
      capabilities: { commentsRead: true, commentsReply: true, dmRead: true, dmSendText: true, dmSendImage: false as const },
      identity: { externalId: 'finder', displayName: '账号', identityHash: `sha256:${'1'.repeat(64)}` },
      checkedAt: now, reasonCode: null }),
    transitionJob: async (input: { from: string[]; to: string }) => {
      transitions.push({ from: input.from, to: input.to });
      return { ...context.job, state: input.to, version: input.to === 'classifying' ? 5 : 6 };
    },
    recordAudit: async () => {},
  } as unknown as InteractionStore;
  const outputs = [
    { role: 'reply_intent_classifier', intent: 'gratitude', confidence: 1, riskTags: [], reasons: [] },
    { role: 'reply_polisher', polishedText: '小王，谢谢关注 示例视频号。', meaningChanged: false, introducedClaims: [], riskTags: [] },
    { role: 'reply_risk_reviewer', riskLevel: 'low', riskTags: [], reasons: [], allowAutoSend: false },
  ];
  const workflow = new ReplyWorkflow(store, { getSnapshot: async () => snapshot() } as unknown as ReplyConfigStore,
    new ReplyAiService({ complete: async () => JSON.stringify(outputs.shift()) }, 100));
  const regenerated = await workflow.generate({ accountId: 'acct_wc_demo', envKey: 'env-a', jobId: 'job-a',
    expectedVersion: 4, actor: 'client:user-a' });
  assert.equal(regenerated.state, 'approval_required');
  assert.ok(transitions[0].from.includes('failed'));

  let mutated = false;
  const blocked = new ReplyWorkflow({ ...store,
    getAuth: async () => ({ ...(await (store as unknown as { getAuth(): Promise<Record<string, unknown>> }).getAuth()),
      status: 'reauth_required' }),
    transitionJob: async () => { mutated = true; throw new Error('must_not_mutate'); },
  } as unknown as InteractionStore, {} as ReplyConfigStore,
  new ReplyAiService({ complete: async () => '{}' }, 100));
  await assert.rejects(blocked.generate({ accountId: 'acct_wc_demo', envKey: 'env-a', jobId: 'job-a',
    expectedVersion: 4, actor: 'client:user-a' }),
  (error: unknown) => (error as { code?: string }).code === 'INTERACTION_AUTH_REQUIRED');
  assert.equal(mutated, false);
});
