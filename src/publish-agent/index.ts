// publish-agent 生成段（content）出口。
//
// change decouple-publish-agent-buckets（Batch D 簇E）：发布管线沿 §4.6.3 的三分接缝拆桶——
// 生成段（content）/ 下发段（automation）/ 台账段（api）各自出口，跨段调用走各文件的现有接缝，
// 不再把三个 owner 段的符号混在这一个桶里 re-export。
//   - 下发段（automation）：`PublishDispatcher` 由组合根从 `./publish-dispatcher.js` 直接 import
//     （它本就以注入依赖 `PublishDispatcherDeps` / `DispatchStore` 与其它段解耦，见 publish-dispatcher.ts:1-16）。
//   - 台账段（api）：`PublishScheduler` / `PublishLogStore` 由各自文件直接 import
//     （`./publish-scheduler.js` / `./publish-log-store.js`）。
// 本桶只出 content 段符号，故它对外的 import 边全部同层（content→content），无跨边界豁免。
export { PipelineContext } from './pipeline-context.js';
export { PublishOrchestrator } from './publish-orchestrator.js';
export { BasePublishRole } from './roles/base-role.js';
export type { RoleConfig } from './roles/base-role.js';
export { executeWithRetry, executeWithFallback } from './retry-strategy.js';
export type { RetryConfig, FallbackOption } from './retry-strategy.js';
export { PostProcessor, detectBannedPhrases, aiScoreFromHits } from './post-processor.js';
export type { PostProcessorOptions } from './post-processor.js';
export {
  FacebookPublishMediaStore,
  FacebookPublishMediaError,
  FACEBOOK_PUBLISH_MEDIA_SCHEMA_SQL,
  FACEBOOK_PUBLISH_MEDIA_STATUSES,
} from './facebook-publish-media-store.js';
export type {
  FacebookPublishImageInput,
  FacebookPublishImageSetView,
  FacebookPublishImageView,
  FacebookPublishMediaListView,
  FacebookPublishMediaStatus,
  FacebookPublishUploadResult,
} from './facebook-publish-media-store.js';
export type {
  PipelineFields,
  PipelineStatus,
  TriggerInput,
  ScoutDecision,
  CreatedContent,
  ReferenceAnalysis,
  FaithfulRewritePlan,
  FaithfulDraft,
  FidelityAuditReport,
  ImageDirective,
  AssembledContent,
  GateDecision,
  PublishResult,
  RoleInvokeOptions,
  OrchestratorDeps,
  Concept,
  LikedNote,
  PostProcessResult,
  PublishRecord,
  PublishStatus,
} from './types.js';
