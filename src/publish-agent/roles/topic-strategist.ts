import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, TopicSelection } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';

/** 平台话题上限（话题数截断到 ≤30）。 */
const MAX_TOPICS = 30;

/**
 * TopicStrategist — 话题决策（A 阶段3 元数据，纯规则、确定性、不调 LLM）。
 * 规则：selectedTopics = 去重(createdContent.tags) 截断到 ≤30。
 * 红线：不足 3 个也不编造补足，如实回报（无 tags → 空数组）。
 */
export class TopicStrategistRole extends BasePublishRole<CreatedContent, TopicSelection> {
  readonly config: RoleConfig = {
    name: 'TopicStrategist',
    watchKeys: ['createdContent'],
    timeoutMs: 5000,
    fallback: 'default',
  };
  protected readonly outputKey = 'topicSelection' as const;

  protected extractInput(snapshot: Partial<PipelineFields>): CreatedContent {
    return snapshot.createdContent!;
  }

  protected async execute(input: CreatedContent, _context: PipelineContext<PipelineFields>): Promise<TopicSelection> {
    const tags = Array.isArray(input?.tags) ? input.tags : [];
    // 去重（保序），截断到 ≤30；不足不补、不编造。
    const deduped = Array.from(new Set(tags.filter((t) => typeof t === 'string' && t.length > 0)));
    const selectedTopics = deduped.slice(0, MAX_TOPICS);
    return { selectedTopics, selectedAt: this.clock() };
  }

  protected override getDefaultOutput(): TopicSelection {
    return { selectedTopics: [], selectedAt: this.clock() };
  }
}
