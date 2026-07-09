/**
 * publish_log 持久化（PostgreSQL，aidcp 库）。
 *
 * 从 src/publish/publisher.ts 迁移而来，作为独立模块存在于 publish-agent/ 下。
 */

import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../cache/pg-anchor-cache.js';
import { SHANGHAI_DAY_START_SQL } from '../time/shanghai-day.js';
import type { PublishRecord, PublishStatus, PublishMetadata, Visibility } from './types.js';
import { clampTitle } from './title-clamp.js';

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
                   CHECK (status IN ('draft','pending_approval','published','failed','needs_review')),
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
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS post_url TEXT;
CREATE INDEX IF NOT EXISTS idx_publish_log_account ON publish_log (account_id);
-- decouple-publish-generation-from-dispatch：status 增加 'pending_approval'（生成候审段产物、待人审、未下发）。
-- 既有表的 CHECK 约束需放开新取值（幂等：先 DROP IF EXISTS 默认约束名再以新集合重建）。无新表/新列。
ALTER TABLE publish_log DROP CONSTRAINT IF EXISTS publish_log_status_check;
ALTER TABLE publish_log ADD CONSTRAINT publish_log_status_check
  CHECK (status IN ('draft','pending_approval','published','failed','needs_review'));
-- edit-note-draft-before-publish：待审草稿就地编辑的「审=发」凭证 + 谁/何时审计。
--   content_version：每行内容版本号（真列、非塞 JSONB，令版本闸是原子 WHERE 谓词）；既有行回填 0；每次成功编辑 +1。
--   edited_by / edited_at：最后一次编辑者（JWT 主体）与时间；仅「谁/何时」，非 diff 日志。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS content_version INT NOT NULL DEFAULT 0;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS edited_by TEXT;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
-- publish-reference-source-panel：参照洗稿来稿快照。普通发布为 NULL；内容页只读此快照，不 join 当前精选池。
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS source_reference JSONB;
`;

export interface PublishLogStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
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
  return s === 'published' || s === 'failed' || s === 'needs_review' || s === 'pending_approval' ? s : 'draft';
}

/**
 * 下发段从落库草稿重建发布所需的最小快照（change decouple-publish-generation-from-dispatch）。
 * 标题/正文/图取自 publish_log 列；话题与发帖元数据取自 publish_metadata JSONB（生成候审段经 recordMetadata 落库）。
 * 下发忠于此快照、绝不重生成（陈旧亦照发）。
 */
export interface DispatchDraft {
  recordId: number;
  accountId: string;
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

/** publish_log 持久化（PostgreSQL，aidcp 库）。 */
export class PublishLogStore {
  private readonly pool: pg.Pool;

  constructor(options: PublishLogStoreOptions = {}) {
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
    await this.pool.query(PUBLISH_SCHEMA_SQL);
  }

  /** 写入一条发布记录，返回新行 id。 */
  async insert(record: PublishRecord): Promise<number> {
    // 多图双写：images 存全部成功配图（下发段读回逐张上传）；image_url 存封面 = imageUrls[0]（审计/向后兼容）。
    const images = record.imageUrls ?? (record.imageUrl ? [record.imageUrl] : []);
    const coverUrl = record.imageUrl ?? images[0] ?? null;
    const { rows } = await this.pool.query<{ id: number }>(
      `INSERT INTO publish_log (title, content, source_concepts, source_liked_ids, status, platform_post_id, image_url, images, images_attached, account_id, source_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
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
        record.sourceReference ? JSON.stringify(record.sourceReference) : null,
      ],
    );
    return rows[0].id;
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
  }

  /** 人工驳回：只允许 pending_approval 翻到 needs_review，避免旧卡误伤已发布记录。 */
  async rejectPendingApproval(id: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE publish_log SET status = 'needs_review' WHERE id = $1 AND status = 'pending_approval'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
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
  }

  /** 落库发帖元数据（A 阶段4 血缘/可观测）+ 防篡改审计标记。 */
  async recordMetadata(id: number, metadata: unknown, aiEnforced: boolean): Promise<void> {
    await this.pool.query('UPDATE publish_log SET publish_metadata = $2, ai_enforced = $3 WHERE id = $1', [
      id,
      JSON.stringify(metadata),
      aiEnforced,
    ]);
  }

  /** 最近一次发布的时间戳（毫秒）；无记录返回 null。供 PublishScheduler 概念积累扳机基准。 */
  async getMostRecentPublishTime(): Promise<number | null> {
    const { rows } = await this.pool.query<{ ts: string | null }>(
      `SELECT extract(epoch from max(published_at)) * 1000 AS ts FROM publish_log WHERE status = 'published'`,
    );
    const ts = rows[0]?.ts;
    return ts == null ? null : Number(ts);
  }

  /** 列出所有待审草稿 id（change decouple-publish-generation-from-dispatch）：供下发段兜底扫描补触发。 */
  async listPendingApprovalIds(): Promise<number[]> {
    const { rows } = await this.pool.query<{ id: number }>(
      `SELECT id FROM publish_log WHERE status = 'pending_approval' ORDER BY id ASC`,
    );
    return rows.map((r) => r.id);
  }

  /** 取最近 n 篇已发布帖子的正文（供生成时避免重复话题）。 */
  async recentPublishedContents(limit = 3): Promise<string[]> {
    const { rows } = await this.pool.query<{ content: string }>(
      `SELECT content FROM publish_log WHERE status = 'published'
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
      title: string | null;
      content: string;
      image_url: string | null;
      images: string[] | null;
      publish_metadata: unknown;
      status: string;
      content_version: number | string | null;
    }>(
      `SELECT id, account_id, title, content, image_url, images, publish_metadata, status, content_version
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
      }>(
        `SELECT status, content_version, title, content, publish_metadata, image_url, images
         FROM publish_log WHERE id = $1 FOR UPDATE`,
        [recordId],
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
      if (newVisibility !== undefined || newTopics !== undefined) {
        if (metadata == null) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'invalid_field' };
        }
        metadata = { ...metadata };
        if (newVisibility !== undefined) metadata.visibility = newVisibility;
        if (newTopics !== undefined) metadata.topics = newTopics;
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
   * 该账号今日（Asia/Shanghai 自然日 00:00 起）已发布数（change content-schedule-auto-publish）。
   * 供内容排期日上限判定——**持久已发历史**（重启不清零），与在途 hasPendingApprovalForAccount 相加做原子上限、防 TOCTOU 超发。
   * 显式 Asia/Shanghai 下界，对齐风控 day quota 与客户端 today 用量口径。
   */
  async countPublishedTodayForAccount(accountId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM publish_log
        WHERE account_id = $1 AND status = 'published' AND published_at >= ${SHANGHAI_DAY_START_SQL}`,
      [accountId],
    );
    return Number(rows[0]?.n ?? '0');
  }

  async countPublishedSinceForAccount(accountId: string, since: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM publish_log
        WHERE account_id = $1 AND status = 'published' AND published_at >= to_timestamp($2 / 1000.0)`,
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
