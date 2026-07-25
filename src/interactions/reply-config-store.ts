import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { resolveEnvPgConfig } from '../kernel/pg-config.js';
import { normalizeReplyProfile, validateReplyConfig } from './reply-config.js';
import {
  DEFAULT_REPLY_POLICY,
  INTERACTION_PLATFORM,
  InteractionError,
  TEMPLATE_VARIABLES,
  type ConfigHead,
  type InteractionChannel,
  type ReplyConfigSnapshot,
  type ReplyPolicy,
  type ReplyProfile,
  type ReplyRule,
  type ReplyTemplate,
} from '../kernel/interaction-types.js';

const { Pool } = pg;

type DraftMutation = (client: pg.PoolClient, version: number, baseVersion: number | null) => Promise<void>;

function epoch(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
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

export interface ConfigAuditItem {
  eventId: string;
  actor: string;
  action: string;
  configVersion: number | null;
  entityType: string;
  entityId: string | null;
  summary: string;
  labels: Record<string, unknown>;
  createdAt: number;
}

export class ReplyConfigStore {
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
    // 这两处硬编码 schema 名**故意不收口**到 schema-name.ts 的 qualifiedObjectName()：本文件是 api 层，
    // schema-name.ts 是 automation 层，收口会新增一条 api→automation 跨边界 import，撞 AC-BOUND-06 冻结棘轮
    // （frozenTotal 已封顶、unplanned 单调不增，且无承接消除的控制仓 change 可填 raises[]）。
    // 收口须等 §4.7 对 src/schema/ 归属裁决（schema-name 纯字符串拼装、可判 kernel，届时 api→kernel 合法）。
    // 现状：字面量留在此、由 AC-SCHEMA-DB-SCOPE 清单继续登记，行为不变（automation 层 interaction-store 已收口）。
    const { rows } = await this.pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.interaction_reply_configs') IS NOT NULL
          AND to_regclass('public.reply_templates') IS NOT NULL AS present`,
    );
    if (rows[0]?.present !== true) throw new Error('interaction_config_schema_missing_run_0039');
  }

  async getHead(accountId: string): Promise<ConfigHead | null> {
    const { rows } = await this.pool.query<{
      account_id: string; current_version: number; draft_version: number | null;
      published_version: number | null; updated_at: Date; updated_by: string;
    }>(
      `SELECT account_id,current_version,draft_version,published_version,updated_at,updated_by
         FROM interaction_reply_configs WHERE platform=$1 AND account_id=$2`,
      [INTERACTION_PLATFORM, accountId],
    );
    const row = rows[0];
    return row ? {
      accountId: row.account_id,
      platform: INTERACTION_PLATFORM,
      currentVersion: Number(row.current_version),
      draftVersion: row.draft_version === null ? null : Number(row.draft_version),
      publishedVersion: row.published_version === null ? null : Number(row.published_version),
      updatedAt: epoch(row.updated_at),
      updatedBy: row.updated_by,
    } : null;
  }

  async getSnapshot(accountId: string, selector: 'draft' | 'published' | number): Promise<ReplyConfigSnapshot | null> {
    let version: number | null;
    if (typeof selector === 'number') version = selector;
    else {
      const head = await this.getHead(accountId);
      version = selector === 'draft' ? head?.draftVersion ?? null : head?.publishedVersion ?? null;
    }
    if (version === null) return null;
    const { rows: versions } = await this.pool.query<{
      config_version: number; state: 'draft' | 'published'; policy: ReplyPolicy;
      created_at: Date; created_by: string; published_at: Date | null; published_by: string | null;
    }>(
      `SELECT config_version,state,policy,created_at,created_by,published_at,published_by
         FROM interaction_reply_config_versions
        WHERE platform=$1 AND account_id=$2 AND config_version=$3`,
      [INTERACTION_PLATFORM, accountId, version],
    );
    const row = versions[0];
    if (!row) return null;
    const [templates, rules, profiles] = await Promise.all([
      this.pool.query<{
        template_id: string; channel: InteractionChannel; name: string; content: string; enabled: boolean;
        archived: boolean; template_version: number; variables: ReplyTemplate['variables']; updated_at: Date; updated_by: string;
      }>(`SELECT template_id,channel,name,content,enabled,archived,template_version,variables,updated_at,updated_by
             FROM reply_templates WHERE platform=$1 AND account_id=$2 AND config_version=$3 ORDER BY template_id`,
        [INTERACTION_PLATFORM, accountId, version]),
      this.pool.query<{
        rule_id: string; channel: InteractionChannel; name: string; priority: number; enabled: boolean;
        conditions: ReplyRule['conditions']; actions: ReplyRule['actions']; updated_at: Date; updated_by: string;
      }>(`SELECT rule_id,channel,name,priority,enabled,conditions,actions,updated_at,updated_by
             FROM reply_rules WHERE platform=$1 AND account_id=$2 AND config_version=$3 ORDER BY priority,rule_id`,
        [INTERACTION_PLATFORM, accountId, version]),
      this.pool.query<{ channel: InteractionChannel; profile: ReplyProfile }>(
        `SELECT channel,profile FROM account_reply_profiles
          WHERE platform=$1 AND account_id=$2 AND config_version=$3 ORDER BY channel`,
        [INTERACTION_PLATFORM, accountId, version]),
    ]);
    return {
      accountId,
      platform: INTERACTION_PLATFORM,
      configVersion: Number(row.config_version),
      state: row.state,
      policy: row.policy,
      templates: templates.rows.map((template) => ({
        templateId: template.template_id,
        channel: template.channel,
        name: template.name,
        content: template.content,
        enabled: template.enabled,
        archived: template.archived,
        templateVersion: Number(template.template_version),
        variables: template.variables,
        updatedAt: epoch(template.updated_at),
        updatedBy: template.updated_by,
      })),
      rules: rules.rows.map((rule) => ({
        ruleId: rule.rule_id,
        channel: rule.channel,
        name: rule.name,
        priority: Number(rule.priority),
        enabled: rule.enabled,
        conditions: rule.conditions,
        actions: rule.actions,
        updatedAt: epoch(rule.updated_at),
        updatedBy: rule.updated_by,
      })),
      profiles: profiles.rows.map((profile) => normalizeReplyProfile({ ...profile.profile, channel: profile.channel })),
      createdAt: epoch(row.created_at),
      createdBy: row.created_by,
      publishedAt: row.published_at ? epoch(row.published_at) : null,
      publishedBy: row.published_by,
    };
  }

  async getPublished(accountId: string): Promise<ReplyConfigSnapshot | null> {
    return this.getSnapshot(accountId, 'published');
  }

  async getSnapshotForJob(
    accountId: string,
    scopeId: string | null | undefined,
    version: number,
  ): Promise<ReplyConfigSnapshot | null> {
    return scopeId ? null : this.getSnapshot(accountId, version);
  }

  private async createDraft(
    accountId: string,
    expectedVersion: number,
    actor: string,
    action: 'draft_saved' | 'template_archived' | 'config_initialized',
    entityType: string,
    entityId: string | null,
    mutation: DraftMutation,
  ): Promise<ReplyConfigSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query<{ platform: string }>(
        `SELECT platform FROM accounts WHERE account_id=$1 FOR SHARE`, [accountId],
      );
      if (account.rows[0]?.platform !== INTERACTION_PLATFORM) {
        throw new InteractionError('INTERACTION_NOT_FOUND', '账号不存在或平台不匹配。', 404);
      }
      await client.query(
        `INSERT INTO interaction_reply_configs
          (platform,account_id,current_version,draft_version,published_version,updated_at,updated_by)
         VALUES ($1,$2,0,NULL,NULL,now(),$3) ON CONFLICT (platform,account_id) DO NOTHING`,
        [INTERACTION_PLATFORM, accountId, actor],
      );
      const heads = await client.query<{ current_version: number; draft_version: number | null; published_version: number | null }>(
        `SELECT current_version,draft_version,published_version FROM interaction_reply_configs
          WHERE platform=$1 AND account_id=$2 FOR UPDATE`, [INTERACTION_PLATFORM, accountId],
      );
      const head = heads.rows[0];
      if (Number(head.current_version) !== expectedVersion) {
        throw new InteractionError('INTERACTION_VERSION_CONFLICT', '配置版本已变化，请刷新后重试。', 409, false, {
          currentVersion: Number(head.current_version),
        });
      }
      const baseVersion = head.draft_version === null ? head.published_version : head.draft_version;
      const nextVersion = Number(head.current_version) + 1;
      const basePolicy = baseVersion === null
        ? DEFAULT_REPLY_POLICY
        : (await client.query<{ policy: ReplyPolicy }>(
          `SELECT policy FROM interaction_reply_config_versions WHERE platform=$1 AND account_id=$2 AND config_version=$3`,
          [INTERACTION_PLATFORM, accountId, baseVersion],
        )).rows[0]?.policy ?? DEFAULT_REPLY_POLICY;
      await client.query(
        `INSERT INTO interaction_reply_config_versions
          (platform,account_id,config_version,state,policy,created_at,created_by)
         VALUES ($1,$2,$3,'draft',$4::jsonb,now(),$5)`,
        [INTERACTION_PLATFORM, accountId, nextVersion, JSON.stringify(basePolicy), actor],
      );
      if (baseVersion !== null) {
        await client.query(
          `INSERT INTO reply_templates
            (platform,account_id,config_version,template_id,channel,name,content,enabled,archived,
             template_version,variables,updated_at,updated_by)
           SELECT platform,account_id,$4,template_id,channel,name,content,enabled,archived,
                  template_version,variables,updated_at,updated_by
             FROM reply_templates WHERE platform=$1 AND account_id=$2 AND config_version=$3`,
          [INTERACTION_PLATFORM, accountId, baseVersion, nextVersion],
        );
        await client.query(
          `INSERT INTO reply_rules
            (platform,account_id,config_version,rule_id,channel,name,priority,enabled,conditions,actions,updated_at,updated_by)
           SELECT platform,account_id,$4,rule_id,channel,name,priority,enabled,conditions,actions,updated_at,updated_by
             FROM reply_rules WHERE platform=$1 AND account_id=$2 AND config_version=$3`,
          [INTERACTION_PLATFORM, accountId, baseVersion, nextVersion],
        );
        await client.query(
          `INSERT INTO account_reply_profiles (platform,account_id,config_version,channel,profile,updated_at,updated_by)
           SELECT platform,account_id,$4,channel,profile,updated_at,updated_by
             FROM account_reply_profiles WHERE platform=$1 AND account_id=$2 AND config_version=$3`,
          [INTERACTION_PLATFORM, accountId, baseVersion, nextVersion],
        );
      } else {
        for (const channel of ['comment', 'dm'] as const) {
          await client.query(
            `INSERT INTO account_reply_profiles
              (platform,account_id,config_version,channel,profile,updated_at,updated_by)
             VALUES ($1,$2,$3,$4,$5::jsonb,now(),$6)`,
            [INTERACTION_PLATFORM, accountId, nextVersion, channel, JSON.stringify(defaultProfile(channel)), actor],
          );
        }
      }
      await mutation(client, nextVersion, baseVersion === null ? null : Number(baseVersion));
      const counts = await client.query<{ templates: string; rules: string }>(
        `SELECT
           (SELECT count(*) FROM reply_templates WHERE platform=$1 AND account_id=$2 AND config_version=$3) AS templates,
           (SELECT count(*) FROM reply_rules WHERE platform=$1 AND account_id=$2 AND config_version=$3) AS rules`,
        [INTERACTION_PLATFORM, accountId, nextVersion],
      );
      if (Number(counts.rows[0]?.templates ?? 0) > 100 || Number(counts.rows[0]?.rules ?? 0) > 100) {
        throw new InteractionError('INTERACTION_VALIDATION_FAILED', '模板和规则各自最多 100 条。', 422);
      }
      await client.query(
        `UPDATE interaction_reply_configs SET current_version=$3,draft_version=$3,updated_at=now(),updated_by=$4
          WHERE platform=$1 AND account_id=$2`, [INTERACTION_PLATFORM, accountId, nextVersion, actor],
      );
      await this.insertAudit(client, accountId, actor, action, nextVersion, entityType, entityId);
      await client.query('COMMIT');
      const snapshot = await this.getSnapshot(accountId, nextVersion);
      if (!snapshot) throw new Error('draft_not_found_after_commit');
      return snapshot;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async initialize(accountId: string, expectedVersion: number, actor: string): Promise<ReplyConfigSnapshot> {
    return this.createDraft(accountId, expectedVersion, actor, 'config_initialized', 'config', accountId,
      async () => undefined);
  }

  async savePolicy(accountId: string, expectedVersion: number, actor: string, policy: ReplyPolicy): Promise<ReplyConfigSnapshot> {
    return this.createDraft(accountId, expectedVersion, actor, 'draft_saved', 'policy', accountId,
      async (client, version) => {
        await client.query(
          `UPDATE interaction_reply_config_versions SET policy=$4::jsonb
            WHERE platform=$1 AND account_id=$2 AND config_version=$3`,
          [INTERACTION_PLATFORM, accountId, version, JSON.stringify(policy)],
        );
      });
  }

  async saveTemplate(
    accountId: string,
    expectedVersion: number,
    actor: string,
    input: Omit<ReplyTemplate, 'templateVersion' | 'updatedAt' | 'updatedBy' | 'archived'> & { archived?: boolean },
  ): Promise<ReplyConfigSnapshot> {
    return this.createDraft(accountId, expectedVersion, actor, 'draft_saved', 'template', input.templateId,
      async (client, version, baseVersion) => {
        const previous = baseVersion === null ? null : (await client.query<{ template_version: number }>(
          `SELECT template_version FROM reply_templates WHERE platform=$1 AND account_id=$2 AND config_version=$3 AND template_id=$4`,
          [INTERACTION_PLATFORM, accountId, baseVersion, input.templateId],
        )).rows[0];
        await client.query(`DELETE FROM reply_templates WHERE platform=$1 AND account_id=$2 AND config_version=$3 AND template_id=$4`,
          [INTERACTION_PLATFORM, accountId, version, input.templateId]);
        await client.query(
          `INSERT INTO reply_templates
            (platform,account_id,config_version,template_id,channel,name,content,enabled,archived,
             template_version,variables,updated_at,updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now(),$12)`,
          [INTERACTION_PLATFORM, accountId, version, input.templateId, input.channel, input.name,
            input.content, input.enabled, input.archived ?? false, Number(previous?.template_version ?? 0) + 1,
            JSON.stringify(input.variables), actor],
        );
      });
  }

  async archiveTemplate(accountId: string, expectedVersion: number, actor: string, templateId: string): Promise<ReplyConfigSnapshot> {
    return this.createDraft(accountId, expectedVersion, actor, 'template_archived', 'template', templateId,
      async (client, version) => {
        const { rowCount } = await client.query(
          `UPDATE reply_templates SET archived=true,enabled=false,template_version=template_version+1,
                  updated_at=now(),updated_by=$5
            WHERE platform=$1 AND account_id=$2 AND config_version=$3 AND template_id=$4`,
          [INTERACTION_PLATFORM, accountId, version, templateId, actor],
        );
        if (!rowCount) throw new InteractionError('INTERACTION_NOT_FOUND', '模板不存在。', 404);
      });
  }

  async saveRule(
    accountId: string,
    expectedVersion: number,
    actor: string,
    input: Omit<ReplyRule, 'updatedAt' | 'updatedBy'>,
  ): Promise<ReplyConfigSnapshot> {
    return this.createDraft(accountId, expectedVersion, actor, 'draft_saved', 'rule', input.ruleId,
      async (client, version) => {
        await client.query(`DELETE FROM reply_rules WHERE platform=$1 AND account_id=$2 AND config_version=$3 AND rule_id=$4`,
          [INTERACTION_PLATFORM, accountId, version, input.ruleId]);
        await client.query(
          `INSERT INTO reply_rules
            (platform,account_id,config_version,rule_id,channel,name,priority,enabled,conditions,actions,updated_at,updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,now(),$11)`,
          [INTERACTION_PLATFORM, accountId, version, input.ruleId, input.channel, input.name, input.priority,
            input.enabled, JSON.stringify(input.conditions), JSON.stringify(input.actions), actor],
        );
      });
  }

  async deleteRule(accountId: string, expectedVersion: number, actor: string, ruleId: string): Promise<ReplyConfigSnapshot> {
    return this.createDraft(accountId, expectedVersion, actor, 'draft_saved', 'rule', ruleId,
      async (client, version) => {
        const { rowCount } = await client.query(
          `DELETE FROM reply_rules WHERE platform=$1 AND account_id=$2 AND config_version=$3 AND rule_id=$4`,
          [INTERACTION_PLATFORM, accountId, version, ruleId],
        );
        if (!rowCount) throw new InteractionError('INTERACTION_NOT_FOUND', '规则不存在。', 404);
      });
  }

  async saveProfiles(
    accountId: string,
    expectedVersion: number,
    actor: string,
    profiles: ReplyProfile[],
  ): Promise<ReplyConfigSnapshot> {
    return this.createDraft(accountId, expectedVersion, actor, 'draft_saved', 'profile', accountId,
      async (client, version) => {
        for (const profile of profiles) {
          await client.query(
            `INSERT INTO account_reply_profiles
              (platform,account_id,config_version,channel,profile,updated_at,updated_by)
             VALUES ($1,$2,$3,$4,$5::jsonb,now(),$6)
             ON CONFLICT (platform,account_id,config_version,channel) DO UPDATE SET
               profile=EXCLUDED.profile,updated_at=now(),updated_by=EXCLUDED.updated_by`,
            [INTERACTION_PLATFORM, accountId, version, profile.channel,
              JSON.stringify(normalizeReplyProfile(profile)), actor],
          );
        }
      });
  }

  async publish(accountId: string, expectedVersion: number, actor: string): Promise<ReplyConfigSnapshot> {
    const draft = await this.getSnapshot(accountId, 'draft');
    if (!draft) throw new InteractionError('INTERACTION_CONFIG_MISSING', '没有可发布的草稿配置。', 409);
    const issues = validateReplyConfig(draft);
    if (issues.length) throw new InteractionError('INTERACTION_VALIDATION_FAILED', '配置未通过发布校验。', 422, false, { issues });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ current_version: number; draft_version: number | null }>(
        `SELECT current_version,draft_version FROM interaction_reply_configs
          WHERE platform=$1 AND account_id=$2 FOR UPDATE`, [INTERACTION_PLATFORM, accountId],
      );
      const head = rows[0];
      if (!head || Number(head.current_version) !== expectedVersion || Number(head.draft_version) !== draft.configVersion) {
        throw new InteractionError('INTERACTION_VERSION_CONFLICT', '配置版本已变化，请刷新后重试。', 409, false, {
          currentVersion: head ? Number(head.current_version) : 0,
        });
      }
      const nextVersion = Number(head.current_version) + 1;
      await client.query(
        `INSERT INTO interaction_reply_config_versions
          (platform,account_id,config_version,state,policy,created_at,created_by,published_at,published_by)
         SELECT platform,account_id,$4,'published',policy,now(),$5,now(),$5
           FROM interaction_reply_config_versions WHERE platform=$1 AND account_id=$2 AND config_version=$3`,
        [INTERACTION_PLATFORM, accountId, draft.configVersion, nextVersion, actor],
      );
      for (const table of ['reply_templates', 'reply_rules', 'account_reply_profiles'] as const) {
        const columns = table === 'reply_templates'
          ? 'platform,account_id,config_version,template_id,channel,name,content,enabled,archived,template_version,variables,updated_at,updated_by'
          : table === 'reply_rules'
            ? 'platform,account_id,config_version,rule_id,channel,name,priority,enabled,conditions,actions,updated_at,updated_by'
            : 'platform,account_id,config_version,channel,profile,updated_at,updated_by';
        const select = columns.replace('config_version', '$4');
        await client.query(
          `INSERT INTO ${table} (${columns}) SELECT ${select} FROM ${table}
            WHERE platform=$1 AND account_id=$2 AND config_version=$3`,
          [INTERACTION_PLATFORM, accountId, draft.configVersion, nextVersion],
        );
      }
      await client.query(
        `UPDATE interaction_reply_configs SET current_version=$3,draft_version=NULL,published_version=$3,
                updated_at=now(),updated_by=$4 WHERE platform=$1 AND account_id=$2`,
        [INTERACTION_PLATFORM, accountId, nextVersion, actor],
      );
      await this.insertAudit(client, accountId, actor, 'config_published', nextVersion, 'config', accountId);
      await client.query('COMMIT');
      const snapshot = await this.getSnapshot(accountId, nextVersion);
      if (!snapshot) throw new Error('published_config_missing_after_commit');
      return snapshot;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async recordPreview(accountId: string, actor: string, configVersion: number): Promise<void> {
    await this.insertAudit(this.pool, accountId, actor, 'previewed', configVersion, 'config', accountId);
  }

  async listAudit(accountId: string, limit: number, before?: { createdAt: number; eventId: string }): Promise<ConfigAuditItem[]> {
    const params: unknown[] = [INTERACTION_PLATFORM, accountId, Math.min(Math.max(limit, 1), 101)];
    const cursor = before ? `AND (created_at,event_id) < (to_timestamp($4/1000.0),$5)` : '';
    if (before) params.push(before.createdAt, before.eventId);
    const { rows } = await this.pool.query<{
      event_id: string; actor: string; action: string; config_version: number | null; entity_type: string;
      entity_id: string | null; summary: string; labels: Record<string, unknown>; created_at: Date;
    }>(
      `SELECT event_id,actor,action,config_version,entity_type,entity_id,summary,labels,created_at
         FROM interaction_audit_events WHERE platform=$1 AND account_id=$2
          AND action IN ('draft_saved','template_archived','config_initialized','config_published','previewed')
          AND entity_type IN ('policy','template','rule','profile','config','preview')
          AND config_version IS NOT NULL ${cursor}
        ORDER BY created_at DESC,event_id DESC LIMIT $3`, params,
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
    accountId: string,
    actor: string,
    action: 'draft_saved' | 'template_archived' | 'config_initialized' | 'config_published' | 'previewed',
    configVersion: number,
    entityType: string,
    entityId: string | null,
  ): Promise<void> {
    await queryable.query(
      `INSERT INTO interaction_audit_events
        (event_id,platform,account_id,env_key,actor,action,config_version,entity_type,entity_id,summary,labels,created_at)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,'{}'::jsonb,now())`,
      [this.idGen('audit'), INTERACTION_PLATFORM, accountId, actor, action, configVersion,
        entityType, entityId, action],
    );
  }

  /** 只 end **自己建的**池；注入的属主池由组合根掌控生命周期（见 ownsPool）。 */
  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

export { defaultProfile, TEMPLATE_VARIABLES };
