import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConceptExtractorRole } from '../../src/agents/concept-extractor-role.js';
import { CuratedCommentEvaluator } from '../../src/agents/curated-comment-evaluator.js';
import { CuratedNoteEvaluator } from '../../src/agents/curated-note-evaluator.js';
import { PersonaGenerator } from '../../src/agents/persona-generator.js';
import { ValuableCommentArchivist } from '../../src/agents/valuable-comment-archivist.js';
import type { RoleName } from '../../src/event-bus/types.js';
import { ROLE_CATALOG } from '../../src/config/role-catalog.js';

/**
 * content 侧角色名的**合同夹具**（change cloud-coupling-phase0）。
 *
 * 背景：这几个角色此前把自己的名字标注成 automation 属主的 `RoleName` 联合，纯粹为了一个自标注就
 * 跨了服务边界。标注删掉了，但**它顺带提供的那道闸不能一起删** —— 角色名写错一个字母，
 * 从前是编译红，删完就变成运行时静默失配：调度器按名字找不到该角色的模型配置，
 * 于是它悄悄用默认模型跑，没有任何一条日志会提到这件事。
 *
 * 这里把那道闸原样搬到测试侧（`src/` 才是边界闸的扫描范围，`test/` 不是，所以在这里跨引用不造边）：
 *   - **类型层**：每个字面量必须仍是 `RoleName` 的成员。tsconfig 覆盖 `test/`，
 *     所以 `npm run typecheck` 会像从前一样在写错时当场红。
 *   - **运行时层**：会用模型的那几个角色必须能在角色目录里查到对应条目 ——
 *     目录缺条目正是「静默用默认模型」的实际触发条件。
 */

/** 类型层断言：只要字面量掉出 `RoleName` 联合，这一行就编译失败。 */
type AssertRoleName<T extends RoleName> = T;

// export 是必要的：未导出的类型别名会被 noUnusedLocals 判为死代码，删掉就等于把这道闸也删了。
export type ContentRoleNamesAreValid = [
  AssertRoleName<ConceptExtractorRole['roleName']>,
  AssertRoleName<CuratedCommentEvaluator['roleName']>,
  AssertRoleName<CuratedNoteEvaluator['roleName']>,
  AssertRoleName<PersonaGenerator['roleName']>,
  AssertRoleName<ValuableCommentArchivist['roleName']>,
];

/**
 * 会经角色目录解析模型的角色 → 目录里必须有对应条目。
 * `valuable_comment_archivist` **有意不在此列**：它不调模型（无 soul、无 LLM），
 * 因此本来就不该出现在角色目录里，硬加进来才是错的。
 */
const MODEL_BACKED_ROLES = [
  'concept_extractor',
  'curated_comment_evaluator',
  'curated_note_evaluator',
  'persona_generator',
] as const;

test('content 角色的名字仍是合法角色名，且用模型的那几个在角色目录里查得到', () => {
  const catalogIds = new Set(ROLE_CATALOG.map((entry) => entry.roleId));
  const missing = MODEL_BACKED_ROLES.filter((name) => !catalogIds.has(`browse:${name}`));
  assert.deepEqual(
    missing,
    [],
    '角色目录缺条目 = 该角色按名字解析不到模型配置、静默回落默认模型，且不会有任何日志提到这件事。\n' +
      `缺: ${missing.join(', ')}`,
  );
});

test('角色实例自报的名字与源码字面量一致（防改了一处忘了另一处）', () => {
  // 只读 roleName，不构造完整依赖：这几个类的 roleName 都是实例字段初始化器，读它不触发任何副作用。
  const named: Record<string, string> = {
    ConceptExtractorRole: ConceptExtractorRole.prototype.constructor.name,
    CuratedCommentEvaluator: CuratedCommentEvaluator.prototype.constructor.name,
    CuratedNoteEvaluator: CuratedNoteEvaluator.prototype.constructor.name,
    PersonaGenerator: PersonaGenerator.prototype.constructor.name,
    ValuableCommentArchivist: ValuableCommentArchivist.prototype.constructor.name,
  };
  // 五个类都能被加载（导入本身即证明模块图完整、没有因为删 import 而漏掉别的引用）。
  assert.equal(Object.keys(named).length, 5);
  for (const [expected, actual] of Object.entries(named)) assert.equal(actual, expected);
});
