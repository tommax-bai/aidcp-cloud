import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, TriggerInput, ScoutDecision } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildScoutPrompt } from '../prompts.js';
import { executeWithFallback } from '../retry-strategy.js';
import type { ChatLlmClient } from '../../llm/qwen.js';

/**
 * 角色闸 + LLM 调用同放宽（env AIDCP_PUBLISH_SCOUT_TIMEOUT_MS）。ContentScout 调 qwen3.7-max，实测单次约 33s；
 * 原 15s 角色闸会先于 LLM 完成砍断 → 角色超时 → 因 fallback:'default' 不写键，整条管道干等全局 180s 才 failed
 * （2026-06-30 真机实测：run=2vwhy664，ContentScout failed after 15000ms，LLM 32.8s 才 ok，管道 180s 超时）。
 * 90s 既盖住慢调用、又远低于全局闸；必须同时传给 chat()，否则 QwenClient 默认 60s 会先 abort（见 ContentCreator）。
 */
const SCOUT_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_SCOUT_TIMEOUT_MS ?? 90000);

export interface ContentScoutDeps {
  llmClient: ChatLlmClient;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class ContentScoutRole extends BasePublishRole<TriggerInput, ScoutDecision> {
  readonly config: RoleConfig = {
    name: 'ContentScout',
    watchKeys: ['trigger'],
    timeoutMs: SCOUT_TIMEOUT_MS,
    // LLM 角色对齐 ContentCreator/TitleCreator 范式：角色闸超时（真卡死）即写中止信号、整条管道**即刻** failed，
    // 不再像原 'default' 那样静默不写键、把流水线吊到全局 180s。正常 LLM 失败仍由 execute 内 executeWithFallback 兜底续跑。
    fallback: 'abort',
  };
  protected readonly outputKey = 'scoutDecision' as const;
  private llmClient: ChatLlmClient;

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
        const raw = await this.llmClient.chat(
          [
            { role: 'system', content: '你是发布决策专家。分析数据后返回严格JSON。' },
            { role: 'user', content: prompt },
          ],
          // 与角色闸同放宽，否则 QwenClient 默认 60s 会先 abort（角色闸放宽也没用，见 ContentCreator）。
          { timeoutMs: SCOUT_TIMEOUT_MS },
        );
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
