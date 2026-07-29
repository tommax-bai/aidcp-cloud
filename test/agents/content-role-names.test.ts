import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
 * aidcp:test-owner=cloud
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
 *
 * 「content 角色」在本仓是**术语**、不是属主标签：指经 `CONTENT_ROLE_FACTORIES` 那张工厂函数表
 * 注入调度器的那一组（公共基类 `src/agents/content-role.ts` 同样保留原名而属主已是 automation）。
 * change split-cloud-automation-production-runtime 把其中四个改判 automation 后，文件名照旧成立。
 *
 * ## 为什么它**必须**留守 aidcp-cloud（不按属主拆，change split-cloud-automation-production-runtime 任务 0.7a）
 *
 * 这道闸要同时握住三样东西，而它们分属**三个**属主，且这不是拆仓的副产物、本来就是三个：
 *   - 角色类本身：四个在 automation（`concept_extractor` / `curated_note_evaluator` /
 *     `curated_comment_evaluator` / `valuable_comment_archivist`）、`persona_generator` 在 content；
 *   - 类型层要用的 `RoleName` 联合：automation（`src/event-bus/types.ts`）；
 *   - 运行时层要查的角色目录 `ROLE_CATALOG`：**api**（`src/config/role-catalog.ts`）。
 *
 * 于是「按属主拆成两份」拆不出任何一份完整的闸，两个方向都在削弱它：
 *   - 拆给 automation 的那半只剩类型层 —— 角色目录在 api，automation 仓不依赖 aidcp-api，
 *     **运行时那一半必然丢**，而「目录里查不到 → 静默回落默认模型」正是要防的那一种；
 *   - 拆给 content 的那半根本写不出来 —— `aidcp-content/src` 里既没有 `event-bus/`（无 `RoleName`）
 *     也没有 `config/`（无 `ROLE_CATALOG`），两层断言的对照物一个都不在。硬写只会重新引到
 *     automation + api，按 import 派生仍判跨属主、还是留守，白拆一趟。
 *
 * 反过来说，留守期间这道闸**并未失效**：aidcp-cloud 仍是归属事实源、其全量测试照跑，
 * 角色名漂了当场红。真正的风险是「等 cloud 退役那天没人记得把它接走」，所以：
 *   - 头部这行 `aidcp:test-owner=cloud` 让留守成为**声明**而非派生副产物
 *     （`scripts/sync-split-repos` 认这个标记，见其 `classify_tests`），
 *     退役盘点时一条 grep 就能捞出「必须先另找归宿的闸」；
 *   - 下面那条断言让留守的**理由**受机械看管：三样原料一旦收敛到同一个属主，它当场红并要求去拆。
 *     没有它，标记就成了永久免死金牌 —— 那才是「悄悄没人跑」的真正形态。
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

/**
 * 这道闸的三样原料各自住在哪个文件。改路径（重命名 / 移动）必须同步改这里 ——
 * 查不到即红，避免「原料悄悄搬走、留守理由无人复核」。
 */
const GATE_INGREDIENTS = {
  roleClasses: [
    'src/agents/concept-extractor-role.ts',
    'src/agents/curated-comment-evaluator.ts',
    'src/agents/curated-note-evaluator.ts',
    'src/agents/valuable-comment-archivist.ts',
    'src/agents/persona-generator.ts',
  ],
  /** 类型层的对照物：`RoleName` 联合。 */
  roleNameUnion: 'src/event-bus/types.ts',
  /** 运行时层的对照物：`ROLE_CATALOG`。 */
  roleCatalog: 'src/config/role-catalog.ts',
} as const;

interface OwnershipEntry {
  readonly path: string;
  readonly layer: string;
}

/**
 * 这里**有意**读生成物 `boundaries/module-ownership.json` 而非规则表：本断言问的不是
 * 「某文件该判给谁」（那是准入判据，MUST 读 `ownership-rules.json`），而是
 * 「同步器最终会把它派到哪个仓」—— 而 `scripts/sync-split-repos` 逐字读的就是这份生成物。
 */
async function ownerOf(): Promise<(path: string) => string> {
  const entries = JSON.parse(
    await readFile(new URL('../../boundaries/module-ownership.json', import.meta.url), 'utf8'),
  ) as OwnershipEntry[];
  const byPath = new Map(entries.map((entry) => [entry.path, entry.layer]));
  return (path: string) => {
    const layer = byPath.get(path);
    assert.ok(layer, `${path} 不在文件级归属表里：原料被改名 / 移走了，本夹具的留守理由需要重判`);
    return layer;
  };
}

test('留守 cloud 的理由仍然成立：三样原料没有收敛到同一个属主（收敛了就去拆）', async () => {
  const owner = await ownerOf();
  const classOwners = new Set(GATE_INGREDIENTS.roleClasses.map(owner));
  const unionOwner = owner(GATE_INGREDIENTS.roleNameUnion);
  const catalogOwner = owner(GATE_INGREDIENTS.roleCatalog);
  const all = new Set([...classOwners, unionOwner, catalogOwner]);

  assert.ok(
    all.size > 1,
    '三样原料已同属一个属主，本夹具没有理由再留守 cloud：请去掉头部的 aidcp:test-owner=cloud 标记、' +
      `连同本断言一起删掉，让 sync-split-repos 把它派到 ${[...all][0]} 仓。\n` +
      '（留守只在「没有任何一个派生仓能整体承接」时才是诚实的。）',
  );
  assert.equal(
    classOwners.has(catalogOwner),
    false,
    '角色目录已与某个角色类同属主：运行时那一半（目录里查不到 → 静默回落默认模型）现在可以在该仓落地了，' +
      `请重新评估按属主拆分。角色类属主=${[...classOwners].sort().join('+')}，目录属主=${catalogOwner}`,
  );
  assert.equal(
    owner('src/agents/persona-generator.ts') === unionOwner,
    false,
    '`persona_generator` 已与 RoleName 联合同属主：content 那一半从「一个字都写不出来」变成可写，' +
      '按属主拆分的结论需要重判',
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
