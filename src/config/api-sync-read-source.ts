import type pg from 'pg';

import type { DeploymentTarget } from '../deployment-target.js';
import { resolveHotLeadGateConfig } from '../kernel/hot-lead-gate-config.js';
import {
  coerceFacebookCommentMode,
  facebookCommentModeToWire,
} from '../kernel/facebook-comment-config-types.js';
import type { FacebookOperationPolicyBaseProjection } from '../kernel/facebook-operation-policy-resolution.js';
import type { ConfigMirrorKey } from '../kernel/config-mirror-bump-types.js';
import {
  makeSyncReadFactEnvelope,
  type AccountPersonaSnapshot,
  type AutomationAccountProjectionSnapshot,
  type ClientEnvironmentAutomationSnapshot,
  type ContentScheduleSnapshot,
  type FacebookCommentConfigSnapshot,
  type FacebookGroupJoinAutomationConfigSnapshot,
  type FacebookOperationPolicySnapshot,
  type FacebookSlowStartPolicySnapshot,
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
  | 'facebook_group_join_automation_config'
  | 'facebook_operation_policy';

export interface ApiSyncReadSourceOptions {
  executionTarget: DeploymentTarget;
  pool: pg.Pool;
  parseSoul(personaText: string): SyncReadJson | null;
  /**
   * Facebook 运营策略整份载荷的取用口（**必填、无默认**）。
   *
   * 刻意不在本文件用 SQL 重算一遍：那三张表的合成规则（全局默认 ← 环境覆盖 ← legacy 回落）
   * 住在属主存储里，抄第二份的现形方式不是报错，而是两个进程按不同节奏跑同一个环境。
   * 也刻意不做成可选：缺实现时回落空表 = 告诉自动化进程「这台机器上没有任何 Facebook 环境」，
   * 于是每个 FB 账号都被一个**错误原因**永久拦住 —— 那正是本 change 的红线形态。
   *
   * **逐环境基线与全局慢启动曲线合成一个取用口，不是两个**：两个口意味着两次取值，
   * 而属主存储是「先刷新、再读内存」的形态 ⇒ 分两次就多出「基线取自刷新后、曲线取自刷新前」
   * 这种错配，且两边都不报错。一个口 = 一次刷新一次读，错配在结构上不成立。
   */
  facebookOperationPolicy(): Promise<FacebookOperationPolicySnapshot>;
}

export interface FacebookOperationPolicyBaselineStore {
  refreshFromAuthority(): Promise<void>;
  baselineProjections(): readonly FacebookOperationPolicyBaseProjection[];
  /**
   * 当前执行目标的慢启动总天数与逐日上限。
   *
   * 属主自己**未配置全局行时会回落编译默认**而不是抛 —— 这条回落在本路径上是安全的，
   * 因为发布前 `refreshFromAuthority()` 已经 await 过：读不到库会当场抛、整条快照不发出，
   * 而不是发出一份「看着正常的默认曲线」。真正回落到默认时，那个默认**也正是属主自己
   * 在用的生效值**（单体里风控拿到的就是它），发过去逐位一致、零回归。
   */
  slowStartRuntimePolicy(): FacebookSlowStartPolicySnapshot;
}

export interface ApiSyncReadCompositionOptions extends Omit<
  ApiSyncReadSourceOptions,
  'facebookOperationPolicy'
> {
  /** Late-bound because segA assigns the store after the API source is described. */
  facebookOperationPolicyStore(): FacebookOperationPolicyBaselineStore;
}

/**
 * Production composition seam shared by monolith and `AIDCP_SERVICE=api`.
 * Refreshing before projection prevents publishing a new cursor with stale
 * policy data. Missing stores and refresh failures remain loud; an empty
 * fallback would falsely mean that this deployment has no Facebook envs.
 */
export function createApiSyncReadSnapshotSource(
  options: ApiSyncReadCompositionOptions,
): ApiSyncReadSnapshotSource {
  return new ApiSyncReadSnapshotSource({
    executionTarget: options.executionTarget,
    pool: options.pool,
    parseSoul: options.parseSoul,
    facebookOperationPolicy: async () => {
      const store = options.facebookOperationPolicyStore();
      await store.refreshFromAuthority();
      // 刷新之后**同一个存储实例**上取两样，顺序无关紧要、错配不可能发生。
      return {
        environments: store.baselineProjections(),
        slowStart: store.slowStartRuntimePolicy(),
      };
    },
  });
}

export class ApiSyncReadSnapshotSource implements SyncReadOwnerSnapshotSource {
  private readonly executionTarget: DeploymentTarget;
  private readonly pool: pg.Pool;
  private readonly parseSoul: (personaText: string) => SyncReadJson | null;
  private readonly facebookOperationPolicy: () => Promise<FacebookOperationPolicySnapshot>;

  constructor(options: ApiSyncReadSourceOptions) {
    this.executionTarget = options.executionTarget;
    this.pool = options.pool;
    this.parseSoul = options.parseSoul;
    this.facebookOperationPolicy = options.facebookOperationPolicy;
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
          slow_start_completed_at: Date | string | null;
        }>(
          `SELECT e.env_key,e.lifecycle_state,e.account_id,e.slow_start_since,
                  (SELECT c.completed_at
                     FROM facebook_environment_slow_start_completion c
                    WHERE c.env_key=e.env_key AND c.execution_target=$1)
                    AS slow_start_completed_at
             FROM client_environments e
            ORDER BY env_key`,
          [this.executionTarget],
        );
        const value = projectClientEnvironmentAutomationSnapshot(rows);
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
        // 逐项回落判定取 kernel 那一份：属主存储的现读口调的是同一个函数，
        // 两处各写一份的现形方式不是报错，而是两个进程按不同阈值筛帖。
        const value: HotLeadConfigSnapshot = resolveHotLeadGateConfig({
          postAgeMaxHours: row?.post_age_max_hours,
          velocityMin: row?.velocity_min,
          minLikeFloor: row?.min_like_floor,
        });
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
          comment_mode_configured: boolean;
          comment_templates: unknown;
        }>(
          `SELECT account_id, keywords, containers, comment_mode,
                  comment_mode_configured, comment_templates
             FROM account_facebook_comment_config
            ORDER BY account_id`,
        );
        const value: FacebookCommentConfigSnapshot = {
          accounts: rows.map((row) => ({
            accountId: row.account_id,
            keywords: stringList(row.keywords),
            containers: containerList(row.containers),
            // 库列（单数 template）→ 领域 → 线缆（复数 templates）：两跳都取 kernel 的具名出口，
            // 别在此写字面量——线缆与领域刻意不同字面量，手写一份漂了不报错。
            commentMode: facebookCommentModeToWire(
              coerceFacebookCommentMode(row.comment_mode),
            ),
            commentModeConfigured: row.comment_mode_configured === true,
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
      case 'facebook_operation_policy': {
        // **游标先读、基线后取**，顺序是有意的：
        // 反过来（先取基线再读游标）会发出「新游标 + 旧基线」，消费方按新游标存下旧值、
        // 且下一轮游标没变就不会再拉 —— 那是会一直错下去的静默陈旧。
        // 现在这个顺序最坏只是「旧游标 + 新基线」，下一轮游标一变就重取，多一次拉取而已。
        const cursor = await versionCursor(client, [
          'facebook_operation_policy',
        ]);
        const value: FacebookOperationPolicySnapshot = await this.facebookOperationPolicy();
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
    stream === 'facebook_group_join_automation_config' ||
    stream === 'facebook_operation_policy'
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

/**
 * 「环境行 → 客户端环境自动化快照」的**纯投影段**（批 H 析出）。
 *
 * 析出的理由不是好看：跨进程载荷的键集不变量**必须用生产者的真输出过真校验器**才算证明。
 * 埋在读库的分支里就只能靠手写夹具，而手写夹具证明的是「契约自洽」——
 * 已经实测过一次：夹具照类型手写、恰好少两个键，多带键的真产出物一路绿到线上。
 */
export function projectClientEnvironmentAutomationSnapshot(
  rows: readonly {
    env_key: string;
    lifecycle_state: string;
    account_id: string | null;
    slow_start_since: Date | string | null;
    slow_start_completed_at: Date | string | null;
  }[],
): ClientEnvironmentAutomationSnapshot {
  const grouped = new Map<string, Array<{
    envKey: string;
    since: number | null;
    completedAt: number | null;
  }>>();
  for (const row of rows) {
    const accountId = row.account_id?.trim();
    if (!accountId || accountId === 'default') continue;
    const values = grouped.get(accountId) ?? [];
    values.push({
      // 批 H：环境键随锚点一起发。这一列本来就在查询里，只是此前没进载荷 ——
      // 而自动化进程解析 Facebook 运营基线**必须**有它（拿不到基线 = 那个账号永远不开始浏览）。
      envKey: row.env_key,
      since: row.slow_start_since === null
        ? null
        : new Date(row.slow_start_since).getTime(),
      completedAt: row.slow_start_completed_at === null
        ? null
        : new Date(row.slow_start_completed_at).getTime(),
    });
    grouped.set(accountId, values);
  }
  return {
    blockedEnvironmentKeys: rows
      .filter((row) => row.lifecycle_state !== 'active')
      .map((row) => row.env_key),
    slowStartAnchors: [...grouped]
      .map(([accountId, values]) => ({
        accountId,
        // 歧义时**恒 null**：挑其中一个发过去等于替下游做了一个它复核不了的选择。
        // 与下面三个字段同一条判据，故用同一个 `values.length === 1`。
        envKey: values.length === 1 ? values[0]!.envKey : null,
        slowStartSince: values.length === 1 ? values[0]!.since : null,
        slowStartCompletedAt: values.length === 1
          ? values[0]!.completedAt
          : null,
        ambiguous: values.length !== 1,
      }))
      .sort((a, b) => a.accountId.localeCompare(b.accountId)),
  };
}
