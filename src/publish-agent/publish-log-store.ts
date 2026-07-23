/**
 * publish_log 持久化（PostgreSQL，aidcp 库）。
 *
 * 从 src/publish/publisher.ts 迁移而来，作为独立模块存在于 publish-agent/ 下。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { SHANGHAI_DAY_START_SQL } from '../time/shanghai-day.js';
import type { PublishRecord, PublishStatus, PublishMetadata, PublishMode, Visibility } from '../kernel/publish-pipeline-types.js';
import { clampTitle } from '../kernel/title-clamp.js';
import { normalizePlatformId, type PlatformId } from '../platform/index.js';
import { validatePublishSchedule } from './schedule-policy.js';
import type { DeploymentTarget } from '../deployment-target.js';
import { ensureCapabilitySchema, probeSchemaShape } from '../schema/schema-capability.js';

/**
 * 执行态影子表名（change publish-log-split-prep：拆 publish_log 七态表的执行态那半）。
 * 表由 migrations/0073 建，与 publish_log 以 record_id（= publish_log.id）关联。裸表名字符串、非 DDL——
 * DDL 的唯一所有者是 migrations/，本仓运行时 MUST NOT 出现 CREATE/ALTER/CREATE INDEX（AC-SCHEMA-DDL-OWNER）。
 */
const PUBLISH_EXECUTION_STATE_TABLE = 'publish_execution_state';

/** JSONB publish_metadata 解析：pg 驱动通常已解析为对象；兼容字符串形态；解析失败诚实置 null。 */
function parsePublishMetadata(raw: unknown): PublishMetadata | null {
  if (raw == null) return null;
  try {
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as PublishMetadata;
  } catch {
    return null;
  }
}

/** 合法可见范围枚举（与 types.ts 的 Visibility 同步；编辑侧校验用）。 */
const VISIBILITY_VALUES: readonly Visibility[] = ['public', 'friends_only', 'self_only'];
const CLIENT_SCHEDULE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const { Pool } = pg;

/** publish_log 建表 DDL（幂等）。 */
export const PUBLISH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS publish_log (
  id               SERIAL PRIMARY KEY,
  published_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  title            TEXT,
  content          TEXT NOT NULL,
  source_concepts  TEXT[] NOT NULL DEFAULT '{}',
  source_liked_ids INT[] DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','pending_approval','scheduled','submitted','published','failed','needs_review')),
  platform_post_id TEXT,
  publish_metadata JSONB,
  ai_enforced      BOOLEAN NOT NULL DEFAULT false,
  image_url        TEXT,
  images_attached  BOOLEAN NOT NULL DEFAULT false
);
-- 既有表向后兼容（幂等）：A 阶段4 元数据落库 + 防篡改审计列。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS publish_metadata JSONB;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS ai_enforced BOOLEAN NOT NULL DEFAULT false;
-- publish-media-upload（配图收口）：审计用 image_url + 权威「真有图」信号 images_attached。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS images_attached BOOLEAN NOT NULL DEFAULT false;
-- publish-multi-image（迁移 0017）：全部成功配图 URL images + 真实附着张数 images_attached_count（images_attached = count>0 派生）。
-- 复活 0004 已建的休眠 images 列；幂等无害。显式兜空使存量旧行非 NULL（读侧亦 ?? [] 兜底）。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS images TEXT[] NOT NULL DEFAULT '{}';
UPDATE publish_log SET images = '{}' WHERE images IS NULL;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS images_attached_count INT NOT NULL DEFAULT 0;
-- publish-history-account-and-detail：
--   account_id（迁移 0005 已加；此处补进 canonical SQL，使全新 init() 的库也有该列，insert 真正写入真实账号）；
--   post_url（带 xsec_token 的完整详情页分享 URL，发布成功后回写；抓不到存 NULL）。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'xiaohongshu';
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS post_url TEXT;
CREATE INDEX IF NOT EXISTS idx_publish_log_account ON publish_log (account_id);
CREATE INDEX IF NOT EXISTS idx_publish_log_platform ON publish_log (platform);
-- decouple-publish-generation-from-dispatch：status 增加 'pending_approval'（生成候审段产物、待人审、未下发）。
-- 既有表的 CHECK 约束需放开新取值（幂等：先 DROP IF EXISTS 默认约束名再以新集合重建）。无新表/新列。
ALTER TABLE publish_log DROP CONSTRAINT IF EXISTS publish_log_status_check;
ALTER TABLE publish_log ADD CONSTRAINT publish_log_status_check
  CHECK (status IN ('draft','pending_approval','scheduled','submitted','published','failed','needs_review'));
-- edit-note-draft-before-publish：待审草稿就地编辑的「审=发」凭证 + 谁/何时审计。
--   content_version：每行内容版本号（真列、非塞 JSONB，令版本闸是原子 WHERE 谓词）；既有行回填 0；每次成功编辑 +1。
--   edited_by / edited_at：最后一次编辑者（JWT 主体）与时间；仅「谁/何时」，非 diff 日志。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS content_version INT NOT NULL DEFAULT 0;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS edited_by TEXT;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
-- publish-reference-source-panel：参照洗稿来稿快照。普通发布为 NULL；内容页只读此快照，不 join 当前精选池。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS source_reference JSONB;
-- xhs-native-scheduled-publish：平台定时内部句柄与有界对账状态；内部 id 绝不复用 platform_post_id。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS scheduled_platform_id TEXT;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS schedule_reconcile_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS schedule_next_reconcile_at TIMESTAMPTZ;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS schedule_last_error TEXT;
CREATE INDEX IF NOT EXISTS idx_publish_log_scheduled_due
  ON publish_log (schedule_next_reconcile_at, id) WHERE status = 'scheduled';
`;

export interface PublishLogStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  clock?: () => number;
}

interface PublishRow {
  id: number;
  title: string | null;
  content: string;
  source_concepts: string[] | null;
  source_liked_ids: number[] | null;
  status: string;
  platform_post_id: string | null;
}

function toStatus(s: string): PublishStatus {
  return s === 'scheduled' || s === 'submitted' || s === 'published' || s === 'failed' || s === 'needs_review' || s === 'pending_approval' ? s : 'draft';
}

export interface ScheduledPublishRecord {
  recordId: number;
  accountId: string;
  title: string;
  scheduledAt: number;
  scheduledPlatformId: string | null;
  reconcileAttempts: number;
}

export interface ScheduledReconcileUpdate {
  status: 'scheduled' | 'needs_review';
  attempts: number;
}

/**
 * 下发段从落库草稿重建发布所需的最小快照（change decouple-publish-generation-from-dispatch）。
 * 标题/正文/图取自 publish_log 列；话题与发帖元数据取自 publish_metadata JSONB（生成候审段经 recordMetadata 落库）。
 * 下发忠于此快照、绝不重生成（陈旧亦照发）。
 */
export interface DispatchDraft {
  recordId: number;
  accountId: string;
  platform?: PlatformId;
  title: string | null;
  content: string;
  /** 封面 URL（= imageUrls[0]，审计/向后兼容）；无图为 null。 */
  imageUrl: string | null;
  /** 多图：全部成功配图 URL（下发段逐张 upload_image；[0]=封面）。空数组=无图。 */
  imageUrls: string[];
  /** 发帖元数据（含 topics/mentions/location/collection/visibility/permissions/mode/publishTime/compliance）；缺则 null。 */
  metadata: PublishMetadata | null;
  status: PublishStatus;
  /** 内容版本号（edit-note-draft-before-publish）：下发闸比对授权所载版本与此值，不一致则作废过期签名并留待审。 */
  contentVersion: number;
}

/** 陪伴客户端所需的当前待审稿件快照；不包含原稿标题、作者、正文或链接。 */
export interface PendingPublishPreview {
  id: number;
  accountId: string;
  platform: PlatformId;
  kind: 'rewrite' | 'generated';
  title: string | null;
  content: string;
  topics: string[];
  images: string[];
  contentVersion: number;
  updatedAt: number;
  publishMode: PublishMode;
  publishTime: number | null;
  /** 客户首页关联精选来源所需的最小键；不披露 sourceReference 其余快照。 */
  sourceCuratedId?: number | null;
  imageReferenceAudit?: {
    requestedCount: number;
    usableCount: number;
    status: 'none' | 'used' | 'unsupported' | 'unavailable' | 'skipped';
    generatedCount: number;
  };
}

/** 客户首页当前仍在途的发布摘要；终态 published/failed/needs_review 由其它投影承载。 */
export interface CurrentPublishRecord {
  id: number;
  title: string | null;
  status: 'pending_approval' | 'scheduled' | 'submitted';
  at: number;
}

interface PendingPublishPreviewRow {
  id: number;
  account_id: string;
  platform: string | null;
  title: string | null;
  content: string;
  images: string[] | null;
  image_url: string | null;
  publish_metadata: unknown;
  content_version: number | string | null;
  edited_at: Date | null;
  published_at: Date;
  source_reference: unknown;
}

function toPendingPublishPreview(row: PendingPublishPreviewRow): PendingPublishPreview {
  const metadata = parsePublishMetadata(row.publish_metadata);
  const publishMode = metadata?.mode === 'scheduled' || metadata?.mode === 'draft'
    ? metadata.mode
    : 'immediate';
  const publishTime = publishMode === 'scheduled' && Number.isFinite(metadata?.publishTime)
    ? metadata!.publishTime
    : null;
  const audit = metadata?.referenceImageAudit ?? null;
  const auditStatus = audit?.status ?? 'none';
  const imageReferenceAudit: PendingPublishPreview['imageReferenceAudit'] = ['none', 'used', 'unsupported', 'unavailable', 'skipped'].includes(auditStatus)
    ? {
        requestedCount: Number.isFinite(Number(audit?.requestedCount)) ? Number(audit?.requestedCount) : 0,
        usableCount: Number.isFinite(Number(audit?.usableCount)) ? Number(audit?.usableCount) : 0,
        status: auditStatus as NonNullable<PendingPublishPreview['imageReferenceAudit']>['status'],
        generatedCount: Number.isFinite(Number(audit?.generatedCount)) ? Number(audit?.generatedCount) : 0,
      }
    : undefined;
  const images = (row.images ?? []).length > 0 ? row.images! : row.image_url ? [row.image_url] : [];
  const sourceReference = (() => {
    if (row.source_reference == null) return null;
    try {
      const parsed = typeof row.source_reference === 'string' ? JSON.parse(row.source_reference) : row.source_reference;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  })();
  const rawCuratedId = sourceReference?.curatedContentId;
  const parsedCuratedId = typeof rawCuratedId === 'number' || typeof rawCuratedId === 'string'
    ? Number(rawCuratedId)
    : NaN;
  return {
    id: row.id,
    accountId: row.account_id,
    platform: normalizePlatformId(row.platform),
    kind: row.source_reference != null ? 'rewrite' : 'generated',
    title: row.title,
    content: row.content,
    topics: Array.isArray(metadata?.topics) ? metadata.topics.filter((topic): topic is string => typeof topic === 'string') : [],
    images,
    contentVersion: Number(row.content_version ?? 0),
    updatedAt: (row.edited_at ?? row.published_at).getTime(),
    publishMode,
    publishTime,
    ...(sourceReference ? { sourceCuratedId: Number.isInteger(parsedCuratedId) && parsedCuratedId > 0 ? parsedCuratedId : null } : {}),
    ...(imageReferenceAudit ? { imageReferenceAudit } : {}),
  };
}

/**
 * 待审草稿编辑补丁（edit-note-draft-before-publish）：本期仅正文文本 + 文本类元数据可编辑。
 * 未出现的键 = 不改（保留原值）；深合并只动 visibility/topics，其余元数据键逐字保留。
 * images（change pending-draft-image-delete）：编辑后应保留的配图 URL **有序列表**——只删不注入，
 * 提交的每项 MUST 是该记录当前 images 的成员（事务内保序过滤），任一非成员 → invalid_field。
 */
export interface EditDraftPatch {
  title?: string;
  content?: string;
  visibility?: string;
  topics?: string[];
  images?: string[];
  publishMode?: PublishMode;
  publishTime?: number | null;
}

/** editDraft 可区分拒因（诚实非乐观；面板据此映射不同 HTTP/文案）。 */
export type EditDraftReason =
  | 'not_found'
  | 'not_pending'
  | 'version_conflict'
  | 'invalid_title'
  | 'missing_visibility'
  | 'invalid_field';

/** editDraft 结果：成功回读写后真态（含自增后的版本号 + 删后配图列表）；失败带可区分拒因。 */
export type EditDraftResult =
  | {
      ok: true;
      contentVersion: number;
      title: string | null;
      content: string;
      metadata: PublishMetadata | null;
      images: string[];
    }
  | { ok: false; reason: EditDraftReason };

export interface RefineDraftPatch {
  title?: string;
  content?: string;
  topics?: string[];
  images?: string[];
}

export type RefineDraftSelection =
  | { imageUrl: string }
  | { start: number; end: number; text: string }
  | null;

export type RefineDraftResult = EditDraftResult | { ok: false; reason: 'invalid_scope' | 'invalid_selection' };

/** publish_log 持久化（PostgreSQL，aidcp 库）。 */
export class PublishLogStore {
  private readonly pool: pg.Pool;
  private readonly clock: () => number;
  /**
   * 执行态影子表（change publish-log-split-prep）是否可双写。
   * 默认 true 让写路径尝试双写；init() 软探测到表不在 / 探测失败即降为 false、停用双写。
   * **影子缺失或写失败 MUST NOT 连累主路径**——这是本 change 的最高约束（发布链路是核心业务）。
   */
  private executionMirrorAvailable = true;
  /** 影子写失败只告警一次，避免每条写入刷屏。 */
  private executionMirrorWarned = false;

  constructor(options: PublishLogStoreOptions = {}) {
    this.clock = options.clock ?? Date.now;
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

  /** 初始化表（幂等）。 */
  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await ensureCapabilitySchema(this.pool, {
      capability: 'publish_log',
      sinceVersion: '0001_publish_log',
      ddl: [PUBLISH_SCHEMA_SQL],
    });
    // 执行态影子表（change publish-log-split-prep）：**软**探测，探不到就停用双写。
    // 与 publish_log 的 ensureCapabilitySchema（探不到即 fail-closed 抛错）不同——影子是可选的，
    // 迁移 0073 未应用（ol 共库、或 dev 未部署）时 MUST 静默停用双写、绝不阻断本 store 初始化或主路径。
    this.executionMirrorAvailable = await this.probeExecutionMirror();
  }

  /** 软探测执行态影子表是否存在；任何异常都诚实降级为「不可用」（绝不假成功、绝不抛）。 */
  private async probeExecutionMirror(): Promise<boolean> {
    try {
      const shape = await probeSchemaShape(this.pool, [PUBLISH_EXECUTION_STATE_TABLE]);
      return shape.tables.has(PUBLISH_EXECUTION_STATE_TABLE);
    } catch {
      return false;
    }
  }

  /**
   * 执行态双写（change publish-log-split-prep，§5.4.6 模板 M2）：把一次 publish_log 执行态迁移
   * 影子进 publish_execution_state（以 record_id 关联）。**MUST fail-safe**：
   * - 只在权威的 publish_log 写**已成功**之后调用；
   * - 内部 try/catch 兜住一切异常，写失败只告警、绝不抛、绝不回滚——影子挂了不能连累主路径与发布链路；
   * - 影子表不可用（迁移未应用）时直接 no-op。
   *
   * upsert 语义：以 record_id 为键；未随本次迁移提供的列（platform_post_id / post_url）用 COALESCE 保留旧值，
   * 不因一次纯状态迁移把已回填的帖子 id / URL 抹掉。
   */
  private async mirrorExecutionState(
    recordId: number,
    status: PublishStatus,
    extra: { platformPostId?: string | null; postUrl?: string | null } = {},
  ): Promise<void> {
    if (!this.executionMirrorAvailable) return;
    try {
      await this.pool.query(
        `INSERT INTO publish_execution_state (record_id, status, platform_post_id, post_url, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (record_id) DO UPDATE
           SET status = EXCLUDED.status,
               platform_post_id = COALESCE(EXCLUDED.platform_post_id, publish_execution_state.platform_post_id),
               post_url = COALESCE(EXCLUDED.post_url, publish_execution_state.post_url),
               updated_at = now()`,
        [recordId, status, extra.platformPostId ?? null, extra.postUrl ?? null],
      );
    } catch (err) {
      if (!this.executionMirrorWarned) {
        this.executionMirrorWarned = true;
        console.warn(
          '[aidcp-cloud] publish_execution_state 影子双写失败（主路径不受影响，只告警一次）:',
          (err as Error).message,
        );
      }
    }
  }

  /** 写入一条发布记录，返回新行 id。 */
  async insert(record: PublishRecord): Promise<number> {
    // 多图双写：images 存全部成功配图（下发段读回逐张上传）；image_url 存封面 = imageUrls[0]（审计/向后兼容）。
    const images = record.imageUrls ?? (record.imageUrl ? [record.imageUrl] : []);
    const coverUrl = record.imageUrl ?? images[0] ?? null;
    const { rows } = await this.pool.query<{ id: number }>(
      `INSERT INTO publish_log (title, content, source_concepts, source_liked_ids, status, platform_post_id, image_url, images, images_attached, account_id, platform, source_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       RETURNING id`,
      [
        record.title,
        record.content,
        record.sourceConcepts,
        record.sourceLikedIds,
        record.status,
        record.platformPostId ?? null,
        coverUrl,
        images,
        // 插入时配图尚未上传，权威信号默认 false；上传成功后由 markImagesAttached 置真实附着数。
        record.imagesAttached ?? false,
        // 发布账号：来自触发上下文；缺省回落 'default'（单账号向后兼容），让发布历史可真正按账号区分。
        record.accountId ?? 'default',
        record.platform ?? 'xiaohongshu',
        record.sourceReference ? JSON.stringify(record.sourceReference) : null,
      ],
    );
    const newId = rows[0].id;
    // 执行态双写：草稿入库即在影子里落一行（record_id + 初始 status），后续状态迁移各自 upsert。fail-safe。
    await this.mirrorExecutionState(newId, record.status, { platformPostId: record.platformPostId ?? null });
    return newId;
  }

  /**
   * 配图收口：标记该帖真实附着张数 K（边缘成功上传条数）。
   * 多图部分成功：K≥1 即有效帖；images_attached = K>0 派生保留（向后兼容旧读者）。
   * 杜绝「要 N 张实成 K 张被读成 N 张」——落真实 K，不落请求数。
   */
  async markImagesAttached(id: number, count: number): Promise<void> {
    const k = Math.max(0, Math.floor(count));
    await this.pool.query('UPDATE publish_log SET images_attached_count = $2, images_attached = ($2 > 0) WHERE id = $1', [id, k]);
  }

  /** 更新一条记录的状态。 */
  async updateStatus(id: number, status: PublishStatus): Promise<void> {
    await this.pool.query('UPDATE publish_log SET status = $2 WHERE id = $1', [id, status]);
    // 执行态双写（谓词语义保持不变——此处仍是 publish_log 原有的无谓词盲写，MUST NOT 在本 change 顺手改它）。
    await this.mirrorExecutionState(id, status);
  }

  /** 人工驳回：只允许 pending_approval 翻到 needs_review，避免旧卡误伤已发布记录。 */
  async rejectPendingApproval(id: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE publish_log
          SET status = 'needs_review',
              publish_metadata = jsonb_set(
                COALESCE(publish_metadata, '{}'::jsonb),
                '{approvalDecision}',
                jsonb_build_object('kind', 'user_rejected', 'decidedAt', $2::bigint),
                true
              )
        WHERE id = $1 AND status = 'pending_approval'`,
      [id, this.clock()],
    );
    const rejected = (result.rowCount ?? 0) > 0;
    // 执行态双写：只有 pending_approval→needs_review 真发生（权威写命中）才 mirror。
    if (rejected) await this.mirrorExecutionState(id, 'needs_review');
    return rejected;
  }

  /**
   * 发布成功后回填平台帖子 id（并置为 published）；可选回写带 xsec_token 的完整详情页分享 URL。
   * postUrl 缺省/为 null 时不覆盖既有值（边缘抓不到 URL 时诚实置空，绝不写假链接）。
   */
  async updatePostId(id: number, postId: string, postUrl?: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE publish_log SET platform_post_id = $2, post_url = COALESCE($3, post_url), status = 'published' WHERE id = $1`,
      [id, postId, postUrl ?? null],
    );
    // 执行态双写：已发布 + 回填帖子 id / URL（postUrl 为空则不覆盖影子里既有的 URL，与主写的 COALESCE 同口径）。
    await this.mirrorExecutionState(id, 'published', { platformPostId: postId, postUrl: postUrl ?? null });
  }

  /** 平台已接受原生定时任务；内部句柄单独落列，公开身份保持空，首次对账在目标时刻后 10 分钟。 */
  async markScheduled(id: number, scheduledAt: number, scheduledPlatformId?: string | null): Promise<void> {
    const result = await this.pool.query(
      `UPDATE publish_log
          SET status = 'scheduled', scheduled_at = to_timestamp($2 / 1000.0),
              scheduled_platform_id = $3, schedule_reconcile_attempts = 0,
              schedule_next_reconcile_at = to_timestamp(($2 + $4) / 1000.0), schedule_last_error = NULL
        WHERE id = $1 AND status = 'pending_approval'`,
      [id, scheduledAt, scheduledPlatformId ?? null, 10 * 60_000],
    );
    if ((result.rowCount ?? 0) === 0) throw new Error('scheduled_state_conflict');
    // 执行态双写：只有权威写真发生（未抛冲突）才 mirror。
    await this.mirrorExecutionState(id, 'scheduled');
  }

  /** 到期扫描只命中 scheduled 的索引行；旧/其它状态绝不被对账任务误领。 */
  async listDueScheduled(limit = 20, now = this.clock()): Promise<ScheduledPublishRecord[]> {
    const { rows } = await this.pool.query<{
      id: number;
      account_id: string | null;
      title: string | null;
      scheduled_at_ms: string;
      scheduled_platform_id: string | null;
      schedule_reconcile_attempts: number | string | null;
    }>(
      `SELECT id, account_id, title, extract(epoch from scheduled_at) * 1000 AS scheduled_at_ms,
              scheduled_platform_id, schedule_reconcile_attempts
         FROM publish_log
        WHERE status = 'scheduled'
          AND schedule_next_reconcile_at IS NOT NULL
          AND schedule_next_reconcile_at <= to_timestamp($1 / 1000.0)
        ORDER BY schedule_next_reconcile_at ASC, id ASC
        LIMIT $2`,
      [now, Math.max(1, Math.floor(limit))],
    );
    return rows.map((row) => ({
      recordId: row.id,
      accountId: row.account_id ?? 'default',
      title: row.title ?? '',
      scheduledAt: Number(row.scheduled_at_ms),
      scheduledPlatformId: row.scheduled_platform_id,
      reconcileAttempts: Number(row.schedule_reconcile_attempts ?? 0),
    }));
  }

  /**
   * 客户端审批快捷排期的账号级占用真态。
   * 只认平台已接受后落成的 scheduled 行；查询窗口由 Cloud 时钟固定，调用方不能扩窗探测历史。
   */
  async listOccupiedScheduledTimesForAccount(accountId: string): Promise<number[]> {
    const now = this.clock();
    const { rows } = await this.pool.query<{ scheduled_at_ms: string }>(
      `SELECT extract(epoch from scheduled_at) * 1000 AS scheduled_at_ms
         FROM publish_log
        WHERE account_id = $1
          AND platform = 'xiaohongshu'
          AND status = 'scheduled'
          AND scheduled_at >= to_timestamp($2 / 1000.0)
          AND scheduled_at <= to_timestamp($3 / 1000.0)
        ORDER BY scheduled_at ASC, id ASC`,
      [accountId, now, now + CLIENT_SCHEDULE_WINDOW_MS],
    );
    return rows.map((row) => Number(row.scheduled_at_ms)).filter(Number.isFinite);
  }

  /** 未确认公开：原子递增尝试并安排下次；达到 maxAttempts 后转人工复核。 */
  async deferScheduledReconcile(
    id: number,
    error: string,
    nextAt: number,
    maxAttempts = 8,
  ): Promise<ScheduledReconcileUpdate | null> {
    const { rows } = await this.pool.query<{ status: 'scheduled' | 'needs_review'; schedule_reconcile_attempts: number | string }>(
      `UPDATE publish_log
          SET schedule_reconcile_attempts = schedule_reconcile_attempts + 1,
              schedule_last_error = $2,
              schedule_next_reconcile_at = CASE
                WHEN schedule_reconcile_attempts + 1 >= $4 THEN NULL
                ELSE to_timestamp($3 / 1000.0)
              END,
              status = CASE
                WHEN schedule_reconcile_attempts + 1 >= $4 THEN 'needs_review'
                ELSE 'scheduled'
              END
        WHERE id = $1 AND status = 'scheduled'
      RETURNING status, schedule_reconcile_attempts`,
      [id, error.slice(0, 1000), nextAt, Math.max(1, Math.floor(maxAttempts))],
    );
    const row = rows[0];
    if (!row) return null;
    // 执行态双写：只有权威 UPDATE 命中（status 仍为 scheduled）才有返回行，据此 mirror 迁移后的真态。
    await this.mirrorExecutionState(id, row.status);
    return { status: row.status, attempts: Number(row.schedule_reconcile_attempts) };
  }

  /**
   * 公开确认的唯一状态闸。只有首次 scheduled→published 返回 true；调用者据此恰记一次发布风险账。
   */
  async confirmScheduledPublished(id: number, postId: string, postUrl: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE publish_log
          SET platform_post_id = $2, post_url = $3, status = 'published', schedule_next_reconcile_at = NULL,
              schedule_last_error = NULL
        WHERE id = $1 AND status = 'scheduled'`,
      [id, postId, postUrl],
    );
    const firstConfirmation = (result.rowCount ?? 0) > 0;
    // 执行态双写：只有首次 scheduled→published（权威写命中）才 mirror，避免对已发布记录重复投影。
    if (firstConfirmation) await this.mirrorExecutionState(id, 'published', { platformPostId: postId, postUrl });
    return firstConfirmation;
  }

  /** 落库发帖元数据（A 阶段4 血缘/可观测）+ 防篡改审计标记。 */
  async recordMetadata(id: number, metadata: unknown, aiEnforced: boolean): Promise<void> {
    await this.pool.query('UPDATE publish_log SET publish_metadata = $2, ai_enforced = $3 WHERE id = $1', [
      id,
      JSON.stringify(metadata),
      aiEnforced,
    ]);
  }

  /** 最近一次已发生发布的时间戳（毫秒）；submitted 也计入，防止确认缺链接时过早再发。 */
  async getMostRecentPublishTime(): Promise<number | null> {
    const { rows } = await this.pool.query<{ ts: string | null }>(
      `SELECT extract(epoch from max(published_at)) * 1000 AS ts FROM publish_log WHERE status IN ('submitted', 'published')`,
    );
    const ts = rows[0]?.ts;
    return ts == null ? null : Number(ts);
  }

  /** 列出所有待审草稿 id（change decouple-publish-generation-from-dispatch）：供下发段兜底扫描补触发。 */
  async listPendingApprovalIds(executionTarget?: DeploymentTarget | null): Promise<number[]> {
    const targetClause =
      executionTarget === undefined
        ? ''
        : executionTarget === null
          ? `AND publish_metadata->'scheduleExecution' IS NULL`
          : `AND (
               publish_metadata->'scheduleExecution' IS NULL
               OR publish_metadata->'scheduleExecution'->>'executionTarget' = $1
             )`;
    const { rows } = await this.pool.query<{ id: number }>(
      `SELECT id
         FROM publish_log
        WHERE status = 'pending_approval'
          ${targetClause}
        ORDER BY id ASC`,
      executionTarget ? [executionTarget] : [],
    );
    return rows.map((r) => r.id);
  }

  /** 取最近 n 篇已发生发布的正文（submitted 也参与，避免确认缺链接时撞题重发）。 */
  async recentPublishedContents(limit = 3): Promise<string[]> {
    const { rows } = await this.pool.query<{ content: string }>(
      `SELECT content FROM publish_log WHERE status IN ('submitted', 'published')
       ORDER BY published_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.content);
  }

  /**
   * 读回一条草稿快照供下发段重建发布输入（change decouple-publish-generation-from-dispatch）。
   * 不限状态（下发段自行据 status 幂等去重）；不存在返回 null。MUST NOT 触发重生成——只读已落库的冻结草稿。
   */
  async loadForDispatch(recordId: number): Promise<DispatchDraft | null> {
    const { rows } = await this.pool.query<{
      id: number;
      account_id: string | null;
      platform: string | null;
      title: string | null;
      content: string;
      image_url: string | null;
      images: string[] | null;
      publish_metadata: unknown;
      status: string;
      content_version: number | string | null;
    }>(
      `SELECT id, account_id, platform, title, content, image_url, images, publish_metadata, status, content_version
       FROM publish_log WHERE id = $1`,
      [recordId],
    );
    const r = rows[0];
    if (!r) return null;
    // JSONB 列：pg 驱动通常已解析为对象；兼容字符串形态。解析失败诚实置 null（下发走保守默认、不崩）。
    const metadata = parsePublishMetadata(r.publish_metadata);
    // 多图读回：优先用 images 全集；旧行 images 为空但有 image_url 时回落单图（向后兼容零回归）。
    const imageUrls = (r.images ?? []).length > 0 ? r.images! : r.image_url ? [r.image_url] : [];
    return {
      recordId: r.id,
      accountId: r.account_id ?? 'default',
      platform: normalizePlatformId(r.platform),
      title: r.title,
      content: r.content,
      imageUrl: r.image_url ?? imageUrls[0] ?? null,
      imageUrls,
      metadata,
      status: toStatus(r.status),
      contentVersion: Number(r.content_version ?? 0),
    };
  }

  /**
   * 就地编辑一条待审正文草稿（edit-note-draft-before-publish）。单写、乐观 CAS、诚实非乐观。
   *
   * 红线：
   * - 仅 `pending_approval` 可编辑（非则 not_pending，绝不静默改写）；
   * - 乐观并发——`content_version` 必须等于调用方所见 expectedVersion，否则 version_conflict（无丢更新）；
   * - 标题仍在此一处 `clampTitle(≤18)`、拒空 → invalid_title（面板不写裸标题）；
   * - 可见范围校验非空且合法枚举（空→missing_visibility，未知→invalid_field），绝不落库无可见范围草稿；
   * - 元数据**深合并**：只拼 visibility/topics，compliance/permissions/mentions/location/collection/mode/publishTime
   *   等未改键逐字保留，绝不重算 aiEnforced 棘轮、绝不下调 AI 声明；
   * - FOR UPDATE 行锁 + 事务令「读版本→写」原子，成功 content_version+1、写 edited_by/edited_at、RETURNING 回读真态。
   *
   * 注：跨进程「授权在途（签名已存在）」的 already_decided 预闸由面板端点侧探测（拥有 requestId 格式与 /tmp 信号），
   * 本方法只管 DB 层单写；写时/下发两处版本闸是最终权威。
   */
  async editDraft(
    recordId: number,
    expectedVersion: number,
    patch: EditDraftPatch,
    editor: string,
    expectedAccountId?: string,
  ): Promise<EditDraftResult> {
    // ── 先做纯字段校验（红线：字形安全标题、可见范围枚举、类型），任一不过即诚实拒绝，不进事务 ──
    let newTitle: string | undefined;
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string' || patch.title.trim().length === 0) {
        return { ok: false, reason: 'invalid_title' };
      }
      newTitle = clampTitle(patch.title, 18);
    }
    if (patch.content !== undefined) {
      if (typeof patch.content !== 'string' || patch.content.trim().length === 0) {
        return { ok: false, reason: 'invalid_field' };
      }
    }
    let newVisibility: Visibility | undefined;
    if (patch.visibility !== undefined) {
      if (typeof patch.visibility !== 'string' || patch.visibility.length === 0) {
        return { ok: false, reason: 'missing_visibility' };
      }
      if (!VISIBILITY_VALUES.includes(patch.visibility as Visibility)) {
        return { ok: false, reason: 'invalid_field' };
      }
      newVisibility = patch.visibility as Visibility;
    }
    let newTopics: string[] | undefined;
    if (patch.topics !== undefined) {
      if (!Array.isArray(patch.topics) || !patch.topics.every((t) => typeof t === 'string')) {
        return { ok: false, reason: 'invalid_field' };
      }
      newTopics = patch.topics;
    }
    // images（pending-draft-image-delete）：此处只做类型预检（数组 + 全 string）；
    // 「只删不注入」的子集校验须在事务内对当前 images 比对（见下），不能在事务外做。
    if (patch.images !== undefined) {
      if (!Array.isArray(patch.images) || !patch.images.every((u) => typeof u === 'string')) {
        return { ok: false, reason: 'invalid_field' };
      }
    }
    let newPublishMode: PublishMode | undefined;
    if (patch.publishMode !== undefined) {
      if (patch.publishMode !== 'immediate' && patch.publishMode !== 'scheduled') {
        return { ok: false, reason: 'invalid_field' };
      }
      newPublishMode = patch.publishMode;
    }
    if (patch.publishTime !== undefined && patch.publishTime !== null
      && (typeof patch.publishTime !== 'number' || !Number.isFinite(patch.publishTime))) {
      return { ok: false, reason: 'invalid_field' };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sel = await client.query<{
        status: string;
        content_version: number | string;
        title: string | null;
        content: string;
        publish_metadata: unknown;
        image_url: string | null;
        images: string[] | null;
        platform: string | null;
      }>(
        `SELECT status, content_version, title, content, publish_metadata, image_url, images, platform
         FROM publish_log WHERE id = $1 AND ($2::text IS NULL OR account_id = $2) FOR UPDATE`,
        [recordId, expectedAccountId ?? null],
      );
      const row = sel.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      if (row.status !== 'pending_approval') {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_pending' };
      }
      if (Number(row.content_version) !== expectedVersion) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'version_conflict' };
      }

      // 深合并：只动 visibility/topics，其余键逐字保留。待审行本应有元数据（生成段 recordMetadata 落库）；
      // 万一为 null 又要改可见范围/话题，则无从保证非空可见范围 → 诚实拒 invalid_field（守硬必选致命闸）。
      let metadata = parsePublishMetadata(row.publish_metadata);
      if (newVisibility !== undefined || newTopics !== undefined || newPublishMode !== undefined || patch.publishTime !== undefined) {
        if (metadata == null) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'invalid_field' };
        }
        metadata = { ...metadata };
        if (newVisibility !== undefined) metadata.visibility = newVisibility;
        if (newTopics !== undefined) metadata.topics = newTopics;
        if (newPublishMode !== undefined || patch.publishTime !== undefined) {
          const mode = newPublishMode ?? metadata.mode;
          const publishTime = mode === 'scheduled'
            ? (patch.publishTime !== undefined ? patch.publishTime : metadata.publishTime)
            : null;
          if (validatePublishSchedule(normalizePlatformId(row.platform), mode, publishTime, this.clock())) {
            await client.query('ROLLBACK');
            return { ok: false, reason: 'invalid_field' };
          }
          metadata.mode = mode;
          metadata.publishTime = publishTime;
        }
      }

      // images 子集校验 + 保序过滤（pending-draft-image-delete）：只删不注入。
      // 提交列表每项 MUST 是当前配图成员，否则整块拒 invalid_field、绝不落库；
      // 落库列表恒为当前 images 的保序子序列（cover = 首项 ?? null），删空合法 = 纯文字帖。
      // 未带 images 补丁时逐字保留原 images / image_url（零回归）。
      let nextImages = row.images ?? [];
      let nextCover: string | null = row.image_url;
      if (patch.images !== undefined) {
        const currentImages = row.images ?? (row.image_url ? [row.image_url] : []);
        const currentSet = new Set(currentImages);
        for (const u of patch.images) {
          if (!currentSet.has(u)) {
            await client.query('ROLLBACK');
            return { ok: false, reason: 'invalid_field' };
          }
        }
        const keepSet = new Set(patch.images);
        nextImages = currentImages.filter((u) => keepSet.has(u));
        nextCover = nextImages[0] ?? null;
      }

      const nextVersion = Number(row.content_version) + 1;
      const upd = await client.query<{
        content_version: number | string;
        title: string | null;
        content: string;
        publish_metadata: unknown;
        image_url: string | null;
        images: string[] | null;
      }>(
        `UPDATE publish_log
         SET title = $2, content = $3, publish_metadata = $4::jsonb,
             content_version = $5, edited_by = $6, edited_at = now(),
             images = $8::text[], image_url = $9
         WHERE id = $1 AND status = 'pending_approval' AND content_version = $7
           AND ($10::text IS NULL OR account_id = $10)
         RETURNING content_version, title, content, publish_metadata, image_url, images`,
        [
          recordId,
          newTitle !== undefined ? newTitle : row.title,
          patch.content !== undefined ? patch.content : row.content,
          metadata != null ? JSON.stringify(metadata) : null,
          nextVersion,
          editor,
          expectedVersion,
          nextImages,
          nextCover,
          expectedAccountId ?? null,
        ],
      );
      if (upd.rowCount === 0) {
        // 理论不达（已持 FOR UPDATE 锁 + 前置版本校验）；兜底当版本冲突。
        await client.query('ROLLBACK');
        return { ok: false, reason: 'version_conflict' };
      }
      await client.query('COMMIT');
      const out = upd.rows[0];
      return {
        ok: true,
        contentVersion: Number(out.content_version),
        title: out.title,
        content: out.content,
        metadata: parsePublishMetadata(out.publish_metadata),
        images: out.images ?? [],
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* 连接已断则忽略 */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * AI 调整的最终单写：所有模型/图片调用先在事务外完成，只有完整结果才能到这里一次 CAS 落稿。
   * scope 与 selection 在锁内对当前版本复核，防止 worker/调用方把更宽补丁伪装成局部调整。
   */
  async refineDraft(
    recordId: number,
    accountId: string,
    expectedVersion: number,
    scope: 'whole' | 'body' | 'images' | 'selected_image' | 'selected_text',
    selection: RefineDraftSelection,
    patch: RefineDraftPatch,
    editor: string,
  ): Promise<RefineDraftResult> {
    const keys = Object.keys(patch).filter((key) => patch[key as keyof RefineDraftPatch] !== undefined);
    const allowed: Record<typeof scope, readonly string[]> = {
      whole: ['title', 'content', 'topics', 'images'],
      body: ['content'],
      images: ['images'],
      selected_image: ['images'],
      selected_text: ['content'],
    };
    if (keys.length === 0 || keys.some((key) => !allowed[scope].includes(key))) {
      return { ok: false, reason: 'invalid_scope' };
    }
    if (scope === 'whole' && !allowed.whole.every((key) => keys.includes(key))) {
      return { ok: false, reason: 'invalid_scope' };
    }
    let nextTitle = patch.title;
    if (nextTitle !== undefined) {
      if (typeof nextTitle !== 'string' || !nextTitle.trim()) return { ok: false, reason: 'invalid_title' };
      nextTitle = clampTitle(nextTitle, 18);
    }
    if (patch.content !== undefined && (typeof patch.content !== 'string' || !patch.content.trim())) {
      return { ok: false, reason: 'invalid_field' };
    }
    if (patch.topics !== undefined && (!Array.isArray(patch.topics) || !patch.topics.every((t) => typeof t === 'string'))) {
      return { ok: false, reason: 'invalid_field' };
    }
    if (patch.images !== undefined && (
      !Array.isArray(patch.images) || patch.images.length === 0 ||
      !patch.images.every((url) => typeof url === 'string' && url.trim().length > 0)
    )) {
      return { ok: false, reason: 'invalid_field' };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{
        status: string;
        content_version: number | string;
        title: string | null;
        content: string;
        publish_metadata: unknown;
        image_url: string | null;
        images: string[] | null;
      }>(
        `SELECT status, content_version, title, content, publish_metadata, image_url, images
           FROM publish_log
          WHERE id=$1 AND account_id=$2
          FOR UPDATE`,
        [recordId, accountId],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      if (row.status !== 'pending_approval') {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_pending' };
      }
      if (Number(row.content_version) !== expectedVersion) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'version_conflict' };
      }

      const currentImages = (row.images ?? []).length > 0 ? row.images! : row.image_url ? [row.image_url] : [];
      if (scope === 'selected_text') {
        if (!selection || !('start' in selection) || !Number.isInteger(selection.start) || !Number.isInteger(selection.end)
          || selection.start < 0 || selection.end <= selection.start || selection.end > row.content.length
          || row.content.slice(selection.start, selection.end) !== selection.text || patch.content === undefined
          || !patch.content.startsWith(row.content.slice(0, selection.start))
          || !patch.content.endsWith(row.content.slice(selection.end))) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'invalid_selection' };
        }
      }
      if (scope === 'selected_image') {
        if (!selection || !('imageUrl' in selection) || patch.images === undefined) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'invalid_selection' };
        }
        const matching = currentImages.reduce<number[]>((out, url, index) => {
          if (url === selection.imageUrl) out.push(index);
          return out;
        }, []);
        const selectedIndex = matching[0];
        if (matching.length !== 1 || patch.images.length !== currentImages.length || selectedIndex === undefined
          || patch.images[selectedIndex] === currentImages[selectedIndex]
          || patch.images.some((url, index) => index !== selectedIndex && url !== currentImages[index])) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'invalid_selection' };
        }
      }
      if ((scope === 'images' || scope === 'whole') && patch.images !== undefined) {
        const expectedCount = Math.max(1, currentImages.length);
        if (patch.images.length !== expectedCount) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'invalid_field' };
        }
      }

      let metadata = parsePublishMetadata(row.publish_metadata);
      if (patch.topics !== undefined) {
        if (metadata == null) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'invalid_field' };
        }
        metadata = { ...metadata, topics: patch.topics };
      }
      const nextImages = patch.images ?? currentImages;
      const nextVersion = Number(row.content_version) + 1;
      const updated = await client.query<{
        content_version: number | string;
        title: string | null;
        content: string;
        publish_metadata: unknown;
        images: string[] | null;
      }>(
        `UPDATE publish_log
            SET title=$3, content=$4, publish_metadata=$5::jsonb,
                images=$6::text[], image_url=$7, content_version=$8,
                edited_by=$9, edited_at=now()
          WHERE id=$1 AND account_id=$2 AND status='pending_approval' AND content_version=$10
          RETURNING content_version,title,content,publish_metadata,images`,
        [
          recordId,
          accountId,
          nextTitle !== undefined ? nextTitle : row.title,
          patch.content !== undefined ? patch.content : row.content,
          metadata == null ? null : JSON.stringify(metadata),
          nextImages,
          nextImages[0] ?? null,
          nextVersion,
          editor,
          expectedVersion,
        ],
      );
      if ((updated.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'version_conflict' };
      }
      await client.query('COMMIT');
      const out = updated.rows[0];
      return {
        ok: true,
        contentVersion: Number(out.content_version),
        title: out.title,
        content: out.content,
        metadata: parsePublishMetadata(out.publish_metadata),
        images: out.images ?? [],
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection already closed */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 该账号是否已有一份未推进终态的待审草稿（change decouple-publish-generation-from-dispatch）。
   * 用于生成段堆积保护：已有 pending_approval 草稿时不再为该账号生成新草稿。
   */
  async hasPendingApprovalForAccount(accountId: string): Promise<boolean> {
    return (await this.countPendingForAccount(accountId)) > 0;
  }

  /**
   * 该账号在途待审草稿真实条数（change parallel-rewrite-drafts）。
   * 供账号在途帽判定（claim 同步段内以「在途 claim 数 + 本计数」之和对帽）；多候选并存世界布尔不够用。
   */
  async countPendingForAccount(accountId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM publish_log WHERE account_id = $1 AND status = 'pending_approval'`,
      [accountId],
    );
    return Number(rows[0]?.n ?? '0');
  }

  /**
   * 该账号在途待审草稿中**自主来源**（非参照洗稿）的真实条数（change parallel-rewrite-drafts）。
   * 供排期日上限原子判定 posted + pendingAutonomous >= cap：自主候选按真实条数计（防两张自动草稿都获批即超发），
   * 洗稿候选（source_reference 非空）是人工发起的候选、不占排期日上限（由账号在途帽独立兜量）。
   */
  async countPendingAutonomousForAccount(accountId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM publish_log
        WHERE account_id = $1 AND status = 'pending_approval' AND source_reference IS NULL`,
      [accountId],
    );
    return Number(rows[0]?.n ?? '0');
  }

  /**
   * 该账号已经真实形成的参照稿总数。
   * `source_reference` 只在参照内容已经写入 publish_log 时存在，因此排队中但尚未生成的委派任务不会被提前计数。
   *
   * 必须排除 `failed`：PublishExecutor 有两条**出生即 failed** 的路径同样写 source_reference——
   * M=0 全部生图失败（roles/publish-executor.ts «诚实 failed，不落待审、不发审批卡»）与合规/质量闸否决。
   * 这两类行从未成稿、客户从未见过，计入即把「没生成的稿」谎报成「已成稿」（静默假成功红线）。
   *
   * 已知保守偏差（宁可少报、绝不虚报）：先到 pending_approval 又被 PublishDispatcher 置 failed 的行
   * （下发失败/异常）确实「曾经成稿」，此处一并少计。当前 schema 无「是否到过待审」的列，
   * 无法在 SQL 层区分「出生即 failed」与「成稿后失败」；宁可少报也不虚报。
   */
  async countReferenceDraftsForAccount(accountId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM publish_log
        WHERE account_id = $1 AND source_reference IS NOT NULL AND status <> 'failed'`,
      [accountId],
    );
    return Number(rows[0]?.n ?? '0');
  }

  /**
   * 该账号今日（Asia/Shanghai 自然日 00:00 起）已发生发布数（change content-schedule-auto-publish）。
   * `submitted` 也计入，供内容排期日上限判定，防止链接暂缺时越过节流再发。
   * 显式 Asia/Shanghai 下界，对齐风控 day quota 与客户端 today 用量口径。
   */
  async countPublishedTodayForAccount(accountId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM publish_log
        WHERE account_id = $1 AND status IN ('submitted', 'published') AND published_at >= ${SHANGHAI_DAY_START_SQL}`,
      [accountId],
    );
    return Number(rows[0]?.n ?? '0');
  }

  async countPublishedSinceForAccount(accountId: string, since: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM publish_log
        WHERE account_id = $1 AND status IN ('submitted', 'published') AND published_at >= to_timestamp($2 / 1000.0)`,
      [accountId, since],
    );
    return Number(rows[0]?.n ?? '0');
  }

  /**
   * 陪伴界面数据回填（change edge-companion-ui 8.1）：某账号最近一次**成功发布**的摘要。
   * at = published_at 的 epoch 毫秒（该列在草稿 INSERT 时落、状态翻转不更新，为草稿入库时间近似——
   * 界面只做「上次发布 · N 前」粒度展示，可接受；绝不臆造真实发布时刻）。无记录返回 null。
   */
  async lastPublishedForAccount(accountId: string): Promise<{ title: string | null; at: number } | null> {
    const { rows } = await this.pool.query<{ title: string | null; ts: string | null }>(
      `SELECT title, extract(epoch from published_at) * 1000 AS ts FROM publish_log
        WHERE account_id = $1 AND status = 'published'
        ORDER BY published_at DESC, id DESC LIMIT 1`,
      [accountId],
    );
    const r = rows[0];
    if (!r || r.ts == null) return null;
    return { title: r.title ?? null, at: Number(r.ts) };
  }

  /**
   * 客户首页当前发布态：只取仍在途的最新记录，避免历史失败或已发布记录长期冒充“处理中”。
   * `published_at` 是既有记录创建时间，沿用 lastPublishedForAccount 的摘要时间口径。
   */
  async currentPublishForAccount(accountId: string): Promise<CurrentPublishRecord | null> {
    const { rows } = await this.pool.query<{
      id: number;
      title: string | null;
      status: CurrentPublishRecord['status'];
      ts: string | null;
    }>(
      `SELECT id, title, status, extract(epoch from published_at) * 1000 AS ts FROM publish_log
        WHERE account_id = $1 AND status IN ('pending_approval', 'scheduled', 'submitted')
        ORDER BY id DESC LIMIT 1`,
      [accountId],
    );
    const row = rows[0];
    if (!row || row.ts == null) return null;
    return { id: row.id, title: row.title ?? null, status: row.status, at: Number(row.ts) };
  }

  /**
   * 陪伴界面数据回填（change edge-companion-ui 8.1）：某账号最新一条待审草稿（发布卡 pending 态）。
   * 已拒草稿会被持久化为 needs_review，因此这里仅返回仍需 hello 回填的待审/已批在途记录。
   */
  async pendingApprovalForAccount(accountId: string): Promise<{ id: number; title: string | null } | null> {
    const { rows } = await this.pool.query<{ id: number; title: string | null }>(
      `SELECT id, title FROM publish_log
        WHERE account_id = $1 AND status = 'pending_approval'
        ORDER BY id DESC LIMIT 1`,
      [accountId],
    );
    const r = rows[0];
    return r ? { id: r.id, title: r.title ?? null } : null;
  }

  /** 陪伴客户端稿件预览：读取当前账号最新待审行的最终标题/正文/话题/配图与版本。 */
  async pendingPublishPreviewForAccount(accountId: string): Promise<PendingPublishPreview | null> {
    const { rows } = await this.pool.query<PendingPublishPreviewRow>(
      `SELECT id, account_id, platform, title, content, images, image_url, publish_metadata, content_version,
               edited_at, published_at, source_reference
       FROM publish_log
       WHERE account_id = $1 AND status = 'pending_approval'
       ORDER BY id DESC LIMIT 1`,
      [accountId],
    );
    return rows[0] ? toPendingPublishPreview(rows[0]) : null;
  }

  /** 按记录号读取待审预览，供后台编辑成功后即时刷新绑定客户端。 */
  async pendingPublishPreviewForRecord(recordId: number): Promise<PendingPublishPreview | null> {
    const { rows } = await this.pool.query<PendingPublishPreviewRow>(
      `SELECT id, account_id, platform, title, content, images, image_url, publish_metadata, content_version,
               edited_at, published_at, source_reference
       FROM publish_log
       WHERE id = $1 AND status = 'pending_approval'
       LIMIT 1`,
      [recordId],
    );
    return rows[0] ? toPendingPublishPreview(rows[0]) : null;
  }

  /** 客户端多稿审核：账号 + pending 状态在 SQL 内共同收口，列表与 total 使用同一筛选口径。 */
  async listPendingPublishPreviewsForAccount(
    accountId: string,
    options: { limit: number; offset: number },
  ): Promise<{ items: PendingPublishPreview[]; total: number }> {
    const [list, count] = await Promise.all([
      this.pool.query<PendingPublishPreviewRow>(
        `SELECT id, account_id, platform, title, content, images, image_url, publish_metadata, content_version,
                edited_at, published_at, source_reference
           FROM publish_log
          WHERE account_id = $1 AND status = 'pending_approval'
          ORDER BY id DESC LIMIT $2 OFFSET $3`,
        [accountId, options.limit, options.offset],
      ),
      this.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM publish_log
          WHERE account_id = $1 AND status = 'pending_approval'`,
        [accountId],
      ),
    ]);
    return {
      items: list.rows.map(toPendingPublishPreview),
      total: Number(count.rows[0]?.n ?? '0'),
    };
  }

  /** 客户端待审详情：跨账号、非 pending 与不存在共用 null，调用方不得泄漏其真实存在性。 */
  async pendingPublishPreviewForAccountRecord(
    accountId: string,
    recordId: number,
  ): Promise<PendingPublishPreview | null> {
    const { rows } = await this.pool.query<PendingPublishPreviewRow>(
      `SELECT id, account_id, platform, title, content, images, image_url, publish_metadata, content_version,
              edited_at, published_at, source_reference
         FROM publish_log
        WHERE id = $1 AND account_id = $2 AND status = 'pending_approval'
        LIMIT 1`,
      [recordId, accountId],
    );
    return rows[0] ? toPendingPublishPreview(rows[0]) : null;
  }

  /** 取最近一条发布记录（任意状态），用于计算距上次发布时长。 */
  async latest(): Promise<PublishRecord | null> {
    const { rows } = await this.pool.query<PublishRow>(
      `SELECT id, title, content, source_concepts, source_liked_ids, status, platform_post_id
       FROM publish_log ORDER BY published_at DESC LIMIT 1`,
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      content: r.content,
      sourceConcepts: r.source_concepts ?? [],
      sourceLikedIds: r.source_liked_ids ?? [],
      status: toStatus(r.status),
      platformPostId: r.platform_post_id,
    };
  }

  /** 关闭连接池。 */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** 发布记录的最小存储接口（便于单测打桩，不依赖真实 PG）。 */
export interface PublishLogSink {
  insert(record: PublishRecord): Promise<number>;
  updatePostId(id: number, postId: string, postUrl?: string | null): Promise<void>;
  updateStatus(id: number, status: PublishStatus): Promise<void>;
}
