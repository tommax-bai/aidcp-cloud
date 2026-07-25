import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { resolveEnvPgConfig } from '../kernel/pg-config.js';
import { normalizeReplyProfile, validateReplyConfig } from './reply-config.js';
import {
  DEFAULT_REPLY_POLICY,
  INTERACTION_PLATFORM,
  InteractionError,
  type InteractionChannel,
  type ReplyConfigScopeHead,
  type ReplyConfigScopeSummary,
  type ReplyConfigSnapshot,
  type ReplyConfigSource,
  type ReplyPolicy,
  type ReplyProfile,
  type ReplyRule,
  type ReplyTemplate,
} from '../kernel/interaction-types.js';
import type { ConfigAuditItem } from './reply-config-store.js';

const { Pool } = pg;

type ScopeAction = 'draft_saved' | 'template_archived' | 'config_initialized' | 'config_published' | 'previewed';

interface ScopeRow {
  scope_id: string;
  scope_type: ReplyConfigSource['type'];
  group_label: string | null;
  current_version: number | string;
  draft_version: number | string | null;
  published_version: number | string | null;
  updated_at: Date | string;
  updated_by: string;
  member_count?: number | string;
}

interface VersionRow {
  config_version: number | string;
  state: 'draft' | 'published';
  policy: ReplyPolicy;
  templates: ReplyTemplate[];
  rules: ReplyRule[];
  profiles: ReplyProfile[];
  created_at: Date | string;
  created_by: string;
  published_at: Date | string | null;
  published_by: string | null;
}

function epoch(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function sourceOf(row: Pick<ScopeRow, 'scope_type' | 'group_label'>): ReplyConfigSource {
  return { type: row.scope_type, groupLabel: row.scope_type === 'group' ? row.group_label : null };
}

function memberCountSql(alias = 's'): string {
  return `(SELECT count(*)::int FROM accounts a WHERE a.platform='wechat_channels' AND
    ((${alias}.scope_type='group' AND a.group_label=${alias}.group_label) OR
     (${alias}.scope_type='default' AND a.group_label IS NULL)))`;
}

function toHead(row: ScopeRow): ReplyConfigScopeHead {
  return {
    scopeId: row.scope_id,
    platform: INTERACTION_PLATFORM,
    source: sourceOf(row),
    memberCount: Number(row.member_count ?? 0),
    currentVersion: Number(row.current_version),
    draftVersion: row.draft_version === null ? null : Number(row.draft_version),
    publishedVersion: row.published_version === null ? null : Number(row.published_version),
    updatedAt: epoch(row.updated_at),
    updatedBy: row.updated_by,
  };
}

function defaultProfile(channel: InteractionChannel): ReplyProfile {
  return {
    channel,
    selfName: '我们',
    userAddress: '你好',
    tone: ['professional', 'friendly', 'concise'],
    maxLength: channel === 'comment' ? 280 : 500,
    allowEmoji: false,
    allowLinks: false,
    blockedPhrases: [],
    disallowedClaims: [],
    requiredDisclaimer: null,
    knowledgeDocument: null,
    variableFallbacks: {
      user_name: '你好',
      video_title: '这条内容',
      account_name: '我们',
      support_channel: '人工客服',
    },
  };
}

function emptySnapshot(scopeId: string, source: ReplyConfigSource, version: number, actor: string): ReplyConfigSnapshot {
  return {
    accountId: '',
    configScopeId: scopeId,
    configSource: source,
    platform: INTERACTION_PLATFORM,
    configVersion: version,
    state: 'draft',
    policy: structuredClone(DEFAULT_REPLY_POLICY),
    templates: [],
    rules: [],
    profiles: [defaultProfile('comment'), defaultProfile('dm')],
    createdAt: Date.now(),
    createdBy: actor,
    publishedAt: null,
    publishedBy: null,
  };
}

export class ReplyConfigScopeStore {
  private readonly pool: pg.Pool;
  /**
   * 本实例是否**自己建的**连接池。组合根注入属主池（automationPool）时为 false ——
   * 那个池被本域十几个 store 共用，`close()` MUST NOT 把它 end 掉。
   *
   * 这不是洁癖：互动域的构造被 try/catch 包着（schema/迁移未就位时整域降级不启用），
   * 失败分支会调本 store 的 `close()`。若那时 end 了共享池，一次**局部**子系统失败会升级成
   * 进程级瘫痪（其余 automation store 全部「Cannot use a pool after calling end」）。
   */
  private readonly ownsPool: boolean;
  private readonly idGen: (prefix: string) => string;

  constructor(options: { pool?: pg.Pool; idGen?: (prefix: string) => string } = {}) {
    this.pool = options.pool ?? new Pool(resolveEnvPgConfig());
    this.ownsPool = options.pool === undefined;
    this.idGen = options.idGen ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  async init(): Promise<void> {
    // 硬编码 schema 名**故意不收口**到 qualifiedObjectName()：api 层文件引 automation 层 schema-name.ts 会撞
    // AC-BOUND-06 冻结的 import 棘轮（详见 reply-config-store.ts init 同款说明）。等 §4.7 归属裁决后再收口。
    const { rows } = await this.pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.interaction_reply_config_scopes') IS NOT NULL
          AND to_regclass('public.interaction_reply_scope_versions') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='interaction_reply_jobs' AND column_name='config_scope_id'
          ) AS present`,
    );
    if (rows[0]?.present !== true) throw new Error('interaction_scope_config_schema_missing_run_0048');
  }

  async ensureScope(source: ReplyConfigSource, actor: string): Promise<ReplyConfigScopeHead> {
    const clean = source.type === 'group' ? (source.groupLabel ?? '').trim() : null;
    if (source.type === 'group' && !clean) {
      throw new InteractionError('INTERACTION_VALIDATION_FAILED', '分组名称不能为空。', 422);
    }
    const scopeId = this.idGen('scope');
    await this.pool.query(
      `INSERT INTO interaction_reply_config_scopes
        (scope_id,platform,scope_type,group_label,current_version,draft_version,published_version,updated_at,updated_by)
       VALUES ($1,$2,$3,$4,0,NULL,NULL,now(),$5)
       ON CONFLICT DO NOTHING`,
      [scopeId, INTERACTION_PLATFORM, source.type, clean, actor],
    );
    const head = await this.getScopeBySource({ type: source.type, groupLabel: clean });
    if (!head) throw new Error('reply_config_scope_create_failed');
    return head;
  }

  async getHead(scopeId: string): Promise<ReplyConfigScopeHead | null> {
    const { rows } = await this.pool.query<ScopeRow>(
      `SELECT s.*,${memberCountSql('s')} AS member_count
         FROM interaction_reply_config_scopes s WHERE s.platform=$1 AND s.scope_id=$2`,
      [INTERACTION_PLATFORM, scopeId],
    );
    return rows[0] ? toHead(rows[0]) : null;
  }

  async getScopeBySource(source: ReplyConfigSource): Promise<ReplyConfigScopeHead | null> {
    const clean = source.type === 'group' ? (source.groupLabel ?? '').trim() : null;
    const { rows } = await this.pool.query<ScopeRow>(
      `SELECT s.*,${memberCountSql('s')} AS member_count
         FROM interaction_reply_config_scopes s
        WHERE s.platform=$1 AND s.scope_type=$2
          AND (($2='default' AND s.group_label IS NULL) OR ($2='group' AND s.group_label=$3))`,
      [INTERACTION_PLATFORM, source.type, clean],
    );
    return rows[0] ? toHead(rows[0]) : null;
  }

  async listScopes(): Promise<ReplyConfigScopeSummary[]> {
    const [scopeRows, groupRows, ungrouped] = await Promise.all([
      this.pool.query<ScopeRow>(
        `SELECT s.*,${memberCountSql('s')} AS member_count
           FROM interaction_reply_config_scopes s WHERE s.platform=$1
          ORDER BY CASE WHEN s.scope_type='default' THEN 0 ELSE 1 END,s.group_label`,
        [INTERACTION_PLATFORM],
      ),
      this.pool.query<{ group_label: string; member_count: number | string }>(
        `SELECT group_label,count(*)::int AS member_count FROM accounts
          WHERE platform=$1 AND group_label IS NOT NULL GROUP BY group_label ORDER BY group_label`,
        [INTERACTION_PLATFORM],
      ),
      this.pool.query<{ member_count: number | string }>(
        `SELECT count(*)::int AS member_count FROM accounts WHERE platform=$1 AND group_label IS NULL`,
        [INTERACTION_PLATFORM],
      ),
    ]);
    const byKey = new Map<string, ReplyConfigScopeSummary>();
    for (const row of scopeRows.rows) {
      const head = toHead(row);
      const key = head.source.type === 'default' ? 'default' : `group:${head.source.groupLabel}`;
      byKey.set(key, { ...head });
    }
    if (!byKey.has('default')) {
      byKey.set('default', {
        scopeId: null, platform: INTERACTION_PLATFORM, source: { type: 'default', groupLabel: null },
        memberCount: Number(ungrouped.rows[0]?.member_count ?? 0), currentVersion: 0,
        draftVersion: null, publishedVersion: null, updatedAt: null, updatedBy: null,
      });
    }
    for (const row of groupRows.rows) {
      const key = `group:${row.group_label}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          scopeId: null, platform: INTERACTION_PLATFORM, source: { type: 'group', groupLabel: row.group_label },
          memberCount: Number(row.member_count), currentVersion: 0,
          draftVersion: null, publishedVersion: null, updatedAt: null, updatedBy: null,
        });
      }
    }
    return [...byKey.values()].sort((left, right) => {
      if (left.source.type !== right.source.type) return left.source.type === 'default' ? -1 : 1;
      return (left.source.groupLabel ?? '').localeCompare(right.source.groupLabel ?? '', 'zh');
    });
  }

  async sourceForAccount(accountId: string): Promise<ReplyConfigSource | null> {
    const { rows } = await this.pool.query<{ platform: string; group_label: string | null }>(
      `SELECT platform,group_label FROM accounts WHERE account_id=$1`, [accountId],
    );
    const account = rows[0];
    if (!account || account.platform !== INTERACTION_PLATFORM) return null;
    return account.group_label === null
      ? { type: 'default', groupLabel: null }
      : { type: 'group', groupLabel: account.group_label };
  }

  async accountMatchesScope(accountId: string, scopeId: string): Promise<boolean> {
    const [source, head] = await Promise.all([this.sourceForAccount(accountId), this.getHead(scopeId)]);
    return !!source && !!head && source.type === head.source.type && source.groupLabel === head.source.groupLabel;
  }

  async getSnapshot(
    scopeId: string,
    selector: 'draft' | 'published' | number,
    accountId = '',
  ): Promise<ReplyConfigSnapshot | null> {
    const head = await this.getHead(scopeId);
    if (!head) return null;
    const version = typeof selector === 'number'
      ? selector
      : selector === 'draft' ? head.draftVersion : head.publishedVersion;
    if (version === null) return null;
    const { rows } = await this.pool.query<VersionRow>(
      `SELECT config_version,state,policy,templates,rules,profiles,created_at,created_by,published_at,published_by
         FROM interaction_reply_scope_versions WHERE scope_id=$1 AND config_version=$2`,
      [scopeId, version],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      accountId,
      configScopeId: scopeId,
      configSource: head.source,
      platform: INTERACTION_PLATFORM,
      configVersion: Number(row.config_version),
      state: row.state,
      policy: row.policy,
      templates: row.templates,
      rules: row.rules,
      profiles: row.profiles.map(normalizeReplyProfile),
      createdAt: epoch(row.created_at),
      createdBy: row.created_by,
      publishedAt: row.published_at ? epoch(row.published_at) : null,
      publishedBy: row.published_by,
    };
  }

  private async mutate(
    scopeId: string,
    expectedVersion: number,
    actor: string,
    action: ScopeAction,
    entityType: string,
    entityId: string | null,
    change: (snapshot: ReplyConfigSnapshot) => void,
  ): Promise<ReplyConfigSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ScopeRow>(
        `SELECT * FROM interaction_reply_config_scopes WHERE platform=$1 AND scope_id=$2 FOR UPDATE`,
        [INTERACTION_PLATFORM, scopeId],
      );
      const row = rows[0];
      if (!row) throw new InteractionError('INTERACTION_NOT_FOUND', '回复策略作用域不存在。', 404);
      if (Number(row.current_version) !== expectedVersion) {
        throw new InteractionError('INTERACTION_VERSION_CONFLICT', '配置版本已变化，请刷新后重试。', 409, false, {
          currentVersion: Number(row.current_version),
        });
      }
      const source = sourceOf(row);
      const baseVersion = row.draft_version === null ? row.published_version : row.draft_version;
      const nextVersion = Number(row.current_version) + 1;
      let snapshot: ReplyConfigSnapshot;
      if (baseVersion === null) snapshot = emptySnapshot(scopeId, source, nextVersion, actor);
      else {
        const base = await client.query<VersionRow>(
          `SELECT config_version,state,policy,templates,rules,profiles,created_at,created_by,published_at,published_by
             FROM interaction_reply_scope_versions WHERE scope_id=$1 AND config_version=$2`,
          [scopeId, baseVersion],
        );
        if (!base.rows[0]) throw new InteractionError('INTERACTION_CONFIG_MISSING', '基础配置快照不存在。', 409);
        const item = base.rows[0];
        snapshot = {
          accountId: '', configScopeId: scopeId, configSource: source, platform: INTERACTION_PLATFORM,
          configVersion: nextVersion, state: 'draft', policy: structuredClone(item.policy),
          templates: structuredClone(item.templates), rules: structuredClone(item.rules),
          profiles: item.profiles.map(normalizeReplyProfile), createdAt: Date.now(), createdBy: actor,
          publishedAt: null, publishedBy: null,
        };
      }
      change(snapshot);
      await client.query(
        `INSERT INTO interaction_reply_scope_versions
          (scope_id,config_version,state,policy,templates,rules,profiles,created_at,created_by)
         VALUES ($1,$2,'draft',$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,now(),$7)`,
        [scopeId, nextVersion, JSON.stringify(snapshot.policy), JSON.stringify(snapshot.templates),
          JSON.stringify(snapshot.rules), JSON.stringify(snapshot.profiles), actor],
      );
      await client.query(
        `UPDATE interaction_reply_config_scopes SET current_version=$2,draft_version=$2,updated_at=now(),updated_by=$3
          WHERE scope_id=$1`, [scopeId, nextVersion, actor],
      );
      await this.insertAudit(client, scopeId, actor, action, nextVersion, entityType, entityId);
      await client.query('COMMIT');
      const saved = await this.getSnapshot(scopeId, nextVersion);
      if (!saved) throw new Error('scope_draft_not_found_after_commit');
      return saved;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async initialize(scopeId: string, expectedVersion: number, actor: string): Promise<ReplyConfigSnapshot> {
    return this.mutate(scopeId, expectedVersion, actor, 'config_initialized', 'config', scopeId, () => undefined);
  }

  async savePolicy(scopeId: string, expectedVersion: number, actor: string, policy: ReplyPolicy): Promise<ReplyConfigSnapshot> {
    return this.mutate(scopeId, expectedVersion, actor, 'draft_saved', 'policy', scopeId, (snapshot) => {
      snapshot.policy = structuredClone(policy);
    });
  }

  async saveTemplate(
    scopeId: string,
    expectedVersion: number,
    actor: string,
    input: Omit<ReplyTemplate, 'templateVersion' | 'updatedAt' | 'updatedBy' | 'archived'> & { archived?: boolean },
  ): Promise<ReplyConfigSnapshot> {
    return this.mutate(scopeId, expectedVersion, actor, 'draft_saved', 'template', input.templateId, (snapshot) => {
      const previous = snapshot.templates.find((item) => item.templateId === input.templateId);
      snapshot.templates = snapshot.templates.filter((item) => item.templateId !== input.templateId);
      snapshot.templates.push({
        ...structuredClone(input), archived: input.archived ?? false,
        templateVersion: (previous?.templateVersion ?? 0) + 1, updatedAt: Date.now(), updatedBy: actor,
      });
      snapshot.templates.sort((left, right) => left.templateId.localeCompare(right.templateId));
    });
  }

  async archiveTemplate(scopeId: string, expectedVersion: number, actor: string, templateId: string): Promise<ReplyConfigSnapshot> {
    return this.mutate(scopeId, expectedVersion, actor, 'template_archived', 'template', templateId, (snapshot) => {
      const template = snapshot.templates.find((item) => item.templateId === templateId);
      if (!template) throw new InteractionError('INTERACTION_NOT_FOUND', '模板不存在。', 404);
      Object.assign(template, { archived: true, enabled: false, templateVersion: template.templateVersion + 1,
        updatedAt: Date.now(), updatedBy: actor });
    });
  }

  async saveRule(
    scopeId: string,
    expectedVersion: number,
    actor: string,
    input: Omit<ReplyRule, 'updatedAt' | 'updatedBy'>,
  ): Promise<ReplyConfigSnapshot> {
    return this.mutate(scopeId, expectedVersion, actor, 'draft_saved', 'rule', input.ruleId, (snapshot) => {
      snapshot.rules = snapshot.rules.filter((item) => item.ruleId !== input.ruleId);
      snapshot.rules.push({ ...structuredClone(input), updatedAt: Date.now(), updatedBy: actor });
      snapshot.rules.sort((left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId));
    });
  }

  async deleteRule(scopeId: string, expectedVersion: number, actor: string, ruleId: string): Promise<ReplyConfigSnapshot> {
    return this.mutate(scopeId, expectedVersion, actor, 'draft_saved', 'rule', ruleId, (snapshot) => {
      if (!snapshot.rules.some((item) => item.ruleId === ruleId)) {
        throw new InteractionError('INTERACTION_NOT_FOUND', '规则不存在。', 404);
      }
      snapshot.rules = snapshot.rules.filter((item) => item.ruleId !== ruleId);
    });
  }

  async saveProfiles(scopeId: string, expectedVersion: number, actor: string, profiles: ReplyProfile[]): Promise<ReplyConfigSnapshot> {
    return this.mutate(scopeId, expectedVersion, actor, 'draft_saved', 'profile', scopeId, (snapshot) => {
      const byChannel = new Map(snapshot.profiles.map((item) => [item.channel, item]));
      for (const profile of profiles) byChannel.set(profile.channel, normalizeReplyProfile(profile));
      snapshot.profiles = [...byChannel.values()].sort((left, right) => left.channel.localeCompare(right.channel));
    });
  }

  async publish(scopeId: string, expectedVersion: number, actor: string): Promise<ReplyConfigSnapshot> {
    const draft = await this.getSnapshot(scopeId, 'draft');
    if (!draft) throw new InteractionError('INTERACTION_CONFIG_MISSING', '没有可发布的草稿配置。', 409);
    const issues = validateReplyConfig(draft);
    if (issues.length) {
      throw new InteractionError('INTERACTION_VALIDATION_FAILED', '配置未通过发布校验。', 422, false, { issues });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ScopeRow>(
        `SELECT * FROM interaction_reply_config_scopes WHERE platform=$1 AND scope_id=$2 FOR UPDATE`,
        [INTERACTION_PLATFORM, scopeId],
      );
      const row = rows[0];
      if (!row || Number(row.current_version) !== expectedVersion || Number(row.draft_version) !== draft.configVersion) {
        throw new InteractionError('INTERACTION_VERSION_CONFLICT', '配置版本已变化，请刷新后重试。', 409, false, {
          currentVersion: row ? Number(row.current_version) : 0,
        });
      }
      const nextVersion = Number(row.current_version) + 1;
      await client.query(
        `INSERT INTO interaction_reply_scope_versions
          (scope_id,config_version,state,policy,templates,rules,profiles,created_at,created_by,published_at,published_by)
         SELECT scope_id,$3,'published',policy,templates,rules,profiles,now(),$4,now(),$4
           FROM interaction_reply_scope_versions WHERE scope_id=$1 AND config_version=$2`,
        [scopeId, draft.configVersion, nextVersion, actor],
      );
      await client.query(
        `UPDATE interaction_reply_config_scopes SET current_version=$2,draft_version=NULL,published_version=$2,
                updated_at=now(),updated_by=$3 WHERE scope_id=$1`,
        [scopeId, nextVersion, actor],
      );
      await this.insertAudit(client, scopeId, actor, 'config_published', nextVersion, 'config', scopeId);
      await client.query('COMMIT');
      const published = await this.getSnapshot(scopeId, nextVersion);
      if (!published) throw new Error('scope_published_config_missing_after_commit');
      return published;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordPreview(scopeId: string, actor: string, configVersion: number, accountId: string): Promise<void> {
    await this.insertAudit(this.pool, scopeId, actor, 'previewed', configVersion, 'preview', accountId);
  }

  async listAudit(scopeId: string, limit: number, before?: { createdAt: number; eventId: string }): Promise<ConfigAuditItem[]> {
    const params: unknown[] = [scopeId, Math.min(Math.max(limit, 1), 101)];
    const cursor = before ? `AND (created_at,event_id) < (to_timestamp($3/1000.0),$4)` : '';
    if (before) params.push(before.createdAt, before.eventId);
    const { rows } = await this.pool.query<{
      event_id: string; actor: string; action: string; config_version: number | null; entity_type: string;
      entity_id: string | null; summary: string; labels: Record<string, unknown>; created_at: Date;
    }>(
      `SELECT event_id,actor,action,config_version,entity_type,entity_id,summary,labels,created_at
         FROM interaction_reply_scope_audit WHERE scope_id=$1 ${cursor}
        ORDER BY created_at DESC,event_id DESC LIMIT $2`, params,
    );
    return rows.map((row) => ({
      eventId: row.event_id, actor: row.actor, action: row.action,
      configVersion: row.config_version === null ? null : Number(row.config_version),
      entityType: row.entity_type, entityId: row.entity_id, summary: row.summary,
      labels: row.labels, createdAt: epoch(row.created_at),
    }));
  }

  private async insertAudit(
    queryable: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>,
    scopeId: string,
    actor: string,
    action: ScopeAction,
    configVersion: number,
    entityType: string,
    entityId: string | null,
  ): Promise<void> {
    await queryable.query(
      `INSERT INTO interaction_reply_scope_audit
        (event_id,scope_id,actor,action,config_version,entity_type,entity_id,summary,labels,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$4,'{}'::jsonb,now())`,
      [this.idGen('audit'), scopeId, actor, action, configVersion, entityType, entityId],
    );
  }

  /** 只 end **自己建的**池；注入的属主池由组合根掌控生命周期（见 ownsPool）。 */
  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
