import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRolePromptProvider } from '../src/config/role-prompt-preview.js';
import type { BaseRole } from '../src/agents/base-role.js';

function fakeRole(roleName: string, preview: () => string): BaseRole {
  return { roleName, previewPrompt: preview } as unknown as BaseRole;
}

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

test('图像角色 → available:false（无文本 prompt）', () => {
  const p = createRolePromptProvider(() => []);
  const v = p.get('publish:ImageGenerator');
  assert.equal(v.available, false);
  assert.equal(v.prompt, null);
});

test('发布文本角色 → available:false（本期只渲染浏览侧，诚实标注）', () => {
  const p = createRolePromptProvider(() => []);
  const v = p.get('publish:ContentCreator');
  assert.equal(v.available, false);
  assert.match(v.note, /发布侧/);
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

test('给定 accountId 但该账号无人设 → personaFallback:true + 诚实回落 note', () => {
  const roles = [fakeRole('content_evaluator', () => 'RENDERED-DEFAULT-PERSONA')];
  const p = createRolePromptProvider(() => roles, {
    withAccount: (_a, fn) => fn(),
    hasPersona: () => false,
  });
  const v = p.get('browse:content_evaluator', 'acc-no-persona');
  assert.equal(v.available, true);
  assert.equal(v.accountId, 'acc-no-persona');
  assert.equal(v.personaFallback, true);
  assert.match(v.note, /未配人设|默认人设/); // 绝不冒充该账号人设
});

test("accountId='default' → 不标 personaFallback（默认账号本就用默认人设）", () => {
  const roles = [fakeRole('content_evaluator', () => 'R')];
  const p = createRolePromptProvider(() => roles, {
    withAccount: (_a, fn) => fn(),
    hasPersona: () => false, // 即便判无人设，default 也豁免
  });
  const v = p.get('browse:content_evaluator', 'default');
  assert.equal(v.accountId, 'default');
  assert.equal(v.personaFallback, undefined);
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
