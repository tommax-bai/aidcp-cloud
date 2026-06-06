/**
 * 概念抽取器：从一条笔记里抽出 1-3 个值得深入了解的技术概念。
 *
 * 用 Qwen 把"标题 + 摘要"转成可搜索的具体关键词，再与已知概念去重，
 * 把真正的新概念加入候选队列（驱动状态机 found_new_concept 迁移）。
 *
 * 防幻觉/脏数据：严格解析模型输出的 JSON 数组（容忍代码块围栏/前后多余文字），
 * 过滤空串、超长串、与已知/候选重复项。LLM 出错时返回空，不影响主流程。
 */

import type { LlmClient } from '../llm/qwen.js';
import type { ConceptPool } from './session-orchestrator.js';

export interface ExtractInput {
  title: string;
  summary: string;
}

export interface ExtractResult {
  /** 本次抽取出的、去重后的新概念（已加入 pool.candidates） */
  newConcepts: string[];
  /** 模型抽取的原始概念（未去重，调试用） */
  raw: string[];
}

/** 概念字符串的清洗上限（避免把长句当关键词） */
const MAX_CONCEPT_LEN = 30;
const MAX_CONCEPTS = 3;

/** 构造让 Qwen 抽取概念的提示词 */
export function buildExtractPrompt(input: ExtractInput): string {
  return [
    '你是一个AI领域的研发工程师。以下是你刚看到的一篇小红书笔记：',
    `标题：${input.title}`,
    `摘要：${input.summary}`,
    '请提取1-3个你觉得值得深入了解的技术概念/关键词（要具体可搜索，不要太泛）。',
    '返回JSON数组: ["概念1", "概念2"]',
  ].join('\n');
}

/** 从模型输出解析概念字符串数组（容忍围栏/多余文字） */
export function parseConcepts(raw: string): string[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (t === '' || t.length > MAX_CONCEPT_LEN) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= MAX_CONCEPTS) break;
  }
  return out;
}

export interface ConceptExtractorOptions {
  llm: LlmClient;
}

/** 概念抽取器 */
export class ConceptExtractor {
  constructor(private readonly options: ConceptExtractorOptions) {}

  /**
   * 抽取并把新概念合并进概念池。
   * @param input 笔记标题/摘要
   * @param pool  当前概念池（会就地更新 candidates / source）
   * @param sourceTitle 概念来源笔记标题（记录到 pool.source）
   */
  async extract(
    input: ExtractInput,
    pool: ConceptPool,
    sourceTitle: string = input.title,
  ): Promise<ExtractResult> {
    let text: string;
    try {
      text = await this.options.llm.complete(buildExtractPrompt(input));
    } catch {
      return { newConcepts: [], raw: [] };
    }
    const raw = parseConcepts(text);
    const newConcepts = mergeConcepts(raw, pool, sourceTitle);
    return { newConcepts, raw };
  }
}

/**
 * 把抽取到的概念合并进池子：过滤已 known / 已在 candidates 的，
 * 新概念追加到 candidates 并登记来源。返回真正新增的概念列表。
 */
export function mergeConcepts(
  concepts: string[],
  pool: ConceptPool,
  sourceTitle: string,
): string[] {
  const added: string[] = [];
  for (const c of concepts) {
    if (pool.known.includes(c) || pool.candidates.includes(c)) continue;
    pool.candidates.push(c);
    pool.source.set(c, sourceTitle);
    added.push(c);
  }
  return added;
}
