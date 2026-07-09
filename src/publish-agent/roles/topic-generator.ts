import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, TopicCandidates } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildTopicGenerationPrompt } from '../prompts.js';
import { executeWithFallback } from '../retry-strategy.js';
import type { ChatLlmClient } from '../../llm/qwen.js';

/**
 * TopicGenerator（change split-topic-roles）— 话题生成，与正文角色解耦。
 *
 * watch `assembledContent`（与 `TitleCreator` 并行、不串在标题后），以**定稿正文** `finalContent`
 * 为输入，单次 LLM 产出话题候选，写入 `topicCandidates`。
 * 红线：宁缺毋滥不编造；LLM / 解析失败 → 经 `executeWithFallback` 写空候选（必写键、防 waitAll 死锁）。
 */

/** 话题生成超时（角色闸 + LLM 调用同值）：≥180s 单次模型天花板，env 可调。 */
const TOPIC_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_TOPIC_TIMEOUT_MS ?? 180_000);
/** 生成阶段先给较宽召回上限；评判阶段再精排截断到 ≤30。 */
const MAX_CANDIDATES = 15;
/** TopicGenerator 专用 system（含「话题生成」标识，与其他角色 system 相区分，便于按 system 路由的桩）。 */
const TOPIC_GEN_SYSTEM = '你是小红书话题生成专家（话题生成）。严格只输出 JSON 格式的话题列表。';

export interface TopicGeneratorDeps {
  llmClient: ChatLlmClient;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface TopicGenInput {
  body: string;
  persona: string;
}

export class TopicGeneratorRole extends BasePublishRole<TopicGenInput, TopicCandidates> {
  readonly config: RoleConfig = {
    name: 'TopicGenerator',
    watchKeys: ['assembledContent'],
    timeoutMs: TOPIC_TIMEOUT_MS,
    // 'skip'（非 'default'）：即便角色闸超时（execute 未及降级即被 Promise.race 掐断），handleError 也会写 getDefaultOutput，
    // 保证 topicCandidates 必写、下游 waitAll 不会干等到 pipelineTimeoutMs（'default' 在超时路径是 no-op，会 fail-slow）。
    fallback: 'skip',
  };
  protected readonly outputKey = 'topicCandidates' as const;
  private llmClient: ChatLlmClient;

  constructor(deps: TopicGeneratorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): TopicGenInput {
    // 以定稿正文为输入（决策③）；标题此刻可能尚未就绪（并行于 TitleCreator），话题源于正文即可。
    const body = snapshot.assembledContent?.finalContent ?? '';
    const identity = snapshot.trigger?.generateInput?.soul?.identity;
    const persona = identity
      ? `${identity.role}｜${identity.background}（语气：${identity.tone}）`
      : '小红书博主';
    return { body, persona };
  }

  protected async execute(input: TopicGenInput, context: PipelineContext<PipelineFields>): Promise<TopicCandidates> {
    // 空正文（上游降级）→ 诚实空候选，不白调一次 LLM。
    if (input.body.trim().length === 0) {
      this.logger.warn('[TopicGenerator] 定稿正文为空 → 空候选');
      return { candidates: [], generatedAt: this.clock() };
    }
    const { result, usedFallback } = await executeWithFallback(
      async () => {
        const raw = await this.llmClient.chat(
          [
            { role: 'system', content: TOPIC_GEN_SYSTEM },
            { role: 'user', content: buildTopicGenerationPrompt(input.body, input.persona) },
          ],
          // 角色闸同传进 chat，否则默认 30s 会先 abort。
          { timeoutMs: TOPIC_TIMEOUT_MS, accountId: this.accountIdFrom(context) },
        );
        return this.parseTopics(raw);
      },
      { default: [] as string[], reason: 'topic generation failed' },
    );
    if (usedFallback) this.logger.warn('[TopicGenerator] 生成失败 → 空候选（诚实置空、不编造）');
    return { candidates: this.normalize(result), generatedAt: this.clock() };
  }

  protected override getDefaultOutput(): TopicCandidates {
    return { candidates: [], generatedAt: this.clock() };
  }

  /** 解析 { "topics": [...] }；无 JSON / 非数组则抛（交 executeWithFallback 降级空）。 */
  private parseTopics(raw: string): string[] {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('TopicGenerator: 输出无 JSON');
    const obj = JSON.parse(match[0]);
    if (!Array.isArray(obj.topics)) throw new Error('TopicGenerator: JSON 无 topics 数组');
    return obj.topics.map((t: unknown) => String(t));
  }

  /** strip 前导 #、trim、去空、去重（保序），封顶 MAX_CANDIDATES；不足绝不补足。 */
  private normalize(topics: string[]): string[] {
    const cleaned = topics.map((t) => t.replace(/^#+/, '').trim()).filter((t) => t.length > 0);
    return Array.from(new Set(cleaned)).slice(0, MAX_CANDIDATES);
  }
}
