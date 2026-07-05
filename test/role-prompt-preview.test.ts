import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRolePromptProvider } from '../src/config/role-prompt-preview.js';
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
  assert.ok(v.note.length > 0);
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

test('15 个发布文本角色全部 available:true 且 prompt 非空', () => {
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

test('评论点赞择选未注册（开关关）→ available:false 诚实标注，不崩', () => {
  const p = createRolePromptProvider(() => []); // 未注册（AIDCP_COMMENT_LIKE 关）
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

test('不传 accountId → 行为不变（不附 accountId / personaFallback，不走账号口径）', () => {
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
