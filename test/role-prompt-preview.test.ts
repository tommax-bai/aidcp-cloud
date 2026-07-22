import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRolePromptProvider } from '../src/config/role-prompt-preview.js';
import { ROLE_CATALOG } from '../src/config/role-catalog.js';
import { STATIC_ROLE_PROMPT_PREVIEWS } from '../src/config/static-role-prompt-previews.js';
import { PUBLISH_PREVIEW_BUILDERS } from '../src/publish-agent/prompts-preview.js';
import type { BaseRole } from '../src/agents/base-role.js';
import { CommentSearchTermGenerator, type RoleLlmLike } from '../src/agents/comment-search-term-generator.js';
import { CommentTargetPicker } from '../src/agents/comment-target-picker.js';
import type { Soul } from '../src/soul/types.js';

function fakeRole(roleName: string, preview: () => string): BaseRole {
  return { roleName, previewPrompt: preview } as unknown as BaseRole;
}

const sampleSoul: Soul = {
  identity: {
    name: '测试账号',
    role: 'AI工程师',
    background: '做过大模型应用落地',
    tone: '理性',
  },
  interests: {
    primary: ['AI工程化'],
    secondary: ['RAG'],
    seed_keywords: ['大模型部署'],
  },
};

const dummyLlm: RoleLlmLike = {
  complete: async () => {
    throw new Error('preview should not call LLM');
  },
};

test('浏览文本角色 → available:true + 真实 prompt 文本', () => {
  const roles = [fakeRole('content_evaluator', () => 'RENDERED-PROMPT-CE')];
  const p = createRolePromptProvider(() => roles);
  const v = p.get('browse:content_evaluator');
  assert.equal(v.available, true);
  assert.equal(v.prompt, 'RENDERED-PROMPT-CE');
  assert.match(v.note, /示例人设/);
  assert.equal(v.personaSource, 'sample');
  assert.equal(v.personaSourceLabel, '示例人设');
});

test('未知角色 → available:false + 未知角色', () => {
  const p = createRolePromptProvider(() => []);
  const v = p.get('browse:does_not_exist');
  assert.equal(v.available, false);
  assert.equal(v.prompt, null);
  assert.equal(v.note, '未知角色');
});

test('图像角色 → available:true（发给文生图模型的图片指令，含固定风格基底）', () => {
  const p = createRolePromptProvider(() => []);
  const v = p.get('publish:ImageGenerator');
  assert.equal(v.available, true);
  assert.ok(v.prompt && v.prompt.trim().length > 0);
  assert.match(v.prompt!, /no text|no watermark|no human faces/); // 固定风格基底可见
  assert.equal(v.segments, undefined); // 图片指令无人设来源段
  assert.equal(v.personaSource, 'none');
  assert.equal(v.personaSourceLabel, '不使用人设');
  assert.match(v.note, /文生图|图片指令/);
});

// ── 发布侧忠实渲染（change publish-prompt-preview）────────────────────────────

test('发布文本角色 → available:true + 真实 prompt 文本，不附来源段', () => {
  const p = createRolePromptProvider(() => []);
  const v = p.get('publish:ContentCreator');
  assert.equal(v.available, true);
  assert.ok(v.prompt && v.prompt.trim().length > 0);
  assert.equal(v.segments, undefined); // 发布侧用示例/账号人设，不做人设来源分段
  assert.ok(v.note.length > 0);
});

test('16 个发布文本角色全部 available:true 且 prompt 非空', () => {
  const p = createRolePromptProvider(() => []);
  const ids = [
    'publish:ContentScout',
    'publish:ContentCreator',
    'publish:ReferenceAnalyzer',
    'publish:FaithfulRewritePlanner',
    'publish:FaithfulDraftWriter',
    'publish:FidelityAuditor',
    'publish:TitleCreator',
    'publish:TopicGenerator',
    'publish:TopicEvaluator',
    'publish:CategoryClassifier',
    'publish:CoverCardWriter',
    'publish:ImageSetPlanner',
    'publish:ImagePromptComposer',
    'publish:ContentCleaner',
    'publish:QualityScorer',
    'publish:ApprovalGatekeeper',
  ];
  for (const id of ids) {
    const v = p.get(id);
    assert.equal(v.available, true, `${id} 应可预览`);
    assert.ok(v.prompt && v.prompt.trim().length > 0, `${id} prompt 应非空`);
    assert.equal(v.segments, undefined, `${id} 不应附来源段`);
  }
});

test('视频号收件箱三个 interaction 角色全部使用真实同源 prompt 预览', () => {
  const p = createRolePromptProvider(() => []);
  const expected: Array<[string, RegExp]> = [
    ['reply_intent_classifier', /reply_intent_classifier.*intent/s],
    ['reply_polisher', /reply_polisher.*polishedText/s],
    ['reply_risk_reviewer', /reply_risk_reviewer.*allowAutoSend/s],
  ];
  for (const [roleId, marker] of expected) {
    const view = p.get(roleId);
    assert.equal(view.available, true, `${roleId} 应可预览`);
    assert.match(view.prompt ?? '', marker);
    assert.match(view.note, /视频号收件箱|示例占位/);
    assert.equal(view.personaSource, 'none');
    assert.equal(view.personaFallback, undefined);
  }
  const polisher = p.get('reply_polisher');
  assert.match(polisher.prompt ?? '', /通用博主回复助手.*默认一到两句/s);
  assert.match(polisher.prompt ?? '', /不得自行增加私聊引导或联系方式/);
  assert.doesNotMatch(polisher.prompt ?? '', /什么时候发货|订单页面显示|想了解一下商品信息/);
});

test('独立 Facebook 角色和封面文字卡角色不依赖 dispatcher 也可预览', () => {
  const p = createRolePromptProvider(() => []);
  const join = p.get('browse:facebook_group_join_judge');
  assert.equal(join.available, true);
  assert.match(join.prompt ?? '', /Facebook public group join observation/);

  const comment = p.get('facebook_comment_composer');
  assert.equal(comment.available, true);
  assert.match(comment.prompt ?? '', /Facebook.*自然、真诚的评论/s);
  assert.match(comment.prompt ?? '', /最终公开正文必须只使用简体中文/);
  assert.equal(comment.personaSource, 'sample');
  assert.match(comment.prompt ?? '', /<示例 Facebook 账号>|<示例账号定位>/);

  const cover = p.get('publish:CoverCardWriter');
  assert.equal(cover.available, true);
  assert.match(cover.prompt ?? '', /封面文字卡的文案编辑/);
  assert.match(cover.prompt ?? '', /<示例笔记标题>/);
});

test('三个 vision 角色展示真实模型文本指令而非误报不调用大模型', () => {
  const p = createRolePromptProvider(() => []);
  const expected: Array<[string, RegExp]> = [
    ['publish:CoverFormSensor', /text_card\|photo\|illustration\|other/],
    ['publish:VisualReferenceAnalyzer', /整组视觉参考分析师.*视觉结构专家/s],
    ['publish:VisualFidelityAuditor', /视觉质量与内容一致性审核员.*copyCheck/s],
  ];
  for (const [roleId, marker] of expected) {
    const view = p.get(roleId);
    assert.equal(view.available, true, `${roleId} 应可预览`);
    assert.match(view.prompt ?? '', marker);
    assert.match(view.note, /视觉模型|视觉/);
    assert.equal(view.segments, undefined);
    assert.equal(view.personaSource, 'none');
  }
});

test('角色目录中所有非 browse 及独立静态业务角色都有非空预览来源', () => {
  const p = createRolePromptProvider(() => []);
  const roles = ROLE_CATALOG.filter((role) => role.group !== 'browse' || STATIC_ROLE_PROMPT_PREVIEWS[role.roleId]);
  assert.ok(roles.length > 0);
  for (const role of roles) {
    const view = p.get(role.roleId);
    assert.equal(view.available, true, `${role.roleId} 只进目录但未补预览`);
    assert.ok(view.prompt?.trim(), `${role.roleId} prompt 应非空`);
  }
});

test('选择账号不会给 interaction、独立 browse、无 persona 发布角色或 vision 角色伪造人设来源', () => {
  let switched = false;
  const p = createRolePromptProvider(() => [], {
    withAccount: (_accountId, fn) => {
      switched = true;
      return fn();
    },
    hasPersona: () => false,
    getPersona: () => null,
  });
  for (const roleId of [
    'reply_intent_classifier',
    'browse:facebook_group_join_judge',
    'publish:CoverCardWriter',
    'publish:CoverFormSensor',
    'publish:VisualReferenceAnalyzer',
    'publish:VisualFidelityAuditor',
  ]) {
    const view = p.get(roleId, 'acc-no-persona');
    assert.equal(view.available, true, `${roleId} 应可预览`);
    assert.equal(view.accountId, undefined);
    assert.equal(view.personaSource, 'none');
    assert.equal(view.personaFallback, undefined);
  }
  assert.equal(switched, false, '不消费 persona 的静态预览不应切换账号口径');
});

test('Facebook 定向评论按所选账号真实人设渲染，无人设时诚实回落示例', () => {
  const accountProvider = createRolePromptProvider(() => [], {
    withAccount: (_accountId, fn) => fn(),
    getPersona: () => sampleSoul,
  });
  const accountView = accountProvider.get('facebook_comment_composer', 'fb-account');
  assert.equal(accountView.available, true);
  assert.equal(accountView.accountId, 'fb-account');
  assert.equal(accountView.personaSource, 'account');
  assert.match(accountView.prompt ?? '', /测试账号.*AI工程师/s);

  const fallbackProvider = createRolePromptProvider(() => [], {
    withAccount: (_accountId, fn) => fn(),
    getPersona: () => null,
  });
  const fallbackView = fallbackProvider.get('facebook_comment_composer', 'fb-no-persona');
  assert.equal(fallbackView.available, true);
  assert.equal(fallbackView.accountId, 'fb-no-persona');
  assert.equal(fallbackView.personaSource, 'fallback_sample');
  assert.equal(fallbackView.personaFallback, true);
  assert.match(fallbackView.prompt ?? '', /<示例 Facebook 账号>|<示例账号定位>/);
});

test('静态同源预览构建失败时诚实降级且不抛', () => {
  const original = STATIC_ROLE_PROMPT_PREVIEWS.reply_intent_classifier;
  STATIC_ROLE_PROMPT_PREVIEWS.reply_intent_classifier = {
    ...original,
    build: () => { throw new Error('boom'); },
  };
  try {
    const view = createRolePromptProvider(() => []).get('reply_intent_classifier');
    assert.equal(view.available, false);
    assert.equal(view.prompt, null);
    assert.match(view.note, /预览不可用：boom/);
  } finally {
    STATIC_ROLE_PROMPT_PREVIEWS.reply_intent_classifier = original;
  }
});

test('发布话题角色 → available:true + 真实话题 prompt', () => {
  const p = createRolePromptProvider(() => []);
  const gen = p.get('publish:TopicGenerator');
  assert.equal(gen.available, true);
  assert.match(gen.prompt ?? '', /话题生成|topics/);
  const evalView = p.get('publish:TopicEvaluator');
  assert.equal(evalView.available, true);
  assert.match(evalView.prompt ?? '', /话题评判|kept/);
});

test('正文去 AI 味改写（ContentCleaner）→ available:true + 真实重写 prompt（与 server 同源）', () => {
  const p = createRolePromptProvider(() => []);
  const v = p.get('publish:ContentCleaner');
  assert.equal(v.available, true);
  assert.ok(v.prompt && v.prompt.includes('去除AI味')); // buildDeAiRewritePrompt 真实文本
  assert.equal(v.segments, undefined);
});

test('评论点赞择选（comment_like_appraiser）→ 已注册即 available:true（浏览角色，可预览）', () => {
  const roles = [fakeRole('comment_like_appraiser', () => 'RENDERED-COMMENT-LIKE')];
  const p = createRolePromptProvider(() => roles);
  const v = p.get('browse:comment_like_appraiser');
  assert.equal(v.available, true);
  assert.equal(v.prompt, 'RENDERED-COMMENT-LIKE');
});

test('评论点赞择选未注册 → available:false 诚实标注，不崩', () => {
  const p = createRolePromptProvider(() => []);
  const v = p.get('browse:comment_like_appraiser');
  assert.equal(v.available, false);
  assert.match(v.note, /暂不支持预览/);
});

test('命令式评论角色作为 preview-only 实例 → available:true', () => {
  const roles = [
    new CommentSearchTermGenerator({ llm: dummyLlm, soul: sampleSoul }) as unknown as BaseRole,
    new CommentTargetPicker({ llm: dummyLlm, soul: sampleSoul }) as unknown as BaseRole,
  ];
  const p = createRolePromptProvider(() => roles);
  const terms = p.get('browse:comment_search_term_generator');
  assert.equal(terms.available, true);
  assert.match(terms.prompt ?? '', /搜索词|创作领域/);

  const picker = p.get('browse:comment_target_picker');
  assert.equal(picker.available, true);
  assert.match(picker.prompt ?? '', /强相关|pickIndex/);
});

test('发布角色渲染抛错 → 优雅降级 available:false，绝不抛', () => {
  const original = PUBLISH_PREVIEW_BUILDERS['publish:ContentScout'];
  PUBLISH_PREVIEW_BUILDERS['publish:ContentScout'] = () => {
    throw new Error('boom');
  };
  try {
    const p = createRolePromptProvider(() => []);
    const v = p.get('publish:ContentScout');
    assert.equal(v.available, false);
    assert.equal(v.prompt, null);
    assert.match(v.note, /预览不可用/);
  } finally {
    PUBLISH_PREVIEW_BUILDERS['publish:ContentScout'] = original;
  }
});

test('发布角色带 accountId 且有人设 → 使用账号人设渲染并回显账号', () => {
  const p = createRolePromptProvider(() => [], {
    withAccount: (_a, fn) => fn(),
    hasPersona: () => true,
    getPersona: () => sampleSoul,
  });
  const v = p.get('publish:ContentCreator', 'acc-1');
  assert.equal(v.available, true);
  assert.ok(v.prompt && v.prompt.length > 0);
  assert.match(v.note, /所选账号人设/);
  assert.match(v.prompt, /测试账号|AI工程师|做过大模型应用落地/);
  assert.equal(v.accountId, 'acc-1');
  assert.equal(v.personaFallback, undefined);
  assert.equal(v.personaSource, 'account');
  assert.equal(v.personaSourceLabel, '所选账号人设');
  assert.equal(v.segments, undefined);
});

test('发布角色带 accountId 但无人设 → personaFallback:true + 示例人设渲染', () => {
  const p = createRolePromptProvider(() => [], {
    withAccount: (_a, fn) => fn(),
    hasPersona: () => false,
    getPersona: () => null,
  });
  const v = p.get('publish:ContentCreator', 'acc-no-persona');
  assert.equal(v.available, true);
  assert.equal(v.accountId, 'acc-no-persona');
  assert.equal(v.personaFallback, true);
  assert.equal(v.personaSource, 'fallback_sample');
  assert.equal(v.personaSourceLabel, '示例人设');
  assert.match(v.note, /未绑定人设|示例人设/);
  assert.match(v.prompt ?? '', /<示例账号>|<示例角色定位>/);
});

test('配图生成执行带 accountId → available:true 图片指令，不加人设标注/回落', () => {
  const p = createRolePromptProvider(() => [], {
    withAccount: (_a, fn) => fn(),
    hasPersona: () => false,
  });
  const v = p.get('publish:ImageGenerator', 'acc-x');
  assert.equal(v.available, true);
  assert.ok(v.prompt && v.prompt.length > 0);
  assert.match(v.note, /文生图|图片指令/); // 保留图片指令说明，不被人设标注覆盖
  assert.equal(v.personaFallback, undefined);
  assert.equal(v.accountId, undefined);
  assert.equal(v.segments, undefined);
  assert.equal(v.personaSource, 'none');
});

test('previewPrompt 抛错 → 优雅降级 available:false，绝不抛', () => {
  const roles = [
    fakeRole('content_evaluator', () => {
      throw new Error('boom');
    }),
  ];
  const p = createRolePromptProvider(() => roles);
  const v = p.get('browse:content_evaluator');
  assert.equal(v.available, false);
  assert.equal(v.prompt, null);
  assert.match(v.note, /预览不可用/);
});

test('浏览角色已注册但无 previewPrompt → available:false 不崩', () => {
  const roles = [{ roleName: 'content_evaluator' } as unknown as BaseRole];
  const p = createRolePromptProvider(() => roles);
  const v = p.get('browse:content_evaluator');
  assert.equal(v.available, false);
});

// ── 人设选择框（change prompt-preview-persona-selector）────────────────────────

test('给定 accountId（有人设）→ withAccount 包裹渲染 + 回显 accountId，无 personaFallback', () => {
  let current = 'default';
  let seenDuringRender: string | null = null;
  const roles = [
    fakeRole('content_evaluator', () => {
      seenDuringRender = current; // 渲染发生在切到该账号期间
      return 'RENDERED-FOR-ACC';
    }),
  ];
  const p = createRolePromptProvider(() => roles, {
    withAccount: (accountId, fn) => {
      const prev = current;
      current = accountId;
      try {
        return fn();
      } finally {
        current = prev;
      }
    },
    hasPersona: () => true,
  });
  const v = p.get('browse:content_evaluator', 'acc-123');
  assert.equal(v.available, true);
  assert.equal(v.prompt, 'RENDERED-FOR-ACC');
  assert.equal(v.accountId, 'acc-123');
  assert.equal(v.personaFallback, undefined);
  assert.equal(v.personaSource, 'account');
  assert.equal(v.personaSourceLabel, '所选账号人设');
  assert.equal(seenDuringRender, 'acc-123'); // 渲染确实在切账号期间发生
  assert.equal(current, 'default'); // 渲染后已还原
});

test('给定 accountId 但该账号无人设 → personaFallback:true + 诚实标注（运行会被拒，仅示例渲染）', () => {
  const roles = [fakeRole('content_evaluator', () => 'RENDERED-SAMPLE-PERSONA')];
  const p = createRolePromptProvider(() => roles, {
    withAccount: (_a, fn) => fn(),
    hasPersona: () => false,
  });
  const v = p.get('browse:content_evaluator', 'acc-no-persona');
  assert.equal(v.available, true);
  assert.equal(v.accountId, 'acc-no-persona');
  assert.equal(v.personaFallback, true);
  assert.equal(v.personaSource, 'fallback_sample');
  assert.equal(v.personaSourceLabel, '示例人设');
  assert.match(v.note, /未绑定人设|示例人设/); // 绝不冒充该账号人设
});

test("persona-driven-content-pipeline：accountId='default' 不再豁免——无人设行同样标 personaFallback", () => {
  const roles = [fakeRole('content_evaluator', () => 'R')];
  const p = createRolePromptProvider(() => roles, {
    withAccount: (_a, fn) => fn(),
    hasPersona: () => false, // default 账号已删，无任何账号例外
  });
  const v = p.get('browse:content_evaluator', 'default');
  assert.equal(v.accountId, 'default');
  assert.equal(v.personaFallback, true);
});

test('不传 accountId → 示例人设预览（不附 accountId / personaFallback，不走账号口径）', () => {
  const roles = [fakeRole('content_evaluator', () => 'R')];
  let withAccountCalled = false;
  const p = createRolePromptProvider(() => roles, {
    withAccount: (_a, fn) => {
      withAccountCalled = true;
      return fn();
    },
    hasPersona: () => false,
  });
  const v = p.get('browse:content_evaluator');
  assert.equal(v.available, true);
  assert.equal(v.accountId, undefined);
  assert.equal(v.personaFallback, undefined);
  assert.equal(v.personaSource, 'sample');
  assert.equal(v.personaSourceLabel, '示例人设');
  assert.equal(withAccountCalled, false);
});

test('给定 accountId 但渲染抛错 → 账号仍被还原 + available:false', () => {
  let current = 'default';
  const roles = [
    fakeRole('content_evaluator', () => {
      throw new Error('boom');
    }),
  ];
  const p = createRolePromptProvider(() => roles, {
    withAccount: (accountId, fn) => {
      const prev = current;
      current = accountId;
      try {
        return fn();
      } finally {
        current = prev; // finally 兜底还原，含抛错路径
      }
    },
    hasPersona: () => true,
  });
  const v = p.get('browse:content_evaluator', 'acc-x');
  assert.equal(v.available, false); // safePreview 内部已 catch，优雅降级
  assert.equal(current, 'default'); // 账号已还原，未泄漏到后续预览
});
