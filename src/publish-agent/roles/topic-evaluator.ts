import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, TopicSelection } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildTopicEvaluationPrompt } from '../prompts.js';
import { executeWithFallback } from '../retry-strategy.js';
import type { ChatLlmClient } from '../../llm/qwen.js';

/**
 * TopicEvaluator（change split-topic-roles）— 话题评判，接管 `TopicStrategist` 的 `topicSelection` 键。
 *
 * watch `topicCandidates`；纯 LLM 按相关性 / 质量 / 合规**只筛不加**（保留项 ⊆ 候选），再确定性去重 + 截断 ≤30。
 * 红线：绝不新增候选外话题、绝不硬凑数量；LLM 失败 → 保守写空选择（必写键、防 waitAll 死锁）。
 */

const TOPIC_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_TOPIC_TIMEOUT_MS ?? 180_000);
/** 平台话题数上限（≤30，沿用历史 TopicStrategist 口径）。 */
const MAX_TOPICS = 30;
const TOPIC_EVAL_SYSTEM = '你是小红书话题评判专家（话题评判）。严格只输出 JSON 格式的保留话题列表。';

export interface TopicEvaluatorDeps {
  llmClient: ChatLlmClient;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface TopicEvalInput {
  candidates: string[];
  title: string;
  body: string;
}

export class TopicEvaluatorRole extends BasePublishRole<TopicEvalInput, TopicSelection> {
  readonly config: RoleConfig = {
    name: 'TopicEvaluator',
    watchKeys: ['topicCandidates'],
    timeoutMs: TOPIC_TIMEOUT_MS,
    fallback: 'default',
  };
  protected readonly outputKey = 'topicSelection' as const;
  private llmClient: ChatLlmClient;

  constructor(deps: TopicEvaluatorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): TopicEvalInput {
    return {
      candidates: snapshot.topicCandidates?.candidates ?? [],
      title: snapshot.titleSelection?.title ?? '',
      body: snapshot.assembledContent?.finalContent ?? '',
    };
  }

  protected async execute(input: TopicEvalInput, _context: PipelineContext<PipelineFields>): Promise<TopicSelection> {
    // 无候选 → 诚实空选择，不白调 LLM。
    if (input.candidates.length === 0) {
      return { selectedTopics: [], selectedAt: this.clock() };
    }
    const { result, usedFallback } = await executeWithFallback(
      async () => {
        const raw = await this.llmClient.chat(
          [
            { role: 'system', content: TOPIC_EVAL_SYSTEM },
            { role: 'user', content: buildTopicEvaluationPrompt(input.candidates, input.title, input.body) },
          ],
          { timeoutMs: TOPIC_TIMEOUT_MS },
        );
        return this.parseKept(raw);
      },
      // 失败保守置空（spec: 评判失败保守置空）——绝不放行未评判候选。
      { default: [] as string[], reason: 'topic evaluation failed' },
    );
    if (usedFallback) this.logger.warn('[TopicEvaluator] 评判失败 → 空选择（失败保守，不放行未评判候选）');
    // 只筛不加：保留项必须是候选子集（LLM 幻觉候选外话题一律剔除），再去重 + 截断 ≤30。绝不硬凑。
    const kept = result.filter((t) => typeof t === 'string' && t.length > 0 && input.candidates.includes(t));
    const selectedTopics = Array.from(new Set(kept)).slice(0, MAX_TOPICS);
    return { selectedTopics, selectedAt: this.clock() };
  }

  protected override getDefaultOutput(): TopicSelection {
    return { selectedTopics: [], selectedAt: this.clock() };
  }

  /** 解析 { "kept": [...] }；无 JSON / 非数组则抛（交 executeWithFallback 降级空）。 */
  private parseKept(raw: string): string[] {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('TopicEvaluator: 输出无 JSON');
    const obj = JSON.parse(match[0]);
    if (!Array.isArray(obj.kept)) throw new Error('TopicEvaluator: JSON 无 kept 数组');
    return obj.kept.map((t: unknown) => String(t));
  }
}
