import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentPromptByPersona } from '@api/config/role-prompt-preview.js';
import { EventBus } from '@automation/event-bus/index.js';
import { ContentEvaluator } from '@automation/agents/content-evaluator.js';
import { CuratedNoteEvaluator } from '@automation/agents/curated-note-evaluator.js';
import { SessionContext } from '@automation/agents/session-context.js';
import type { Soul } from '@kernel/kernel/soul-types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程'], seed_keywords: ['GPT'] },
};

// ── 纯函数：两道诚实闸 + 多片段 ──────────────────────────────────────────────
test('单片段在中间 → [role, persona, role]，拼接等值', () => {
  const flat = '前导指令。你是「X」，兴趣：AI。\n后续指令。';
  const segs = segmentPromptByPersona(flat, ['你是「X」，兴趣：AI。']);
  assert.ok(segs);
  assert.deepEqual(segs!.map((s) => s.source), ['role', 'persona', 'role']);
  assert.equal(segs!.find((s) => s.source === 'persona')!.text, '你是「X」，兴趣：AI。');
  assert.equal(segs!.map((s) => s.text).join(''), flat); // 拼接等值
});

test('片段在开头 → [persona, role]', () => {
  const flat = '你是「X」。\n剩余指令。';
  const segs = segmentPromptByPersona(flat, ['你是「X」。']);
  assert.deepEqual(segs!.map((s) => s.source), ['persona', 'role']);
  assert.equal(segs!.map((s) => s.text).join(''), flat);
});

test('两个片段（拆开的人设）→ 交替定位、各自唯一、拼接等值', () => {
  const flat = '你是「X」。\n当前场景：滚动3次无收获。\n兴趣领域：AI、LLM\n请决定。';
  const segs = segmentPromptByPersona(flat, ['你是「X」。', '兴趣领域：AI、LLM']);
  assert.ok(segs);
  assert.equal(segs!.filter((s) => s.source === 'persona').length, 2);
  assert.equal(segs!.map((s) => s.text).join(''), flat);
});

test('唯一性闸：片段出现两次 → null（绝不瞎标）', () => {
  const flat = '你是「X」。重复你是「X」。';
  assert.equal(segmentPromptByPersona(flat, ['你是「X」。']), null);
});

test('唯一性闸：片段未出现 → null（回落扁平）', () => {
  const flat = '完全不含人设的指令。';
  assert.equal(segmentPromptByPersona(flat, ['你是「X」。']), null);
});

test('空片段 → null（防误标）', () => {
  assert.equal(segmentPromptByPersona('任意 prompt', ['']), null);
});

test('片段重叠 → null', () => {
  const flat = 'ABCDE';
  assert.equal(segmentPromptByPersona(flat, ['BCD', 'CDE']), null);
});

// ── 集成：真实角色 previewPrompt + personaSegments → 分段 ─────────────────────
test('ContentEvaluator：真实渲染 prompt 能定位人设段、拼接等值、人设段含身份与兴趣', () => {
  const role = new ContentEvaluator(
    { eventBus: new EventBus(), soul: mockSoul, llm: { complete: async () => '{}' } },
    new SessionContext(),
  );
  const flat = role.previewPrompt();
  const segs = segmentPromptByPersona(flat, role.personaSegments());
  assert.ok(segs, '应成功分段');
  const persona = segs!.find((s) => s.source === 'persona')!;
  assert.ok(persona.text.includes('TestBot'), '人设段含身份名');
  // change humanize-interaction-prompts：兴趣改分层表述「主要关注 …；也会看 …」，主/次都在人设段内。
  assert.ok(persona.text.includes('主要关注 AI、LLM') && persona.text.includes('编程'), '人设段含分层兴趣');
  assert.equal(segs!.map((s) => s.text).join(''), flat, '拼接逐字等于扁平 prompt');
  // 真实人设不是占位：身份名出现在 prompt 里
  assert.ok(flat.includes('你是「TestBot」'));
});

test('CuratedNoteEvaluator：真实渲染 prompt 能定位人设段，且包含 seed keywords', () => {
  const role = new CuratedNoteEvaluator({
    eventBus: new EventBus(),
    soul: mockSoul,
    llm: { complete: async () => '{}' },
    // Sink 三个方法都必选（task 0.6d）：本例只看 prompt 渲染，桩如实回答「库里没这条 / 没缓存」。
    curatedStore: {
      upsertObservation: async () => {},
      refreshReferenceImages: async () => 0,
      getTextCardContext: async () => null,
    },
    getAccountId: () => 'acc-1',
    // 本用例只看 prompt 渲染，不需要转写能力——但字段必填，所以**明说**没接上，而不是省略。
    textCardTranscriber: { state: 'unavailable', reason: 'not_injected' },
  });
  const flat = role.previewPrompt();
  const segs = segmentPromptByPersona(flat, role.personaSegments());
  assert.ok(segs, '应成功分段');
  const persona = segs!.find((s) => s.source === 'persona')!;
  assert.ok(persona.text.includes('TestBot'), '人设段含身份名');
  assert.ok(persona.text.includes('AI、LLM、编程、GPT'), '人设段含 primary/secondary/seed keywords');
  assert.ok(flat.includes('<示例正文，运行时为真实笔记全文>'), '运行时正文仍为示例占位');
  assert.equal(segs!.map((s) => s.text).join(''), flat, '拼接逐字等于扁平 prompt');
});
