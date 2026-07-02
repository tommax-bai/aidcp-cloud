import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, PostCategory, ImageCategory } from '../types.js';
import { IMAGE_CATEGORIES } from '../types.js';
import { buildCategoryClassifierPrompt } from '../prompts.js';
import type { ChatLlmClient } from '../../llm/qwen.js';

/**
 * CategoryClassifier — 发布侧【品类判定角色】（change category-adaptive-images-and-judgment）。
 * watch createdContent（读正文才准）→ 从固定品类枚举里选一个 category，写 postCategory。
 * 一帖判一次，下游配图选题（风格档）与质量评审复用同一值（守帖内一致）。
 * 红线：
 * - 单一职责——只分类、绝不干别的（比让配图选题「搭车分类」更准）。
 * - 判不出 / 枚举外 / LLM 失败 → 诚实回落安全兜底档 general，**绝不 brick**、恒写 postCategory
 *   （下游 composer 对 [imageSetPlan, postCategory] 做 waitAll，这一键缺失会挂死流水线）。
 * - flash 模型即可（发布低频、成本可忽略）；模型经 role-catalog `publish:CategoryClassifier` 后台可配。
 */

const CLASSIFY_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_CATEGORY_TIMEOUT_MS ?? 60_000);
const FALLBACK: ImageCategory = 'general';

export interface CategoryClassifierDeps {
  llmClient: ChatLlmClient;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class CategoryClassifierRole extends BasePublishRole<CreatedContent, PostCategory> {
  readonly config: RoleConfig = {
    name: 'CategoryClassifier',
    watchKeys: ['createdContent'],
    timeoutMs: CLASSIFY_TIMEOUT_MS,
    fallback: 'skip',
  };
  protected readonly outputKey = 'postCategory' as const;
  private llmClient: ChatLlmClient;

  constructor(deps: CategoryClassifierDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): CreatedContent {
    return snapshot.createdContent!;
  }

  protected async execute(input: CreatedContent): Promise<PostCategory> {
    try {
      const raw = await this.llmClient.chat(
        [
          { role: 'system', content: '你是内容品类分类器。严格返回JSON。' },
          { role: 'user', content: buildCategoryClassifierPrompt(input.title, input.content) },
        ],
        { timeoutMs: CLASSIFY_TIMEOUT_MS },
      );
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no json');
      const obj = JSON.parse(match[0]) as { category?: unknown };
      const cat = String(obj.category ?? '').trim();
      const category: ImageCategory = (IMAGE_CATEGORIES as readonly string[]).includes(cat)
        ? (cat as ImageCategory)
        : FALLBACK;
      return { category, classifiedAt: this.clock() };
    } catch (err) {
      // 诚实回落——绝不 brick、恒写 postCategory（不让 composer waitAll 挂死）。
      this.logger.warn(
        `[CategoryClassifier] 分类失败，回落 ${FALLBACK}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { category: FALLBACK, classifiedAt: this.clock() };
    }
  }

  protected override getDefaultOutput(): PostCategory {
    return { category: FALLBACK, classifiedAt: this.clock() };
  }
}
