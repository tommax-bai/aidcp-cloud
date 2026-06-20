import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type {
  PipelineFields,
  TopicSelection,
  MentionSelection,
  LocationSelection,
  CollectionSelection,
  VisibilityDecision,
  PermissionDecision,
  PublishModeDecision,
  ComplianceDecision,
  PublishMetadata,
  Visibility,
} from '../types.js';
import { METADATA_DEFAULT_VALUES } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';

/**
 * MetadataAggregator（A 阶段3）— 纯规则汇合，无 LLM / 无 IO。
 * waitAll 八键（仿 ContentAssembler 五键 waitAll），各由"无论成败必写自己键"的决策角色生产（R1 死锁防护）。
 * 汇合成发帖元数据 publishMetadata（并行于 assembledContent，本阶段不应用到边缘）。
 *
 * 红线：
 * - aiEnforced 防篡改回正：若 compliance.aiEnforced && !compliance.ai → 强制 ai=true 并记 error 审计，绝不静默放行 ai=false。
 * - 只读不写边界：绝不 ctx.write('assembledContent', ...)（assembledContent 八字段由 ContentAssembler 单写、逐字不动）。
 * - metadataScore 如实：缺失项计 0、不虚高。
 */
interface MetadataInput {
  topicSelection: TopicSelection;
  mentionSelection: MentionSelection;
  locationSelection: LocationSelection;
  collectionSelection: CollectionSelection;
  visibilityDecision: VisibilityDecision;
  permissionDecision: PermissionDecision;
  publishModeDecision: PublishModeDecision;
  complianceDecision: ComplianceDecision;
}

// 评分语义：「有效」= 实际做出了非保守降级的分享决策（如实反映元数据完整度，
// 不把最保守的兜底默认 self_only / disable 计入完整度，避免缺省态虚高）。
const SHARING_VISIBILITIES: ReadonlySet<Visibility> = new Set<Visibility>(['public', 'friends_only']);
const OPEN_PERMISSION_LEVELS: ReadonlySet<string> = new Set(['allow', 'restrict']);

export class MetadataAggregatorRole extends BasePublishRole<MetadataInput, PublishMetadata> {
  readonly config: RoleConfig = {
    name: 'MetadataAggregator',
    waitAll: true,
    watchKeys: [
      'topicSelection',
      'mentionSelection',
      'locationSelection',
      'collectionSelection',
      'visibilityDecision',
      'permissionDecision',
      'publishModeDecision',
      'complianceDecision',
    ],
    timeoutMs: 10000,
    fallback: 'default',
  };
  protected readonly outputKey = 'publishMetadata' as const;

  protected extractInput(snapshot: Partial<PipelineFields>): MetadataInput {
    return {
      topicSelection: snapshot.topicSelection!,
      mentionSelection: snapshot.mentionSelection!,
      locationSelection: snapshot.locationSelection!,
      collectionSelection: snapshot.collectionSelection!,
      visibilityDecision: snapshot.visibilityDecision!,
      permissionDecision: snapshot.permissionDecision!,
      publishModeDecision: snapshot.publishModeDecision!,
      complianceDecision: snapshot.complianceDecision!,
    };
  }

  protected async execute(input: MetadataInput, _context: PipelineContext<PipelineFields>): Promise<PublishMetadata> {
    const topics = input.topicSelection.selectedTopics ?? [];
    const mentions = input.mentionSelection.selectedMentions ?? [];
    const location = input.locationSelection.selectedLocation ?? null;
    const collection = input.collectionSelection.selectedCollection ?? null;
    const visibility = input.visibilityDecision.visibility;
    const permissions = {
      comment: input.permissionDecision.comment,
      save: input.permissionDecision.save,
    };
    const mode = input.publishModeDecision.mode;
    const publishTime = input.publishModeDecision.publishTime ?? null;

    // aiEnforced 防篡改回正：一经置位禁止降级，绝不静默放行 ai=false。
    const compliance = { ...input.complianceDecision.compliance };
    if (compliance.aiEnforced && !compliance.ai) {
      this.logger.error(
        `[${this.config.name}] compliance tamper detected: aiEnforced=true but ai=${String(compliance.ai)}; forcing ai=true (audit)`
      );
      compliance.ai = true;
    }

    const metadataScore = this.computeScore({ topics, mentions, location, collection, visibility, permissions });

    return {
      topics,
      mentions,
      location,
      collection,
      visibility,
      permissions,
      mode,
      publishTime,
      compliance,
      metadataScore,
      decidedAt: this.clock(),
    };
  }

  /**
   * 元数据完整度 0-1（如实，缺失项计 0、不虚高）。权重求和：
   * topics 数量 3-30 → 0.2 / mentions 数量 1-10 → 0.2 / location 非 null → 0.15 /
   * collection 非 null → 0.15 / visibility 有效 → 0.15 / permissions 有效 → 0.15。
   * 「有效」指实际分享决策（visibility 非保守 self_only、permissions 非全关），
   * 全默认（空 / null / self_only / disable）→ 0、全实际分享决策 → 1.0。
   */
  private computeScore(m: {
    topics: string[];
    mentions: string[];
    location: string | null;
    collection: string | null;
    visibility: Visibility;
    permissions: { comment: string; save: string };
  }): number {
    let score = 0;
    if (m.topics.length >= 3 && m.topics.length <= 30) score += 0.2;
    if (m.mentions.length >= 1 && m.mentions.length <= 10) score += 0.2;
    if (m.location !== null) score += 0.15;
    if (m.collection !== null) score += 0.15;
    if (SHARING_VISIBILITIES.has(m.visibility)) score += 0.15;
    if (OPEN_PERMISSION_LEVELS.has(m.permissions.comment) || m.permissions.save === 'allow') score += 0.15;
    return Math.min(score, 1.0);
  }

  protected override getDefaultOutput(): PublishMetadata {
    return { ...METADATA_DEFAULT_VALUES, decidedAt: this.clock() };
  }
}
