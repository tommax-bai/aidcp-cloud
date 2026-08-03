import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { DeploymentTarget } from '../deployment-target.js';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import {
  SchemaCapabilityError,
  classifySchemaCapability,
  type SchemaProber,
} from '../kernel/schema-capability-contract.js';
import {
  advanceFacebookConsumptionCounters,
  facebookConsumptionTargetIsDispatchable,
  sameFacebookConsumptionPolicySnapshot,
  validateFacebookConsumptionPolicy,
} from './facebook-consumption-mode.js';
import type {
  ApplyFacebookConsumptionViewResult,
  ClaimFacebookConsumptionActionResult,
  FacebookConsumptionActionReceiptInput,
  FacebookConsumptionActionState,
  FacebookConsumptionActionTarget,
  FacebookConsumptionActionType,
  FacebookConsumptionActionView,
  FacebookConsumptionOutcome,
  FacebookConsumptionPolicySnapshot,
  FacebookConsumptionRuntimePolicy,
  FacebookConsumptionRuntimeView,
  MutateFacebookConsumptionActionResult,
  SettleFacebookConsumptionActionResult,
} from './facebook-consumption-mode-types.js';

const { Pool } = pg;

const ACTION_COLUMNS = `
  action_id, account_id, execution_target, policy_revision, policy_snapshot,
  action_sequence, action_type, idempotency_key, trigger_source_dedupe_key,
  state, dispatch_phase, outcome, blocker, downstream_enabled,
  group_key, group_url, content_key, content_url, selection_strategy, target_evidence,
  owner_id, owner_expires_at, version, dispatched_at, settled_at, created_at, updated_at
`;

const FACEBOOK_CONSUMPTION_RUNTIME_REQUIREMENT = {
  tables: new Map([
    ['facebook_consumption_progress', new Set([
      'account_id',
      'execution_target',
      'policy_revision',
      'policy_snapshot',
      'revision_state',
      'collecting_sequence',
      'views_since_like',
      'confirmed_new_likes_since_join',
      'confirmed_new_joins_since_comment',
      'next_action_sequence',
      'active_action_id',
      'superseded_at',
      'created_at',
      'updated_at',
    ])],
    ['facebook_consumption_view_fact', new Set([
      'account_id',
      'execution_target',
      'policy_revision',
      'collecting_sequence',
      'content_key',
      'content_url',
      'source_dedupe_key',
      'occurred_at',
      'created_at',
    ])],
    ['facebook_consumption_action', new Set([
      'action_id',
      'account_id',
      'execution_target',
      'policy_revision',
      'policy_snapshot',
      'action_sequence',
      'action_type',
      'idempotency_key',
      'trigger_source_dedupe_key',
      'state',
      'dispatch_phase',
      'outcome',
      'blocker',
      'downstream_enabled',
      'group_key',
      'group_url',
      'content_key',
      'content_url',
      'selection_strategy',
      'target_evidence',
      'owner_id',
      'owner_expires_at',
      'version',
      'dispatched_at',
      'settled_at',
      'created_at',
      'updated_at',
    ])],
    ['facebook_consumption_action_result_fact', new Set([
      'action_id',
      'account_id',
      'execution_target',
      'policy_revision',
      'source_dedupe_key',
      'outcome',
      'evidence',
      'occurred_at',
      'created_at',
    ])],
  ]),
  indexes: new Map([
    ['uq_facebook_consumption_active_action', 'facebook_consumption_action'],
    ['idx_facebook_consumption_action_revision', 'facebook_consumption_action'],
    ['idx_facebook_consumption_result_source', 'facebook_consumption_action_result_fact'],
  ]),
};

interface ProgressDbRow {
  account_id: string;
  execution_target: DeploymentTarget;
  policy_revision: number | string;
  policy_snapshot: unknown;
  revision_state: 'active' | 'superseded';
  collecting_sequence: number | string;
  views_since_like: number | string;
  confirmed_new_likes_since_join: number | string;
  confirmed_new_joins_since_comment: number | string;
  next_action_sequence: number | string;
  active_action_id: string | null;
  updated_at: Date | string;
}

interface ActionDbRow {
  action_id: string;
  account_id: string;
  execution_target: DeploymentTarget;
  policy_revision: number | string;
  policy_snapshot: unknown;
  action_sequence: number | string;
  action_type: FacebookConsumptionActionType;
  idempotency_key: string;
  trigger_source_dedupe_key: string;
  state: FacebookConsumptionActionState;
  dispatch_phase: 'not_started' | 'dispatched' | 'settled';
  outcome: FacebookConsumptionOutcome | null;
  blocker: string | null;
  downstream_enabled: boolean;
  group_key: string | null;
  group_url: string | null;
  content_key: string | null;
  content_url: string | null;
  selection_strategy: 'first_commentable_group_post' | null;
  target_evidence: unknown;
  owner_id: string | null;
  owner_expires_at: Date | string | null;
  version: number | string;
  dispatched_at: Date | string | null;
  settled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface FacebookConsumptionModeRuntimeStoreOptions {
  pool?: pg.Pool;
  runtimePool?: pg.Pool;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  executionTarget: DeploymentTarget;
  schemaProber: SchemaProber;
  clock?: () => number;
}

export interface BindFacebookConsumptionActionTargetInput {
  actionId: string;
  accountId: string;
  policyRevision: number;
  ownerId: string;
  expectedVersion: number;
  target: Partial<{
    groupKey: string;
    groupUrl: string;
    contentKey: string;
    contentUrl: string;
    selection: 'first_commentable_group_post';
    evidence: Record<string, unknown>;
  }>;
}

export interface SetFacebookConsumptionPreDispatchStateInput {
  actionId: string;
  accountId: string;
  policyRevision: number;
  ownerId: string;
  expectedVersion: number;
  blocker?: string | null;
}

/**
 * The existing Facebook comment executor holds one exact page through a
 * nine-minute prepare/approval lease. Consumption ownership must outlive that
 * documented boundary or the final before-submit CAS will fail after a valid
 * approval.
 */
export const FACEBOOK_CONSUMPTION_ACTION_CLAIM_MAX_LEASE_MS = 15 * 60_000;

function parsedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('facebook_consumption_runtime_json_invalid');
  }
}

function snapshotFromDb(value: unknown): FacebookConsumptionPolicySnapshot {
  const parsed = parsedJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('facebook_consumption_policy_snapshot_invalid');
  }
  const row = parsed as Record<string, unknown>;
  const snapshot = {
    viewsPerLike: Number(row.viewsPerLike),
    confirmedLikesPerJoin: Number(row.confirmedLikesPerJoin),
    confirmedJoinsPerComment: Number(row.confirmedJoinsPerComment),
  };
  const verdict = validateFacebookConsumptionPolicy(1, snapshot);
  if (!verdict.ok) throw new Error(verdict.blocker);
  return snapshot;
}

function evidenceFromDb(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  const parsed = parsedJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('facebook_consumption_target_evidence_invalid');
  }
  return parsed as Record<string, unknown>;
}

function iso(value: Date | string | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

function actionFromDb(row: ActionDbRow): FacebookConsumptionActionView {
  return {
    actionId: row.action_id,
    accountId: row.account_id,
    executionTarget: row.execution_target,
    policyRevision: Number(row.policy_revision),
    policySnapshot: snapshotFromDb(row.policy_snapshot),
    sequence: Number(row.action_sequence),
    actionType: row.action_type,
    idempotencyKey: row.idempotency_key,
    triggerSourceDedupeKey: row.trigger_source_dedupe_key,
    state: row.state,
    dispatchPhase: row.dispatch_phase,
    outcome: row.outcome,
    blocker: row.blocker,
    downstreamEnabled: row.downstream_enabled === true,
    target: {
      groupKey: row.group_key,
      groupUrl: row.group_url,
      contentKey: row.content_key,
      contentUrl: row.content_url,
      selection: row.selection_strategy,
      evidence: evidenceFromDb(row.target_evidence),
    },
    ownerId: row.owner_id,
    ownerExpiresAt: iso(row.owner_expires_at),
    version: Number(row.version),
    dispatchedAt: iso(row.dispatched_at),
    settledAt: iso(row.settled_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function normalizedRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`invalid_${field}`);
  return normalized;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function actionIdempotencyKey(input: {
  accountId: string;
  executionTarget: DeploymentTarget;
  policyRevision: number;
  sequence: number;
  actionType: FacebookConsumptionActionType;
}): string {
  return createHash('sha256')
    .update([
      'facebook_consumption',
      input.accountId,
      input.executionTarget,
      String(input.policyRevision),
      String(input.sequence),
      input.actionType,
    ].join('\u001f'))
    .digest('hex');
}

function outcomeCompatible(
  actionType: FacebookConsumptionActionType,
  outcome: FacebookConsumptionOutcome,
): boolean {
  if (outcome === 'confirmed_new_like' || outcome === 'already_liked' || outcome === 'already_reacted') {
    return actionType === 'like';
  }
  if (outcome === 'confirmed_new_join' || outcome === 'already_member') {
    return actionType === 'join';
  }
  if (outcome === 'confirmed_comment') return actionType === 'comment';
  // Target absence is a reversible planner state. Callers must use
  // markActionWaitingTarget so the obligation remains durable.
  if (outcome === 'no_target') return false;
  return true;
}

function resultIsPositive(outcome: FacebookConsumptionOutcome): boolean {
  return outcome === 'confirmed_new_like'
    || outcome === 'confirmed_new_join'
    || outcome === 'confirmed_comment';
}

function outcomeRequiresDispatch(outcome: FacebookConsumptionOutcome): boolean {
  return outcome === 'confirmed_new_like'
    || outcome === 'confirmed_new_join'
    || outcome === 'confirmed_comment'
    || outcome === 'pending'
    || outcome === 'ambiguous'
    || outcome === 'submitted_unknown';
}

export class FacebookConsumptionModeRuntimeStore {
  private readonly runtimePool: pg.Pool;
  private readonly executionTarget: DeploymentTarget;
  private readonly schemaProber: SchemaProber;
  private readonly clock: () => number;
  private readonly ownedPool?: pg.Pool;

  constructor(options: FacebookConsumptionModeRuntimeStoreOptions) {
    this.executionTarget = options.executionTarget;
    this.schemaProber = options.schemaProber;
    this.clock = options.clock ?? Date.now;
    let pool = options.runtimePool ?? options.pool;
    if (!pool) {
      pool = new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
      this.ownedPool = pool;
    }
    this.runtimePool = pool;
  }

  async init(): Promise<void> {
    const shape = await this.schemaProber(
      this.runtimePool,
      [...FACEBOOK_CONSUMPTION_RUNTIME_REQUIREMENT.tables.keys()],
    );
    const verdict = classifySchemaCapability(
      FACEBOOK_CONSUMPTION_RUNTIME_REQUIREMENT,
      shape,
    );
    if (verdict.status !== 'ready') {
      throw new SchemaCapabilityError(
        {
          capability: 'facebook_consumption_mode_runtime',
          sinceVersion: '0102_facebook_consumption_runtime',
          ddl: [],
        },
        verdict,
      );
    }
    await this.recoverExpiredClaims();
  }

  async getRuntimeView(
    accountId: string,
    policyRevision: number,
  ): Promise<FacebookConsumptionRuntimeView | null> {
    const progress = await this.runtimePool.query<ProgressDbRow>(
      `SELECT account_id, execution_target, policy_revision, policy_snapshot,
              revision_state, collecting_sequence, views_since_like,
              confirmed_new_likes_since_join, confirmed_new_joins_since_comment,
              next_action_sequence, active_action_id, updated_at
         FROM facebook_consumption_progress
        WHERE account_id=$1 AND execution_target=$2 AND policy_revision=$3`,
      [accountId, this.executionTarget, policyRevision],
    );
    const row = progress.rows[0];
    if (!row) return null;
    let activeAction: FacebookConsumptionActionView | null = null;
    if (row.active_action_id) {
      const action = await this.runtimePool.query<ActionDbRow>(
        `SELECT ${ACTION_COLUMNS}
           FROM facebook_consumption_action
          WHERE action_id=$1 AND account_id=$2 AND execution_target=$3
            AND policy_revision=$4`,
        [row.active_action_id, accountId, this.executionTarget, policyRevision],
      );
      if (!action.rows[0]) throw new Error('facebook_consumption_active_action_missing');
      activeAction = actionFromDb(action.rows[0]);
    }
    return {
      accountId: row.account_id,
      executionTarget: row.execution_target,
      policyRevision: Number(row.policy_revision),
      policySnapshot: snapshotFromDb(row.policy_snapshot),
      revisionState: row.revision_state,
      collectingSequence: Number(row.collecting_sequence),
      viewsSinceLike: Number(row.views_since_like),
      confirmedNewLikesSinceJoin: Number(row.confirmed_new_likes_since_join),
      confirmedNewJoinsSinceComment: Number(row.confirmed_new_joins_since_comment),
      nextActionSequence: Number(row.next_action_sequence),
      activeAction,
      updatedAt: iso(row.updated_at)!,
    };
  }

  async getAction(actionId: string): Promise<FacebookConsumptionActionView | null> {
    const result = await this.runtimePool.query<ActionDbRow>(
      `SELECT ${ACTION_COLUMNS}
         FROM facebook_consumption_action
        WHERE action_id=$1 AND execution_target=$2`,
      [actionId, this.executionTarget],
    );
    return result.rows[0] ? actionFromDb(result.rows[0]) : null;
  }

  async listActiveActions(limit = 100): Promise<FacebookConsumptionActionView[]> {
    const boundedLimit = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(500, limit))
      : 100;
    const result = await this.runtimePool.query<ActionDbRow>(
      `SELECT ${ACTION_COLUMNS}
         FROM facebook_consumption_action
        WHERE execution_target=$1 AND state <> 'terminal'
        ORDER BY created_at ASC
        LIMIT $2`,
      [this.executionTarget, boundedLimit],
    );
    return result.rows.map(actionFromDb);
  }

  async applyConfirmedView(input: {
    accountId: string;
    policy: FacebookConsumptionRuntimePolicy;
    contentKey: string;
    contentUrl: string;
    sourceDedupeKey: string;
    occurredAt: number;
  }): Promise<ApplyFacebookConsumptionViewResult> {
    const accountId = normalizedRequired(input.accountId, 'account_id');
    const contentKey = normalizedRequired(input.contentKey, 'content_key');
    const contentUrl = normalizedRequired(input.contentUrl, 'content_url');
    const sourceDedupeKey = normalizedRequired(input.sourceDedupeKey, 'source_dedupe_key');
    const policyVerdict = validateFacebookConsumptionPolicy(
      input.policy.policyRevision,
      input.policy.snapshot,
    );
    if (!policyVerdict.ok) throw new Error(policyVerdict.blocker);
    if (!Number.isFinite(input.occurredAt)) throw new Error('invalid_occurred_at');

    const client = await this.runtimePool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const revisionRows = await client.query<Pick<ProgressDbRow, 'policy_revision' | 'revision_state'>>(
        `SELECT policy_revision, revision_state
           FROM facebook_consumption_progress
          WHERE account_id=$1 AND execution_target=$2
          ORDER BY policy_revision DESC
          FOR UPDATE`,
        [accountId, this.executionTarget],
      );
      // Policy revisions are globally unique identities, not an ordering for a
      // particular account. Rebinding an account can legitimately move from a
      // numerically newer environment revision to an older one. The caller has
      // already resolved the current authoritative environment policy, so keep
      // that exact identity and supersede every different revision.
      if (revisionRows.rows.some(
        (row) => Number(row.policy_revision) !== input.policy.policyRevision,
      )) {
        await this.supersedeWithClient(
          client,
          accountId,
          input.policy.policyRevision,
          'policy_superseded',
        );
      }

      const active = await this.selectAccountActiveActionForUpdate(client, accountId);
      if (active) {
        await client.query('COMMIT');
        transactionOpen = false;
        return { kind: 'action_active', action: actionFromDb(active) };
      }

      await client.query(
        `INSERT INTO facebook_consumption_progress
           (account_id, execution_target, policy_revision, policy_snapshot)
         VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT DO NOTHING`,
        [
          accountId,
          this.executionTarget,
          input.policy.policyRevision,
          JSON.stringify(input.policy.snapshot),
        ],
      );
      const progressResult = await client.query<ProgressDbRow>(
        `SELECT account_id, execution_target, policy_revision, policy_snapshot,
                revision_state, collecting_sequence, views_since_like,
                confirmed_new_likes_since_join, confirmed_new_joins_since_comment,
                next_action_sequence, active_action_id, updated_at
           FROM facebook_consumption_progress
          WHERE account_id=$1 AND execution_target=$2 AND policy_revision=$3
          FOR UPDATE`,
        [accountId, this.executionTarget, input.policy.policyRevision],
      );
      const progress = progressResult.rows[0]!;
      if (progress.revision_state !== 'active') {
        await client.query('COMMIT');
        transactionOpen = false;
        return { kind: 'policy_superseded' };
      }
      if (!sameFacebookConsumptionPolicySnapshot(
        snapshotFromDb(progress.policy_snapshot),
        input.policy.snapshot,
      )) {
        await client.query('COMMIT');
        transactionOpen = false;
        return { kind: 'policy_snapshot_mismatch' };
      }
      if (progress.active_action_id) {
        const existing = await this.selectActionForUpdate(
          client,
          progress.active_action_id,
          accountId,
          input.policy.policyRevision,
        );
        await client.query('COMMIT');
        transactionOpen = false;
        if (!existing) throw new Error('facebook_consumption_active_action_missing');
        return { kind: 'action_active', action: actionFromDb(existing) };
      }

      const inserted = await client.query(
        `INSERT INTO facebook_consumption_view_fact
           (account_id, execution_target, policy_revision, collecting_sequence,
            content_key, content_url, source_dedupe_key, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING
         RETURNING content_key`,
        [
          accountId,
          this.executionTarget,
          input.policy.policyRevision,
          Number(progress.collecting_sequence),
          contentKey,
          contentUrl,
          sourceDedupeKey,
          new Date(input.occurredAt),
        ],
      );
      const currentCount = Number(progress.views_since_like);
      if (inserted.rowCount === 0) {
        await client.query('COMMIT');
        transactionOpen = false;
        return { kind: 'duplicate', viewCount: currentCount };
      }

      const nextCount = currentCount + 1;
      if (nextCount < input.policy.snapshot.viewsPerLike) {
        await client.query(
          `UPDATE facebook_consumption_progress
              SET views_since_like=$4, updated_at=now()
            WHERE account_id=$1 AND execution_target=$2 AND policy_revision=$3`,
          [accountId, this.executionTarget, input.policy.policyRevision, nextCount],
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return { kind: 'counted', viewCount: nextCount };
      }

      const action = await this.insertAction(client, {
        accountId,
        policyRevision: input.policy.policyRevision,
        snapshot: input.policy.snapshot,
        sequence: Number(progress.next_action_sequence),
        actionType: 'like',
        triggerSourceDedupeKey: sourceDedupeKey,
        contentKey,
        contentUrl,
      });
      if (!action) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        const competing = await this.findAccountActiveAction(accountId);
        if (!competing) throw new Error('facebook_consumption_action_insert_conflict');
        return { kind: 'action_active', action: actionFromDb(competing) };
      }
      await client.query(
        `UPDATE facebook_consumption_progress
            SET collecting_sequence=collecting_sequence+1,
                views_since_like=0,
                next_action_sequence=next_action_sequence+1,
                active_action_id=$4,
                updated_at=now()
          WHERE account_id=$1 AND execution_target=$2 AND policy_revision=$3`,
        [accountId, this.executionTarget, input.policy.policyRevision, action.action_id],
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return { kind: 'action_created', action: actionFromDb(action) };
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimAction(input: {
    actionId: string;
    accountId: string;
    policyRevision: number;
    ownerId: string;
    leaseMs: number;
  }): Promise<ClaimFacebookConsumptionActionResult> {
    const ownerId = normalizedRequired(input.ownerId, 'owner_id');
    if (
      !Number.isSafeInteger(input.leaseMs)
      || input.leaseMs < 1_000
      || input.leaseMs > FACEBOOK_CONSUMPTION_ACTION_CLAIM_MAX_LEASE_MS
    ) {
      throw new Error('invalid_claim_lease_ms');
    }
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.selectActionForUpdate(
        client,
        input.actionId,
        input.accountId,
        input.policyRevision,
      );
      if (!row || row.state === 'terminal') {
        await client.query('COMMIT');
        return { kind: 'not_found' };
      }
      const now = this.clock();
      const leaseActive = row.owner_id !== null
        && row.owner_expires_at !== null
        && new Date(row.owner_expires_at).getTime() > now;
      if (leaseActive && row.owner_id === ownerId) {
        await client.query('COMMIT');
        return { kind: 'already_owned', action: actionFromDb(row) };
      }
      if (leaseActive) {
        await client.query('COMMIT');
        return { kind: 'owned_elsewhere', action: actionFromDb(row) };
      }
      const updated = await client.query<ActionDbRow>(
        `UPDATE facebook_consumption_action
            SET owner_id=$2, owner_expires_at=$3, version=version+1, updated_at=now()
          WHERE action_id=$1 AND account_id=$4 AND execution_target=$5
            AND policy_revision=$6 AND state <> 'terminal'
          RETURNING ${ACTION_COLUMNS}`,
        [
          input.actionId,
          ownerId,
          new Date(now + input.leaseMs),
          input.accountId,
          this.executionTarget,
          input.policyRevision,
        ],
      );
      await client.query('COMMIT');
      return updated.rows[0]
        ? { kind: 'claimed', action: actionFromDb(updated.rows[0]) }
        : { kind: 'not_found' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async bindActionTarget(
    input: BindFacebookConsumptionActionTargetInput,
  ): Promise<MutateFacebookConsumptionActionResult> {
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.selectActionForUpdate(
        client,
        input.actionId,
        input.accountId,
        input.policyRevision,
      );
      if (!row) {
        await client.query('COMMIT');
        return { kind: 'not_found' };
      }
      const current = actionFromDb(row);
      if (row.state === 'terminal' || row.dispatch_phase !== 'not_started') {
        await client.query('COMMIT');
        return { kind: 'invalid_state', action: current };
      }
      if (!this.ownerMatches(row, input.ownerId)) {
        await client.query('COMMIT');
        return { kind: 'owner_conflict', action: current };
      }
      if (Number(row.version) !== input.expectedVersion) {
        await client.query('COMMIT');
        return { kind: 'version_conflict', action: current };
      }

      const incoming = {
        groupKey: input.target.groupKey === undefined
          ? undefined
          : normalizedRequired(input.target.groupKey, 'group_key'),
        groupUrl: input.target.groupUrl === undefined
          ? undefined
          : normalizedRequired(input.target.groupUrl, 'group_url'),
        contentKey: input.target.contentKey === undefined
          ? undefined
          : normalizedRequired(input.target.contentKey, 'content_key'),
        contentUrl: input.target.contentUrl === undefined
          ? undefined
          : normalizedRequired(input.target.contentUrl, 'content_url'),
        selection: input.target.selection,
        evidence: input.target.evidence,
      };
      for (const [existing, next] of [
        [row.group_key, incoming.groupKey],
        [row.group_url, incoming.groupUrl],
        [row.content_key, incoming.contentKey],
        [row.content_url, incoming.contentUrl],
        [row.selection_strategy, incoming.selection],
      ] as const) {
        if (existing !== null && next !== undefined && existing !== next) {
          await client.query('COMMIT');
          return { kind: 'target_conflict', action: current };
        }
      }
      const existingEvidence = evidenceFromDb(row.target_evidence);
      if (
        existingEvidence
        && incoming.evidence !== undefined
        && stableJson(existingEvidence) !== stableJson(incoming.evidence)
      ) {
        await client.query('COMMIT');
        return { kind: 'target_conflict', action: current };
      }
      const target: FacebookConsumptionActionTarget = {
        groupKey: row.group_key ?? incoming.groupKey ?? null,
        groupUrl: row.group_url ?? incoming.groupUrl ?? null,
        contentKey: row.content_key ?? incoming.contentKey ?? null,
        contentUrl: row.content_url ?? incoming.contentUrl ?? null,
        selection: row.selection_strategy ?? incoming.selection ?? null,
        evidence: existingEvidence ?? incoming.evidence ?? null,
      };
      if (row.action_type === 'comment' && target.selection !== 'first_commentable_group_post') {
        await client.query('COMMIT');
        return { kind: 'target_conflict', action: current };
      }
      const nextState: FacebookConsumptionActionState =
        facebookConsumptionTargetIsDispatchable(row.action_type, target)
          ? 'ready'
          : 'waiting_target';
      const nextBlocker = nextState === 'ready'
        ? null
        : row.action_type === 'comment' && target.groupUrl
          ? 'waiting_content_target'
          : row.blocker;
      const changed = stableJson(current.target) !== stableJson(target)
        || row.state !== nextState
        || row.blocker !== nextBlocker;
      if (!changed) {
        await client.query('COMMIT');
        return { kind: 'unchanged', action: current };
      }
      const updated = await client.query<ActionDbRow>(
        `UPDATE facebook_consumption_action
            SET group_key=$2, group_url=$3, content_key=$4, content_url=$5,
                selection_strategy=$6, target_evidence=$7::jsonb,
                state=$8, blocker=$9, version=version+1, updated_at=now()
          WHERE action_id=$1 AND account_id=$10 AND execution_target=$11
            AND policy_revision=$12 AND version=$13
          RETURNING ${ACTION_COLUMNS}`,
        [
          input.actionId,
          target.groupKey,
          target.groupUrl,
          target.contentKey,
          target.contentUrl,
          target.selection,
          target.evidence == null ? null : JSON.stringify(target.evidence),
          nextState,
          nextBlocker,
          input.accountId,
          this.executionTarget,
          input.policyRevision,
          input.expectedVersion,
        ],
      );
      await client.query('COMMIT');
      return updated.rows[0]
        ? { kind: 'updated', action: actionFromDb(updated.rows[0]) }
        : { kind: 'version_conflict', action: current };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Irreversible-executor handoff. The exact target and dispatched phase commit
   * in one CAS update; callers may continue to Edge only for `kind='updated'`.
   */
  async bindTargetAndMarkDispatched(
    input: BindFacebookConsumptionActionTargetInput,
  ): Promise<MutateFacebookConsumptionActionResult> {
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.selectActionForUpdate(
        client,
        input.actionId,
        input.accountId,
        input.policyRevision,
      );
      if (!row) {
        await client.query('COMMIT');
        return { kind: 'not_found' };
      }
      const current = actionFromDb(row);
      const incoming = {
        groupKey: input.target.groupKey === undefined
          ? undefined
          : normalizedRequired(input.target.groupKey, 'group_key'),
        groupUrl: input.target.groupUrl === undefined
          ? undefined
          : normalizedRequired(input.target.groupUrl, 'group_url'),
        contentKey: input.target.contentKey === undefined
          ? undefined
          : normalizedRequired(input.target.contentKey, 'content_key'),
        contentUrl: input.target.contentUrl === undefined
          ? undefined
          : normalizedRequired(input.target.contentUrl, 'content_url'),
        selection: input.target.selection,
        evidence: input.target.evidence,
      };
      for (const [existing, next] of [
        [row.group_key, incoming.groupKey],
        [row.group_url, incoming.groupUrl],
        [row.content_key, incoming.contentKey],
        [row.content_url, incoming.contentUrl],
        [row.selection_strategy, incoming.selection],
      ] as const) {
        if (existing !== null && next !== undefined && existing !== next) {
          await client.query('COMMIT');
          return { kind: 'target_conflict', action: current };
        }
      }
      const existingEvidence = evidenceFromDb(row.target_evidence);
      if (
        existingEvidence
        && incoming.evidence !== undefined
        && stableJson(existingEvidence) !== stableJson(incoming.evidence)
      ) {
        await client.query('COMMIT');
        return { kind: 'target_conflict', action: current };
      }
      if (row.dispatch_phase === 'dispatched') {
        await client.query('COMMIT');
        return { kind: 'unchanged', action: current };
      }
      if (row.state === 'terminal' || row.dispatch_phase !== 'not_started') {
        await client.query('COMMIT');
        return { kind: 'invalid_state', action: current };
      }
      if (!this.ownerMatches(row, input.ownerId)) {
        await client.query('COMMIT');
        return { kind: 'owner_conflict', action: current };
      }
      if (Number(row.version) !== input.expectedVersion) {
        await client.query('COMMIT');
        return { kind: 'version_conflict', action: current };
      }
      const target: FacebookConsumptionActionTarget = {
        groupKey: row.group_key ?? incoming.groupKey ?? null,
        groupUrl: row.group_url ?? incoming.groupUrl ?? null,
        contentKey: row.content_key ?? incoming.contentKey ?? null,
        contentUrl: row.content_url ?? incoming.contentUrl ?? null,
        selection: row.selection_strategy ?? incoming.selection ?? null,
        evidence: existingEvidence ?? incoming.evidence ?? null,
      };
      if (
        row.action_type === 'comment'
        && target.selection !== 'first_commentable_group_post'
      ) {
        await client.query('COMMIT');
        return { kind: 'target_conflict', action: current };
      }
      if (!facebookConsumptionTargetIsDispatchable(row.action_type, target)) {
        await client.query('COMMIT');
        return { kind: 'invalid_state', action: current };
      }
      const updated = await client.query<ActionDbRow>(
        `UPDATE facebook_consumption_action
            SET group_key=$2, group_url=$3, content_key=$4, content_url=$5,
                selection_strategy=$6, target_evidence=$7::jsonb,
                state='dispatched', dispatch_phase='dispatched', outcome=NULL,
                blocker=NULL, dispatched_at=$8, version=version+1, updated_at=now()
          WHERE action_id=$1 AND account_id=$9 AND execution_target=$10
            AND policy_revision=$11 AND version=$12
          RETURNING ${ACTION_COLUMNS}`,
        [
          input.actionId,
          target.groupKey,
          target.groupUrl,
          target.contentKey,
          target.contentUrl,
          target.selection,
          target.evidence == null ? null : JSON.stringify(target.evidence),
          new Date(this.clock()),
          input.accountId,
          this.executionTarget,
          input.policyRevision,
          input.expectedVersion,
        ],
      );
      await client.query('COMMIT');
      return updated.rows[0]
        ? { kind: 'updated', action: actionFromDb(updated.rows[0]) }
        : { kind: 'version_conflict', action: current };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markActionWaitingTarget(
    input: SetFacebookConsumptionPreDispatchStateInput,
  ): Promise<MutateFacebookConsumptionActionResult> {
    return this.setPreDispatchState(input, 'waiting_target', input.blocker ?? 'waiting_target');
  }

  async markActionWaitingGate(
    input: SetFacebookConsumptionPreDispatchStateInput,
  ): Promise<MutateFacebookConsumptionActionResult> {
    return this.setPreDispatchState(input, 'waiting_gate', input.blocker ?? 'waiting_gate');
  }

  async markActionReady(
    input: SetFacebookConsumptionPreDispatchStateInput,
  ): Promise<MutateFacebookConsumptionActionResult> {
    return this.setPreDispatchState(input, 'ready', null);
  }

  async markDispatched(
    input: SetFacebookConsumptionPreDispatchStateInput,
  ): Promise<MutateFacebookConsumptionActionResult> {
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.selectActionForUpdate(
        client,
        input.actionId,
        input.accountId,
        input.policyRevision,
      );
      if (!row) {
        await client.query('COMMIT');
        return { kind: 'not_found' };
      }
      const current = actionFromDb(row);
      // A replay after this transition must never authorize another platform write.
      if (row.dispatch_phase === 'dispatched') {
        await client.query('COMMIT');
        return { kind: 'unchanged', action: current };
      }
      if (
        row.state !== 'ready'
        || row.dispatch_phase !== 'not_started'
        || !facebookConsumptionTargetIsDispatchable(row.action_type, current.target)
      ) {
        await client.query('COMMIT');
        return { kind: 'invalid_state', action: current };
      }
      if (!this.ownerMatches(row, input.ownerId)) {
        await client.query('COMMIT');
        return { kind: 'owner_conflict', action: current };
      }
      if (Number(row.version) !== input.expectedVersion) {
        await client.query('COMMIT');
        return { kind: 'version_conflict', action: current };
      }
      const updated = await client.query<ActionDbRow>(
        `UPDATE facebook_consumption_action
            SET state='dispatched', dispatch_phase='dispatched', outcome=NULL,
                blocker=NULL, dispatched_at=$2, version=version+1, updated_at=now()
          WHERE action_id=$1 AND account_id=$3 AND execution_target=$4
            AND policy_revision=$5 AND version=$6
          RETURNING ${ACTION_COLUMNS}`,
        [
          input.actionId,
          new Date(this.clock()),
          input.accountId,
          this.executionTarget,
          input.policyRevision,
          input.expectedVersion,
        ],
      );
      await client.query('COMMIT');
      return updated.rows[0]
        ? { kind: 'updated', action: actionFromDb(updated.rows[0]) }
        : { kind: 'version_conflict', action: current };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseActionClaim(input: {
    actionId: string;
    accountId: string;
    policyRevision: number;
    ownerId: string;
    expectedVersion: number;
  }): Promise<MutateFacebookConsumptionActionResult> {
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.selectActionForUpdate(
        client,
        input.actionId,
        input.accountId,
        input.policyRevision,
      );
      if (!row) {
        await client.query('COMMIT');
        return { kind: 'not_found' };
      }
      const current = actionFromDb(row);
      if (row.owner_id !== input.ownerId) {
        await client.query('COMMIT');
        return { kind: 'owner_conflict', action: current };
      }
      if (Number(row.version) !== input.expectedVersion) {
        await client.query('COMMIT');
        return { kind: 'version_conflict', action: current };
      }
      const updated = await client.query<ActionDbRow>(
        `UPDATE facebook_consumption_action
            SET owner_id=NULL, owner_expires_at=NULL, version=version+1, updated_at=now()
          WHERE action_id=$1 AND account_id=$2 AND execution_target=$3
            AND policy_revision=$4 AND version=$5
          RETURNING ${ACTION_COLUMNS}`,
        [
          input.actionId,
          input.accountId,
          this.executionTarget,
          input.policyRevision,
          input.expectedVersion,
        ],
      );
      await client.query('COMMIT');
      return updated.rows[0]
        ? { kind: 'updated', action: actionFromDb(updated.rows[0]) }
        : { kind: 'version_conflict', action: current };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async settleAction(
    input: FacebookConsumptionActionReceiptInput,
  ): Promise<SettleFacebookConsumptionActionResult> {
    normalizedRequired(input.actionId, 'action_id');
    normalizedRequired(input.accountId, 'account_id');
    if (!Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1) {
      throw new Error('invalid_policy_revision');
    }
    if (!Number.isFinite(input.occurredAt)) throw new Error('invalid_occurred_at');
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.selectActionForUpdate(
        client,
        input.actionId,
        input.accountId,
        input.policyRevision,
      );
      if (!row) {
        await client.query('COMMIT');
        return { kind: 'not_found' };
      }
      const current = actionFromDb(row);
      if (
        (input.expectedContentKey !== undefined
          && input.expectedContentKey !== row.content_key)
        || (input.expectedContentUrl !== undefined
          && input.expectedContentUrl !== row.content_url)
        || (input.expectedGroupKey !== undefined
          && input.expectedGroupKey !== row.group_key)
        || (input.expectedGroupUrl !== undefined
          && input.expectedGroupUrl !== row.group_url)
      ) {
        await client.query('COMMIT');
        return { kind: 'target_mismatch', action: current };
      }
      if (!outcomeCompatible(row.action_type, input.outcome)) {
        await client.query('COMMIT');
        return { kind: 'incompatible_outcome', action: current };
      }
      if (
        row.state !== 'terminal'
        && outcomeRequiresDispatch(input.outcome)
        && row.dispatch_phase !== 'dispatched'
      ) {
        await client.query('COMMIT');
        return { kind: 'incompatible_outcome', action: current };
      }

      const sourceDedupeKey = normalizedRequired(
        input.sourceDedupeKey,
        'source_dedupe_key',
      );
      const resultFact = await client.query(
        `INSERT INTO facebook_consumption_action_result_fact
           (action_id, account_id, execution_target, policy_revision,
            source_dedupe_key, outcome, evidence, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         ON CONFLICT DO NOTHING
         RETURNING source_dedupe_key`,
        [
          input.actionId,
          input.accountId,
          this.executionTarget,
          input.policyRevision,
          sourceDedupeKey,
          input.outcome,
          input.evidence == null ? null : JSON.stringify(input.evidence),
          new Date(input.occurredAt),
        ],
      );
      if (resultFact.rowCount === 0) {
        const existingFact = await client.query<{
          action_id: string;
          outcome: FacebookConsumptionOutcome;
        }>(
          `SELECT action_id, outcome
             FROM facebook_consumption_action_result_fact
            WHERE account_id=$1 AND execution_target=$2 AND policy_revision=$3
              AND source_dedupe_key=$4
            FOR UPDATE`,
          [
            input.accountId,
            this.executionTarget,
            input.policyRevision,
            sourceDedupeKey,
          ],
        );
        const fact = existingFact.rows[0];
        const pendingUpgrade = fact?.action_id === input.actionId
          && fact.outcome === 'pending'
          && input.outcome !== 'pending';
        if (!pendingUpgrade) {
          await client.query('COMMIT');
          return { kind: 'duplicate', action: current };
        }
        await client.query(
          `UPDATE facebook_consumption_action_result_fact
              SET outcome=$5, evidence=$6::jsonb, occurred_at=$7
            WHERE action_id=$1 AND account_id=$2 AND execution_target=$3
              AND policy_revision=$4 AND source_dedupe_key=$8
              AND outcome='pending'`,
          [
            input.actionId,
            input.accountId,
            this.executionTarget,
            input.policyRevision,
            input.outcome,
            input.evidence == null ? null : JSON.stringify(input.evidence),
            new Date(input.occurredAt),
            sourceDedupeKey,
          ],
        );
      }
      if (row.state === 'terminal') {
        await client.query('COMMIT');
        return { kind: 'already_terminal', action: current };
      }
      if (input.outcome === 'pending') {
        const pending = await client.query<ActionDbRow>(
          `UPDATE facebook_consumption_action
              SET outcome='pending', version=version+1, updated_at=now()
            WHERE action_id=$1 AND account_id=$2 AND execution_target=$3
              AND policy_revision=$4
            RETURNING ${ACTION_COLUMNS}`,
          [input.actionId, input.accountId, this.executionTarget, input.policyRevision],
        );
        await client.query('COMMIT');
        return { kind: 'pending', action: actionFromDb(pending.rows[0]!) };
      }

      const terminalBlocker = row.downstream_enabled === false
        ? row.blocker ?? 'policy_superseded'
        : resultIsPositive(input.outcome)
          ? null
          : input.outcome;
      const terminal = await client.query<ActionDbRow>(
        `UPDATE facebook_consumption_action
            SET state='terminal', dispatch_phase='settled', outcome=$2, blocker=$3,
                owner_id=NULL, owner_expires_at=NULL, settled_at=$4,
                version=version+1, updated_at=now()
          WHERE action_id=$1 AND account_id=$5 AND execution_target=$6
            AND policy_revision=$7
          RETURNING ${ACTION_COLUMNS}`,
        [
          input.actionId,
          input.outcome,
          terminalBlocker,
          new Date(input.occurredAt),
          input.accountId,
          this.executionTarget,
          input.policyRevision,
        ],
      );
      const settledRow = terminal.rows[0]!;
      const progressResult = await client.query<ProgressDbRow>(
        `SELECT account_id, execution_target, policy_revision, policy_snapshot,
                revision_state, collecting_sequence, views_since_like,
                confirmed_new_likes_since_join, confirmed_new_joins_since_comment,
                next_action_sequence, active_action_id, updated_at
           FROM facebook_consumption_progress
          WHERE account_id=$1 AND execution_target=$2 AND policy_revision=$3
          FOR UPDATE`,
        [input.accountId, this.executionTarget, input.policyRevision],
      );
      const progress = progressResult.rows[0];
      let nextAction: ActionDbRow | null = null;
      if (progress?.active_action_id === input.actionId) {
        const transition = advanceFacebookConsumptionCounters({
          actionType: row.action_type,
          outcome: input.outcome,
          snapshot: snapshotFromDb(row.policy_snapshot),
          counters: {
            confirmedNewLikesSinceJoin: Number(progress.confirmed_new_likes_since_join),
            confirmedNewJoinsSinceComment: Number(progress.confirmed_new_joins_since_comment),
          },
          downstreamEnabled:
            row.downstream_enabled === true && progress.revision_state === 'active',
        });
        if (transition.nextActionType) {
          nextAction = await this.insertAction(client, {
            accountId: input.accountId,
            policyRevision: input.policyRevision,
            snapshot: snapshotFromDb(row.policy_snapshot),
            sequence: Number(progress.next_action_sequence),
            actionType: transition.nextActionType,
            triggerSourceDedupeKey: input.sourceDedupeKey,
          });
          if (!nextAction) throw new Error('facebook_consumption_next_action_conflict');
        }
        await client.query(
          `UPDATE facebook_consumption_progress
              SET confirmed_new_likes_since_join=$4,
                  confirmed_new_joins_since_comment=$5,
                  next_action_sequence=next_action_sequence+$6,
                  active_action_id=$7,
                  updated_at=now()
            WHERE account_id=$1 AND execution_target=$2 AND policy_revision=$3`,
          [
            input.accountId,
            this.executionTarget,
            input.policyRevision,
            transition.counters.confirmedNewLikesSinceJoin,
            transition.counters.confirmedNewJoinsSinceComment,
            nextAction ? 1 : 0,
            nextAction?.action_id ?? null,
          ],
        );
      }
      await client.query('COMMIT');
      return {
        kind: 'settled',
        action: actionFromDb(settledRow),
        nextAction: nextAction ? actionFromDb(nextAction) : null,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async supersedeAccount(input: {
    accountId: string;
    keepPolicyRevision?: number | null;
    reason?: string;
  }): Promise<FacebookConsumptionActionView[]> {
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN');
      const rows = await this.supersedeWithClient(
        client,
        input.accountId,
        input.keepPolicyRevision ?? null,
        input.reason?.trim() || 'policy_superseded',
      );
      await client.query('COMMIT');
      return rows.map(actionFromDb);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.ownedPool?.end();
  }

  private async setPreDispatchState(
    input: SetFacebookConsumptionPreDispatchStateInput,
    state: 'waiting_target' | 'waiting_gate' | 'ready',
    blocker: string | null,
  ): Promise<MutateFacebookConsumptionActionResult> {
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.selectActionForUpdate(
        client,
        input.actionId,
        input.accountId,
        input.policyRevision,
      );
      if (!row) {
        await client.query('COMMIT');
        return { kind: 'not_found' };
      }
      const current = actionFromDb(row);
      if (row.state === 'terminal' || row.dispatch_phase !== 'not_started') {
        await client.query('COMMIT');
        return { kind: 'invalid_state', action: current };
      }
      if (!this.ownerMatches(row, input.ownerId)) {
        await client.query('COMMIT');
        return { kind: 'owner_conflict', action: current };
      }
      if (Number(row.version) !== input.expectedVersion) {
        await client.query('COMMIT');
        return { kind: 'version_conflict', action: current };
      }
      if (state === 'ready' && !facebookConsumptionTargetIsDispatchable(
        row.action_type,
        current.target,
      )) {
        await client.query('COMMIT');
        return { kind: 'invalid_state', action: current };
      }
      if (row.state === state && row.blocker === blocker) {
        await client.query('COMMIT');
        return { kind: 'unchanged', action: current };
      }
      const updated = await client.query<ActionDbRow>(
        `UPDATE facebook_consumption_action
            SET state=$2, blocker=$3, version=version+1, updated_at=now()
          WHERE action_id=$1 AND account_id=$4 AND execution_target=$5
            AND policy_revision=$6 AND version=$7
          RETURNING ${ACTION_COLUMNS}`,
        [
          input.actionId,
          state,
          blocker,
          input.accountId,
          this.executionTarget,
          input.policyRevision,
          input.expectedVersion,
        ],
      );
      await client.query('COMMIT');
      return updated.rows[0]
        ? { kind: 'updated', action: actionFromDb(updated.rows[0]) }
        : { kind: 'version_conflict', action: current };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private ownerMatches(row: ActionDbRow, ownerId: string): boolean {
    return row.owner_id === ownerId
      && row.owner_expires_at !== null
      && new Date(row.owner_expires_at).getTime() > this.clock();
  }

  private async insertAction(
    client: pg.PoolClient,
    input: {
      accountId: string;
      policyRevision: number;
      snapshot: FacebookConsumptionPolicySnapshot;
      sequence: number;
      actionType: FacebookConsumptionActionType;
      triggerSourceDedupeKey: string;
      contentKey?: string;
      contentUrl?: string;
    },
  ): Promise<ActionDbRow | null> {
    const state: FacebookConsumptionActionState = input.actionType === 'like'
      ? 'ready'
      : 'waiting_target';
    const blocker = input.actionType === 'join'
      ? 'waiting_join_target'
      : input.actionType === 'comment'
        ? 'waiting_historical_group_target'
        : null;
    const selection = input.actionType === 'comment'
      ? 'first_commentable_group_post'
      : null;
    const actionId = randomUUID();
    const inserted = await client.query<ActionDbRow>(
      `INSERT INTO facebook_consumption_action
         (action_id, account_id, execution_target, policy_revision, policy_snapshot,
          action_sequence, action_type, idempotency_key, trigger_source_dedupe_key,
          state, blocker, content_key, content_url, selection_strategy)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT DO NOTHING
       RETURNING ${ACTION_COLUMNS}`,
      [
        actionId,
        input.accountId,
        this.executionTarget,
        input.policyRevision,
        JSON.stringify(input.snapshot),
        input.sequence,
        input.actionType,
        actionIdempotencyKey({
          accountId: input.accountId,
          executionTarget: this.executionTarget,
          policyRevision: input.policyRevision,
          sequence: input.sequence,
          actionType: input.actionType,
        }),
        input.triggerSourceDedupeKey,
        state,
        blocker,
        input.contentKey ?? null,
        input.contentUrl ?? null,
        selection,
      ],
    );
    return inserted.rows[0] ?? null;
  }

  private async selectActionForUpdate(
    client: pg.PoolClient,
    actionId: string,
    accountId: string,
    policyRevision: number,
  ): Promise<ActionDbRow | null> {
    const result = await client.query<ActionDbRow>(
      `SELECT ${ACTION_COLUMNS}
         FROM facebook_consumption_action
        WHERE action_id=$1 AND account_id=$2 AND execution_target=$3
          AND policy_revision=$4
        FOR UPDATE`,
      [actionId, accountId, this.executionTarget, policyRevision],
    );
    return result.rows[0] ?? null;
  }

  private async selectAccountActiveActionForUpdate(
    client: pg.PoolClient,
    accountId: string,
  ): Promise<ActionDbRow | null> {
    const result = await client.query<ActionDbRow>(
      `SELECT ${ACTION_COLUMNS}
         FROM facebook_consumption_action
        WHERE account_id=$1 AND execution_target=$2 AND state <> 'terminal'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE`,
      [accountId, this.executionTarget],
    );
    return result.rows[0] ?? null;
  }

  private async findAccountActiveAction(accountId: string): Promise<ActionDbRow | null> {
    const result = await this.runtimePool.query<ActionDbRow>(
      `SELECT ${ACTION_COLUMNS}
         FROM facebook_consumption_action
        WHERE account_id=$1 AND execution_target=$2 AND state <> 'terminal'
        ORDER BY created_at ASC
        LIMIT 1`,
      [accountId, this.executionTarget],
    );
    return result.rows[0] ?? null;
  }

  private async supersedeWithClient(
    client: pg.PoolClient,
    accountId: string,
    keepPolicyRevision: number | null,
    reason: string,
  ): Promise<ActionDbRow[]> {
    await client.query(
      `UPDATE facebook_consumption_progress
          SET revision_state='superseded', superseded_at=COALESCE(superseded_at, now()),
              updated_at=now()
        WHERE account_id=$1 AND execution_target=$2
          AND ($3::bigint IS NULL OR policy_revision <> $3)
          AND revision_state <> 'superseded'`,
      [accountId, this.executionTarget, keepPolicyRevision],
    );
    const updated = await client.query<ActionDbRow>(
      `UPDATE facebook_consumption_action
          SET downstream_enabled=false,
              state=CASE WHEN dispatch_phase='not_started' THEN 'terminal' ELSE state END,
              dispatch_phase=CASE
                WHEN dispatch_phase='not_started' THEN 'settled'
                ELSE dispatch_phase
              END,
              outcome=CASE
                WHEN dispatch_phase='not_started' THEN 'policy_superseded'
                ELSE outcome
              END,
              blocker=$4,
              settled_at=CASE
                WHEN dispatch_phase='not_started' THEN now()
                ELSE settled_at
              END,
              owner_id=CASE WHEN dispatch_phase='not_started' THEN NULL ELSE owner_id END,
              owner_expires_at=CASE
                WHEN dispatch_phase='not_started' THEN NULL ELSE owner_expires_at
              END,
              version=version+1,
              updated_at=now()
        WHERE account_id=$1 AND execution_target=$2
          AND ($3::bigint IS NULL OR policy_revision <> $3)
          AND state <> 'terminal'
        RETURNING ${ACTION_COLUMNS}`,
      [accountId, this.executionTarget, keepPolicyRevision, reason],
    );
    const terminalIds = updated.rows
      .filter((row) => row.state === 'terminal')
      .map((row) => row.action_id);
    if (terminalIds.length > 0) {
      await client.query(
        `UPDATE facebook_consumption_progress
            SET active_action_id=NULL, updated_at=now()
          WHERE account_id=$1 AND execution_target=$2
            AND active_action_id = ANY($3::uuid[])`,
        [accountId, this.executionTarget, terminalIds],
      );
    }
    return updated.rows;
  }

  private async recoverExpiredClaims(): Promise<void> {
    await this.runtimePool.query(
      `UPDATE facebook_consumption_action
          SET owner_id=NULL, owner_expires_at=NULL, version=version+1, updated_at=now()
        WHERE execution_target=$1 AND state <> 'terminal'
          AND owner_expires_at IS NOT NULL AND owner_expires_at <= now()`,
      [this.executionTarget],
    );
  }
}
