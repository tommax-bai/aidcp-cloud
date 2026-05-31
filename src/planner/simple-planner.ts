/**
 * 简单任务规划器（地基版）。
 *
 * 两种工作模式：
 * 1) 规则优先：命中内置关键词模板（点赞/关注/评论/搜索…）直接产出步骤，
 *    零模型调用、确定性强，适合高频固定动作；
 * 2) LLM 兜底：未命中模板且注入了 LlmClient 时，让 Qwen 把目标拆成 JSON 步骤，
 *    并对输出做严格校验（防幻觉：op 合法、字段齐全）。
 *
 * 这是"任务规划接口 + 简单实现"，后续可替换为更强的 LLM/计划图实现而不动调用方。
 */

import type { LlmClient } from '../llm/qwen.js';
import type { Plan, PlanRequest, PlanStep, TaskPlanner } from './types.js';

const VALID_OPS = new Set(['click', 'input', 'scroll']);

/** 关键词 → 步骤模板（地基期覆盖最高频的几个动作） */
interface Rule {
  test: RegExp;
  build: (goal: string) => PlanStep[];
}

const RULES: Rule[] = [
  {
    test: /(点赞|赞一下|like)/i,
    build: () => [{ actionId: 'note.like_button', op: 'click', goal: '点赞当前笔记的点赞按钮' }],
  },
  {
    test: /(关注|follow)/i,
    build: () => [{ actionId: 'note.follow_button', op: 'click', goal: '关注当前笔记作者' }],
  },
  {
    test: /(收藏|favorite|bookmark)/i,
    build: () => [{ actionId: 'note.favorite_button', op: 'click', goal: '收藏当前笔记' }],
  },
  {
    test: /搜索\s*(.+)/,
    build: (goal) => {
      const m = goal.match(/搜索\s*(.+)/);
      const kw = m ? m[1].trim() : '';
      return [
        { actionId: 'search.input', op: 'input', goal: '在搜索框输入关键词', value: kw },
        { actionId: 'search.submit', op: 'click', goal: '点击搜索按钮' },
      ];
    },
  },
];

export interface SimplePlannerOptions {
  /** 可选 LLM 兜底（未命中规则时用） */
  llm?: LlmClient;
}

export class SimplePlanner implements TaskPlanner {
  constructor(private readonly options: SimplePlannerOptions = {}) {}

  async plan(req: PlanRequest): Promise<Plan> {
    // —— 1) 规则优先 ——
    const ruleSteps: PlanStep[] = [];
    for (const rule of RULES) {
      if (rule.test.test(req.goal)) ruleSteps.push(...rule.build(req.goal));
    }
    if (ruleSteps.length > 0) {
      return { steps: ruleSteps, reason: 'rule_matched' };
    }

    // —— 2) LLM 兜底 ——
    if (this.options.llm) {
      const raw = await this.options.llm.complete(buildPlanPrompt(req.goal));
      const steps = parsePlanSteps(raw);
      if (steps.length > 0) {
        return { steps, reason: 'llm_planned' };
      }
      return { steps: [], reason: 'llm_no_valid_steps' };
    }

    return { steps: [], reason: 'no_rule_no_llm' };
  }
}

/** 构造让 LLM 输出 JSON 步骤的提示词 */
export function buildPlanPrompt(goal: string): string {
  return [
    '你是浏览器自动化的任务规划器。把用户目标拆解为有序的原子步骤。',
    '每个步骤是一个 JSON 对象，字段：',
    '- actionId: 稳定的业务标识（小写点分，如 "note.like_button"）',
    '- op: 操作类型，只能是 "click" | "input" | "scroll"',
    '- goal: 该步骤的自然语言描述',
    '- value: 仅 input 操作需要，填要输入的文本',
    '只输出一个 JSON 数组，不要输出任何解释或 markdown 代码块标记。',
    '',
    `用户目标：${goal}`,
    '',
    'JSON：',
  ].join('\n');
}

/** 解析并严格校验 LLM 输出的步骤数组（防幻觉/脏数据） */
export function parsePlanSteps(raw: string): PlanStep[] {
  const jsonText = extractJsonArray(raw);
  if (!jsonText) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const steps: PlanStep[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.actionId !== 'string' || !o.actionId) continue;
    if (typeof o.op !== 'string' || !VALID_OPS.has(o.op)) continue;
    if (typeof o.goal !== 'string' || !o.goal) continue;
    const step: PlanStep = {
      actionId: o.actionId,
      op: o.op as PlanStep['op'],
      goal: o.goal,
    };
    if (typeof o.value === 'string') step.value = o.value;
    steps.push(step);
  }
  return steps;
}

/** 从模型输出中提取第一个 JSON 数组片段（容忍前后多余文字/代码块围栏） */
function extractJsonArray(raw: string): string | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}
