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
