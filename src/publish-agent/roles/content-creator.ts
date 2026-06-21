import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, ScoutDecision, TriggerInput, CreatedContent } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildCreatorPrompt } from '../prompts.js';
import { executeWithRetry } from '../retry-strategy.js';
import type { ChatLlmClient } from '../../llm/qwen.js';

// 内容生成超时（角色闸 + LLM 调用同值）：放宽到 120s，容纳较强/较慢模型（如 qwen-max 系）。env 可调。
const CONTENT_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_CONTENT_TIMEOUT_MS ?? 120000);

export interface ContentCreatorDeps {
  llmClient: ChatLlmClient;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface CreatorInput {
  scoutDecision: ScoutDecision;
  trigger: TriggerInput;
}

export class ContentCreatorRole extends BasePublishRole<CreatorInput, CreatedContent> {
  readonly config: RoleConfig = {
    name: 'ContentCreator',
    watchKeys: ['scoutDecision'],
    timeoutMs: CONTENT_TIMEOUT_MS,
    fallback: 'abort',
  };
  protected readonly outputKey = 'createdContent' as const;
  private llmClient: ChatLlmClient;

  constructor(deps: ContentCreatorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
  }

  protected override shouldActivate(snapshot: Partial<PipelineFields>): boolean {
    return snapshot.scoutDecision?.shouldPublish === true;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): CreatorInput {
    return {
      scoutDecision: snapshot.scoutDecision!,
      trigger: snapshot.trigger!,
    };
  }

  protected async execute(input: CreatorInput, _context: PipelineContext<PipelineFields>): Promise<CreatedContent> {
    const prompt = buildCreatorPrompt(input.scoutDecision, input.trigger);
    const raw = await executeWithRetry(
      async () => {
        return this.llmClient.chat(
          [
            { role: 'system', content: '你是一个小红书技术博主。严格按要求生成JSON格式内容。' },
            { role: 'user', content: prompt },
          ],
          // LLM 调用超时须与角色闸同放宽，否则 QwenClient 默认 30s 会先 abort（角色闸放宽也没用）。
          { timeoutMs: CONTENT_TIMEOUT_MS },
        );
      },
      { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 2 },
    );
    const parsed = this.parseOutput(raw);
    return { ...parsed, createdAt: this.clock() };
  }

  private parseOutput(raw: string): Omit<CreatedContent, 'createdAt'> {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in Creator output');
    const obj = JSON.parse(match[0]);
    // 小红书标题硬上限 20 字（超限「发布」按钮静默失效）。云端先截断至 20 兜底，edge 再截一次双保险。
    const title = String(obj.title || '').slice(0, 20);
    return {
      title,
      content: String(obj.content || ''),
      tags: Array.isArray(obj.tags) ? obj.tags.map(String) : [],
      tone: this.validateTone(obj.tone),
      style: typeof obj.style === 'object' && obj.style !== null ? obj.style : {},
    };
  }

  private validateTone(tone: unknown): CreatedContent['tone'] {
    const valid: CreatedContent['tone'][] = ['professional', 'casual', 'technical', 'narrative'];
    if (typeof tone === 'string' && valid.includes(tone as CreatedContent['tone'])) {
      return tone as CreatedContent['tone'];
    }
    return 'casual';
  }
}
