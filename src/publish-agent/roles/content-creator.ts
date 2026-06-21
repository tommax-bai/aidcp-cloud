import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, ScoutDecision, TriggerInput, CreatedContent } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildCreatorPrompt } from '../prompts.js';
import { executeWithRetry } from '../retry-strategy.js';
import type { ChatLlmClient } from '../../llm/qwen.js';

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
    timeoutMs: 30000,
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
        return this.llmClient.chat([
          { role: 'system', content: '你是一个小红书技术博主。严格按要求生成JSON格式内容。' },
          { role: 'user', content: prompt },
        ]);
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
    return {
      title: String(obj.title || ''),
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
