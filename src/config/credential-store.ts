/**
 * 加密凭据存储（provider_credentials 表，PostgreSQL）。
 *
 * change console-model-provider-config：把模型厂商 API 密钥经 AES-256-GCM 加密后落库，
 * 主加密密钥来自 env `AIDCP_CRED_KEY`（base64 编码的 32 字节）。
 *
 * 安全红线：
 * - 明文密钥绝不落库、绝不进日志、绝不回前端；
 * - 主密钥绝不入库 / 入仓；缺失时写入被拒（诚实报因），绝不静默假成功、绝不明文落库；
 * - 落库密文 = base64(iv‖authTag‖ciphertext)，GCM authTag 防篡改。
 *
 * 建表幂等（CREATE TABLE IF NOT EXISTS），与 migrations/0007_model_config.sql 同源。
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import type { SchemaEnsurer } from '../kernel/schema-capability-contract.js';

const { Pool } = pg;

const IV_BYTES = 12; // GCM 推荐 96-bit nonce
const TAG_BYTES = 16;

export const PROVIDER_CREDENTIALS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider    TEXT NOT NULL,
  field       TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  masked_hint TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  PRIMARY KEY (provider, field)
);
`;

/** 主密钥缺失 / 非法时由 setSecret 抛出，面板层据此返回 503 cred_key_missing。 */
export class CredentialKeyMissingError extends Error {
  constructor() {
    super('cred_key_missing');
    this.name = 'CredentialKeyMissingError';
  }
}

/** 掩码：头4****尾4；过短则全掩。绝不暴露明文中段。 */
export function maskSecret(plaintext: string): string {
  const s = plaintext.trim();
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/** 解析主密钥（env AIDCP_CRED_KEY，base64 的 32 字节）；非法返回 null（= 不可编辑凭据）。 */
function loadMasterKey(raw: string | undefined): Buffer | null {
  if (!raw || !raw.trim()) return null;
  try {
    const key = Buffer.from(raw.trim(), 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export interface CredentialStoreOptions {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: pg.Pool;
  /** schema 保障能力注入端口（必填、无默认）：组合根传 automation 的 ensureCapabilitySchema，本文件只从 kernel 取类型。 */
  schemaEnsurer: SchemaEnsurer;
  /** 主加密密钥（默认读 env AIDCP_CRED_KEY）。 */
  masterKeyRaw?: string;
}

export interface StoredCredential {
  maskedHint: string;
}

export class CredentialStore {
  private readonly pool: pg.Pool;
  private readonly masterKey: Buffer | null;

  private readonly schemaEnsurer: SchemaEnsurer;

  constructor(options: CredentialStoreOptions) {
    this.schemaEnsurer = options.schemaEnsurer;
    this.pool =
      options.pool ??
      new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
    this.masterKey = loadMasterKey(options.masterKeyRaw ?? process.env.AIDCP_CRED_KEY);
  }

  async init(): Promise<void> {
    // DDL 单一所有者（change cloud-schema-migration-executor 任务 5.x）：只探测、不建表。
    // 探不到即带 version id 明确报错并 fail-closed；MUST NOT 在这里把表建出来继续跑。
    await this.schemaEnsurer(this.pool, {
      capability: 'provider_credentials',
      sinceVersion: '0007_model_config',
      ddl: [PROVIDER_CREDENTIALS_SCHEMA_SQL],
    });
  }

  /** 主密钥是否就位——决定凭据能否在后台编辑。 */
  canEdit(): boolean {
    return this.masterKey !== null;
  }

  private encrypt(plaintext: string): string {
    if (!this.masterKey) throw new CredentialKeyMissingError();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  private decrypt(blob: string): string {
    if (!this.masterKey) throw new CredentialKeyMissingError();
    const raw = Buffer.from(blob, 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  /** 读库内凭据的掩码提示（不解密、不回明文）；无则 null。 */
  async getStored(provider: string, field: string): Promise<StoredCredential | null> {
    const { rows } = await this.pool.query<{ masked_hint: string }>(
      `SELECT masked_hint FROM provider_credentials WHERE provider = $1 AND field = $2`,
      [provider, field],
    );
    return rows[0] ? { maskedHint: rows[0].masked_hint } : null;
  }

  /** 加密落库一个密钥；主密钥缺失抛 CredentialKeyMissingError（绝不明文落库）。返回掩码。 */
  async setSecret(
    provider: string,
    field: string,
    value: string,
    updatedBy: string,
  ): Promise<StoredCredential> {
    if (!this.canEdit()) throw new CredentialKeyMissingError();
    const ciphertext = this.encrypt(value);
    const maskedHint = maskSecret(value);
    await this.pool.query(
      `INSERT INTO provider_credentials (provider, field, ciphertext, masked_hint, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (provider, field)
       DO UPDATE SET ciphertext = EXCLUDED.ciphertext, masked_hint = EXCLUDED.masked_hint,
                     updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [provider, field, ciphertext, maskedHint, updatedBy],
    );
    return { maskedHint };
  }

  /** 运行时取明文（仅启动期注入客户端用）；无库内凭据或主密钥缺失返回 null。绝不日志化返回值。 */
  async getSecretForRuntime(provider: string, field: string): Promise<string | null> {
    if (!this.masterKey) return null;
    const { rows } = await this.pool.query<{ ciphertext: string }>(
      `SELECT ciphertext FROM provider_credentials WHERE provider = $1 AND field = $2`,
      [provider, field],
    );
    if (!rows[0]) return null;
    try {
      return this.decrypt(rows[0].ciphertext);
    } catch {
      return null; // 篡改/密钥不匹配：当作未配置，绝不崩
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
