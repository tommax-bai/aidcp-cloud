/**
 * publish_pipeline_logs 持久化（PostgreSQL，aidcp 库）。
 *
 * migration 0004 早建了此表却一直**无 writer**（死表）——发布失败「卡在哪个角色」只能翻 journalctl。
 * 本 store 补上 best-effort 写入：每个发布角色每次执行落一行（run_id 串起整条管道 + success / error_message /
 * duration_ms），可直接查库定位失败/慢的角色。
 *
 * 红线：写入是 best-effort——调用方 fire-and-forget（不 await、吞错），写库失败/慢**绝不**波及发布主链路。
 * 注：input_snapshot / output_snapshot 暂置 NULL（整快照体积大、含正文/图 URL，序列化有风险）；
 *     如需正文/产出，后续按角色 watchKeys 裁剪后再补，不在最小改动里。
 */
import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';

import type { PipelineLogEntry, PipelineLogSink } from '../kernel/pipeline-log-contract.js';

const { Pool } = pg;

export type { PipelineLogEntry, PipelineLogSink };

export interface PublishPipelineLogStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
}

export class PublishPipelineLogStore implements PipelineLogSink {
  private readonly pool: pg.Pool;

  constructor(options: PublishPipelineLogStoreOptions = {}) {
    this.pool =
      options.pool ??
      new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
  }

  async append(entry: PipelineLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO publish_pipeline_logs
         (run_id, role_name, triggered_at, completed_at, input_snapshot, output_snapshot, success, error_message, duration_ms)
       VALUES ($1, $2, to_timestamp($3::double precision / 1000), to_timestamp($4::double precision / 1000), NULL, NULL, $5, $6, $7)`,
      [entry.runId, entry.roleName, entry.triggeredAt, entry.completedAt, entry.success, entry.errorMessage, entry.durationMs],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
