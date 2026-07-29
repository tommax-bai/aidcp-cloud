import crypto from 'node:crypto';
import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import { RETIRED_ACCOUNT_ID } from '../kernel/account-identity.js';
import type { AccountPlatformReader } from '../kernel/platform-types.js';
import type { ObjectStore } from '../storage/object-store.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';
import {
  FACEBOOK_PUBLISH_MEDIA_ERROR_NAME,
  FACEBOOK_PUBLISH_MEDIA_STATUSES,
  facebookPublishMediaErrorCode,
  isFacebookPublishMediaError,
  isFacebookPublishMediaErrorReason,
} from '../kernel/facebook-publish-media-types.js';
import type {
  FacebookPublishImageInput,
  FacebookPublishImageSetView,
  FacebookPublishImageView,
  FacebookPublishMediaErrorReason,
  FacebookPublishMediaListView,
  FacebookPublishMediaStatus,
  FacebookPublishSetPatch,
  FacebookPublishUploadResult,
} from '../kernel/facebook-publish-media-types.js';

const { Pool } = pg;

export { FACEBOOK_PUBLISH_MEDIA_STATUSES };
export type {
  FacebookPublishImageInput,
  FacebookPublishImageSetView,
  FacebookPublishImageView,
  FacebookPublishMediaErrorReason,
  FacebookPublishMediaListView,
  FacebookPublishMediaStatus,
  FacebookPublishSetPatch,
  FacebookPublishUploadResult,
};

export class FacebookPublishMediaError extends Error {
  /** 线上 code，恒为 `facebook_publish_media_<reason>`（见 kernel 侧的 code 生成 / 还原一对函数）。 */
  readonly code: string;

  constructor(readonly reason: FacebookPublishMediaErrorReason, message?: string) {
    super(message ?? reason);
    // 跨进程识别键：MUST 是实例自有的可枚举属性。不赋值时 Error 子类的 name 继承为 'Error'，
    // JSON 序列化后面板层无从分辨，reason 会被兜底文案吞掉（见 kernel/facebook-publish-media-types.ts）。
    this.name = FACEBOOK_PUBLISH_MEDIA_ERROR_NAME;
    // name / reason 只活到「JSON 往返」为止。内部 HTTP 那一跳只搬 code + message，
    // 不带 code 的抛出物到对面一律被记成 handler_error —— 具名原因整片丢掉。
    this.code = facebookPublishMediaErrorCode(reason);
  }
}

export interface FacebookPublishMediaStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  /**
   * Block③ 拆库解耦：账号平台读端口（api 属主）。发媒体前的账号校验 MUST 经本接口向 api 域要、MUST NOT 直连 api 库。
   * 惰性 thunk；缺省则 assertFacebookAccount fail-closed（account_not_found）。
   */
  accountPlatformReader?: () => AccountPlatformReader | undefined;
  /** schema 保障能力注入端口（必填、无默认）：组合根传 automation 的 ensureCapabilitySchema，本文件只从 kernel 取类型。 */
  schemaEnsurer: SchemaEnsurer;
  objectStore?: ObjectStore;
  maxBytes?: number;
  clock?: () => number;
  idGen?: () => string;
}

export const FACEBOOK_PUBLISH_MEDIA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS account_facebook_publish_image_set (
  id                     BIGSERIAL PRIMARY KEY,
  -- 跨 owner 外键已降级（Block③ 物理拆库前置）：accounts 属 api，本表属 content，拆库后两者不同物理库，
  -- PostgreSQL 外键不能跨库 —— 带着它建表会在空的 content 库里当场失败（accounts 不存在），是硬阻断。
  -- 原约束的两个作用各有去处，**不是静默拿掉**：
  --   ① 插入期引用完整性：等价守卫在 assertFacebookAccount（本文件 :504，经 AccountPlatformReader 端口向 api
  --      域问平台，缺账号即 account_not_found fail-closed），且它挂在**每一个**公开入口上
  --      （list/upload/reorder/updateSet/deleteSet/reserveNext/availableCount）；唯一写 account_id 的语句
  --      在 uploadOne，只能由 uploadFiles 进入，而 uploadFiles 第一行就是该断言 → 违规插入构造不出来。
  --   ② ON DELETE CASCADE：全仓零 DELETE FROM accounts、account-store 不暴露任何删除入口 → 今天从不触发。
  --      账号删除若日后落地，级联由 src/transport/account-delete-cascade.ts 的 outbox 接管（见
  --      scripts/db-split/0076_downgrade_cross_owner_account_fk.sql 的「危险窗口」）。
  account_id             TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'available'
                         CHECK (status IN ('available','reserved','used','disabled','deleted','quarantine')),
  caption_hint           TEXT,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  reserved_by            TEXT,
  reserved_at            TIMESTAMPTZ,
  -- 跨 owner 外键已降级（同上理由：publish_log 属 api）。本列可空、纯审计（记「这组图被哪条发布记录用掉」）。
  -- 它今天挡不住任何东西：唯一写点是 markUsed(setId, publishLogId)，publishLogId 来自
  -- src/publish-agent/publish-dispatcher.ts:505 那条刚落库的 publish_log 记录 id（必然存在）；
  -- ON DELETE SET NULL 同样从不触发（publish_log 全仓零 DELETE）。此指针不参与任何鉴权/取数判定，
  -- 读侧只原样透出 id，拆库后即便悬空也无害，故不补读侧校验（YAGNI）。
  used_by_publish_log_id INTEGER,
  last_error             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_facebook_publish_image (
  id                    BIGSERIAL PRIMARY KEY,
  set_id                BIGINT NOT NULL REFERENCES account_facebook_publish_image_set(id) ON DELETE CASCADE,
  url                   TEXT NOT NULL,
  object_key            TEXT NOT NULL,
  filename              TEXT NOT NULL,
  content_type          TEXT NOT NULL,
  byte_size             INTEGER NOT NULL,
  sha256                TEXT NOT NULL,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  duplicate_of_image_id BIGINT REFERENCES account_facebook_publish_image(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS caption_hint TEXT;
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS reserved_by TEXT;
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;
-- 旧库补列路径，与上面同一条审计列；跨 owner 外键同样已降级（理由与上同，此处只补列、不补约束）。
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS used_by_publish_log_id INTEGER;
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE account_facebook_publish_image ADD COLUMN IF NOT EXISTS duplicate_of_image_id BIGINT REFERENCES account_facebook_publish_image(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_fb_publish_image_set_account_status_order
  ON account_facebook_publish_image_set (account_id, status, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_fb_publish_image_set_reserved
  ON account_facebook_publish_image_set (status, reserved_at);
CREATE INDEX IF NOT EXISTS idx_fb_publish_image_set_used_log
  ON account_facebook_publish_image_set (used_by_publish_log_id);
CREATE INDEX IF NOT EXISTS idx_fb_publish_image_set_account_sha
  ON account_facebook_publish_image (sha256);
`;

interface ImageSetRow {
  id: number | string;
  account_id: string;
  status: string;
  caption_hint: string | null;
  sort_order: number | string;
  reserved_by: string | null;
  reserved_at: Date | string | null;
  used_by_publish_log_id: number | string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ImageRow {
  id: number | string;
  set_id: number | string;
  url: string;
  object_key: string;
  filename: string;
  content_type: string;
  byte_size: number | string;
  sha256: string;
  sort_order: number | string;
  duplicate_of_image_id: number | string | null;
  created_at: Date | string;
}

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function toIso(v: Date | string | null): string | null {
  return v ? new Date(v).toISOString() : null;
}

function objectKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'unknown';
}

function normalizeFilename(value: string): string {
  const base = value.split(/[\\/]/).pop()?.trim() || 'image';
  return base.replace(/[^\w.\- ()]+/g, '_').slice(0, 160) || 'image';
}

function sniffStrictImage(bytes: Buffer, contentType?: string | null): { ext: string; contentType: string } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { ext: 'gif', contentType: 'image/gif' };
  }
  const header = contentType?.toLowerCase().split(';')[0].trim() ?? '';
  if (ACCEPTED_CONTENT_TYPES.has(header)) {
    if (header === 'image/jpeg') return { ext: 'jpg', contentType: header };
    if (header === 'image/png') return { ext: 'png', contentType: header };
    if (header === 'image/webp') return { ext: 'webp', contentType: header };
    if (header === 'image/gif') return { ext: 'gif', contentType: header };
  }
  return null;
}

function statusFromDb(status: string): FacebookPublishMediaStatus {
  return (FACEBOOK_PUBLISH_MEDIA_STATUSES as readonly string[]).includes(status)
    ? (status as FacebookPublishMediaStatus)
    : 'quarantine';
}

export class FacebookPublishMediaStore {
  private readonly pool: pg.Pool;
  private readonly objectStore?: ObjectStore;
  private readonly maxBytes: number;
  private readonly clock: () => number;
  private readonly idGen: () => string;

  private readonly schemaEnsurer: SchemaEnsurer;

  private readonly accountPlatformReader?: () => AccountPlatformReader | undefined;

  constructor(options: FacebookPublishMediaStoreOptions) {
    this.schemaEnsurer = options.schemaEnsurer;
    this.accountPlatformReader = options.accountPlatformReader;
    this.pool =
      options.pool ??
      new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
    this.objectStore = options.objectStore;
    this.maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES);
    this.clock = options.clock ?? Date.now;
    this.idGen = options.idGen ?? (() => crypto.randomBytes(8).toString('hex'));
  }

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'facebook_publish_media',
      sinceVersion: '0067_baseline_facebook_tables',
      ddl: [FACEBOOK_PUBLISH_MEDIA_SCHEMA_SQL],
    });
  }

  async listForAccount(accountId: string): Promise<FacebookPublishMediaListView> {
    await this.assertFacebookAccount(accountId);
    return this.listForAccountUnchecked(accountId);
  }

  async uploadFiles(accountId: string, files: FacebookPublishImageInput[]): Promise<{ results: FacebookPublishUploadResult[]; view: FacebookPublishMediaListView }> {
    await this.assertFacebookAccount(accountId);
    const results: FacebookPublishUploadResult[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        results.push(await this.uploadOne(accountId, file, i));
      } catch (err) {
        // 结构化识别、MUST NOT 用 instanceof：本类今天只在同进程内构造，但 uploadOne 的抛出物
        // 将来会经属主进程边界回来，那时 instanceof 恒 false、逐条原因全部塌成 invalid_file。
        // 未在枚举内的 reason 不硬塞回闭集合字段（跨进程取值不受本进程枚举约束）。
        const reason = isFacebookPublishMediaError(err) && isFacebookPublishMediaErrorReason(err.reason)
          ? err.reason
          : 'invalid_file';
        results.push({
          ok: false,
          filename: file?.filename ? normalizeFilename(file.filename) : `file-${i + 1}`,
          reason,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { results, view: await this.listForAccountUnchecked(accountId) };
  }

  async reorder(accountId: string, orderedSetIds: number[]): Promise<FacebookPublishMediaListView> {
    await this.assertFacebookAccount(accountId);
    if (!Array.isArray(orderedSetIds) || orderedSetIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      throw new FacebookPublishMediaError('invalid_value');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ id: number | string; status: string }>(
        `SELECT id, status FROM account_facebook_publish_image_set
          WHERE account_id = $1 AND status <> 'deleted' FOR UPDATE`,
        [accountId],
      );
      const currentIds = new Set(current.rows.map((r) => Number(r.id)));
      for (const id of orderedSetIds) {
        if (!currentIds.has(id)) throw new FacebookPublishMediaError('not_found');
      }
      const locked = current.rows.filter((r) => ['reserved', 'quarantine'].includes(r.status) && orderedSetIds.includes(Number(r.id)));
      if (locked.length > 0) throw new FacebookPublishMediaError('status_locked');
      for (let i = 0; i < orderedSetIds.length; i++) {
        await client.query(
          `UPDATE account_facebook_publish_image_set SET sort_order = $3, updated_at = now()
            WHERE account_id = $1 AND id = $2`,
          [accountId, orderedSetIds[i], i + 1],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return this.listForAccountUnchecked(accountId);
  }

  async updateSet(accountId: string, setId: number, patch: FacebookPublishSetPatch): Promise<FacebookPublishImageSetView | null> {
    await this.assertFacebookAccount(accountId);
    if (!Number.isInteger(setId) || setId <= 0) throw new FacebookPublishMediaError('invalid_value');
    const hasCaption = 'captionHint' in patch;
    const hasStatus = 'status' in patch;
    if (!hasCaption && !hasStatus) throw new FacebookPublishMediaError('invalid_value');
    if (hasStatus && !['available', 'disabled', 'deleted'].includes(String(patch.status))) {
      throw new FacebookPublishMediaError('invalid_value');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sel = await client.query<ImageSetRow>(
        `SELECT * FROM account_facebook_publish_image_set WHERE account_id = $1 AND id = $2 FOR UPDATE`,
        [accountId, setId],
      );
      const row = sel.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return null;
      }
      const current = statusFromDb(row.status);
      if (current === 'reserved' || current === 'used') {
        throw new FacebookPublishMediaError('status_locked');
      }
      const nextCaption = hasCaption ? normalizeCaption(patch.captionHint) : row.caption_hint;
      const nextStatus = hasStatus ? patch.status! : current;
      const upd = await client.query<ImageSetRow>(
        `UPDATE account_facebook_publish_image_set
          SET caption_hint = $3, status = $4, updated_at = now()
          WHERE account_id = $1 AND id = $2
          RETURNING *`,
        [accountId, setId, nextCaption, nextStatus],
      );
      await client.query('COMMIT');
      const hydrated = await this.hydrateSets(upd.rows);
      return hydrated[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteSet(accountId: string, setId: number): Promise<FacebookPublishImageSetView | null> {
    await this.assertFacebookAccount(accountId);
    if (!Number.isInteger(setId) || setId <= 0) throw new FacebookPublishMediaError('invalid_value');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sel = await client.query<ImageSetRow>(
        `SELECT * FROM account_facebook_publish_image_set WHERE account_id = $1 AND id = $2 FOR UPDATE`,
        [accountId, setId],
      );
      const row = sel.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return null;
      }
      const current = statusFromDb(row.status);
      if (current === 'reserved' || current === 'used') {
        throw new FacebookPublishMediaError('status_locked');
      }
      const upd = await client.query<ImageSetRow>(
        `UPDATE account_facebook_publish_image_set
          SET status = 'deleted', updated_at = now()
          WHERE account_id = $1 AND id = $2
          RETURNING *`,
        [accountId, setId],
      );
      await client.query('COMMIT');
      const hydrated = await this.hydrateSets(upd.rows);
      return hydrated[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async reserveNext(accountId: string, reservationId: string): Promise<FacebookPublishImageSetView | null> {
    await this.assertFacebookAccount(accountId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<ImageSetRow>(
        `SELECT * FROM account_facebook_publish_image_set
          WHERE account_id = $1 AND status = 'available'
          ORDER BY sort_order ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [accountId],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      const upd = await client.query<ImageSetRow>(
        `UPDATE account_facebook_publish_image_set
          SET status = 'reserved', reserved_by = $2, reserved_at = now(), updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [row.id, reservationId],
      );
      await client.query('COMMIT');
      const hydrated = await this.hydrateSets(upd.rows);
      return hydrated[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async releaseReservation(setId: number, reservationId?: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE account_facebook_publish_image_set
        SET status = 'available', reserved_by = NULL, reserved_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'reserved' AND ($2::text IS NULL OR reserved_by = $2)`,
      [setId, reservationId ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markUsed(setId: number, publishLogId: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE account_facebook_publish_image_set
        SET status = 'used', used_by_publish_log_id = $2, updated_at = now()
        WHERE id = $1 AND status IN ('reserved','available')`,
      [setId, publishLogId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async quarantine(setId: number, reason: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE account_facebook_publish_image_set
        SET status = 'quarantine', last_error = $2, updated_at = now()
        WHERE id = $1 AND status <> 'deleted'`,
      [setId, reason.slice(0, 500)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async availableCount(accountId: string): Promise<number> {
    await this.assertFacebookAccount(accountId);
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM account_facebook_publish_image_set
        WHERE account_id = $1 AND status = 'available'`,
      [accountId],
    );
    return Number(rows[0]?.n ?? '0');
  }

  private async assertFacebookAccount(accountId: string): Promise<void> {
    if (accountId === RETIRED_ACCOUNT_ID) throw new FacebookPublishMediaError('retired_account');
    // Block③ 拆库解耦：accounts 属 api，MUST NOT 直连它的库——经 api 域的账号平台读端口要（缺账号返 null）。
    const reader = this.accountPlatformReader?.();
    if (!reader) throw new FacebookPublishMediaError('account_not_found'); // 无读端口 = 无法核验 → fail-closed
    const platform = await reader.getPlatformOrNull(accountId);
    if (platform === null) throw new FacebookPublishMediaError('account_not_found');
    if (platform !== 'facebook') throw new FacebookPublishMediaError('non_facebook_account');
  }

  private validateFile(file: FacebookPublishImageInput): { filename: string; bytes: Buffer; sha256: string; ext: string; contentType: string; captionHint: string | null } {
    if (!file || !Buffer.isBuffer(file.bytes)) throw new FacebookPublishMediaError('invalid_file', 'missing bytes');
    if (file.bytes.length <= 0) throw new FacebookPublishMediaError('invalid_file', 'empty file');
    if (file.bytes.length > this.maxBytes) throw new FacebookPublishMediaError('body_too_large', `file exceeds ${this.maxBytes} bytes`);
    const sniffed = sniffStrictImage(file.bytes, file.contentType);
    if (!sniffed || !ACCEPTED_CONTENT_TYPES.has(sniffed.contentType)) {
      throw new FacebookPublishMediaError('invalid_file', 'unsupported image type');
    }
    return {
      filename: normalizeFilename(file.filename),
      bytes: file.bytes,
      sha256: crypto.createHash('sha256').update(file.bytes).digest('hex'),
      ext: sniffed.ext,
      contentType: sniffed.contentType,
      captionHint: normalizeCaption(file.captionHint),
    };
  }

  private async uploadOne(accountId: string, file: FacebookPublishImageInput, index: number): Promise<FacebookPublishUploadResult> {
    if (!this.objectStore) {
      return {
        ok: false,
        filename: file?.filename ? normalizeFilename(file.filename) : `file-${index + 1}`,
        reason: 'object_store_unavailable',
      };
    }
    const valid = this.validateFile(file);
    const accountPart = objectKeyPart(accountId);
    const ts = new Date(this.clock()).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const key = `facebook-publish-media/${accountPart}/${ts}/${String(index + 1).padStart(2, '0')}-${this.idGen()}.${valid.ext}`;
    const duplicate = await this.findDuplicate(accountId, valid.sha256);
    const { url } = await this.objectStore.put(key, valid.bytes, { contentType: valid.contentType });
    const sortOrder = await this.nextSortOrder(accountId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const set = await client.query<ImageSetRow>(
        `INSERT INTO account_facebook_publish_image_set (account_id, status, caption_hint, sort_order, updated_at)
          VALUES ($1, 'available', $2, $3, now())
          RETURNING *`,
        [accountId, valid.captionHint, sortOrder],
      );
      const setId = Number(set.rows[0].id);
      await client.query<ImageRow>(
        `INSERT INTO account_facebook_publish_image
          (set_id, url, object_key, filename, content_type, byte_size, sha256, sort_order, duplicate_of_image_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)
          RETURNING *`,
        [setId, url, key, valid.filename, valid.contentType, valid.bytes.length, valid.sha256, duplicate?.imageId ?? null],
      );
      await client.query('COMMIT');
      const hydrated = await this.getSetById(accountId, setId);
      if (!hydrated) throw new FacebookPublishMediaError('not_found');
      return { ok: true, filename: valid.filename, set: hydrated, duplicate: duplicate !== null };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async findDuplicate(accountId: string, sha256: string): Promise<{ imageId: number } | null> {
    const { rows } = await this.pool.query<{ id: number | string }>(
      `SELECT i.id
         FROM account_facebook_publish_image i
         JOIN account_facebook_publish_image_set s ON s.id = i.set_id
        WHERE s.account_id = $1 AND i.sha256 = $2 AND s.status <> 'deleted'
        ORDER BY i.id ASC LIMIT 1`,
      [accountId, sha256],
    );
    return rows[0] ? { imageId: Number(rows[0].id) } : null;
  }

  private async nextSortOrder(accountId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string | null }>(
      `SELECT coalesce(max(sort_order), 0)::text AS n FROM account_facebook_publish_image_set WHERE account_id = $1`,
      [accountId],
    );
    return Number(rows[0]?.n ?? '0') + 1;
  }

  private async getSetById(accountId: string, setId: number): Promise<FacebookPublishImageSetView | null> {
    const { rows } = await this.pool.query<ImageSetRow>(
      `SELECT * FROM account_facebook_publish_image_set WHERE account_id = $1 AND id = $2`,
      [accountId, setId],
    );
    const hydrated = await this.hydrateSets(rows);
    return hydrated[0] ?? null;
  }

  private async listForAccountUnchecked(accountId: string): Promise<FacebookPublishMediaListView> {
    const [setsResult, countsResult] = await Promise.all([
      this.pool.query<ImageSetRow>(
        `SELECT * FROM account_facebook_publish_image_set
          WHERE account_id = $1 AND status <> 'deleted'
          ORDER BY sort_order ASC, id ASC`,
        [accountId],
      ),
      this.pool.query<{ status: string; n: string }>(
        `SELECT status, count(*)::text AS n
           FROM account_facebook_publish_image_set
          WHERE account_id = $1
          GROUP BY status`,
        [accountId],
      ),
    ]);
    const statusCounts = Object.fromEntries(FACEBOOK_PUBLISH_MEDIA_STATUSES.map((s) => [s, 0])) as Record<FacebookPublishMediaStatus, number>;
    for (const r of countsResult.rows) statusCounts[statusFromDb(r.status)] = Number(r.n);
    return { accountId, sets: await this.hydrateSets(setsResult.rows), statusCounts };
  }

  private async hydrateSets(rows: ImageSetRow[]): Promise<FacebookPublishImageSetView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => Number(r.id));
    const images = await this.pool.query<ImageRow>(
      `SELECT * FROM account_facebook_publish_image
        WHERE set_id = ANY($1::bigint[])
        ORDER BY set_id ASC, sort_order ASC, id ASC`,
      [ids],
    );
    const bySet = new Map<number, FacebookPublishImageView[]>();
    for (const img of images.rows) {
      const setId = Number(img.set_id);
      const list = bySet.get(setId) ?? [];
      list.push({
        id: Number(img.id),
        setId,
        url: img.url,
        objectKey: img.object_key,
        filename: img.filename,
        contentType: img.content_type,
        byteSize: Number(img.byte_size),
        sha256: img.sha256,
        sortOrder: Number(img.sort_order),
        duplicateOfImageId: img.duplicate_of_image_id == null ? null : Number(img.duplicate_of_image_id),
        createdAt: toIso(img.created_at)!,
      });
      bySet.set(setId, list);
    }
    return rows.map((r) => ({
      id: Number(r.id),
      accountId: r.account_id,
      status: statusFromDb(r.status),
      captionHint: r.caption_hint ?? null,
      sortOrder: Number(r.sort_order),
      reservedBy: r.reserved_by ?? null,
      reservedAt: toIso(r.reserved_at),
      usedByPublishLogId: r.used_by_publish_log_id == null ? null : Number(r.used_by_publish_log_id),
      lastError: r.last_error ?? null,
      createdAt: toIso(r.created_at)!,
      updatedAt: toIso(r.updated_at)!,
      images: bySet.get(Number(r.id)) ?? [],
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function normalizeCaption(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}
