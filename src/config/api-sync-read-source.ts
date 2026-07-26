import type pg from 'pg';

import type { DeploymentTarget } from '../deployment-target.js';
import { DEFAULT_HOT_LEAD_GATE_CONFIG } from '../kernel/hot-lead-gate-config.js';
import type { ConfigMirrorKey } from '../kernel/config-mirror-bump-types.js';
import {
  makeSyncReadFactEnvelope,
  type AccountPersonaSnapshot,
  type AutomationAccountProjectionSnapshot,
  type ClientEnvironmentAutomationSnapshot,
  type ContentScheduleSnapshot,
  type FacebookCommentConfigSnapshot,
  type FacebookGroupJoinAutomationConfigSnapshot,
  type HotLeadConfigSnapshot,
  type SyncReadOwnerSnapshotSource,
  type SyncReadPayloadByStream,
} from '../kernel/sync-read-facts.js';
import type {
  SyncReadJson,
  SyncReadSnapshotEnvelope,
  SyncReadStream,
} from '../kernel/sync-read-snapshot.js';

const SHARED_FACT_FRESH_MS = 5 * 60_000;

type ApiOwnedStream =
  | 'account_persona'
  | 'client_environment_automation'
  | 'automation_account_projection'
  | 'content_schedule'
  | 'hot_lead_config'
  | 'facebook_comment_config'
  | 'facebook_group_join_automation_config';

export interface ApiSyncReadSourceOptions {
  executionTarget: DeploymentTarget;
  pool: pg.Pool;
  parseSoul(personaText: string): SyncReadJson | null;
}

export class ApiSyncReadSnapshotSource implements SyncReadOwnerSnapshotSource {
  private readonly executionTarget: DeploymentTarget;
  private readonly pool: pg.Pool;
  private readonly parseSoul: (personaText: string) => SyncReadJson | null;

  constructor(options: ApiSyncReadSourceOptions) {
    this.executionTarget = options.executionTarget;
    this.pool = options.pool;
    this.parseSoul = options.parseSoul;
  }

  async snapshot<S extends SyncReadStream>(
    stream: S,
    observedAt = Date.now(),
  ): Promise<SyncReadSnapshotEnvelope<any>> {
    if (!isApiOwnedStream(stream)) {
      throw new Error(`sync_read_stream_not_owned_by_api:${stream}`);
    }
    const loaded = await this.load(stream);
    return makeSyncReadFactEnvelope({
      executionTarget: this.executionTarget,
      stream,
      cursor: loaded.cursor,
      asOf: observedAt,
      freshUntil: observedAt + SHARED_FACT_FRESH_MS,
      value: loaded.value,
    });
  }

  private async load<S extends ApiOwnedStream>(
    stream: S,
  ): Promise<{
    cursor: string;
    value: SyncReadPayloadByStream[S];
  }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await this.loadInTransaction(client, stream);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadInTransaction<S extends ApiOwnedStream>(
    client: pg.PoolClient,
    stream: S,
  ): Promise<{
    cursor: string;
    value: SyncReadPayloadByStream[S];
  }> {
    switch (stream) {
      case 'account_persona': {
        const cursor = await versionCursor(client, ['persona_config']);
        const { rows } = await client.query<{
          account_id: string;
          persona: string;
        }>(
          `SELECT account_id, persona
             FROM persona_config
            ORDER BY account_id`,
        );
        const value: AccountPersonaSnapshot = {
          accounts: rows
            .filter((row) => row.persona.trim().length > 0)
            .map((row) => ({
              accountId: row.account_id,
              personaText: row.persona,
              soul: this.parseSoul(row.persona),
            })),
        };
        return { cursor, value } as {
          cursor: string;
          value: SyncReadPayloadByStream[S];
        };
      }
      case 'client_environment_automation': {
        const cursor = await versionCursor(client, [
          'client_environment_automation_gate',
          'client_environment_slow_start',
        ]);
        const { rows } = await client.query<{
          env_key: string;
          lifecycle_state: string;
          account_id: string | null;
          slow_start_since: Date | string | null;
        }>(
          `SELECT env_key, lifecycle_state, account_id, slow_start_since
             FROM client_environments
            ORDER BY env_key`,
        );
        const grouped = new Map<string, Array<number | null>>();
        for (const row of rows) {
          const accountId = row.account_id?.trim();
          if (!accountId || accountId === 'default') continue;
          const values = grouped.get(accountId) ?? [];
          values.push(
            row.slow_start_since === null
              ? null
              : new Date(row.slow_start_since).getTime(),
          );
          grouped.set(accountId, values);
        }
        const value: ClientEnvironmentAutomationSnapshot = {
          blockedEnvironmentKeys: rows
            .filter((row) => row.lifecycle_state !== 'active')
            .map((row) => row.env_key),
          slowStartAnchors: [...grouped]
            .map(([accountId, values]) => ({
              accountId,
              slowStartSince: values.length === 1 ? values[0]! : null,
              ambiguous: values.length !== 1,
            }))
            .sort((a, b) => a.accountId.localeCompare(b.accountId)),
        };
        return { cursor, value } as {
          cursor: string;
          value: SyncReadPayloadByStream[S];
        };
      }
      case 'automation_account_projection': {
        const cursor = await versionCursor(client, ['account_status']);
        const { rows } = await client.query<{
          account_id: string;
          platform: string | null;
          group_label: string | null;
          created_at: Date | string | null;
          status: string;
        }>(
          `SELECT account_id, platform, group_label, created_at, status
             FROM accounts
            ORDER BY account_id`,
        );
        const value: AutomationAccountProjectionSnapshot = {
          accounts: rows
            .filter((row) => row.account_id !== 'default')
            .map((row) => ({
              accountId: row.account_id,
              platform: row.platform ?? '',
              groupLabel: row.group_label ?? null,
              createdAt:
                row.created_at === null
                  ? null
                  : new Date(row.created_at).getTime(),
              status: row.status === 'paused' ? 'paused' : 'active',
            })),
        };
        return { cursor, value } as {
          cursor: string;
          value: SyncReadPayloadByStream[S];
        };
      }
      case 'content_schedule': {
        const cursor = await versionCursor(client, ['content_schedule']);
        const [global, accounts] = await Promise.all([
          client.query<{ content_active_mask: string | null }>(
            `SELECT content_active_mask
               FROM content_schedule_global
              WHERE id=1`,
          ),
          client.query<{
            account_id: string;
            auto_enabled: boolean;
            post_enabled: boolean;
            post_mode: string | null;
            post_daily_cap: number | string;
            comment_enabled: boolean;
            comment_mode: string | null;
            comment_daily_cap: number | string;
            contact_comment_enabled: boolean;
            contact_comment_mode: string | null;
            contact_comment_daily_cap: number | string;
            active_week_mask: string | null;
            content_active_mask: string | null;
          }>(
            `SELECT account_id, auto_enabled, post_enabled, post_mode, post_daily_cap,
                    comment_enabled, comment_mode, comment_daily_cap,
                    contact_comment_enabled, contact_comment_mode,
                    contact_comment_daily_cap, active_week_mask, content_active_mask
               FROM account_content_schedule
              ORDER BY account_id`,
          ),
        ]);
        const value: ContentScheduleSnapshot = {
          global: global.rows[0]
            ? { contentActiveMask: global.rows[0].content_active_mask ?? null }
            : null,
          accounts: accounts.rows.map((row) => ({
            accountId: row.account_id,
            autoEnabled: row.auto_enabled === true,
            postMode: actionMode(row.post_mode, row.post_enabled),
            postDailyCap: Number(row.post_daily_cap),
            commentMode: actionMode(row.comment_mode, row.comment_enabled),
            commentDailyCap: Number(row.comment_daily_cap),
            contactCommentMode: actionMode(
              row.contact_comment_mode,
              row.contact_comment_enabled,
            ),
            contactCommentDailyCap: Number(row.contact_comment_daily_cap),
            activeWeekMask: row.active_week_mask ?? null,
            contentActiveMask: row.content_active_mask ?? null,
          })),
        };
        return { cursor, value } as {
          cursor: string;
          value: SyncReadPayloadByStream[S];
        };
      }
      case 'hot_lead_config': {
        const cursor = await versionCursor(client, ['hot_lead_config']);
        const { rows } = await client.query<{
          post_age_max_hours: number | string | null;
          velocity_min: number | string | null;
          min_like_floor: number | string | null;
        }>(
          `SELECT post_age_max_hours, velocity_min, min_like_floor
             FROM hot_lead_config_global
            WHERE id=1`,
        );
        const row = rows[0];
        const value: HotLeadConfigSnapshot = {
          maxAgeHours: positiveInt(row?.post_age_max_hours) ??
            DEFAULT_HOT_LEAD_GATE_CONFIG.maxAgeHours,
          velocityMin: positiveInt(row?.velocity_min) ??
            DEFAULT_HOT_LEAD_GATE_CONFIG.velocityMin,
          minLikeFloor: positiveInt(row?.min_like_floor) ??
            DEFAULT_HOT_LEAD_GATE_CONFIG.minLikeFloor,
          floorHours: DEFAULT_HOT_LEAD_GATE_CONFIG.floorHours,
        };
        return { cursor, value } as {
          cursor: string;
          value: SyncReadPayloadByStream[S];
        };
      }
      case 'facebook_comment_config': {
        const cursor = await versionCursor(client, ['facebook_comment_config']);
        const { rows } = await client.query<{
          account_id: string;
          keywords: unknown;
          containers: unknown;
          comment_mode: unknown;
          comment_templates: unknown;
        }>(
          `SELECT account_id, keywords, containers, comment_mode, comment_templates
             FROM account_facebook_comment_config
            ORDER BY account_id`,
        );
        const value: FacebookCommentConfigSnapshot = {
          accounts: rows.map((row) => ({
            accountId: row.account_id,
            keywords: stringList(row.keywords),
            containers: containerList(row.containers),
            commentMode:
              row.comment_mode === 'templates' ? 'templates' : 'generated',
            commentTemplates: stringList(row.comment_templates),
          })),
        };
        return { cursor, value } as {
          cursor: string;
          value: SyncReadPayloadByStream[S];
        };
      }
      case 'facebook_group_join_automation_config': {
        const cursor = await versionCursor(client, [
          'facebook_group_join_automation_config',
        ]);
        const { rows } = await client.query<{
          account_id: string;
          enabled: boolean;
          daily_cap: number | string;
          week_mask: string | null;
        }>(
          `SELECT account_id, enabled, daily_cap, week_mask
             FROM facebook_group_join_automation_config
            ORDER BY account_id`,
        );
        const value: FacebookGroupJoinAutomationConfigSnapshot = {
          accounts: rows.map((row) => ({
            accountId: row.account_id,
            enabled: row.enabled === true,
            dailyCap: Number(row.daily_cap),
            weekMask: row.week_mask ?? null,
          })),
        };
        return { cursor, value } as {
          cursor: string;
          value: SyncReadPayloadByStream[S];
        };
      }
    }
  }
}

async function versionCursor(
  client: pg.PoolClient,
  keys: readonly ConfigMirrorKey[],
): Promise<string> {
  const { rows } = await client.query<{
    mirror_key: string;
    version: number | string;
  }>(
    `SELECT mirror_key, version
       FROM config_mirror_version
      WHERE mirror_key = ANY($1::text[])
      ORDER BY mirror_key`,
    [keys],
  );
  const versions = new Map(
    rows.map((row) => [row.mirror_key, BigInt(row.version)]),
  );
  return keys
    .map((key) => versions.get(key) ?? 0n)
    .reduce((cursor, version) => cantor(cursor, version), 0n)
    .toString();
}

function cantor(left: bigint, right: bigint): bigint {
  const sum = left + right;
  return (sum * (sum + 1n)) / 2n + right;
}

function isApiOwnedStream(stream: SyncReadStream): stream is ApiOwnedStream {
  return (
    stream === 'account_persona' ||
    stream === 'client_environment_automation' ||
    stream === 'automation_account_projection' ||
    stream === 'content_schedule' ||
    stream === 'hot_lead_config' ||
    stream === 'facebook_comment_config' ||
    stream === 'facebook_group_join_automation_config'
  );
}

function actionMode(
  value: string | null,
  enabled: boolean,
): 'off' | 'review' | 'auto_approve' {
  return value === 'review' || value === 'auto_approve'
    ? value
    : enabled
      ? 'review'
      : 'off';
}

function positiveInt(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function containerList(
  value: unknown,
): Array<{ url: string; name?: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ url: string; name?: string }> = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ url: item.trim() });
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.url !== 'string' || !row.url.trim()) continue;
    const name =
      typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : undefined;
    out.push(name ? { url: row.url.trim(), name } : { url: row.url.trim() });
  }
  return out;
}
