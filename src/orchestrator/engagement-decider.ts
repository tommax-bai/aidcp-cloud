/**
 * 互动决策器：给定一条笔记，决定点赞 / 收藏 / 跳过。
 *
 * 模型输出严格解析为 JSON；解析失败/模型出错 → 保守 skip（不误点赞）。
 */

import type { LlmClient } from '../llm/qwen.js';
import type { Soul } from '../soul/types.js';

export interface NoteForDecision {
  title: string;
  summary: string;
  likeCount: number;
  collectCount: number;
}

export type EngageAction = 'like' | 'collect' | 'skip';

export interface EngageDecision {
  action: EngageAction;
  reason: string;
  /** 模型顺带发现的、值得搜索的新概念（可选） */
  newConcepts?: string[];
}

/** 构造带 soul 上下文的互动判断提示词 */
export function buildEngagementPrompt(note: NoteForDecision, soul: Soul): string {
  const { identity, interests, engagement_rules: rules } = soul;
  const lines: string[] = [
    `你是「${identity.name}」，${identity.role}。${identity.background}`,
    `语气风格：${identity.tone}。`,
    '',
    '你的主要兴趣：',
    ...interests.primary.map((x) => `- ${x}`),
    '次要兴趣：',
    ...interests.secondary.map((x) => `- ${x}`),
    '',
  ];
  if (rules) {
    lines.push('你倾向于「点赞」的内容：');
    lines.push(...rules.like.map((x) => `- ${x}`));
    lines.push('你倾向于「跳过」的内容：');
    lines.push(...rules.skip.map((x) => `- ${x}`));
    lines.push('');
  }
  lines.push(
    '下面是一条小红书笔记：',
    `标题：${note.title}`,
    `摘要：${note.summary}`,
    `点赞数：${note.likeCount}，收藏数：${note.collectCount}`,
    '',
    '请基于你的人设与兴趣，判断是否与你相关且值得互动。',
    '只输出一个 JSON 对象，不要任何解释或 markdown 代码块：',
    '{"action": "like" | "collect" | "skip", "reason": "简短理由", "newConcepts": ["可选的新概念"]}',
    'action 含义：like=优质且强相关想点赞；collect=值得收藏深读；skip=不相关或低质。',
  );
  return lines.join('\n');
}

const VALID_ACTIONS = new Set<EngageAction>(['like', 'collect', 'skip']);

/** 解析模型输出的 JSON 决策（容忍围栏/多余文字）；失败返回 null */
export function parseDecision(raw: string): EngageDecision | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.action !== 'string' || !VALID_ACTIONS.has(o.action as EngageAction)) return null;
  const decision: EngageDecision = {
    action: o.action as EngageAction,
    reason: typeof o.reason === 'string' ? o.reason : '',
  };
  if (Array.isArray(o.newConcepts)) {
    const concepts = o.newConcepts.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    if (concepts.length > 0) decision.newConcepts = concepts.map((c) => c.trim());
  }
  return decision;
}

export interface EngagementDeciderOptions {
  soul: Soul;
  llm: LlmClient;
}

/** 互动决策器 */
export class EngagementDecider {
  constructor(private readonly options: EngagementDeciderOptions) {}

  /** 决定对一条笔记的互动动作 */
  async decide(note: NoteForDecision): Promise<EngageDecision> {
    // 直接调用模型判断质量与兴趣匹配
    let text: string;
    try {
      text = await this.options.llm.complete(buildEngagementPrompt(note, this.options.soul));
    } catch (err) {
      return { action: 'skip', reason: `llm_error:${(err as Error).message}` };
    }
    const decision = parseDecision(text);
    if (!decision) {
      return { action: 'skip', reason: `unparsable_output:${text.slice(0, 40)}` };
    }
    return decision;
  }
}
