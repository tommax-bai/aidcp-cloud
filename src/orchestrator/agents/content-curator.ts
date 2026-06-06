/**
 * ContentCurator — 内容质量评估 Agent（LLM）。
 *
 * 职责：
 * - 对笔记详情页内容进行质量评估（具体细节、真实案例、原创性等）
 * - 产出 content.verdict 事件供 InteractionAppraiser 使用
 *
 * 消费事件：note.content + session.verdict
 * 产出事件：content.verdict
 */

import type { LlmClient } from '../../llm/qwen.js';
import type {
  EventStream,
  NoteContentPayload,
  ContentVerdictPayload,
  SessionVerdictPayload,
} from '../events.js';
import { EVENT_TYPES } from '../events.js';
import type { Soul } from '../../soul/types.js';
import type { RoleAgent } from './base-agent.js';

export class ContentCurator implements RoleAgent {
  readonly name = 'ContentCurator';

  constructor(private readonly llm: LlmClient) {}

  async process(stream: EventStream, soul: Soul): Promise<void> {
    // 幂等
    if (stream.has(EVENT_TYPES.CONTENT_VERDICT)) return;

    // 若无 note.content 事件则 return
    const noteEvent = stream.find<NoteContentPayload>(EVENT_TYPES.NOTE_CONTENT);
    if (!noteEvent) return;

    // 检查 session.verdict
    const verdictEvent = stream.find<SessionVerdictPayload>(EVENT_TYPES.SESSION_VERDICT);
    if (!verdictEvent) return; // 等下一轮
    if (!verdictEvent.payload.allow) return; // 自主跳过

    const { note } = noteEvent.payload;
    const prompt = this.buildPrompt(soul, note);

    try {
      const raw = await this.llm.complete(prompt);
      const verdict = this.parseOutput(raw);

      stream.emit({
        type: EVENT_TYPES.CONTENT_VERDICT,
        source: this.name,
        timestamp: Date.now(),
        payload: verdict,
      });
    } catch {
      // LLM 失败不阻塞
    }
  }

  private buildPrompt(soul: Soul, note: NoteContentPayload['note']): string {
    const { identity, interests, behavior_guidelines: bg } = soul;
    const collectionPrinciple = bg?.collection_principle ?? '值得反复参考、可直接落地执行';
    const likePrinciple = bg?.like_principle ?? '学到了新东西或观点受启发';

    return `你是「${identity.name}」，${identity.role}。${identity.background}
你的兴趣：${[...interests.primary, ...interests.secondary].join('、')}

你的收藏标准：${collectionPrinciple}
你的点赞标准：${likePrinciple}

请评估以下笔记的内容质量：
标题：${note.title}
作者：${note.author}
内容：${note.content.slice(0, 800)}

评估维度：
1. 是否有具体细节（步骤、代码、配置等）？
2. 是否有真实案例或个人经验？
3. 是否有数据支撑？
4. 是否原创内容（非搬运/非广告/非标题党）？

只输出一个 JSON 对象，不要任何解释或 markdown 代码块：
{"quality": "high|medium|low", "reason": "简短评价"}

quality 含义：
- high：有具体细节+真实经验+原创，值得互动
- medium：内容尚可但无突出亮点
- low：空洞/标题党/广告/搬运`;
  }

  private parseOutput(raw: string): ContentVerdictPayload {
    const fallback: ContentVerdictPayload = { quality: 'medium', reason: 'parse_fallback' };
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return fallback;

    let obj: unknown;
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return fallback;
    }

    if (!obj || typeof obj !== 'object') return fallback;
    const o = obj as Record<string, unknown>;
    const validQualities = new Set(['high', 'medium', 'low']);
    if (typeof o.quality !== 'string' || !validQualities.has(o.quality)) return fallback;

    return {
      quality: o.quality as ContentVerdictPayload['quality'],
      reason: typeof o.reason === 'string' ? o.reason : 'content_evaluated',
    };
  }
}
