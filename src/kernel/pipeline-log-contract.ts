/**
 * 发布管道角色执行日志契约（从 src/publish-agent/publish-pipeline-log-store.ts 抬入 kernel）。
 *
 * 纯类型契约，零 import、无 SQL、无活状态。写入实现（PublishPipelineLogStore，含 pg Pool + INSERT）
 * 留在 src/publish-agent/publish-pipeline-log-store.ts（api）。被 content 侧发布角色 type-only 共导。
 */

/** 单条角色执行日志（triggeredAt/completedAt 为毫秒时间戳）。 */
export interface PipelineLogEntry {
  runId: string;
  roleName: string;
  triggeredAt: number;
  completedAt: number;
  success: boolean;
  errorMessage: string | null;
  durationMs: number;
}

/** 角色执行日志写入接口（便于单测打桩 / 注入；未注入时 orchestrator 行为退化为现状、不报错）。 */
export interface PipelineLogSink {
  append(entry: PipelineLogEntry): Promise<void>;
}
