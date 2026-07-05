export { BasePublishRole } from './base-role.js';
export type { RoleConfig } from './base-role.js';
export { ContentScoutRole } from './content-scout.js';
export { ContentTypeSelectorRole } from './content-type-selector.js';
export { ContentCreatorRole } from './content-creator.js';
export {
  ReferenceAnalyzerRole,
  FaithfulRewritePlannerRole,
  FaithfulDraftWriterRole,
  FidelityAuditorRole,
} from './faithful-reference-rewrite.js';
export { CategoryClassifierRole } from './category-classifier.js';
export { ImageSetPlannerRole } from './image-set-planner.js';
export { ImagePromptComposerRole } from './image-prompt-composer.js';
export { ImageGeneratorRole } from './image-generator.js';
export { CoverSelectorRole } from './cover-selector.js';
export { ContentCleanerRole, CLEAN_TIMEOUT_MS } from './content-cleaner.js';
export { AiFlavorScorerRole } from './ai-flavor-scorer.js';
export { QualityScorerRole } from './quality-scorer.js';
export { ContentAssemblerRole } from './content-assembler.js';
// 标题链路（定稿后单独生成标题，发布门前置依赖）
export { TitleCreatorRole } from './title-creator.js';
// 阶段3 元数据 + 合规决策角色
export { TopicGeneratorRole } from './topic-generator.js';
export { TopicEvaluatorRole } from './topic-evaluator.js';
export { MentionStrategistRole } from './mention-strategist.js';
export { LocationStrategistRole } from './location-strategist.js';
export { CollectionStrategistRole } from './collection-strategist.js';
export { VisibilityDeciderRole } from './visibility-decider.js';
export { PermissionDeciderRole } from './permission-decider.js';
export { PublishModeDeciderRole } from './publish-mode-decider.js';
export { ComplianceDeciderRole } from './compliance-decider.js';
export { MetadataAggregatorRole } from './metadata-aggregator.js';
export { ApprovalGatekeeperRole } from './approval-gatekeeper.js';
export { PublishExecutorRole } from './publish-executor.js';
