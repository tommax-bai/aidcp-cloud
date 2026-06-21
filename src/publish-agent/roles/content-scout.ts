import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, TriggerInput, ScoutDecision } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildScoutPrompt } from '../prompts.js';
import { executeWithFallback } from '../retry-strategy.js';
import type { QwenClient } from '../../llm/qwen.js';

export interface ContentScoutDeps {
  llmClient: QwenClient;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class ContentScoutRole extends BasePublishRole<TriggerInput, ScoutDecision> {
  readonly config: RoleConfig = {
    name: 'ContentScout',
    watchKeys: ['trigger'],
    timeoutMs: 15000,
    fallback: 'default',
  };
  protected readonly outputKey = 'scoutDecision' as const;
  private llmClient: QwenClient;

  constructor(deps: ContentScoutDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): TriggerInput {
    return snapshot.trigger!;
  }

  protected async execute(input: TriggerInput, _context: PipelineContext<PipelineFields>): Promise<ScoutDecision> {
    const prompt = buildScoutPrompt(input);
    const { result, usedFallback } = await executeWithFallback(
      async () => {
        const raw = await this.llmClient.chat([
          { role: 'system', content: '你是发布决策专家。分析数据后返回严格JSON。' },
          { role: 'user', content: prompt },
        ]);
        return this.parseOutput(raw);
      },
      { default: this.getFallbackDecision(), reason: 'LLM failed' },
    );
    if (usedFallback) {
      this.logger.warn('[ContentScout] used fallback decision');
    }
    // 手动 /publish 强制发布：运营已明确要发（下游人审兜底），不被「无新素材」否决。
    // 仍用 LLM 给出的方向/要点（基于人物设定与现有素材），仅把 shouldPublish 锁为 true。
    const shouldPublish = input.forced ? true : result.shouldPublish;
    if (input.forced && !result.shouldPublish) {
      this.logger.log('[ContentScout] 手动强制发布：覆盖 shouldPublish=true（沿用 LLM 方向/要点）');
    }
    return { ...result, shouldPublish, scoutedAt: this.clock() };
  }

  private parseOutput(raw: string): Omit<ScoutDecision, 'scoutedAt'> {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in Scout output');
    const obj = JSON.parse(match[0]);
    return {
      shouldPublish: Boolean(obj.shouldPublish),
      publishDirection: String(obj.publishDirection || 'general'),
      keyPoints: Array.isArray(obj.keyPoints) ? obj.keyPoints.map(String) : [],
      confidence: Number(obj.confidence ?? 0.5),
      reason: String(obj.reason || ''),
    };
  }

  private getFallbackDecision(): Omit<ScoutDecision, 'scoutedAt'> {
    return { shouldPublish: false, publishDirection: 'fallback', keyPoints: [], confidence: 0, reason: 'LLM降级' };
  }
}
