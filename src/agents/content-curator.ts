/**
 * ContentCurator — 内容质量评估 Agent（LLM）。
 *
 * 职责：
 * - 对笔记详情页内容进行质量评估
 * - 质量差时输出 close_note 并通过 gate 阻断互动 Agent
 * - 激活条件：pageType 为 note 且 currentNote 存在
 */

import type { AgentRole, AgentDecision } from '../event-bus/types.js';
import type { BlackboardState } from '../blackboard/types.js';
import { BaseAgent } from './types.js';
import type { BaseAgentOptions } from './types.js';

export class ContentCurator extends BaseAgent {
  readonly role: AgentRole = 'content_curator';

  constructor(options: BaseAgentOptions) {
    super(options);
    if (!options.llm) throw new Error('ContentCurator 需要 LlmClient');
  }

  shouldActivate(board: BlackboardState): boolean {
    return board.pageType === 'note' && board.currentNote !== null;
  }

  async decide(board: BlackboardState): Promise<AgentDecision> {
    const note = board.currentNote!;
    const prompt = this.buildPrompt(note);

    try {
      const raw = await this.llm!.complete(prompt);
      return this.parseOutput(raw);
    } catch {
      return this.pass('llm_error');
    }
  }

  private buildPrompt(note: { title: string; summary: string; author?: string; likeCount: number; collectCount: number }): string {
    const { identity, interests } = this.soul;
    const interestsStr = [...interests.primary, ...interests.secondary].join('、');

    return `你是「${identity.name}」，${identity.role}。
你的兴趣：${interestsStr}
你正在评估一篇小红书笔记的内容质量。

笔记信息：
标题：${note.title}
内容：${note.summary}
作者：${note.author ?? '未知'}
点赞：${note.likeCount}，收藏：${note.collectCount}

评估维度：
- 内容是否有具体细节、真实案例、数据支撑
- 作者是否原创（有真实经验、非广告）
- 是否空洞、标题党、广告

如果质量差，输出 close_note；质量好，输出 pass（让后续Agent决定互动）。
只输出JSON：{"action":"close_note","reason":"简短原因","confidence":0.8}
或：{"action":"pass","reason":"简短原因","confidence":0.8}`;
  }

  private parseOutput(raw: string): AgentDecision {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return this.pass('parse_failed');

    let obj: unknown;
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return this.pass('json_parse_error');
    }

    if (!obj || typeof obj !== 'object') return this.pass('invalid_output');
    const o = obj as Record<string, unknown>;

    const validActions = new Set(['close_note', 'pass']);
    if (typeof o.action !== 'string' || !validActions.has(o.action)) {
      return this.pass('invalid_action');
    }

    const action = o.action as 'close_note' | 'pass';
    const reason = typeof o.reason === 'string' ? o.reason : 'content_evaluated';
    const confidence = typeof o.confidence === 'number' ? o.confidence : 0.7;

    const decision: AgentDecision = {
      agent: this.role,
      action,
      reason,
      confidence,
      ts: Date.now(),
    };

    // 质量差时通过 gate 阻断互动 Agent
    if (action === 'close_note') {
      decision.gate = { blocks: ['interaction_appraiser'] };
    }

    return decision;
  }
}
