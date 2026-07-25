/**
 * 发布草稿 / 排期 / 稿件精修的**跨属主契约**（change cloud-coupling-phase4-runtime-ports）。
 *
 * 为什么在 kernel：发布日志存储归 api，而排期对账器 / 下发器（automation）与精修 worker（content）
 * 只为了拿几个记录形状与三五个方法形状就得跨属主 import 那个存储实现；反向地，客户端鉴权服务（api）
 * 也为了拿精修队列的作业形状而 import content 的精修存储。两条方向的边都由本文件承接。
 *
 * 三个端口是**恰好够用**的快照：逐字复刻消费方当下用的 `Pick<Store,…>`。将来消费方想多调一个方法
 * 必须先在这里加——这是设计意图（防止拆进程时把不该带走的能力顺手带走），不是端口坏了。
 */
import type { PlatformId } from './platform-types.js';
import type { PublishMetadata, PublishStatus } from './publish-pipeline-types.js';
import type { DeploymentTarget } from '../deployment-target.js';

/* ── 排期发布（实现在 api 的 PublishLogStore） ──────────────────────────── */

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

/** 排期对账器要的三个方法，一个不多。 */
export interface ScheduledPublishStore {
  listDueScheduled(limit?: number, now?: number): Promise<ScheduledPublishRecord[]>;
  deferScheduledReconcile(
    id: number,
    error: string,
    nextAt: number,
    maxAttempts?: number,
  ): Promise<ScheduledReconcileUpdate | null>;
  confirmScheduledPublished(id: number, postId: string, postUrl: string): Promise<boolean>;
}

/* ── 下发快照 ─────────────────────────────────────────────────────────── */

/**
 * 下发段从落库草稿重建发布所需的最小快照（change decouple-publish-generation-from-dispatch）。
 * 标题/正文/图取自 publish_log 列；话题与发帖元数据取自 publish_metadata JSONB。
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
  /** 发帖元数据；缺则 null。 */
  metadata: PublishMetadata | null;
  status: PublishStatus;
  /** 内容版本号：下发闸比对授权所载版本与此值，不一致则作废过期签名并留待审。 */
  contentVersion: number;
}

/* ── 草稿编辑 / 精修的结果形状 ────────────────────────────────────────── */

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

/* ── 稿件精修队列（作业形状实现在 content 的 DraftRefinementStore） ─────── */

export type DraftRefinementScope = 'whole' | 'body' | 'images' | 'selected_image' | 'selected_text';
export type DraftRefinementStatus = 'queued' | 'running' | 'completed' | 'failed';
export type DraftRefinementStage = '计划' | '判断' | '生成' | '检查' | '确认';

export type DraftRefinementSelection =
  | { imageUrl: string }
  | { start: number; end: number; text: string }
  | null;

export interface DraftRefinementProgress {
  seq: number;
  stage: DraftRefinementStage;
  status: 'running' | 'completed';
  summary: string;
  at: number;
}

export interface DraftRefinementJob {
  id: string;
  executionTarget: DeploymentTarget;
  accountId: string;
  recordId: number;
  expectedVersion: number;
  scope: DraftRefinementScope;
  instruction: string;
  selection: DraftRefinementSelection;
  status: DraftRefinementStatus;
  progress: DraftRefinementProgress[];
  claimToken: string | null;
  resultVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/** 精修 worker 从发布日志存储要的两个方法。 */
export interface DraftRefinementDrafts {
  loadForDispatch(recordId: number): Promise<DispatchDraft | null>;
  refineDraft(
    recordId: number,
    accountId: string,
    expectedVersion: number,
    scope: DraftRefinementScope,
    selection: RefineDraftSelection,
    patch: RefineDraftPatch,
    editor: string,
  ): Promise<RefineDraftResult>;
}

/** 客户端鉴权服务（api）从精修队列要的四个方法。 */
export interface DraftRefinementReadWritePort {
  create(input: {
    accountId: string;
    recordId: number;
    expectedVersion: number;
    scope: DraftRefinementScope;
    instruction: string;
    selection: DraftRefinementSelection;
  }): Promise<DraftRefinementJob>;
  getForAccount(accountId: string, recordId: number, jobId: string): Promise<DraftRefinementJob | null>;
  latestForAccountRecord(accountId: string, recordId: number): Promise<DraftRefinementJob | null>;
  latestForAccountRecords(accountId: string, recordIds: number[]): Promise<Map<number, DraftRefinementJob>>;
}
