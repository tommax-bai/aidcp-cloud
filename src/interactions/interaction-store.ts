import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { resolveEnvPgConfig } from '../cache/pg-config.js';
import {
  INTERACTION_PLATFORM,
  InteractionError,
  type InteractionAuthStatusPayload,
  type InteractionChannel,
  type InteractionErrorCode,
  type InteractionListItem,
  type InteractionOffboardResultPayload,
  type InteractionReplyReconcileResultPayload,
  type InteractionReplyResultPayload,
  type InteractionReplySendPayload,
  type InteractionSyncAckPayload,
  type InteractionSyncBatchPayload,
  type MessageView,
  type RateLimits,
  type ReplyJobState,
  type ReplyJobView,
  type RiskTag,
  type RuntimeControls,
  type ScopedJobContext,
  type SendAttemptView,
  type ThreadView,
} from './types.js';

const { Pool } = pg;

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface InteractionStoreOptions {
  pool?: pg.Pool;
  clock?: () => number;
  idGen?: (prefix: string) => string;
}

export interface IngestResult {
  ack: InteractionSyncAckPayload;
  newJobIds: string[];
}

export interface ListQuery {
  accountId: string;
  envKey: string;
  asOf: number;
  limit: number;
  channel?: InteractionChannel;
  state?: ReplyJobState;
  before?: { lastMessageAt: number; id: string };
}

export interface ListResult {
  items: InteractionListItem[];
  next: { lastMessageAt: number; id: string } | null;
}

export interface RecoverableJobRef {
  accountId: string;
  envKey: string;
  jobId: string;
  version: number;
}

export interface RecoverableAttemptRef {
  accountId: string;
  envKey: string;
  status: 'created' | 'dispatched' | 'ambiguous';
  command: InteractionReplySendPayload;
}

export interface PendingOffboardRef {
  offboardId: string;
  accountId: string;
  envKey: string;
  reason: 'environment_unbind' | 'customer_terminated' | 'admin_revoked';
  state: 'pending_edge' | 'dispatched';
  requestedAt: number;
  purgeDueAt: number;
}

export interface DetailResult {
  thread: ThreadView;
  messages: MessageView[];
  replyJob: ReplyJobView | null;
  sendAttempt: SendAttemptView | null;
  next: { platformCreatedAt: number; id: string } | null;
}

interface ThreadRow {
  id: string;
  platform: string;
  account_id: string;
  env_key: string;
  channel: InteractionChannel;
  external_thread_id: string;
  source_external_id: string | null;
  source_title: string | null;
  source_cover_url: string | null;
  participant_external_id: string | null;
  participant_name: string | null;
  participant_avatar_url: string | null;
  status: ThreadView['status'];
  last_message_at: Date | string;
  last_synced_at: Date | string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  direction: MessageView['direction'];
  external_message_id: string;
  external_parent_id: string | null;
  external_root_id: string | null;
  message_type: MessageView['messageType'];
  content_text: string | null;
  attachment_meta: MessageView['attachmentMeta'];
  lifecycle: MessageView['lifecycle'];
  platform_created_at: Date | string;
}

interface JobRow {
  id: string;
  inbound_message_id: string;
  state: ReplyJobState;
  version: number | string;
  matched_rule_id: string | null;
  config_version: number | string | null;
  template_id: string | null;
  template_version: number | string | null;
  rendered_text: string | null;
  polished_text: string | null;
  final_text: string | null;
  meaning_changed: boolean;
  introduced_claims: unknown;
  risk_level: ReplyJobView['riskLevel'];
  risk_reasons: unknown;
  approval_actor: string | null;
  approved_at: Date | string | null;
  idempotency_key: string | null;
  last_error_code: InteractionErrorCode | null;
  updated_at: Date | string;
}

interface AttemptRow {
  id: string;
  reply_job_id: string;
  attempt_no: number | string;
  idempotency_key: string;
  status: SendAttemptView['status'];
  verification_status: SendAttemptView['verificationStatus'];
  external_message_id: string | null;
  error_code: InteractionErrorCode | null;
  started_at: Date | string;
  finished_at: Date | string | null;
}

function epoch(value: Date | string | number): number {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime();
}

function jsonArray<T>(value: unknown, guard: (item: unknown) => item is T): T[] {
  const parsed = typeof value === 'string' ? safeJson(value) : value;
  return Array.isArray(parsed) ? parsed.filter(guard) : [];
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function isString(value: unknown): value is string { return typeof value === 'string'; }

function toThread(row: ThreadRow): ThreadView {
  return {
    id: row.id,
    platform: INTERACTION_PLATFORM,
    accountId: row.account_id,
    envKey: row.env_key,
    channel: row.channel,
    externalThreadId: row.external_thread_id,
    sourceExternalId: row.source_external_id,
    sourceTitle: row.source_title,
    sourceCoverUrl: row.source_cover_url,
    participant: row.participant_external_id
      ? { externalId: row.participant_external_id, displayName: row.participant_name, avatarUrl: row.participant_avatar_url }
      : null,
    status: row.status,
    lastMessageAt: epoch(row.last_message_at),
    lastSyncedAt: epoch(row.last_synced_at),
  };
}

function toMessage(row: MessageRow): MessageView {
  return {
    id: row.id,
    threadId: row.thread_id,
    direction: row.direction,
    externalMessageId: row.external_message_id,
    externalParentId: row.external_parent_id,
    externalRootId: row.external_root_id,
    messageType: row.message_type,
    contentText: row.content_text,
    attachmentMeta: row.attachment_meta,
    lifecycle: row.lifecycle,
    platformCreatedAt: epoch(row.platform_created_at),
  };
}

function toJob(row: JobRow): ScopedJobContext['job'] {
  return {
    id: row.id,
    inboundMessageId: row.inbound_message_id,
    state: row.state,
    version: Number(row.version),
    matchedRuleId: row.matched_rule_id,
    configVersion: row.config_version === null ? null : Number(row.config_version),
    template: {
      templateId: row.template_id,
      templateVersion: row.template_version === null ? null : Number(row.template_version),
    },
    renderedText: row.rendered_text,
    polishedText: row.polished_text,
    finalText: row.final_text,
    meaningChanged: row.meaning_changed,
    introducedClaims: jsonArray(row.introduced_claims, isString),
    riskLevel: row.risk_level,
    riskReasons: jsonArray(row.risk_reasons, isString) as RiskTag[],
    approvalActor: row.approval_actor,
    approvedAt: row.approved_at ? epoch(row.approved_at) : null,
    idempotencyKey: row.idempotency_key,
    lastErrorCode: row.last_error_code,
    updatedAt: epoch(row.updated_at),
  };
}

function toPublicJob(job: ScopedJobContext['job']): ReplyJobView {
  const { meaningChanged: _meaningChanged, introducedClaims: _introducedClaims, lastErrorCode: _lastErrorCode, ...view } = job;
  return view;
}

function toAttempt(row: AttemptRow): SendAttemptView {
  return {
    id: row.id,
    replyJobId: row.reply_job_id,
    attemptNo: Number(row.attempt_no),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    verificationStatus: row.verification_status,
    externalMessageId: row.external_message_id,
    errorCode: row.error_code,
    startedAt: epoch(row.started_at),
    finishedAt: row.finished_at ? epoch(row.finished_at) : null,
  };
}

const JOB_COLUMNS = `id, inbound_message_id, state, version, matched_rule_id, config_version,
  template_id, template_version, rendered_text, polished_text, final_text, meaning_changed,
  introduced_claims, risk_level, risk_reasons, approval_actor, approved_at, idempotency_key,
  last_error_code, updated_at`;

export class InteractionStore {
  private readonly pool: pg.Pool;
  private readonly clock: () => number;
  private readonly idGen: (prefix: string) => string;

  constructor(options: InteractionStoreOptions = {}) {
    this.pool = options.pool ?? new Pool(resolveEnvPgConfig());
    this.clock = options.clock ?? Date.now;
    this.idGen = options.idGen ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  /** Migrations own the schema. init fails locally and lets main disable only this feature. */
  async init(): Promise<void> {
    const { rows } = await this.pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.interaction_threads') IS NOT NULL
          AND to_regclass('public.interaction_reply_configs') IS NOT NULL
          AND to_regclass('public.interaction_offboards') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='interaction_send_attempts'
              AND column_name='reconciliation_state'
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='interaction_auth_state'
              AND column_name='runtime_controls_version'
          ) AS present`,
    );
    if (rows[0]?.present !== true) throw new Error('interaction_schema_missing_run_0042');
  }

  async upsertAuthStatus(payload: InteractionAuthStatusPayload): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Same lock as ClientUserStore.beginEnvironmentOffboard: first-auth and
      // customer unbind must observe one serial order for an environment.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`interaction-env:${payload.envKey}`]);
      await this.assertAccountScope(client, payload.accountId, payload.envKey, false);
      const offboard = await client.query<{ offboard_id: string; state: string }>(
        `SELECT offboard_id,state FROM interaction_offboards
          WHERE platform=$1 AND account_id=$2 AND env_key=$3 AND state <> 'purged' FOR SHARE`,
        [payload.platform, payload.accountId, payload.envKey],
      );
      if (offboard.rows[0]) {
        await client.query(
          `INSERT INTO interaction_offboard_audit
             (event_id,offboard_id,platform,account_id,env_key,event,status)
           VALUES ($1,$2,$3,$4,$5,'auth_status_ignored',$6)`,
          [this.idGen('audit'), offboard.rows[0].offboard_id, payload.platform, payload.accountId,
            payload.envKey, offboard.rows[0].state],
        );
        await client.query('COMMIT');
        return;
      }
      await client.query(
        `INSERT INTO interaction_auth_state
          (platform, account_id, env_key, status, browser_state, capabilities, identity, reason_code,
           runtime_controls_version, checked_at, active_since, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,to_timestamp($10/1000.0),
                 CASE WHEN $4='active' THEN to_timestamp($10/1000.0) ELSE NULL END,now())
         ON CONFLICT (platform, account_id) DO UPDATE SET
           env_key=EXCLUDED.env_key, status=EXCLUDED.status, browser_state=EXCLUDED.browser_state,
           capabilities=EXCLUDED.capabilities, identity=EXCLUDED.identity, reason_code=EXCLUDED.reason_code,
           runtime_controls_version=EXCLUDED.runtime_controls_version,
           checked_at=EXCLUDED.checked_at,
           active_since=CASE
             WHEN EXCLUDED.status <> 'active' THEN NULL
             WHEN interaction_auth_state.status <> 'active' THEN EXCLUDED.checked_at
             ELSE interaction_auth_state.active_since
           END, updated_at=now()`,
        [payload.platform, payload.accountId, payload.envKey, payload.status, payload.browserState,
          JSON.stringify(payload.capabilities), payload.identity ? JSON.stringify(payload.identity) : null,
          payload.reasonCode, payload.runtimeControlsVersion, payload.checkedAt],
      );
      await client.query(
        `INSERT INTO interaction_runtime_controls (platform, account_id, env_key, updated_by)
         VALUES ($1,$2,$3,'system')
         ON CONFLICT (platform, account_id) DO UPDATE SET env_key=EXCLUDED.env_key`,
        [payload.platform, payload.accountId, payload.envKey],
      );
      await this.audit(client, payload.accountId, payload.envKey, 'edge', 'auth_status_updated', null, 'auth', null, payload.status, {
        browserState: payload.browserState,
        reasonCode: payload.reasonCode,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async ingestBatch(payload: InteractionSyncBatchPayload): Promise<IngestResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `${payload.platform}|${payload.accountId}|${payload.batchId}`,
      ]);
      await this.assertAccountScope(client, payload.accountId, payload.envKey);
      const existing = await client.query<{
        env_key: string; channel: InteractionChannel; scope_external_id: string | null;
        cursor_after: string | null; persisted_threads: number; persisted_messages: number; received_at: Date;
      }>(
        `SELECT env_key, channel, scope_external_id, cursor_after, persisted_threads, persisted_messages, received_at
           FROM interaction_sync_batches
          WHERE platform=$1 AND account_id=$2 AND batch_id=$3`,
        [payload.platform, payload.accountId, payload.batchId],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (
          row.env_key !== payload.envKey || row.channel !== payload.channel ||
          row.scope_external_id !== payload.scopeExternalId || row.cursor_after !== payload.cursorAfter
        ) {
          throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '重复批次的 scope 或游标不一致。', 409);
        }
        await client.query('COMMIT');
        return {
          newJobIds: [],
          ack: {
            batchId: payload.batchId, envKey: payload.envKey, accountId: payload.accountId,
            platform: INTERACTION_PLATFORM, channel: payload.channel, scopeExternalId: payload.scopeExternalId,
            status: 'duplicate', cursorAfter: payload.cursorAfter,
            persisted: { threads: row.persisted_threads, messages: row.persisted_messages },
            errorCode: null, receivedAt: epoch(row.received_at),
          },
        };
      }

      const threadIds = new Map<string, string>();
      for (const thread of payload.threads) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO interaction_threads
            (id,platform,account_id,env_key,channel,external_thread_id,source_external_id,source_title,
             source_cover_url,participant_external_id,participant_name,participant_avatar_url,status,
             last_message_at,last_synced_at,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',to_timestamp($13/1000.0),now(),now(),now())
           ON CONFLICT (platform,account_id,channel,external_thread_id) DO UPDATE SET
             env_key=EXCLUDED.env_key,
             source_external_id=COALESCE(EXCLUDED.source_external_id,interaction_threads.source_external_id),
             source_title=COALESCE(EXCLUDED.source_title,interaction_threads.source_title),
             source_cover_url=COALESCE(EXCLUDED.source_cover_url,interaction_threads.source_cover_url),
             participant_external_id=COALESCE(EXCLUDED.participant_external_id,interaction_threads.participant_external_id),
             participant_name=COALESCE(EXCLUDED.participant_name,interaction_threads.participant_name),
             participant_avatar_url=COALESCE(EXCLUDED.participant_avatar_url,interaction_threads.participant_avatar_url),
             last_message_at=GREATEST(interaction_threads.last_message_at,EXCLUDED.last_message_at),
             last_synced_at=now(), updated_at=now()
           RETURNING id`,
          [this.idGen('thread'), payload.platform, payload.accountId, payload.envKey, payload.channel,
            thread.externalThreadId, thread.sourceExternalId, thread.sourceTitle, thread.sourceCoverUrl,
            thread.participant?.externalId ?? null, thread.participant?.displayName ?? null,
            thread.participant?.avatarUrl ?? null, thread.updatedAt],
        );
        threadIds.set(thread.externalThreadId, rows[0].id);
      }

      const newJobIds: string[] = [];
      for (const message of payload.messages) {
        const threadId = threadIds.get(message.externalThreadId);
        if (!threadId) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '消息引用了批次外线程。', 422);
        const { rows } = await client.query<{ id: string; inserted: boolean }>(
          `INSERT INTO interaction_messages
            (id,thread_id,platform,account_id,env_key,channel,direction,external_message_id,external_parent_id,
             external_root_id,message_type,content_text,attachment_meta,lifecycle,platform_created_at,
             raw_meta_sanitized,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,to_timestamp($15/1000.0),$16::jsonb,now(),now())
           ON CONFLICT (platform,account_id,channel,direction,external_message_id) DO UPDATE SET
             thread_id=EXCLUDED.thread_id, env_key=EXCLUDED.env_key,
             external_parent_id=COALESCE(EXCLUDED.external_parent_id,interaction_messages.external_parent_id),
             external_root_id=COALESCE(EXCLUDED.external_root_id,interaction_messages.external_root_id),
             message_type=EXCLUDED.message_type,
             content_text=CASE WHEN EXCLUDED.lifecycle='active'
               THEN COALESCE(EXCLUDED.content_text,interaction_messages.content_text) ELSE NULL END,
             attachment_meta=CASE WHEN EXCLUDED.lifecycle='active'
               THEN COALESCE(EXCLUDED.attachment_meta,interaction_messages.attachment_meta) ELSE NULL END,
             lifecycle=EXCLUDED.lifecycle, raw_meta_sanitized=EXCLUDED.raw_meta_sanitized, updated_at=now()
           RETURNING id,(xmax=0) AS inserted`,
          [this.idGen('msg'), threadId, payload.platform, payload.accountId, payload.envKey, payload.channel,
            message.direction, message.externalMessageId, message.externalParentId, message.externalRootId,
            message.messageType, message.contentText,
            message.attachmentMeta ? JSON.stringify(message.attachmentMeta) : null, message.lifecycle,
            message.platformCreatedAt, JSON.stringify(message.rawMetaSanitized)],
        );
        const dbMessage = rows[0];
        if (message.direction === 'inbound' && message.lifecycle === 'active') {
          const job = await client.query<{ id: string }>(
            `INSERT INTO interaction_reply_jobs
              (id,platform,account_id,env_key,channel,inbound_message_id,state,version,risk_level,risk_reasons,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,'new',0,'unknown','[]'::jsonb,now(),now())
             ON CONFLICT (inbound_message_id) DO NOTHING RETURNING id`,
            [this.idGen('job'), payload.platform, payload.accountId, payload.envKey, payload.channel, dbMessage.id],
          );
          if (job.rows[0]) newJobIds.push(job.rows[0].id);
          await client.query(
            `UPDATE interaction_threads SET status='waiting_review',
               last_message_at=GREATEST(last_message_at,to_timestamp($2/1000.0)),last_synced_at=now(),updated_at=now()
             WHERE id=$1 AND account_id=$3 AND env_key=$4`,
            [threadId, message.platformCreatedAt, payload.accountId, payload.envKey],
          );
        }
      }

      await client.query(
        `INSERT INTO interaction_sync_cursors
          (id,platform,account_id,env_key,channel,scope_external_id,cursor,last_success_at,last_batch_id,schema_version,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,1,now())
         ON CONFLICT (platform,account_id,channel,(COALESCE(scope_external_id,''))) DO UPDATE SET
           env_key=EXCLUDED.env_key,cursor=EXCLUDED.cursor,last_success_at=now(),last_batch_id=EXCLUDED.last_batch_id,updated_at=now()`,
        [this.idGen('cursor'), payload.platform, payload.accountId, payload.envKey, payload.channel,
          payload.scopeExternalId, payload.cursorAfter, payload.batchId],
      );
      const receivedAt = this.clock();
      await client.query(
        `INSERT INTO interaction_sync_batches
          (id,platform,account_id,env_key,batch_id,request_id,channel,scope_external_id,cursor_before,cursor_after,
           has_more,ack_status,persisted_threads,persisted_messages,observed_at,received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'accepted',$12,$13,to_timestamp($14/1000.0),to_timestamp($15/1000.0))`,
        [this.idGen('batch'), payload.platform, payload.accountId, payload.envKey, payload.batchId, payload.requestId,
          payload.channel, payload.scopeExternalId, payload.cursorBefore, payload.cursorAfter, payload.hasMore,
          payload.threads.length, payload.messages.length, payload.observedAt, receivedAt],
      );
      await this.audit(client, payload.accountId, payload.envKey, 'edge', 'sync_batch_accepted', null, 'batch', payload.batchId,
        'batch persisted', { channel: payload.channel, threads: payload.threads.length, messages: payload.messages.length });
      await client.query('COMMIT');
      return {
        newJobIds,
        ack: {
          batchId: payload.batchId, envKey: payload.envKey, accountId: payload.accountId,
          platform: INTERACTION_PLATFORM, channel: payload.channel, scopeExternalId: payload.scopeExternalId,
          status: 'accepted', cursorAfter: payload.cursorAfter,
          persisted: { threads: payload.threads.length, messages: payload.messages.length },
          errorCode: null, receivedAt,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertAccountScope(
    queryable: Queryable,
    accountId: string,
    envKey: string,
    requireBinding = true,
  ): Promise<void> {
    const account = await queryable.query<{ platform: string }>(
      `SELECT platform FROM accounts WHERE account_id=$1 FOR SHARE`, [accountId],
    );
    if (!account.rows[0]) throw new InteractionError('INTERACTION_NOT_FOUND', '账号不存在。', 404);
    if (account.rows[0].platform !== INTERACTION_PLATFORM) {
      throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '账号平台与互动请求不匹配。', 409);
    }
    const conflict = await queryable.query<{ account_id: string; env_key: string }>(
      `SELECT account_id,env_key FROM interaction_auth_state
        WHERE platform=$1 AND (account_id=$2 OR env_key=$3) FOR SHARE`,
      [INTERACTION_PLATFORM, accountId, envKey],
    );
    if (conflict.rows.some((row) => row.account_id !== accountId || row.env_key !== envKey)) {
      throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '环境与账号归属不匹配。', 409);
    }
    if (requireBinding && !conflict.rows.some((row) => row.account_id === accountId && row.env_key === envKey)) {
      throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '环境尚未绑定到该账号。', 409);
    }
  }

  async accountForEnv(envKey: string): Promise<{ accountId: string; envKey: string } | null> {
    const { rows } = await this.pool.query<{ account_id: string; env_key: string }>(
      `SELECT account_id,env_key FROM interaction_auth_state WHERE platform=$1 AND env_key=$2`,
      [INTERACTION_PLATFORM, envKey],
    );
    return rows[0] ? { accountId: rows[0].account_id, envKey: rows[0].env_key } : null;
  }

  async getAuth(accountId: string, envKey: string): Promise<InteractionAuthStatusPayload | null> {
    const { rows } = await this.pool.query<{
      status: InteractionAuthStatusPayload['status']; browser_state: InteractionAuthStatusPayload['browserState'];
      capabilities: InteractionAuthStatusPayload['capabilities']; identity: InteractionAuthStatusPayload['identity'];
      runtime_controls_version: number | null; checked_at: Date; reason_code: InteractionErrorCode | null;
    }>(
      `SELECT status,browser_state,capabilities,identity,runtime_controls_version,checked_at,reason_code
         FROM interaction_auth_state WHERE platform=$1 AND account_id=$2 AND env_key=$3`,
      [INTERACTION_PLATFORM, accountId, envKey],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      envKey, accountId, platform: INTERACTION_PLATFORM, status: row.status,
      browserState: row.browser_state, capabilities: row.capabilities, identity: row.identity,
      runtimeControlsVersion: row.runtime_controls_version === null ? null : Number(row.runtime_controls_version),
      checkedAt: epoch(row.checked_at), reasonCode: row.reason_code,
    };
  }

  async getSendAuthGate(accountId: string, envKey: string): Promise<{
    auth: InteractionAuthStatusPayload;
    activeSince: number | null;
  } | null> {
    const { rows } = await this.pool.query<{ active_since: Date | null }>(
      `SELECT active_since FROM interaction_auth_state
        WHERE platform=$1 AND account_id=$2 AND env_key=$3`,
      [INTERACTION_PLATFORM, accountId, envKey],
    );
    const auth = await this.getAuth(accountId, envKey);
    if (!auth || !rows[0]) return null;
    return { auth, activeSince: rows[0].active_since ? epoch(rows[0].active_since) : null };
  }

  async listInteractions(query: ListQuery): Promise<ListResult> {
    const params: unknown[] = [query.accountId, query.envKey, new Date(query.asOf), query.limit + 1];
    let where = `t.account_id=$1 AND t.env_key=$2 AND t.last_message_at <= $3`;
    if (query.channel) { params.push(query.channel); where += ` AND t.channel=$${params.length}`; }
    if (query.state) { params.push(query.state); where += ` AND j.state=$${params.length}`; }
    if (query.before) {
      params.push(new Date(query.before.lastMessageAt), query.before.id);
      where += ` AND (t.last_message_at,t.id) < ($${params.length - 1},$${params.length})`;
    }
    const { rows } = await this.pool.query<{
      thread_id: string; message_id: string; channel: InteractionChannel; participant_name: string | null;
      participant_avatar_url: string | null; content_text: string | null; source_title: string | null;
      last_message_at: Date; risk_level: ReplyJobView['riskLevel']; state: ReplyJobState; version: number;
    }>(
      `SELECT t.id AS thread_id,im.id AS message_id,t.channel,t.participant_name,t.participant_avatar_url,
              m.content_text,t.source_title,t.last_message_at,j.risk_level,j.state,j.version
         FROM interaction_threads t
         JOIN LATERAL (
           SELECT id,content_text FROM interaction_messages
            WHERE thread_id=t.id AND account_id=t.account_id AND env_key=t.env_key
            ORDER BY platform_created_at DESC,id DESC LIMIT 1
         ) m ON true
         JOIN LATERAL (
           SELECT id FROM interaction_messages
            WHERE thread_id=t.id AND account_id=t.account_id AND env_key=t.env_key AND direction='inbound'
            ORDER BY platform_created_at DESC,id DESC LIMIT 1
         ) im ON true
         JOIN interaction_reply_jobs j ON j.inbound_message_id=im.id AND j.account_id=t.account_id AND j.env_key=t.env_key
        WHERE ${where}
        ORDER BY t.last_message_at DESC,t.id DESC LIMIT $4`,
      params,
    );
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => ({
        threadId: row.thread_id, messageId: row.message_id, channel: row.channel,
        participantName: row.participant_name, participantAvatarUrl: row.participant_avatar_url,
        previewText: row.content_text, sourceTitle: row.source_title, lastMessageAt: epoch(row.last_message_at),
        unread: ['new', 'classifying', 'approval_required'].includes(row.state),
        riskLevel: row.risk_level, jobState: row.state, jobVersion: Number(row.version),
      })),
      next: rows.length > query.limit && page.length
        ? { lastMessageAt: epoch(page[page.length - 1].last_message_at), id: page[page.length - 1].thread_id }
        : null,
    };
  }

  async getDetail(
    accountId: string,
    envKey: string,
    threadId: string,
    limit: number,
    before?: { platformCreatedAt: number; id: string },
  ): Promise<DetailResult | null> {
    const threads = await this.pool.query<ThreadRow>(
      `SELECT * FROM interaction_threads WHERE id=$1 AND account_id=$2 AND env_key=$3`,
      [threadId, accountId, envKey],
    );
    if (!threads.rows[0]) return null;
    const params: unknown[] = [threadId, accountId, envKey, limit + 1];
    let beforeSql = '';
    if (before) {
      params.push(new Date(before.platformCreatedAt), before.id);
      beforeSql = ` AND (platform_created_at,id) < ($5,$6)`;
    }
    const messages = await this.pool.query<MessageRow>(
      `SELECT id,thread_id,direction,external_message_id,external_parent_id,external_root_id,message_type,
              content_text,attachment_meta,lifecycle,platform_created_at
         FROM interaction_messages WHERE thread_id=$1 AND account_id=$2 AND env_key=$3${beforeSql}
        ORDER BY platform_created_at DESC,id DESC LIMIT $4`,
      params,
    );
    const page = messages.rows.slice(0, limit);
    const latestInboundQuery = await this.pool.query<{ id: string }>(
      `SELECT id FROM interaction_messages
        WHERE thread_id=$1 AND account_id=$2 AND env_key=$3 AND direction='inbound'
        ORDER BY platform_created_at DESC,id DESC LIMIT 1`, [threadId, accountId, envKey],
    );
    const latestInbound = latestInboundQuery.rows[0];
    let replyJob: ReplyJobView | null = null;
    let sendAttempt: SendAttemptView | null = null;
    if (latestInbound) {
      const jobs = await this.pool.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM interaction_reply_jobs
          WHERE inbound_message_id=$1 AND account_id=$2 AND env_key=$3`,
        [latestInbound.id, accountId, envKey],
      );
      if (jobs.rows[0]) {
        replyJob = toPublicJob(toJob(jobs.rows[0]));
        const attempts = await this.pool.query<AttemptRow>(
          `SELECT id,reply_job_id,attempt_no,idempotency_key,status,verification_status,external_message_id,
                  error_code,started_at,finished_at
             FROM interaction_send_attempts WHERE reply_job_id=$1 AND account_id=$2 AND env_key=$3
            ORDER BY attempt_no DESC LIMIT 1`,
          [jobs.rows[0].id, accountId, envKey],
        );
        if (attempts.rows[0]) sendAttempt = toAttempt(attempts.rows[0]);
      }
    }
    return {
      thread: toThread(threads.rows[0]), messages: page.map(toMessage), replyJob, sendAttempt,
      next: messages.rows.length > limit && page.length
        ? { platformCreatedAt: epoch(page[page.length - 1].platform_created_at), id: page[page.length - 1].id }
        : null,
    };
  }

  async getJobContext(accountId: string, envKey: string, jobId: string): Promise<ScopedJobContext | null> {
    const { rows } = await this.pool.query<JobRow & MessageRow & ThreadRow>(
      `SELECT j.id,j.inbound_message_id,j.state,j.version,j.matched_rule_id,j.config_version,j.template_id,
              j.template_version,j.rendered_text,j.polished_text,j.final_text,j.meaning_changed,j.introduced_claims,
              j.risk_level,j.risk_reasons,j.approval_actor,j.approved_at,j.idempotency_key,j.last_error_code,j.updated_at,
              m.id AS m_id,m.thread_id,m.direction,m.external_message_id,m.external_parent_id,m.external_root_id,
              m.message_type,m.content_text,m.attachment_meta,m.lifecycle,m.platform_created_at,
              t.id AS t_id,t.platform,t.account_id,t.env_key,t.channel,t.external_thread_id,t.source_external_id,
              t.source_title,t.source_cover_url,t.participant_external_id,t.participant_name,t.participant_avatar_url,
              t.status AS t_status,t.last_message_at,t.last_synced_at
         FROM interaction_reply_jobs j
         JOIN interaction_messages m ON m.id=j.inbound_message_id AND m.account_id=j.account_id AND m.env_key=j.env_key
         JOIN interaction_threads t ON t.id=m.thread_id AND t.account_id=j.account_id AND t.env_key=j.env_key
        WHERE j.id=$1 AND j.account_id=$2 AND j.env_key=$3`,
      [jobId, accountId, envKey],
    );
    const row = rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) return null;
    const job = toJob(row as unknown as JobRow);
    const message = toMessage({
      id: row.m_id as string, thread_id: row.thread_id as string, direction: row.direction as MessageView['direction'],
      external_message_id: row.external_message_id as string, external_parent_id: row.external_parent_id as string | null,
      external_root_id: row.external_root_id as string | null, message_type: row.message_type as MessageView['messageType'],
      content_text: row.content_text as string | null, attachment_meta: row.attachment_meta as MessageView['attachmentMeta'],
      lifecycle: row.lifecycle as MessageView['lifecycle'], platform_created_at: row.platform_created_at as Date,
    });
    const thread = toThread({
      id: row.t_id as string, platform: row.platform as string, account_id: row.account_id as string,
      env_key: row.env_key as string, channel: row.channel as InteractionChannel,
      external_thread_id: row.external_thread_id as string, source_external_id: row.source_external_id as string | null,
      source_title: row.source_title as string | null, source_cover_url: row.source_cover_url as string | null,
      participant_external_id: row.participant_external_id as string | null,
      participant_name: row.participant_name as string | null, participant_avatar_url: row.participant_avatar_url as string | null,
      status: row.t_status as ThreadView['status'], last_message_at: row.last_message_at as Date,
      last_synced_at: row.last_synced_at as Date,
    });
    return { job, message, thread };
  }

  async transitionJob(input: {
    accountId: string; envKey: string; jobId: string; expectedVersion: number;
    from: ReplyJobState[]; to: ReplyJobState; actor: string;
    patch?: Partial<{
      matchedRuleId: string | null; configVersion: number | null; templateId: string | null;
      templateVersion: number | null; renderedText: string | null; polishedText: string | null;
      finalText: string | null; meaningChanged: boolean; introducedClaims: string[];
      riskLevel: ReplyJobView['riskLevel']; riskReasons: RiskTag[]; idempotencyKey: string | null;
      lastErrorCode: InteractionErrorCode | null;
    }>;
  }): Promise<ScopedJobContext['job']> {
    const set: string[] = [`state=$6`, `version=version+1`, `updated_at=now()`];
    const values: unknown[] = [input.jobId, input.accountId, input.envKey, input.expectedVersion, input.from, input.to];
    const map: Record<string, string> = {
      matchedRuleId: 'matched_rule_id', configVersion: 'config_version', templateId: 'template_id',
      templateVersion: 'template_version', renderedText: 'rendered_text', polishedText: 'polished_text',
      finalText: 'final_text', meaningChanged: 'meaning_changed', introducedClaims: 'introduced_claims',
      riskLevel: 'risk_level', riskReasons: 'risk_reasons', idempotencyKey: 'idempotency_key', lastErrorCode: 'last_error_code',
    };
    for (const [key, column] of Object.entries(map)) {
      if (input.patch && key in input.patch) {
        const raw = (input.patch as Record<string, unknown>)[key];
        const value = key === 'introducedClaims' || key === 'riskReasons' ? JSON.stringify(raw) : raw;
        values.push(value);
        set.push(`${column}=$${values.length}${key === 'introducedClaims' || key === 'riskReasons' ? '::jsonb' : ''}`);
      }
    }
    if (input.to === 'approved') {
      values.push(input.actor);
      set.push(`approval_actor=$${values.length}`, `approved_at=now()`);
    } else if (input.to === 'approval_required') {
      set.push(`approval_actor=NULL`, `approved_at=NULL`, `idempotency_key=NULL`);
    }
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE interaction_reply_jobs SET ${set.join(',')}
        WHERE id=$1 AND account_id=$2 AND env_key=$3 AND version=$4 AND state=ANY($5::text[])
          AND (expires_at IS NULL OR expires_at > now())
        RETURNING ${JOB_COLUMNS}`,
      values,
    );
    if (rows[0]) return toJob(rows[0]);
    throw await this.jobConflict(input.accountId, input.envKey, input.jobId, input.expectedVersion, input.from);
  }

  private async jobConflict(
    accountId: string, envKey: string, jobId: string, expectedVersion: number, from: ReplyJobState[],
  ): Promise<InteractionError> {
    const { rows } = await this.pool.query<{ version: number; state: ReplyJobState; expires_at: Date | null }>(
      `SELECT version,state,expires_at FROM interaction_reply_jobs WHERE id=$1 AND account_id=$2 AND env_key=$3`,
      [jobId, accountId, envKey],
    );
    const row = rows[0];
    if (!row) return new InteractionError('INTERACTION_NOT_FOUND', '回复任务不存在。', 404);
    if (Number(row.version) !== expectedVersion) {
      return new InteractionError('INTERACTION_VERSION_CONFLICT', '任务版本已变化，请刷新后重试。', 409, false, {
        currentVersion: Number(row.version), currentState: row.state,
      });
    }
    if (row.expires_at && row.expires_at.getTime() <= this.clock()) {
      return new InteractionError('INTERACTION_STATE_CONFLICT', '回复任务已过期。', 409, false, {
        currentVersion: Number(row.version), currentState: row.state,
        issues: [{ path: 'expiresAt', code: 'expired_job', message: '任务已过期，不能继续操作。' }],
      });
    }
    return new InteractionError('INTERACTION_STATE_CONFLICT', `任务状态不允许此操作（当前 ${row.state}）。`, 409, false, {
      currentVersion: Number(row.version), currentState: row.state,
      issues: [{ path: 'state', code: 'invalid_transition', message: `expected ${from.join('|')}` }],
    });
  }

  async transitionMessageJob(input: {
    accountId: string; envKey: string; messageId: string; expectedVersion: number;
    to: 'ignored' | 'escalated'; actor: string; reason?: string;
  }): Promise<ScopedJobContext['job']> {
    const jobs = await this.pool.query<{ id: string }>(
      `SELECT id FROM interaction_reply_jobs WHERE inbound_message_id=$1 AND account_id=$2 AND env_key=$3`,
      [input.messageId, input.accountId, input.envKey],
    );
    if (!jobs.rows[0]) throw new InteractionError('INTERACTION_NOT_FOUND', '入站消息或回复任务不存在。', 404);
    const job = await this.transitionJob({
      accountId: input.accountId, envKey: input.envKey, jobId: jobs.rows[0].id,
      expectedVersion: input.expectedVersion,
      from: ['new','classifying','draft_ready','approval_required','approved','failed'], to: input.to, actor: input.actor,
    });
    await this.pool.query(
      `UPDATE interaction_threads t SET status=$4,updated_at=now()
        FROM interaction_messages m WHERE m.id=$1 AND m.thread_id=t.id AND t.account_id=$2 AND t.env_key=$3`,
      [input.messageId, input.accountId, input.envKey, input.to === 'escalated' ? 'escalated' : 'closed'],
    );
    await this.audit(this.pool, input.accountId, input.envKey, input.actor, input.to, null, 'message', input.messageId,
      input.to, { reasonProvided: Boolean(input.reason?.trim()) });
    return job;
  }

  async createAttempt(input: {
    accountId: string; envKey: string; jobId: string; expectedVersion: number; idempotencyKey: string;
    rateLimits: RateLimits; now: number;
  }): Promise<{ job: ScopedJobContext['job']; attempt: SendAttemptView }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`interaction-send|${input.accountId}`]);
      const jobs = await client.query<JobRow & { channel: InteractionChannel; expires_at: Date | null }>(
        `SELECT ${JOB_COLUMNS},channel,expires_at FROM interaction_reply_jobs
          WHERE id=$1 AND account_id=$2 AND env_key=$3 FOR UPDATE`,
        [input.jobId, input.accountId, input.envKey],
      );
      const row = jobs.rows[0];
      if (!row) throw new InteractionError('INTERACTION_NOT_FOUND', '回复任务不存在。', 404);
      if (Number(row.version) !== input.expectedVersion) throw await this.jobConflict(input.accountId, input.envKey, input.jobId, input.expectedVersion, ['queued']);
      if (row.state !== 'queued') throw await this.jobConflict(input.accountId, input.envKey, input.jobId, input.expectedVersion, ['queued']);
      if (row.expires_at && row.expires_at.getTime() <= this.clock()) {
        throw await this.jobConflict(input.accountId, input.envKey, input.jobId, input.expectedVersion, ['queued']);
      }
      const activeAccount = await client.query<{ status: SendAttemptView['status'] }>(
        `SELECT status FROM interaction_send_attempts
          WHERE account_id=$1 AND status IN ('created','dispatched') LIMIT 1 FOR UPDATE`,
        [input.accountId],
      );
      if (activeAccount.rows[0]) {
        throw new InteractionError('INTERACTION_STATE_CONFLICT', '账号已有发送尝试在进行中。', 409);
      }
      const active = await client.query<{ status: string }>(
        `SELECT status FROM interaction_send_attempts WHERE reply_job_id=$1 AND status IN ('created','dispatched','ambiguous')`,
        [input.jobId],
      );
      if (active.rows[0]) {
        const code = active.rows[0].status === 'ambiguous' ? 'INTERACTION_SEND_AMBIGUOUS' : 'INTERACTION_STATE_CONFLICT';
        throw new InteractionError(code, active.rows[0].status === 'ambiguous' ? '发送结果待核验，禁止重复发送。' : '已有发送尝试在进行中。', 409);
      }
      const windows = await client.query<{
        minute: string; hour: string; day: string; last_thread_send_at: Date | null;
      }>(
        `SELECT
           count(*) FILTER (WHERE a.started_at >= to_timestamp($3/1000.0)-interval '1 minute') AS minute,
           count(*) FILTER (WHERE a.started_at >= to_timestamp($3/1000.0)-interval '1 hour') AS hour,
           count(*) FILTER (WHERE a.started_at >= to_timestamp($3/1000.0)-interval '1 day') AS day,
           max(a.started_at) FILTER (WHERE m.thread_id=target_message.thread_id
             AND a.status IN ('dispatched','confirmed','ambiguous')) AS last_thread_send_at
         FROM interaction_reply_jobs target
         JOIN interaction_messages target_message ON target_message.id=target.inbound_message_id
         LEFT JOIN interaction_send_attempts a ON a.account_id=target.account_id
           AND a.status IN ('created','dispatched','confirmed','ambiguous')
         LEFT JOIN interaction_reply_jobs j ON j.id=a.reply_job_id
         LEFT JOIN interaction_messages m ON m.id=j.inbound_message_id
        WHERE target.id=$1 AND target.account_id=$2
        GROUP BY target_message.thread_id`,
        [input.jobId, input.accountId, input.now],
      );
      const counts = windows.rows[0];
      const limits = input.rateLimits;
      if (!counts || limits.accountPerMinute <= 0 || Number(counts.minute) >= limits.accountPerMinute ||
          limits.accountPerHour <= 0 || Number(counts.hour) >= limits.accountPerHour ||
          limits.accountPerDay <= 0 || Number(counts.day) >= limits.accountPerDay ||
          (counts.last_thread_send_at !== null &&
            input.now - counts.last_thread_send_at.getTime() < limits.threadCooldownSeconds * 1_000)) {
        throw new InteractionError('INTERACTION_RATE_LIMITED', '账号回复限额或会话冷却不允许本次发送。', 429);
      }
      const next = await client.query<{ n: number }>(
        `SELECT COALESCE(max(attempt_no),0)+1 AS n FROM interaction_send_attempts WHERE reply_job_id=$1`, [input.jobId],
      );
      const attemptId = this.idGen('attempt');
      const attempts = await client.query<AttemptRow>(
        `INSERT INTO interaction_send_attempts
          (id,platform,account_id,env_key,channel,reply_job_id,attempt_no,idempotency_key,status,
           verification_status,started_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'created','not_needed',to_timestamp($9/1000.0))
         RETURNING id,reply_job_id,attempt_no,idempotency_key,status,verification_status,external_message_id,
                   error_code,started_at,finished_at`,
        [attemptId, INTERACTION_PLATFORM, input.accountId, input.envKey, row.channel, input.jobId,
          Number(next.rows[0].n), input.idempotencyKey, input.now],
      );
      const updated = await client.query<JobRow>(
        `UPDATE interaction_reply_jobs SET state='sending',version=version+1,idempotency_key=$4,updated_at=now()
          WHERE id=$1 AND account_id=$2 AND env_key=$3 AND state='queued'
          RETURNING ${JOB_COLUMNS}`,
        [input.jobId, input.accountId, input.envKey, input.idempotencyKey],
      );
      await client.query('COMMIT');
      return { job: toJob(updated.rows[0]), attempt: toAttempt(attempts.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') {
        throw new InteractionError('INTERACTION_STATE_CONFLICT', '已有发送尝试在进行中。', 409);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async markAttemptDispatched(accountId: string, envKey: string, attemptId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE interaction_send_attempts SET status='dispatched',dispatched_at=now()
        WHERE id=$1 AND account_id=$2 AND env_key=$3 AND status='created'`,
      [attemptId, accountId, envKey],
    );
    if (!rowCount) {
      const { rows } = await this.pool.query<{ status: SendAttemptView['status'] }>(
        `SELECT status FROM interaction_send_attempts WHERE id=$1 AND account_id=$2 AND env_key=$3`,
        [attemptId, accountId, envKey],
      );
      // Edge 可能在 pushToEdges 返回后、此 UPDATE 前立即回传权威结果。
      if (rows[0] && ['confirmed','failed','ambiguous'].includes(rows[0].status)) return;
      throw new InteractionError('INTERACTION_STATE_CONFLICT', '发送尝试无法进入 dispatched。', 409);
    }
  }

  async markDispatchFailed(accountId: string, envKey: string, attemptId: string, code: InteractionErrorCode): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ reply_job_id: string }>(
        `UPDATE interaction_send_attempts SET status='failed',verification_status='not_found',error_code=$4,
             error_category='internal_error',retryable=true,finished_at=now()
          WHERE id=$1 AND account_id=$2 AND env_key=$3 AND status='created' RETURNING reply_job_id`,
        [attemptId, accountId, envKey, code],
      );
      if (rows[0]) {
        await client.query(
          `UPDATE interaction_reply_jobs SET state='failed',version=version+1,last_error_code=$2,updated_at=now()
            WHERE id=$1 AND state='sending'`, [rows[0].reply_job_id, code],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  /** WS 下发抛错时无法证明命令未离开进程；保守进入 ambiguous，绝不按 failed 自动放开重投。 */
  async markDispatchAmbiguous(accountId: string, envKey: string, attemptId: string, code: InteractionErrorCode): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ reply_job_id: string }>(
        `UPDATE interaction_send_attempts SET status='ambiguous',verification_status='pending',error_code=$4,
             error_category='transient_network',retryable=false,finished_at=now()
          WHERE id=$1 AND account_id=$2 AND env_key=$3 AND status='created' RETURNING reply_job_id`,
        [attemptId, accountId, envKey, code],
      );
      if (rows[0]) {
        await client.query(
          `UPDATE interaction_reply_jobs SET state='ambiguous',version=version+1,last_error_code=$2,updated_at=now()
            WHERE id=$1 AND state='sending'`, [rows[0].reply_job_id, code],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async applyReplyResult(payload: InteractionReplyResultPayload): Promise<{ duplicate: boolean; confirmedNeedsRiskRecord: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const attempts = await client.query<{
        status: SendAttemptView['status']; reply_job_id: string; risk_recorded_at: Date | null;
      }>(
        `SELECT status,reply_job_id,risk_recorded_at FROM interaction_send_attempts
          WHERE id=$1 AND idempotency_key=$2 AND account_id=$3 AND env_key=$4 AND channel=$5 FOR UPDATE`,
        [payload.attemptId, payload.idempotencyKey, payload.accountId, payload.envKey, payload.channel],
      );
      const attempt = attempts.rows[0];
      if (!attempt) throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '回复结果与发送尝试不匹配。', 409);
      if (attempt.reply_job_id !== payload.jobId) {
        throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '回复结果与 job 不匹配。', 409);
      }
      const targetStatus = payload.status === 'confirmed' ? 'confirmed' : payload.status;
      if (attempt.status === targetStatus) {
        await client.query('COMMIT');
        return { duplicate: true, confirmedNeedsRiskRecord: payload.status === 'confirmed' && !attempt.risk_recorded_at };
      }
      const allowed = attempt.status === 'created' || attempt.status === 'dispatched' ||
        (attempt.status === 'ambiguous' && payload.status !== 'ambiguous');
      if (!allowed) throw new InteractionError('INTERACTION_STATE_CONFLICT', '回复结果不允许从当前 attempt 状态推进。', 409);
      const verification = payload.status === 'confirmed' ? 'confirmed' : payload.status === 'ambiguous' ? 'pending' :
        payload.verification === 'not_verified' ? 'not_found' : 'confirmed';
      await client.query(
        `UPDATE interaction_send_attempts SET status=$6,verification_status=$7,external_message_id=$8,
             error_category=$9,error_code=$10,retryable=$11,finished_at=to_timestamp($12/1000.0)
          WHERE id=$1 AND idempotency_key=$2 AND account_id=$3 AND env_key=$4 AND channel=$5`,
        [payload.attemptId, payload.idempotencyKey, payload.accountId, payload.envKey, payload.channel,
          targetStatus, verification, payload.externalMessageId, payload.errorCategory, payload.errorCode,
          payload.status === 'failed' && ['transient_network','rate_limited'].includes(payload.errorCategory ?? ''), payload.finishedAt],
      );
      const jobState: ReplyJobState = payload.status === 'confirmed' ? 'sent' : payload.status;
      const job = await client.query<{ id: string }>(
        `UPDATE interaction_reply_jobs SET state=$4,version=version+1,last_error_code=$5,updated_at=now()
          WHERE id=$1 AND account_id=$2 AND env_key=$3 AND state IN ('sending','ambiguous') RETURNING id`,
        [payload.jobId, payload.accountId, payload.envKey, jobState, payload.errorCode],
      );
      if (!job.rows[0] || job.rows[0].id !== attempt.reply_job_id) {
        throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '回复结果与 job 不匹配。', 409);
      }
      if (payload.status === 'confirmed') {
        await client.query(
          `UPDATE interaction_threads t SET status='replied',updated_at=now()
            FROM interaction_messages m,interaction_reply_jobs j
           WHERE j.id=$1 AND m.id=j.inbound_message_id AND t.id=m.thread_id`, [payload.jobId],
        );
      }
      await this.audit(client, payload.accountId, payload.envKey, 'edge', `reply_${payload.status}`, null,
        'attempt', payload.attemptId, payload.status, { channel: payload.channel, verification: payload.verification });
      await client.query('COMMIT');
      return { duplicate: false, confirmedNeedsRiskRecord: payload.status === 'confirmed' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async claimRiskRecord(attemptId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE interaction_send_attempts SET risk_recorded_at=now()
        WHERE id=$1 AND status='confirmed' AND risk_recorded_at IS NULL`, [attemptId],
    );
    return (rowCount ?? 0) === 1;
  }

  async releaseRiskRecordClaim(attemptId: string): Promise<void> {
    await this.pool.query(`UPDATE interaction_send_attempts SET risk_recorded_at=NULL WHERE id=$1 AND status='confirmed'`, [attemptId]);
  }

  async getRuntimeControls(accountId: string): Promise<RuntimeControls> {
    await this.pool.query(
      `INSERT INTO interaction_runtime_controls (platform,account_id,updated_by)
       SELECT $1,$2,'system' WHERE EXISTS (SELECT 1 FROM accounts WHERE account_id=$2 AND platform=$1)
       ON CONFLICT (platform,account_id) DO NOTHING`,
      [INTERACTION_PLATFORM, accountId],
    );
    const { rows } = await this.pool.query<{
      account_id: string; env_key: string | null; version: number; comments_read_enabled: boolean;
      comments_reply_enabled: boolean; dm_read_enabled: boolean; dm_send_text_enabled: boolean;
      dm_send_image_enabled: boolean; write_paused: boolean; consecutive_failures: number;
      circuit_opened_at: Date | null; last_confirmed_at: Date | null; updated_at: Date; updated_by: string;
    }>(`SELECT * FROM interaction_runtime_controls WHERE platform=$1 AND account_id=$2`, [INTERACTION_PLATFORM, accountId]);
    const row = rows[0];
    if (!row) throw new InteractionError('INTERACTION_NOT_FOUND', '账号不存在或不是视频号账号。', 404);
    return {
      accountId: row.account_id, platform: INTERACTION_PLATFORM, envKey: row.env_key, version: Number(row.version),
      commentsReadEnabled: row.comments_read_enabled, commentsReplyEnabled: row.comments_reply_enabled,
      dmReadEnabled: row.dm_read_enabled, dmSendTextEnabled: row.dm_send_text_enabled, dmSendImageEnabled: false,
      writePaused: row.write_paused, consecutiveFailures: Number(row.consecutive_failures),
      circuitOpenedAt: row.circuit_opened_at ? epoch(row.circuit_opened_at) : null,
      lastConfirmedAt: row.last_confirmed_at ? epoch(row.last_confirmed_at) : null,
      updatedAt: epoch(row.updated_at), updatedBy: row.updated_by,
    };
  }

  async updateRuntimeControls(input: {
    accountId: string; expectedVersion: number; actor: string;
    commentsReadEnabled: boolean; commentsReplyEnabled: boolean; dmReadEnabled: boolean;
    dmSendTextEnabled: boolean; dmSendImageEnabled: false; writePaused: boolean;
  }): Promise<RuntimeControls> {
    await this.getRuntimeControls(input.accountId);
    const { rows } = await this.pool.query<{ version: number }>(
      `UPDATE interaction_runtime_controls SET version=version+1,comments_read_enabled=$3,
          comments_reply_enabled=$4,dm_read_enabled=$5,dm_send_text_enabled=$6,
          dm_send_image_enabled=false,write_paused=$7,updated_at=now(),updated_by=$8
        WHERE platform=$1 AND account_id=$2 AND version=$9 RETURNING version`,
      [INTERACTION_PLATFORM, input.accountId, input.commentsReadEnabled, input.commentsReplyEnabled,
        input.dmReadEnabled, input.dmSendTextEnabled, input.writePaused, input.actor, input.expectedVersion],
    );
    if (!rows[0]) {
      const current = await this.getRuntimeControls(input.accountId);
      throw new InteractionError('INTERACTION_VERSION_CONFLICT', '运行控制版本已变化。', 409, false, {
        currentVersion: current.version,
      });
    }
    await this.audit(this.pool, input.accountId, null, input.actor, 'runtime_controls_updated', null,
      'runtime_controls', input.accountId, 'runtime controls updated', { version: Number(rows[0].version) });
    return this.getRuntimeControls(input.accountId);
  }

  async noteSendOutcome(accountId: string, confirmed: boolean, failureLimit: number): Promise<void> {
    if (confirmed) {
      await this.pool.query(
        `UPDATE interaction_runtime_controls SET consecutive_failures=0,circuit_opened_at=NULL,last_confirmed_at=now()
          WHERE platform=$1 AND account_id=$2`, [INTERACTION_PLATFORM, accountId],
      );
      return;
    }
    await this.pool.query(
      `UPDATE interaction_runtime_controls SET consecutive_failures=consecutive_failures+1,
          circuit_opened_at=CASE WHEN consecutive_failures+1 >= $3 THEN COALESCE(circuit_opened_at,now()) ELSE circuit_opened_at END,
          write_paused=CASE WHEN consecutive_failures+1 >= $3 THEN true ELSE write_paused END,
          version=CASE WHEN consecutive_failures+1 >= $3 AND write_paused=false THEN version+1 ELSE version END,
          updated_at=now(),updated_by=CASE WHEN consecutive_failures+1 >= $3 THEN 'circuit_breaker' ELSE updated_by END
        WHERE platform=$1 AND account_id=$2`, [INTERACTION_PLATFORM, accountId, failureLimit],
    );
  }

  async sendWindowCounts(accountId: string, threadId: string, now: number): Promise<{
    minute: number; hour: number; day: number; lastThreadSendAt: number | null;
  }> {
    const { rows } = await this.pool.query<{
      minute: string; hour: string; day: string; last_thread_send_at: Date | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE a.started_at >= to_timestamp($3/1000.0)-interval '1 minute') AS minute,
         count(*) FILTER (WHERE a.started_at >= to_timestamp($3/1000.0)-interval '1 hour') AS hour,
         count(*) FILTER (WHERE a.started_at >= to_timestamp($3/1000.0)-interval '1 day') AS day,
         max(a.started_at) FILTER (WHERE m.thread_id=$2 AND a.status IN ('dispatched','confirmed','ambiguous')) AS last_thread_send_at
       FROM interaction_send_attempts a
       JOIN interaction_reply_jobs j ON j.id=a.reply_job_id
       JOIN interaction_messages m ON m.id=j.inbound_message_id
      WHERE a.account_id=$1 AND a.status IN ('created','dispatched','confirmed','ambiguous')`,
      [accountId, threadId, now],
    );
    const row = rows[0];
    return {
      minute: Number(row?.minute ?? 0), hour: Number(row?.hour ?? 0), day: Number(row?.day ?? 0),
      lastThreadSendAt: row?.last_thread_send_at ? epoch(row.last_thread_send_at) : null,
    };
  }

  async recoverableAttempts(accountId?: string, limit = 100): Promise<RecoverableAttemptRef[]> {
    const { rows } = await this.pool.query<{
      account_id: string; env_key: string; status: RecoverableAttemptRef['status']; job_id: string;
      attempt_id: string; idempotency_key: string; channel: InteractionChannel; external_thread_id: string;
      external_message_id: string; external_parent_id: string | null; final_text: string; started_at: Date;
    }>(
      `SELECT a.account_id,a.env_key,a.status,j.id AS job_id,a.id AS attempt_id,a.idempotency_key,a.channel,
              t.external_thread_id,m.external_message_id,m.external_parent_id,j.final_text,a.started_at
         FROM interaction_send_attempts a
         JOIN interaction_reply_jobs j ON j.id=a.reply_job_id AND j.account_id=a.account_id AND j.env_key=a.env_key
         JOIN interaction_messages m ON m.id=j.inbound_message_id
         JOIN interaction_threads t ON t.id=m.thread_id
        WHERE a.status IN ('created','dispatched','ambiguous') AND j.final_text IS NOT NULL
          AND ($1::text IS NULL OR a.account_id=$1)
        ORDER BY a.started_at ASC,a.id ASC LIMIT $2`,
      [accountId ?? null, Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map((row) => ({
      accountId: row.account_id, envKey: row.env_key, status: row.status,
      command: {
        jobId: row.job_id, attemptId: row.attempt_id, idempotencyKey: row.idempotency_key,
        envKey: row.env_key, accountId: row.account_id, platform: INTERACTION_PLATFORM, channel: row.channel,
        target: { threadExternalId: row.external_thread_id, inboundMessageExternalId: row.external_message_id,
          parentExternalId: row.external_parent_id },
        content: { type: 'text', text: row.final_text }, expiresAt: row.started_at.getTime() + 120_000,
      },
    }));
  }

  async recoverableAttemptIds(): Promise<string[]> {
    return (await this.recoverableAttempts()).map((ref) => ref.command.attemptId);
  }

  async applyReplyReconcileResult(payload: InteractionReplyReconcileResultPayload): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const observation of payload.attempts) {
        const attempts = await client.query<{ status: SendAttemptView['status']; reply_job_id: string }>(
          `SELECT status,reply_job_id FROM interaction_send_attempts
            WHERE id=$1 AND idempotency_key=$2 AND account_id=$3 AND env_key=$4 FOR UPDATE`,
          [observation.attemptId, observation.idempotencyKey, payload.accountId, payload.envKey],
        );
        const attempt = attempts.rows[0];
        if (!attempt || attempt.reply_job_id !== observation.jobId) {
          throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '恢复观察与发送尝试不匹配。', 409);
        }
        await client.query(
          `UPDATE interaction_send_attempts SET reconciliation_state=$2,last_reconciled_at=to_timestamp($3/1000.0)
            WHERE id=$1`, [observation.attemptId, observation.state, observation.observedAt],
        );
        if (['confirmed', 'failed'].includes(attempt.status) || observation.state === 'result_replayed') continue;
        if (observation.state === 'not_found' && attempt.status === 'created') {
          await client.query(
            `UPDATE interaction_send_attempts SET status='failed',verification_status='not_found',
                error_category='transient_network',error_code='INTERACTION_UPSTREAM_UNAVAILABLE',retryable=true,finished_at=now()
              WHERE id=$1`, [observation.attemptId],
          );
          await client.query(
            `UPDATE interaction_reply_jobs SET state='failed',version=version+1,
                last_error_code='INTERACTION_UPSTREAM_UNAVAILABLE',updated_at=now()
              WHERE id=$1 AND state='sending'`, [observation.jobId],
          );
        } else {
          await client.query(
            `UPDATE interaction_send_attempts SET status='ambiguous',verification_status='not_found',
                error_category='verification_failed',error_code='INTERACTION_SEND_AMBIGUOUS',retryable=false,finished_at=now()
              WHERE id=$1 AND status IN ('created','dispatched','ambiguous')`, [observation.attemptId],
          );
          await client.query(
            `UPDATE interaction_reply_jobs SET state='ambiguous',version=version+1,
                last_error_code='INTERACTION_SEND_AMBIGUOUS',updated_at=now()
              WHERE id=$1 AND state='sending'`, [observation.jobId],
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async pendingOffboards(accountId?: string, limit = 100): Promise<PendingOffboardRef[]> {
    const { rows } = await this.pool.query<{
      offboard_id: string; account_id: string; env_key: string; reason: PendingOffboardRef['reason'];
      state: PendingOffboardRef['state']; requested_at: Date; purge_due_at: Date;
    }>(`SELECT offboard_id,account_id,env_key,reason,state,requested_at,purge_due_at
          FROM interaction_offboards WHERE state IN ('pending_edge','dispatched')
            AND ($1::text IS NULL OR account_id=$1)
          ORDER BY requested_at ASC,offboard_id ASC LIMIT $2`,
      [accountId ?? null, Math.min(Math.max(limit, 1), 100)]);
    return rows.map((row) => ({ offboardId: row.offboard_id, accountId: row.account_id,
      envKey: row.env_key, reason: row.reason, state: row.state,
      requestedAt: row.requested_at.getTime(), purgeDueAt: row.purge_due_at.getTime() }));
  }

  async markOffboardDispatched(offboardId: string, accountId: string, envKey: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE interaction_offboards SET state='dispatched',dispatch_attempts=dispatch_attempts+1,
          last_dispatched_at=now(),updated_at=now()
        WHERE offboard_id=$1 AND account_id=$2 AND env_key=$3 AND state IN ('pending_edge','dispatched')`,
      [offboardId, accountId, envKey],
    );
    if (!rowCount) throw new InteractionError('INTERACTION_STATE_CONFLICT', '解绑任务已不允许派发。', 409);
  }

  async applyOffboardResult(payload: InteractionOffboardResultPayload): Promise<{ duplicate: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ state: string; edge_result_status: string | null; user_id: string | null }>(
        `SELECT state,edge_result_status,user_id FROM interaction_offboards
          WHERE offboard_id=$1 AND account_id=$2 AND env_key=$3 AND platform=$4 FOR UPDATE`,
        [payload.offboardId, payload.accountId, payload.envKey, payload.platform],
      );
      const offboard = rows[0];
      if (!offboard) throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '解绑结果与任务 scope 不匹配。', 409);
      if ((offboard.state === 'tombstoned' || offboard.state === 'purged') &&
          offboard.edge_result_status === payload.status) {
        await client.query('COMMIT');
        return { duplicate: true };
      }
      if (!['pending_edge', 'dispatched'].includes(offboard.state)) {
        throw new InteractionError('INTERACTION_STATE_CONFLICT', '解绑结果不允许推进当前任务。', 409);
      }
      if (payload.status === 'failed') {
        await client.query(
          `UPDATE interaction_offboards SET state='pending_edge',edge_result_status='failed',last_error_code=$2,updated_at=now()
            WHERE offboard_id=$1`, [payload.offboardId, payload.errorCode],
        );
        await client.query(
          `INSERT INTO interaction_offboard_audit
             (event_id,offboard_id,platform,account_id,env_key,user_id,event,status)
           VALUES ($1,$2,$3,$4,$5,$6,'edge_cleanup_failed','pending_edge')`,
          [this.idGen('audit'), payload.offboardId, payload.platform, payload.accountId, payload.envKey, offboard.user_id],
        );
        await client.query('COMMIT');
        return { duplicate: false };
      }
      await client.query(
        `UPDATE interaction_offboards SET state='tombstoned',edge_result_status=$2,last_error_code=NULL,
            edge_cleared_at=to_timestamp($3/1000.0),tombstoned_at=now(),updated_at=now()
          WHERE offboard_id=$1`, [payload.offboardId, payload.status, payload.finishedAt],
      );
      await client.query(
        `UPDATE interaction_auth_state SET status='disabled',capabilities=$3::jsonb,identity=NULL,
            reason_code='INTERACTION_FEATURE_DISABLED',offboarded_at=now(),updated_at=now()
          WHERE platform=$1 AND account_id=$2 AND env_key=$4`,
        [payload.platform, payload.accountId, JSON.stringify({ commentsRead: false, commentsReply: false,
          dmRead: false, dmSendText: false, dmSendImage: false }), payload.envKey],
      );
      await client.query(
        `UPDATE interaction_messages SET content_text=NULL,attachment_meta=NULL,raw_meta_sanitized='{}'::jsonb,
            lifecycle='hidden',updated_at=now() WHERE account_id=$1 AND env_key=$2`,
        [payload.accountId, payload.envKey],
      );
      await client.query(
        `UPDATE interaction_reply_jobs SET rendered_text=NULL,polished_text=NULL,final_text=NULL,
            introduced_claims='[]'::jsonb,updated_at=now() WHERE account_id=$1 AND env_key=$2`,
        [payload.accountId, payload.envKey],
      );
      await client.query(
        `UPDATE interaction_threads SET status='closed',participant_external_id=NULL,participant_name=NULL,
            participant_avatar_url=NULL,source_title=NULL,source_cover_url=NULL,updated_at=now()
          WHERE account_id=$1 AND env_key=$2`, [payload.accountId, payload.envKey],
      );
      await client.query(
        `INSERT INTO interaction_offboard_audit
           (event_id,offboard_id,platform,account_id,env_key,user_id,event,status)
         VALUES ($1,$2,$3,$4,$5,$6,'cloud_tombstoned','tombstoned')`,
        [this.idGen('audit'), payload.offboardId, payload.platform, payload.accountId, payload.envKey, offboard.user_id],
      );
      await client.query('COMMIT');
      return { duplicate: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async purgeDueOffboards(now = this.clock()): Promise<number> {
    let purged = 0;
    while (true) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const due = await client.query<{
          offboard_id: string; account_id: string; env_key: string; user_id: string | null;
        }>(`SELECT offboard_id,account_id,env_key,user_id FROM interaction_offboards
              WHERE state='tombstoned' AND purge_due_at <= to_timestamp($1/1000.0)
              ORDER BY purge_due_at ASC,offboard_id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, [now]);
        const row = due.rows[0];
        if (!row) {
          await client.query('COMMIT');
          break;
        }
        await client.query(`DELETE FROM interaction_threads WHERE account_id=$1 AND env_key=$2`, [row.account_id, row.env_key]);
        await client.query(`DELETE FROM interaction_sync_batches WHERE account_id=$1 AND env_key=$2`, [row.account_id, row.env_key]);
        await client.query(`DELETE FROM interaction_sync_cursors WHERE account_id=$1 AND env_key=$2`, [row.account_id, row.env_key]);
        await client.query(`DELETE FROM interaction_api_requests WHERE account_id=$1 AND env_key=$2`, [row.account_id, row.env_key]);
        await client.query(`DELETE FROM reply_templates WHERE account_id=$1`, [row.account_id]);
        await client.query(`DELETE FROM reply_rules WHERE account_id=$1`, [row.account_id]);
        await client.query(`DELETE FROM account_reply_profiles WHERE account_id=$1`, [row.account_id]);
        await client.query(`DELETE FROM interaction_reply_config_versions WHERE account_id=$1`, [row.account_id]);
        await client.query(`DELETE FROM interaction_reply_configs WHERE account_id=$1`, [row.account_id]);
        await client.query(`DELETE FROM interaction_auth_state WHERE account_id=$1 AND env_key=$2`, [row.account_id, row.env_key]);
        await client.query(`DELETE FROM interaction_runtime_controls WHERE account_id=$1`, [row.account_id]);
        const updated = await client.query(
          `UPDATE interaction_offboards SET state='purged',purged_at=now(),updated_at=now()
            WHERE offboard_id=$1 AND state='tombstoned'`, [row.offboard_id],
        );
        if (updated.rowCount) {
          await client.query(
            `INSERT INTO interaction_offboard_audit
               (event_id,offboard_id,platform,account_id,env_key,user_id,event,status)
             VALUES ($1,$2,'wechat_channels',$3,$4,$5,'cloud_purged','purged')`,
            [this.idGen('audit'), row.offboard_id, row.account_id, row.env_key, row.user_id],
          );
          purged++;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }
    return purged;
  }

  /** AI 途中进程退出没有外部写副作用；旧 classifying 可安全回 new 后以新 version 重跑。 */
  async recoverStalledClassifyingJobs(staleBefore: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE interaction_reply_jobs SET state='new',version=version+1,
          last_error_code='INTERACTION_UPSTREAM_UNAVAILABLE',updated_at=now()
        WHERE state='classifying' AND updated_at < to_timestamp($1/1000.0)`, [staleBefore],
    );
    return rowCount ?? 0;
  }

  async pendingGenerationJobs(limit = 50): Promise<RecoverableJobRef[]> {
    const { rows } = await this.pool.query<{ account_id: string; env_key: string; id: string; version: number }>(
      `SELECT account_id,env_key,id,version FROM interaction_reply_jobs
        WHERE state='new' ORDER BY updated_at ASC,id ASC LIMIT $1`, [Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map((row) => ({ accountId: row.account_id, envKey: row.env_key,
      jobId: row.id, version: Number(row.version) }));
  }

  async pendingQueuedJobs(limit = 50): Promise<RecoverableJobRef[]> {
    const { rows } = await this.pool.query<{ account_id: string; env_key: string; id: string; version: number }>(
      `SELECT j.account_id,j.env_key,j.id,j.version FROM interaction_reply_jobs j
        WHERE j.state='queued' AND NOT EXISTS (
          SELECT 1 FROM interaction_send_attempts a WHERE a.reply_job_id=j.id
            AND a.status IN ('created','dispatched','ambiguous')
        ) ORDER BY j.updated_at ASC,j.id ASC LIMIT $1`, [Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map((row) => ({ accountId: row.account_id, envKey: row.env_key,
      jobId: row.id, version: Number(row.version) }));
  }

  async purgeExpiredContent(now = this.clock()): Promise<{
    comments: number; dms: number; replyJobs: number; apiRequests: number; audits: number;
  }> {
    const comments = await this.pool.query(
      `UPDATE interaction_messages SET content_text=NULL,attachment_meta=NULL,raw_meta_sanitized='{}'::jsonb,updated_at=now()
        WHERE channel='comment' AND platform_created_at < to_timestamp($1/1000.0)-interval '180 days'
          AND (content_text IS NOT NULL OR attachment_meta IS NOT NULL)`, [now],
    );
    const dms = await this.pool.query(
      `UPDATE interaction_messages SET content_text=NULL,attachment_meta=NULL,raw_meta_sanitized='{}'::jsonb,updated_at=now()
        WHERE channel='dm' AND platform_created_at < to_timestamp($1/1000.0)-interval '90 days'
          AND (content_text IS NOT NULL OR attachment_meta IS NOT NULL)`, [now],
    );
    const replyJobs = await this.pool.query(
      `UPDATE interaction_reply_jobs j SET rendered_text=NULL,polished_text=NULL,final_text=NULL,
           introduced_claims='[]'::jsonb,updated_at=now()
        FROM interaction_messages m
       WHERE m.id=j.inbound_message_id
         AND ((m.channel='comment' AND m.platform_created_at < to_timestamp($1/1000.0)-interval '180 days')
           OR (m.channel='dm' AND m.platform_created_at < to_timestamp($1/1000.0)-interval '90 days'))
         AND (j.rendered_text IS NOT NULL OR j.polished_text IS NOT NULL OR j.final_text IS NOT NULL
           OR j.introduced_claims <> '[]'::jsonb)`, [now],
    );
    const apiRequests = await this.pool.query(
      `DELETE FROM interaction_api_requests
        WHERE created_at < to_timestamp($1/1000.0)-interval '90 days'`, [now],
    );
    const audits = await this.pool.query(
      `DELETE FROM interaction_audit_events WHERE created_at < to_timestamp($1/1000.0)-interval '365 days'`, [now],
    );
    return {
      comments: comments.rowCount ?? 0, dms: dms.rowCount ?? 0, replyJobs: replyJobs.rowCount ?? 0,
      apiRequests: apiRequests.rowCount ?? 0, audits: audits.rowCount ?? 0,
    };
  }

  async audit(
    queryable: Queryable,
    accountId: string,
    envKey: string | null,
    actor: string,
    action: string,
    configVersion: number | null,
    entityType: string,
    entityId: string | null,
    summary: string,
    labels: Record<string, unknown>,
  ): Promise<void> {
    await queryable.query(
      `INSERT INTO interaction_audit_events
        (event_id,platform,account_id,env_key,actor,action,config_version,entity_type,entity_id,summary,labels,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now())`,
      [this.idGen('audit'), INTERACTION_PLATFORM, accountId, envKey, actor, action, configVersion,
        entityType, entityId, summary.slice(0, 512), JSON.stringify(labels)],
    );
  }

  /** 供工作流记录不含正文的状态审计；调用方不能拿到 pool，也不能绕开字段约束。 */
  async recordAudit(input: {
    accountId: string; envKey: string | null; actor: string; action: string;
    configVersion?: number | null; entityType: string; entityId?: string | null;
    summary: string; labels?: Record<string, unknown>;
  }): Promise<void> {
    await this.audit(this.pool, input.accountId, input.envKey, input.actor, input.action,
      input.configVersion ?? null, input.entityType, input.entityId ?? null, input.summary, input.labels ?? {});
  }

  async claimApiRequest(input: {
    actor: string; action: 'send' | 'sync' | 'auth_reopen'; idempotencyKey: string;
    accountId: string; envKey: string; resourceId?: string | null;
  }): Promise<{ requestId: string; fresh: boolean; response: unknown | null }> {
    const requestId = this.idGen('request');
    const { rows } = await this.pool.query<{ request_id: string; account_id: string; env_key: string; resource_id: string | null; response: unknown }>(
      `INSERT INTO interaction_api_requests
        (request_id,actor,action,idempotency_key,platform,account_id,env_key,resource_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'processing',now(),now())
       ON CONFLICT (actor,action,idempotency_key) DO UPDATE SET updated_at=interaction_api_requests.updated_at
       RETURNING request_id,account_id,env_key,resource_id,response`,
      [requestId, input.actor, input.action, input.idempotencyKey, INTERACTION_PLATFORM,
        input.accountId, input.envKey, input.resourceId ?? null],
    );
    const row = rows[0];
    if (row.account_id !== input.accountId || row.env_key !== input.envKey || row.resource_id !== (input.resourceId ?? null)) {
      throw new InteractionError('INTERACTION_SCOPE_MISMATCH', '幂等键已用于不同 scope 或资源。', 409);
    }
    return { requestId: row.request_id, fresh: row.request_id === requestId, response: row.response ?? null };
  }

  async completeApiRequest(requestId: string, response: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE interaction_api_requests SET status='completed',response=$2::jsonb,updated_at=now()
        WHERE request_id=$1`, [requestId, JSON.stringify(response)],
    );
  }

  async close(): Promise<void> { await this.pool.end(); }
}
