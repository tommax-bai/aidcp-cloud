/**
 * 注册表（期1-6）：persona 只读研究任务的 TaskDefinition + CapabilityDefinition。
 *
 * 这是期1 唯一发布的任务定义：线性四步 搜索 → 浏览 → 评估 → 汇总，
 * 全部落在 'research.read' 域（唯一 read_only 域，见 action-classification.ts），
 * sideEffect='none'——本定义不含任何写面能力，编译准入闸（plan-compiler 规则 4）
 * 对它天然放行；写动作仍在准入即拒（capability_not_available），注册表不放宽准入。
 *
 * 发布纪律（design §4.2）：定义对象由代码 + 代码评审发布（本文件即发布载体），
 * 不允许运行期动态注册；参数 schema 由 parsePersonaResearchParams 落地
 * （inputSchemaRef 是引用，解析器是期1 的可执行事实源）。
 */

import type { JsonValue, StructuredConstraints } from '../contracts/common.js';
import type { CapabilityDefinition, TaskDefinition } from '../contracts/capability.js';

/** 任务定义 ID / 版本（期1 固定 v1；改图必须发新版本，不原地改）。 */
export const PERSONA_RESEARCH_TASK_DEFINITION_ID = 'persona.research';
export const PERSONA_RESEARCH_TASK_DEFINITION_VERSION = 1;

/** 发布时间：2026-07-30T00:00:00Z（本文件首次经代码评审发布的日期，常量冻结）。 */
const PERSONA_RESEARCH_PUBLISHED_AT = 1_785_369_600_000;

/** 四步能力 ID（链序）。 */
export const PERSONA_RESEARCH_CAPABILITY_IDS = [
  'research.search',
  'research.browse',
  'research.assess',
  'research.summarize',
] as const;

export type PersonaResearchCapabilityId = (typeof PERSONA_RESEARCH_CAPABILITY_IDS)[number];

const READ_ONLY_BASE = {
  version: 1,
  sideEffect: 'none',
  requiredEvidenceRef: 'evidence:dom-read',
  actionDomain: 'research.read',
  executionClass: 'read_only',
} as const satisfies Partial<CapabilityDefinition>;

/**
 * persona 研究四能力（全部 read_only）。bounds.maxWallClockMs 即步级派发超时
 * （ResearchStepExecutor 以此为回执等待上限）；浏览步最长——逐篇打开与阅读证据采集。
 */
export const PERSONA_RESEARCH_CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    ...READ_ONLY_BASE,
    capabilityId: 'research.search',
    inputSchemaRef: 'schema:persona.research/search-input@1',
    outputSchemaRef: 'schema:persona.research/search-output@1',
    bounds: { maxWallClockMs: 90_000, maxExecutionAttempts: 3 },
  },
  {
    ...READ_ONLY_BASE,
    capabilityId: 'research.browse',
    inputSchemaRef: 'schema:persona.research/browse-input@1',
    outputSchemaRef: 'schema:persona.research/browse-output@1',
    bounds: { maxWallClockMs: 300_000, maxExecutionAttempts: 3 },
  },
  {
    ...READ_ONLY_BASE,
    capabilityId: 'research.assess',
    inputSchemaRef: 'schema:persona.research/assess-input@1',
    outputSchemaRef: 'schema:persona.research/assess-output@1',
    bounds: { maxWallClockMs: 120_000, maxExecutionAttempts: 3 },
  },
  {
    ...READ_ONLY_BASE,
    capabilityId: 'research.summarize',
    inputSchemaRef: 'schema:persona.research/summarize-input@1',
    outputSchemaRef: 'schema:persona.research/summarize-output@1',
    bounds: { maxWallClockMs: 120_000, maxExecutionAttempts: 3 },
  },
];

/**
 * persona 研究任务定义：线性链 search → browse → assess → summarize。
 * 四节点全部必选（optional=false）：只读研究没有「可授权关闭」的子动作，
 * 缺任何一步都不构成可交付的研究结论。
 */
export const PERSONA_RESEARCH_TASK_DEFINITION: TaskDefinition = {
  taskDefinitionId: PERSONA_RESEARCH_TASK_DEFINITION_ID,
  version: PERSONA_RESEARCH_TASK_DEFINITION_VERSION,
  inputSchemaRef: 'schema:persona.research/task-input@1',
  allowedTriggerTypes: ['manual', 'schedule'],
  executionGraph: {
    nodes: PERSONA_RESEARCH_CAPABILITY_IDS.map((capabilityId) => ({
      nodeId: nodeIdFor(capabilityId),
      capabilityId,
      capabilityVersion: 1,
      inputBindingRef: `bind:persona.research@1/${nodeIdFor(capabilityId)}`,
      optional: false,
    })),
    edges: PERSONA_RESEARCH_CAPABILITY_IDS.slice(0, -1).map((capabilityId, i) => ({
      kind: 'sequential' as const,
      from: nodeIdFor(capabilityId),
      to: nodeIdFor(PERSONA_RESEARCH_CAPABILITY_IDS[i + 1]),
    })),
  },
  bounds: {
    maxNodes: 4,
    maxLoopIterations: 0,
    maxDerivationDepth: 1,
    maxExecutionAttempts: 3,
    // 全链上限 ≥ 四步能力级上限之和（90+300+120+120s），留少量调度余量。
    maxWallClockMs: 660_000,
  },
  publishedAt: PERSONA_RESEARCH_PUBLISHED_AT,
};

/** 能力 ID → 节点 ID（'research.search' → 'search'；链序即节点序）。 */
function nodeIdFor(capabilityId: PersonaResearchCapabilityId): string {
  return capabilityId.slice('research.'.length);
}

/** 篇数上限的硬顶（只读研究也占浏览器时长，防止提案把上限写成天文数字）。 */
export const PERSONA_RESEARCH_MAX_ITEMS_CAP = 20;
const PERSONA_RESEARCH_MAX_KEYWORDS = 8;
const PERSONA_RESEARCH_DEFAULT_MAX_ITEMS = 5;

/** 研究参数（Task.constraints 内按 inputSchemaRef 约束的期1 键集）。 */
export interface PersonaResearchParams {
  /** 搜索关键词（非空、去重、1..8 个）。 */
  keywords: string[];
  /** 浏览篇数上限（1..20，缺省 5）。 */
  maxItems: number;
}

export type PersonaResearchParamsResult =
  | { ok: true; params: PersonaResearchParams }
  | { ok: false; detail: string };

/**
 * 从 Task.constraints 解析研究参数。解析失败如实返回 detail（调用方以
 * 'contract_invalid' 拒绝/失败），绝不静默取缺省值掩盖非法输入；
 * 只有 maxItems **缺失**（而非非法）才取缺省 5。
 */
export function parsePersonaResearchParams(constraints: StructuredConstraints): PersonaResearchParamsResult {
  const rawKeywords: JsonValue | undefined = constraints['keywords'];
  if (!Array.isArray(rawKeywords) || rawKeywords.length === 0) {
    return { ok: false, detail: 'constraints.keywords 必须是非空字符串数组' };
  }
  const keywords: string[] = [];
  for (const entry of rawKeywords) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return { ok: false, detail: `constraints.keywords 含非法项：${JSON.stringify(entry)}` };
    }
    const keyword = entry.trim();
    if (!keywords.includes(keyword)) keywords.push(keyword);
  }
  if (keywords.length > PERSONA_RESEARCH_MAX_KEYWORDS) {
    return { ok: false, detail: `关键词 ${keywords.length} 个超出上限 ${PERSONA_RESEARCH_MAX_KEYWORDS}` };
  }
  const rawMaxItems: JsonValue | undefined = constraints['maxItems'];
  let maxItems = PERSONA_RESEARCH_DEFAULT_MAX_ITEMS;
  if (rawMaxItems !== undefined) {
    if (typeof rawMaxItems !== 'number' || !Number.isInteger(rawMaxItems) || rawMaxItems < 1) {
      return { ok: false, detail: `constraints.maxItems=${JSON.stringify(rawMaxItems)} 非法（要求 ≥1 的整数）` };
    }
    if (rawMaxItems > PERSONA_RESEARCH_MAX_ITEMS_CAP) {
      return { ok: false, detail: `constraints.maxItems=${rawMaxItems} 超出硬顶 ${PERSONA_RESEARCH_MAX_ITEMS_CAP}` };
    }
    maxItems = rawMaxItems;
  }
  return { ok: true, params: { keywords, maxItems } };
}
