import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type pg from 'pg';
import type { SchemaProber } from '../../src/kernel/schema-capability-contract.js';
import {
  FacebookConsumptionModeRuntimeStore,
} from '../../src/orchestrator/facebook-consumption-mode-runtime-store.js';
import {
  FacebookConsumptionMode,
  advanceFacebookConsumptionCounters,
  classifyFacebookConsumptionCommentReceipt,
  classifyFacebookConsumptionJoinReceipt,
  classifyFacebookConsumptionLikeReceipt,
  validateFacebookConsumptionPolicy,
} from '../../src/orchestrator/facebook-consumption-mode.js';
import type {
  FacebookConsumptionActionView,
  FacebookConsumptionPolicySnapshot,
} from '../../src/orchestrator/facebook-consumption-mode-types.js';

interface MemoryProgress {
  account_id: string;
  execution_target: 'dev' | 'ol';
  policy_revision: number;
  policy_snapshot: FacebookConsumptionPolicySnapshot;
  revision_state: 'active' | 'superseded';
  collecting_sequence: number;
  views_since_like: number;
  confirmed_new_likes_since_join: number;
  confirmed_new_joins_since_comment: number;
  next_action_sequence: number;
  active_action_id: string | null;
  superseded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MemoryAction {
  action_id: string;
  account_id: string;
  execution_target: 'dev' | 'ol';
  policy_revision: number;
  policy_snapshot: FacebookConsumptionPolicySnapshot;
  action_sequence: number;
  action_type: 'like' | 'join' | 'comment';
  idempotency_key: string;
  trigger_source_dedupe_key: string;
  state: 'waiting_target' | 'waiting_gate' | 'ready' | 'dispatched' | 'terminal';
  dispatch_phase: 'not_started' | 'dispatched' | 'settled';
  outcome: string | null;
  blocker: string | null;
  downstream_enabled: boolean;
  group_key: string | null;
  group_url: string | null;
  content_key: string | null;
  content_url: string | null;
  selection_strategy: 'first_commentable_group_post' | null;
  target_evidence: Record<string, unknown> | null;
  owner_id: string | null;
  owner_expires_at: Date | null;
  version: number;
  dispatched_at: Date | null;
  settled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function memoryDatabase(clock: () => number) {
  const progress = new Map<string, MemoryProgress>();
  const actions = new Map<string, MemoryAction>();
  const viewContentFacts = new Set<string>();
  const viewSourceFacts = new Set<string>();
  const resultFacts = new Map<string, {
    action_id: string;
    outcome: string;
    evidence: Record<string, unknown> | null;
    occurred_at: Date;
  }>();
  const queries: string[] = [];
  let lockTail = Promise.resolve();

  const progressKey = (accountId: string, target: string, revision: number) =>
    `${accountId}|${target}|${revision}`;
  const touch = <T extends { updated_at: Date }>(row: T) => {
    row.updated_at = new Date(clock());
    return row;
  };
  // 让位判据的内存转写。生产判据的唯一定义处是 `isDeferrableFacebookConsumptionObligation()`；
  // 这里三条件必须与它逐字一致，否则这套内存库会替生产码把「等待中的义务」当成占槽动作，
  // 于是「整链冻死」在测试里长得和正常一模一样。
  const isDeferrable = (row: MemoryAction) =>
    row.action_type !== 'like'
    && (row.state === 'waiting_target' || row.state === 'waiting_gate')
    && row.dispatch_phase === 'not_started';
  const nonTerminalFor = (accountId: string, target: string) =>
    [...actions.values()]
      .filter((row) =>
        row.account_id === accountId
        && row.execution_target === target
        && row.state !== 'terminal')
      .sort((left, right) => left.created_at.getTime() - right.created_at.getTime());
  /** 占槽动作 = 可下发 / 在途的那一个。 */
  const activeFor = (accountId: string, target: string) =>
    nonTerminalFor(accountId, target).filter((row) => !isDeferrable(row))[0];
  /** 让了位的义务：唯一索引改按动作类型分之后，它可以与占槽动作并存。 */
  const deferredFor = (accountId: string, target: string) =>
    nonTerminalFor(accountId, target).filter(isDeferrable)[0];
  const parseJson = (value: unknown) =>
    value == null ? null : typeof value === 'string' ? JSON.parse(value) : value;
  const acquire = async () => {
    let release!: () => void;
    const previous = lockTail;
    lockTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  };

  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    const parameterNumbers = [...sql.matchAll(/\$(\d+)\b/g)]
      .map((match) => Number(match[1]));
    const expectedParameterCount = parameterNumbers.length > 0
      ? Math.max(...parameterNumbers)
      : 0;
    assert.equal(
      params.length,
      expectedParameterCount,
      `PostgreSQL bind count mismatch for query: ${sql}`,
    );
    queries.push(sql);
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith('UPDATE facebook_consumption_action SET owner_id=NULL')
      && sql.includes('owner_expires_at <= now()')) {
      const target = String(params[0]);
      let count = 0;
      for (const row of actions.values()) {
        if (
          row.execution_target === target
          && row.state !== 'terminal'
          && row.owner_expires_at
          && row.owner_expires_at.getTime() <= clock()
        ) {
          row.owner_id = null;
          row.owner_expires_at = null;
          row.version += 1;
          touch(row);
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (sql.startsWith('SELECT policy_revision, revision_state FROM facebook_consumption_progress')) {
      const rows = [...progress.values()]
        .filter((row) =>
          row.account_id === String(params[0])
          && row.execution_target === String(params[1]))
        .sort((left, right) => right.policy_revision - left.policy_revision)
        .map((row) => ({
          policy_revision: row.policy_revision,
          revision_state: row.revision_state,
        }));
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith('INSERT INTO facebook_consumption_progress')) {
      const key = progressKey(String(params[0]), String(params[1]), Number(params[2]));
      if (!progress.has(key)) {
        const now = new Date(clock());
        progress.set(key, {
          account_id: String(params[0]),
          execution_target: String(params[1]) as 'dev' | 'ol',
          policy_revision: Number(params[2]),
          policy_snapshot: parseJson(params[3]) as FacebookConsumptionPolicySnapshot,
          revision_state: 'active',
          collecting_sequence: 1,
          views_since_like: 0,
          confirmed_new_likes_since_join: 0,
          confirmed_new_joins_since_comment: 0,
          next_action_sequence: 1,
          active_action_id: null,
          superseded_at: null,
          created_at: now,
          updated_at: now,
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('FROM facebook_consumption_progress')
      && sql.includes('policy_revision=$3')
      && !sql.startsWith('UPDATE')) {
      const row = progress.get(progressKey(
        String(params[0]),
        String(params[1]),
        Number(params[2]),
      ));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('INSERT INTO facebook_consumption_view_fact')) {
      const accountId = String(params[0]);
      const target = String(params[1]);
      const revision = Number(params[2]);
      const sequence = Number(params[3]);
      const contentKey = String(params[4]);
      const contentFact = `${accountId}|${target}|${revision}|${sequence}|${contentKey}`;
      const sourceFact = `${accountId}|${target}|${revision}|${String(params[6])}`;
      if (viewContentFacts.has(contentFact) || viewSourceFacts.has(sourceFact)) {
        return { rows: [], rowCount: 0 };
      }
      viewContentFacts.add(contentFact);
      viewSourceFacts.add(sourceFact);
      return { rows: [{ content_key: contentKey }], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE facebook_consumption_progress SET views_since_like=')) {
      const row = progress.get(progressKey(
        String(params[0]),
        String(params[1]),
        Number(params[2]),
      ))!;
      row.views_since_like = Number(params[3]);
      touch(row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO facebook_consumption_action (')) {
      const accountId = String(params[1]);
      const target = String(params[2]) as 'dev' | 'ol';
      const revision = Number(params[3]);
      const actionType = String(params[6]) as MemoryAction['action_type'];
      const trigger = String(params[8]);
      const idempotency = String(params[7]);
      // `uq_facebook_consumption_active_action`（迁移 0111 起按动作类型分）：
      // 同账号同目标下，同一 action_type 至多一条未终结。
      const duplicate = nonTerminalFor(accountId, target)
        .find((row) => row.action_type === actionType)
        || [...actions.values()].find((row) =>
          row.account_id === accountId
          && row.execution_target === target
          && row.policy_revision === revision
          && row.action_type === actionType
          && row.trigger_source_dedupe_key === trigger)
        || [...actions.values()].find((row) => row.idempotency_key === idempotency);
      if (duplicate) return { rows: [], rowCount: 0 };
      const now = new Date(clock());
      const row: MemoryAction = {
        action_id: String(params[0]),
        account_id: accountId,
        execution_target: target,
        policy_revision: revision,
        policy_snapshot: parseJson(params[4]) as FacebookConsumptionPolicySnapshot,
        action_sequence: Number(params[5]),
        action_type: actionType,
        idempotency_key: idempotency,
        trigger_source_dedupe_key: trigger,
        state: String(params[9]) as MemoryAction['state'],
        dispatch_phase: 'not_started',
        outcome: null,
        blocker: params[10] == null ? null : String(params[10]),
        downstream_enabled: true,
        group_key: null,
        group_url: null,
        content_key: params[11] == null ? null : String(params[11]),
        content_url: params[12] == null ? null : String(params[12]),
        selection_strategy: params[13] == null
          ? null
          : String(params[13]) as 'first_commentable_group_post',
        target_evidence: null,
        owner_id: null,
        owner_expires_at: null,
        version: 1,
        dispatched_at: null,
        settled_at: null,
        created_at: now,
        updated_at: now,
      };
      actions.set(row.action_id, row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE facebook_consumption_progress SET collecting_sequence=')) {
      const row = progress.get(progressKey(
        String(params[0]),
        String(params[1]),
        Number(params[2]),
      ))!;
      row.collecting_sequence += 1;
      row.views_since_like = 0;
      row.next_action_sequence += 1;
      row.active_action_id = String(params[3]);
      touch(row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('FROM facebook_consumption_action')
      && sql.includes('WHERE action_id=$1 AND account_id=$2')
      && sql.includes('policy_revision=$4')) {
      const row = actions.get(String(params[0]));
      const matches = row
        && row.account_id === String(params[1])
        && row.execution_target === String(params[2])
        && row.policy_revision === Number(params[3]);
      return { rows: matches ? [row] : [], rowCount: matches ? 1 : 0 };
    }

    if (sql.includes('FROM facebook_consumption_action')
      && sql.includes("state <> 'terminal'")
      && sql.includes('account_id=$1')
      && sql.includes('action_type=$4')) {
      const row = nonTerminalFor(String(params[0]), String(params[1])).find((candidate) =>
        candidate.policy_revision === Number(params[2])
        && candidate.action_type === String(params[3]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('FROM facebook_consumption_action')
      && sql.includes("state <> 'terminal'")
      && sql.includes('account_id=$1')) {
      // 生产 SQL 里 `NOT (...)` 取占槽动作、去掉 NOT 取让位义务；两条谓词文本只差这三个字符，
      // 所以这里按 `AND NOT (` 分流，别按「含不含 action_type」分（那样两条会撞在一起）。
      const deferredShape = !sql.includes('AND NOT (');
      const row = deferredShape
        ? deferredFor(String(params[0]), String(params[1]))
        : activeFor(String(params[0]), String(params[1]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('FROM facebook_consumption_action')
      && sql.includes('WHERE action_id=$1 AND execution_target=$2')) {
      const row = actions.get(String(params[0]));
      const matches = row?.execution_target === String(params[1]);
      return { rows: matches ? [row] : [], rowCount: matches ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE facebook_consumption_action SET owner_id=$2')) {
      const row = actions.get(String(params[0]));
      if (
        !row
        || row.account_id !== String(params[3])
        || row.execution_target !== String(params[4])
        || row.policy_revision !== Number(params[5])
        || row.state === 'terminal'
      ) return { rows: [], rowCount: 0 };
      row.owner_id = String(params[1]);
      row.owner_expires_at = new Date(params[2] as Date);
      row.version += 1;
      touch(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE facebook_consumption_action SET group_key=$2')
      && sql.includes("state='dispatched'")) {
      const row = actions.get(String(params[0]));
      if (!row || row.version !== Number(params[11])) return { rows: [], rowCount: 0 };
      row.group_key = params[1] == null ? null : String(params[1]);
      row.group_url = params[2] == null ? null : String(params[2]);
      row.content_key = params[3] == null ? null : String(params[3]);
      row.content_url = params[4] == null ? null : String(params[4]);
      row.selection_strategy = params[5] == null
        ? null
        : String(params[5]) as 'first_commentable_group_post';
      row.target_evidence = parseJson(params[6]) as Record<string, unknown> | null;
      row.state = 'dispatched';
      row.dispatch_phase = 'dispatched';
      row.outcome = null;
      row.blocker = null;
      row.dispatched_at = new Date(params[7] as Date);
      row.version += 1;
      touch(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE facebook_consumption_action SET group_key=$2')) {
      const row = actions.get(String(params[0]));
      if (!row || row.version !== Number(params[12])) return { rows: [], rowCount: 0 };
      row.group_key = params[1] == null ? null : String(params[1]);
      row.group_url = params[2] == null ? null : String(params[2]);
      row.content_key = params[3] == null ? null : String(params[3]);
      row.content_url = params[4] == null ? null : String(params[4]);
      row.selection_strategy = params[5] == null
        ? null
        : String(params[5]) as 'first_commentable_group_post';
      row.target_evidence = parseJson(params[6]) as Record<string, unknown> | null;
      row.state = String(params[7]) as MemoryAction['state'];
      row.blocker = params[8] == null ? null : String(params[8]);
      row.version += 1;
      touch(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE facebook_consumption_action SET state=$2, blocker=$3')) {
      const row = actions.get(String(params[0]));
      if (!row || row.version !== Number(params[6])) return { rows: [], rowCount: 0 };
      row.state = String(params[1]) as MemoryAction['state'];
      row.blocker = params[2] == null ? null : String(params[2]);
      row.version += 1;
      touch(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE facebook_consumption_action SET state='dispatched'")) {
      const row = actions.get(String(params[0]));
      if (!row || row.version !== Number(params[5])) return { rows: [], rowCount: 0 };
      row.state = 'dispatched';
      row.dispatch_phase = 'dispatched';
      row.outcome = null;
      row.blocker = null;
      row.dispatched_at = new Date(params[1] as Date);
      row.version += 1;
      touch(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE facebook_consumption_action SET owner_id=NULL')
      && sql.includes('WHERE action_id=$1')) {
      const row = actions.get(String(params[0]));
      if (!row || row.version !== Number(params[4])) return { rows: [], rowCount: 0 };
      row.owner_id = null;
      row.owner_expires_at = null;
      row.version += 1;
      touch(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO facebook_consumption_action_result_fact')) {
      const key = `${String(params[1])}|${String(params[2])}|${Number(params[3])}|${String(params[4])}`;
      if (resultFacts.has(key)) return { rows: [], rowCount: 0 };
      resultFacts.set(key, {
        action_id: String(params[0]),
        outcome: String(params[5]),
        evidence: parseJson(params[6]) as Record<string, unknown> | null,
        occurred_at: new Date(params[7] as Date),
      });
      return { rows: [{ source_dedupe_key: String(params[4]) }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT action_id, outcome FROM facebook_consumption_action_result_fact')) {
      const key = `${String(params[0])}|${String(params[1])}|${Number(params[2])}|${String(params[3])}`;
      const row = resultFacts.get(key);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE facebook_consumption_action_result_fact SET outcome=$5')) {
      const key = `${String(params[1])}|${String(params[2])}|${Number(params[3])}|${String(params[7])}`;
      const row = resultFacts.get(key);
      if (!row || row.action_id !== String(params[0]) || row.outcome !== 'pending') {
        return { rows: [], rowCount: 0 };
      }
      row.outcome = String(params[4]);
      row.evidence = parseJson(params[5]) as Record<string, unknown> | null;
      row.occurred_at = new Date(params[6] as Date);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE facebook_consumption_action SET outcome='pending'")) {
      const row = actions.get(String(params[0]))!;
      row.outcome = 'pending';
      row.version += 1;
      touch(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE facebook_consumption_action SET state='terminal'")) {
      const row = actions.get(String(params[0]))!;
      row.state = 'terminal';
      row.dispatch_phase = 'settled';
      row.outcome = String(params[1]);
      row.blocker = params[2] == null ? null : String(params[2]);
      row.owner_id = null;
      row.owner_expires_at = null;
      row.settled_at = new Date(params[3] as Date);
      row.version += 1;
      touch(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE facebook_consumption_progress SET confirmed_new_likes_since_join=')) {
      const row = progress.get(progressKey(
        String(params[0]),
        String(params[1]),
        Number(params[2]),
      ))!;
      row.confirmed_new_likes_since_join = Number(params[3]);
      row.confirmed_new_joins_since_comment = Number(params[4]);
      row.next_action_sequence += Number(params[5]);
      row.active_action_id = params[6] == null ? null : String(params[6]);
      touch(row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE facebook_consumption_progress SET revision_state='superseded'")) {
      const accountId = String(params[0]);
      const target = String(params[1]);
      const keep = params[2] == null ? null : Number(params[2]);
      let count = 0;
      for (const row of progress.values()) {
        if (
          row.account_id === accountId
          && row.execution_target === target
          && (keep === null || row.policy_revision !== keep)
          && row.revision_state !== 'superseded'
        ) {
          row.revision_state = 'superseded';
          row.superseded_at = new Date(clock());
          touch(row);
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (sql.startsWith('UPDATE facebook_consumption_action SET downstream_enabled=false')) {
      const accountId = String(params[0]);
      const target = String(params[1]);
      const keep = params[2] == null ? null : Number(params[2]);
      const reason = String(params[3]);
      const rows: MemoryAction[] = [];
      for (const row of actions.values()) {
        if (
          row.account_id !== accountId
          || row.execution_target !== target
          || (keep !== null && row.policy_revision === keep)
          || row.state === 'terminal'
        ) continue;
        row.downstream_enabled = false;
        row.blocker = reason;
        if (row.dispatch_phase === 'not_started') {
          row.state = 'terminal';
          row.dispatch_phase = 'settled';
          row.outcome = 'policy_superseded';
          row.settled_at = new Date(clock());
          row.owner_id = null;
          row.owner_expires_at = null;
        }
        row.version += 1;
        touch(row);
        rows.push(row);
      }
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith('UPDATE facebook_consumption_progress SET active_action_id=NULL')
      && sql.includes('active_action_id=$4')) {
      const row = progress.get(progressKey(
        String(params[0]),
        String(params[1]),
        Number(params[2]),
      ));
      if (row && row.active_action_id === String(params[3])) {
        row.active_action_id = null;
        touch(row);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith('UPDATE facebook_consumption_progress SET active_action_id=NULL')
      && sql.includes('ANY($3::uuid[])')) {
      const accountId = String(params[0]);
      const target = String(params[1]);
      const ids = new Set(params[2] as string[]);
      for (const row of progress.values()) {
        if (
          row.account_id === accountId
          && row.execution_target === target
          && row.active_action_id
          && ids.has(row.active_action_id)
        ) {
          row.active_action_id = null;
          touch(row);
        }
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('FROM facebook_consumption_action')
      && sql.includes("WHERE execution_target=$1 AND state <> 'terminal'")) {
      const rows = [...actions.values()]
        .filter((row) => row.execution_target === String(params[0]) && row.state !== 'terminal')
        .sort((left, right) => left.created_at.getTime() - right.created_at.getTime())
        .slice(0, Number(params[1]));
      return { rows, rowCount: rows.length };
    }

    throw new Error(`unhandled consumption test query: ${sql}`);
  };

  const pool = {
    query,
    connect: async () => {
      let releaseLock: (() => void) | null = null;
      return {
        query: async (text: string, params?: unknown[]) => {
          if (text === 'BEGIN') releaseLock = await acquire();
          const result = await query(text, params);
          if (text === 'COMMIT' || text === 'ROLLBACK') {
            releaseLock?.();
            releaseLock = null;
          }
          return result;
        },
        release: () => releaseLock?.(),
      };
    },
  } as unknown as pg.Pool;
  return { pool, progress, actions, resultFacts, queries };
}

const schemaColumns: Record<string, string[]> = {
  facebook_consumption_progress: [
    'account_id', 'execution_target', 'policy_revision', 'policy_snapshot',
    'revision_state', 'collecting_sequence', 'views_since_like',
    'confirmed_new_likes_since_join', 'confirmed_new_joins_since_comment',
    'next_action_sequence', 'active_action_id', 'superseded_at', 'created_at', 'updated_at',
  ],
  facebook_consumption_view_fact: [
    'account_id', 'execution_target', 'policy_revision', 'collecting_sequence',
    'content_key', 'content_url', 'source_dedupe_key', 'occurred_at', 'created_at',
  ],
  facebook_consumption_action: [
    'action_id', 'account_id', 'execution_target', 'policy_revision', 'policy_snapshot',
    'action_sequence', 'action_type', 'idempotency_key', 'trigger_source_dedupe_key',
    'state', 'dispatch_phase', 'outcome', 'blocker', 'downstream_enabled',
    'group_key', 'group_url', 'content_key', 'content_url', 'selection_strategy',
    'target_evidence', 'owner_id', 'owner_expires_at', 'version', 'dispatched_at',
    'settled_at', 'created_at', 'updated_at',
  ],
  facebook_consumption_action_result_fact: [
    'action_id', 'account_id', 'execution_target', 'policy_revision',
    'source_dedupe_key', 'outcome', 'evidence', 'occurred_at', 'created_at',
  ],
};

const readySchema: SchemaProber = async (_pool, tables) => ({
  tables: new Set(tables),
  columns: new Set(tables.flatMap((table) =>
    (schemaColumns[table] ?? []).map((column) => `${table}.${column}`))),
  indexes: new Set([
    'uq_facebook_consumption_active_action',
    'idx_facebook_consumption_action_revision',
    'idx_facebook_consumption_result_source',
  ]),
});

const oneOneOne: FacebookConsumptionPolicySnapshot = {
  viewsPerLike: 1,
  confirmedLikesPerJoin: 1,
  confirmedJoinsPerComment: 1,
};

function makeStore(
  db: ReturnType<typeof memoryDatabase>,
  target: 'dev' | 'ol',
  clock: () => number,
) {
  return new FacebookConsumptionModeRuntimeStore({
    pool: db.pool,
    executionTarget: target,
    schemaProber: readySchema,
    clock,
  });
}

async function recordView(
  mode: FacebookConsumptionMode,
  revision: number,
  sequence: number,
  snapshot = oneOneOne,
) {
  return mode.recordConfirmedView({
    accountId: 'fb-1',
    effectiveMode: 'consumption',
    policy: { policyRevision: revision, snapshot },
    contentKey: `post-${sequence}`,
    contentUrl: `https://www.facebook.com/posts/${sequence}`,
    sourceDedupeKey: `view-${revision}-${sequence}`,
    occurredAt: 1_800_000_000_000 + sequence,
  });
}

async function claim(
  store: FacebookConsumptionModeRuntimeStore,
  action: FacebookConsumptionActionView,
  ownerId: string,
) {
  const result = await store.claimAction({
    actionId: action.actionId,
    accountId: action.accountId,
    policyRevision: action.policyRevision,
    ownerId,
    leaseMs: 60_000,
  });
  assert.equal(result.kind, 'claimed');
  if (result.kind !== 'claimed') throw new Error('expected claimed action');
  return result.action;
}

async function dispatch(
  store: FacebookConsumptionModeRuntimeStore,
  action: FacebookConsumptionActionView,
  ownerId: string,
) {
  const result = await store.markDispatched({
    actionId: action.actionId,
    accountId: action.accountId,
    policyRevision: action.policyRevision,
    ownerId,
    expectedVersion: action.version,
  });
  assert.equal(result.kind, 'updated');
  if (result.kind !== 'updated') throw new Error('expected dispatched action');
  return result.action;
}

describe('Facebook consumption policy and truthful receipt classification', () => {
  it('supports default and non-default cadence without crediting already/ambiguous outcomes', () => {
    assert.deepEqual(validateFacebookConsumptionPolicy(3, {
      viewsPerLike: 5,
      confirmedLikesPerJoin: 2,
      confirmedJoinsPerComment: 2,
    }), { ok: true });
    assert.equal(validateFacebookConsumptionPolicy(3, {
      viewsPerLike: 0,
      confirmedLikesPerJoin: 2,
      confirmedJoinsPerComment: 2,
    }).ok, false);

    const firstLike = advanceFacebookConsumptionCounters({
      actionType: 'like',
      outcome: 'confirmed_new_like',
      snapshot: { viewsPerLike: 5, confirmedLikesPerJoin: 2, confirmedJoinsPerComment: 2 },
      counters: { confirmedNewLikesSinceJoin: 0, confirmedNewJoinsSinceComment: 0 },
      downstreamEnabled: true,
    });
    assert.deepEqual(firstLike, {
      counters: { confirmedNewLikesSinceJoin: 1, confirmedNewJoinsSinceComment: 0 },
      nextActionType: null,
    });
    const secondLike = advanceFacebookConsumptionCounters({
      actionType: 'like',
      outcome: 'confirmed_new_like',
      snapshot: { viewsPerLike: 5, confirmedLikesPerJoin: 2, confirmedJoinsPerComment: 2 },
      counters: firstLike.counters,
      downstreamEnabled: true,
    });
    assert.equal(secondLike.nextActionType, 'join');
    assert.equal(secondLike.counters.confirmedNewLikesSinceJoin, 0);

    for (const outcome of [
      'already_liked', 'pending', 'ambiguous', 'submitted_unknown', 'gated', 'failed',
    ] as const) {
      const result = advanceFacebookConsumptionCounters({
        actionType: 'like',
        outcome,
        snapshot: oneOneOne,
        counters: { confirmedNewLikesSinceJoin: 0, confirmedNewJoinsSinceComment: 0 },
        downstreamEnabled: true,
      });
      assert.equal(result.nextActionType, null, outcome);
      assert.equal(result.counters.confirmedNewLikesSinceJoin, 0, outcome);
    }

    assert.equal(
      classifyFacebookConsumptionLikeReceipt({ ok: true, reason: 'already_liked' }),
      'already_liked',
    );
    assert.equal(
      classifyFacebookConsumptionLikeReceipt({ ok: false, reason: 'verification_ambiguous' }),
      'ambiguous',
    );
    for (const reason of ['verify_indeterminate', 'state_unchanged']) {
      assert.equal(
        classifyFacebookConsumptionLikeReceipt({ ok: false, reason }),
        'ambiguous',
        `${reason} cannot authorize a retry or count as a confirmed new like`,
      );
      assert.equal(
        classifyFacebookConsumptionLikeReceipt({ ok: true, reason }),
        'ambiguous',
        `${reason} is authoritative even if a contradictory ok flag arrives`,
      );
    }
    for (const [reason, outcome] of [
      ['pending', 'pending'],
      ['submitted_unconfirmed', 'submitted_unknown'],
      ['like_failed', 'failed'],
      ['approval_rejected', 'gated'],
      ['blocked_by_captcha', 'gated'],
      ['contradictory_unknown_reason', 'failed'],
    ] as const) {
      assert.equal(
        classifyFacebookConsumptionLikeReceipt({ ok: true, reason }),
        outcome,
        `${reason} must override a contradictory ok flag for like accounting`,
      );
      assert.equal(
        classifyFacebookConsumptionCommentReceipt({ ok: true, reason }),
        outcome,
        `${reason} must override a contradictory ok flag for comment accounting`,
      );
    }
    assert.equal(
      classifyFacebookConsumptionJoinReceipt({
        triggered: true,
        outcome: 'already_member',
      }),
      'already_member',
    );
    assert.equal(
      classifyFacebookConsumptionJoinReceipt({
        triggered: false,
        outcome: 'no_targets',
      }),
      'no_target',
    );
    assert.equal(
      classifyFacebookConsumptionJoinReceipt({
        triggered: true,
        outcome: 'joined',
        reason: 'pending',
      }),
      'pending',
    );
    assert.equal(
      classifyFacebookConsumptionJoinReceipt({
        triggered: false,
        outcome: 'joined',
      }),
      'failed',
    );
    assert.equal(
      classifyFacebookConsumptionCommentReceipt({
        ok: false,
        reason: 'submitted_unconfirmed',
      }),
      'submitted_unknown',
    );
  });

  it('admits confirmed views only for an exact consumption policy and exact content URL', async () => {
    let calls = 0;
    const mode = new FacebookConsumptionMode({
      applyConfirmedView: async () => {
        calls += 1;
        return { kind: 'counted', viewCount: 1 };
      },
      settleAction: async () => ({ kind: 'not_found' }),
    });
    assert.deepEqual(await mode.recordConfirmedView({
      accountId: 'fb-1',
      effectiveMode: 'rule',
      policy: { policyRevision: 1, snapshot: oneOneOne },
      contentKey: 'post-1',
      contentUrl: 'https://www.facebook.com/posts/1',
      sourceDedupeKey: 'view-1',
      occurredAt: 1,
    }), { kind: 'not_admitted', blocker: 'effective_mode_rule' });
    assert.equal((await mode.recordConfirmedView({
      accountId: 'fb-1',
      effectiveMode: 'consumption',
      policy: { policyRevision: 1, snapshot: oneOneOne },
      contentKey: 'post-1',
      contentUrl: '',
      sourceDedupeKey: 'view-1',
      occurredAt: 1,
    })).kind, 'invalid_fact');
    assert.equal(calls, 0);
  });
});

describe('FacebookConsumptionModeRuntimeStore durable state machine', () => {
  it('executes the account active-action lock query with one bounded LIMIT before FOR UPDATE', async () => {
    const clock = () => 1_800_000_000_000;
    const db = memoryDatabase(clock);
    const store = makeStore(db, 'dev', clock);
    await store.init();
    const mode = new FacebookConsumptionMode(store);
    const created = await recordView(mode, 1, 1);
    assert.equal(created.kind, 'action_created');
    const blockedByActive = await recordView(mode, 1, 2);
    assert.equal(blockedByActive.kind, 'action_active');

    const lockQueries = db.queries.filter((sql) =>
      sql.includes("WHERE account_id=$1 AND execution_target=$2 AND state <> 'terminal'")
      && sql.includes('FOR UPDATE'));
    assert.ok(lockQueries.length >= 2, 'production active-action lock path must execute');
    for (const sql of lockQueries) {
      assert.equal(
        sql.match(/\bLIMIT\s+1\b/g)?.length,
        1,
        `active-action SQL must contain exactly one LIMIT 1: ${sql}`,
      );
      assert.match(sql, /ORDER BY created_at ASC LIMIT 1 FOR UPDATE$/);
    }
  });

  it('lets browsing and likes continue while a downstream obligation waits, and keeps one obligation per type', async () => {
    let now = 1_800_000_000_000;
    const db = memoryDatabase(() => now);
    const store = makeStore(db, 'dev', () => now);
    await store.init();
    const mode = new FacebookConsumptionMode(store);
    const twoOneOne: FacebookConsumptionPolicySnapshot = {
      viewsPerLike: 2,
      confirmedLikesPerJoin: 1,
      confirmedJoinsPerComment: 1,
    };

    assert.equal((await recordView(mode, 1, 1, twoOneOne)).kind, 'counted');
    const firstLike = await recordView(mode, 1, 2, twoOneOne);
    assert.equal(firstLike.kind, 'action_created');
    if (firstLike.kind !== 'action_created') throw new Error('expected like action');

    let like = await claim(store, firstLike.action, 'worker-like-1');
    like = await dispatch(store, like, 'worker-like-1');
    const settledLike = await mode.recordActionReceipt({
      actionId: like.actionId,
      accountId: like.accountId,
      policyRevision: like.policyRevision,
      sourceDedupeKey: 'like-receipt-1',
      outcome: 'confirmed_new_like',
      occurredAt: now + 1,
      expectedContentKey: 'post-2',
      expectedContentUrl: 'https://www.facebook.com/posts/2',
    });
    assert.equal(settledLike.kind, 'settled');
    if (settledLike.kind !== 'settled') throw new Error('expected settled like');
    const obligation = settledLike.nextAction!;
    assert.equal(obligation.actionType, 'join');
    assert.equal(obligation.state, 'waiting_target');
    assert.equal(obligation.dispatchPhase, 'not_started');

    // 本 change 的承重断言：等待中的义务在场时，浏览事实照记、点赞机会照到点。
    // 旧行为在这两步上返回 `action_active`，于是点赞与加群跨重启永久停摆。
    const counted = await recordView(mode, 1, 3, twoOneOne);
    assert.equal(counted.kind, 'counted');
    if (counted.kind !== 'counted') throw new Error('expected counted view');
    assert.equal(counted.viewCount, 1);
    assert.equal(
      counted.deferredObligation?.actionId,
      obligation.actionId,
      'the obligation that yielded the slot must be reported back so it still gets driven',
    );

    const secondLike = await recordView(mode, 1, 4, twoOneOne);
    assert.equal(secondLike.kind, 'action_created');
    if (secondLike.kind !== 'action_created') throw new Error('expected second like action');
    assert.equal(secondLike.action.actionType, 'like');
    assert.equal(
      (secondLike as { deferredObligation?: unknown }).deferredObligation,
      undefined,
      'a round that already produced an Edge-facing like MUST NOT also hand back the obligation',
    );

    const stillWaiting = await store.getAction(obligation.actionId);
    assert.equal(stillWaiting?.state, 'waiting_target', 'yielding is not discarding');

    // 在途的写照旧占槽：让位判据 MUST NOT 放行任何已派发的动作。
    let second = await claim(store, secondLike.action, 'worker-like-2');
    second = await dispatch(store, second, 'worker-like-2');
    assert.equal((await recordView(mode, 1, 5, twoOneOne)).kind, 'action_active');

    // 积压上限：第二次到点 MUST NOT 造出第二份同类义务。
    const settledSecond = await mode.recordActionReceipt({
      actionId: second.actionId,
      accountId: second.accountId,
      policyRevision: second.policyRevision,
      sourceDedupeKey: 'like-receipt-2',
      outcome: 'confirmed_new_like',
      occurredAt: now + 2,
      expectedContentKey: 'post-4',
      expectedContentUrl: 'https://www.facebook.com/posts/4',
    });
    assert.equal(settledSecond.kind, 'settled');
    if (settledSecond.kind !== 'settled') throw new Error('expected settled second like');
    assert.equal(
      settledSecond.nextAction,
      null,
      'a standing obligation of the same type absorbs the newly earned one',
    );
    const nonTerminal = await store.listActiveActions();
    assert.deepEqual(
      nonTerminal.filter((row) => row.actionType === 'join').map((row) => row.actionId),
      [obligation.actionId],
      'exactly one join obligation may stand at a time',
    );
  });

  it('keeps exact URLs, upgrades same-key pending receipts, waits for targets, and advances only confirmed-new outcomes', async () => {
    let now = 1_800_000_000_000;
    const db = memoryDatabase(() => now);
    const store = makeStore(db, 'dev', () => now);
    await store.init();
    const mode = new FacebookConsumptionMode(store);

    const createdLike = await recordView(mode, 1, 1);
    assert.equal(createdLike.kind, 'action_created');
    if (createdLike.kind !== 'action_created') throw new Error('expected like action');
    assert.equal(createdLike.action.actionType, 'like');
    assert.equal(createdLike.action.target.contentKey, 'post-1');
    assert.equal(createdLike.action.target.contentUrl, 'https://www.facebook.com/posts/1');

    let like = await claim(store, createdLike.action, 'worker-like-1');
    like = await dispatch(store, like, 'worker-like-1');
    const pending = await mode.recordActionReceipt({
      actionId: like.actionId,
      accountId: like.accountId,
      policyRevision: like.policyRevision,
      sourceDedupeKey: 'like-receipt-1',
      outcome: 'pending',
      occurredAt: now + 1,
      expectedContentKey: 'post-1',
      expectedContentUrl: 'https://www.facebook.com/posts/1',
    });
    assert.equal(pending.kind, 'pending');
    if (pending.kind !== 'pending') throw new Error('expected pending');

    const noRedispatch = await store.markDispatched({
      actionId: like.actionId,
      accountId: like.accountId,
      policyRevision: like.policyRevision,
      ownerId: 'worker-like-1',
      expectedVersion: like.version,
    });
    assert.equal(noRedispatch.kind, 'unchanged', 'pending action is never dispatched twice');

    const confirmedLike = await mode.recordActionReceipt({
      actionId: like.actionId,
      accountId: like.accountId,
      policyRevision: like.policyRevision,
      sourceDedupeKey: 'like-receipt-1',
      outcome: 'confirmed_new_like',
      occurredAt: now + 2,
      expectedContentKey: 'post-1',
      expectedContentUrl: 'https://www.facebook.com/posts/1',
    });
    assert.equal(confirmedLike.kind, 'settled', 'same correlation key upgrades pending to terminal');
    if (confirmedLike.kind !== 'settled') throw new Error('expected settled like');
    assert.equal(confirmedLike.nextAction?.actionType, 'join');
    assert.equal(confirmedLike.nextAction?.state, 'waiting_target');

    const duplicateLike = await mode.recordActionReceipt({
      actionId: like.actionId,
      accountId: like.accountId,
      policyRevision: like.policyRevision,
      sourceDedupeKey: 'like-receipt-1',
      outcome: 'confirmed_new_like',
      occurredAt: now + 3,
    });
    assert.equal(duplicateLike.kind, 'duplicate');

    const firstJoin = confirmedLike.nextAction!;
    const missingTarget = await mode.recordActionReceipt({
      actionId: firstJoin.actionId,
      accountId: firstJoin.accountId,
      policyRevision: firstJoin.policyRevision,
      sourceDedupeKey: 'join-no-target-1',
      outcome: 'no_target',
      occurredAt: now + 4,
    });
    assert.equal(missingTarget.kind, 'incompatible_outcome');
    assert.equal((await store.getAction(firstJoin.actionId))?.state, 'waiting_target');

    let join = await claim(store, firstJoin, 'worker-join-1');
    const joinClaimVersion = join.version;
    const boundJoin = await store.bindTargetAndMarkDispatched({
      actionId: join.actionId,
      accountId: join.accountId,
      policyRevision: join.policyRevision,
      ownerId: 'worker-join-1',
      expectedVersion: join.version,
      target: {
        groupKey: 'group-1',
        groupUrl: 'https://www.facebook.com/groups/1',
      },
    });
    assert.equal(boundJoin.kind, 'updated');
    if (boundJoin.kind !== 'updated') throw new Error('expected bound join');
    join = boundJoin.action;
    assert.equal(join.state, 'dispatched');
    const handoffReplay = await store.bindTargetAndMarkDispatched({
      actionId: join.actionId,
      accountId: join.accountId,
      policyRevision: join.policyRevision,
      ownerId: 'worker-join-1',
      expectedVersion: joinClaimVersion,
      target: {
        groupKey: 'group-1',
        groupUrl: 'https://www.facebook.com/groups/1',
      },
    });
    assert.equal(handoffReplay.kind, 'unchanged', 'assigned target is never sent twice');
    const alreadyMember = await mode.recordActionReceipt({
      actionId: join.actionId,
      accountId: join.accountId,
      policyRevision: join.policyRevision,
      sourceDedupeKey: 'join-receipt-1',
      outcome: 'already_member',
      occurredAt: now + 5,
      expectedGroupKey: 'group-1',
      expectedGroupUrl: 'https://www.facebook.com/groups/1',
    });
    assert.equal(alreadyMember.kind, 'settled');
    if (alreadyMember.kind !== 'settled') throw new Error('expected settled already member');
    assert.equal(alreadyMember.nextAction, null);
    assert.equal((await store.getRuntimeView('fb-1', 1))?.confirmedNewJoinsSinceComment, 0);

    const secondLikeCreated = await recordView(mode, 1, 2);
    assert.equal(secondLikeCreated.kind, 'action_created');
    if (secondLikeCreated.kind !== 'action_created') throw new Error('expected second like');
    let secondLike = await claim(store, secondLikeCreated.action, 'worker-like-2');
    secondLike = await dispatch(store, secondLike, 'worker-like-2');
    const secondLikeSettled = await mode.recordActionReceipt({
      actionId: secondLike.actionId,
      accountId: secondLike.accountId,
      policyRevision: 1,
      sourceDedupeKey: 'like-receipt-2',
      outcome: 'confirmed_new_like',
      occurredAt: now + 6,
      expectedContentUrl: 'https://www.facebook.com/posts/2',
    });
    assert.equal(secondLikeSettled.kind, 'settled');
    if (secondLikeSettled.kind !== 'settled' || !secondLikeSettled.nextAction) {
      throw new Error('expected second join');
    }

    join = await claim(store, secondLikeSettled.nextAction, 'worker-join-2');
    const secondBoundJoin = await store.bindActionTarget({
      actionId: join.actionId,
      accountId: join.accountId,
      policyRevision: 1,
      ownerId: 'worker-join-2',
      expectedVersion: join.version,
      target: {
        groupKey: 'group-2',
        groupUrl: 'https://www.facebook.com/groups/2',
      },
    });
    assert.equal(secondBoundJoin.kind, 'updated');
    if (secondBoundJoin.kind !== 'updated') throw new Error('expected second bound join');
    join = await dispatch(store, secondBoundJoin.action, 'worker-join-2');
    const confirmedJoin = await mode.recordActionReceipt({
      actionId: join.actionId,
      accountId: join.accountId,
      policyRevision: 1,
      sourceDedupeKey: 'join-receipt-2',
      outcome: 'confirmed_new_join',
      occurredAt: now + 7,
      expectedGroupUrl: 'https://www.facebook.com/groups/2',
    });
    assert.equal(confirmedJoin.kind, 'settled');
    if (confirmedJoin.kind !== 'settled' || !confirmedJoin.nextAction) {
      throw new Error('expected comment obligation');
    }
    assert.equal(confirmedJoin.nextAction.actionType, 'comment');
    assert.equal(
      confirmedJoin.nextAction.target.selection,
      'first_commentable_group_post',
    );

    let comment = await claim(store, confirmedJoin.nextAction, 'worker-comment');
    const boundGroup = await store.bindActionTarget({
      actionId: comment.actionId,
      accountId: comment.accountId,
      policyRevision: 1,
      ownerId: 'worker-comment',
      expectedVersion: comment.version,
      target: {
        groupKey: 'historical-group',
        groupUrl: 'https://www.facebook.com/groups/historical',
        evidence: {
          joinedAt: '2026-07-01T00:00:00.000Z',
          groupCommentPolicyRevision: 7,
          joinToFirstCommentHours: 24,
          recommentCooldownHours: 72,
        },
      },
    });
    assert.equal(boundGroup.kind, 'updated');
    if (boundGroup.kind !== 'updated') throw new Error('expected bound comment group');
    assert.equal(boundGroup.action.state, 'waiting_target');
    assert.equal(boundGroup.action.target.groupUrl, 'https://www.facebook.com/groups/historical');

    const boundContent = await store.bindActionTarget({
      actionId: comment.actionId,
      accountId: comment.accountId,
      policyRevision: 1,
      ownerId: 'worker-comment',
      expectedVersion: boundGroup.action.version,
      target: {
        contentKey: 'historical-post-1',
        contentUrl: 'https://www.facebook.com/groups/historical/posts/1',
      },
    });
    assert.equal(boundContent.kind, 'updated');
    if (boundContent.kind !== 'updated') throw new Error('expected bound comment content');
    assert.equal(boundContent.action.state, 'ready');
    comment = await dispatch(store, boundContent.action, 'worker-comment');
    const ambiguousComment = await mode.recordActionReceipt({
      actionId: comment.actionId,
      accountId: comment.accountId,
      policyRevision: 1,
      sourceDedupeKey: 'comment-receipt-1',
      outcome: 'ambiguous',
      occurredAt: now + 8,
      expectedGroupUrl: 'https://www.facebook.com/groups/historical',
      expectedContentUrl: 'https://www.facebook.com/groups/historical/posts/1',
    });
    assert.equal(ambiguousComment.kind, 'settled');
    if (ambiguousComment.kind !== 'settled') throw new Error('expected ambiguous terminal');
    assert.equal(ambiguousComment.nextAction, null);
    assert.equal((await store.getRuntimeView('fb-1', 1))?.activeAction, null);
  });

  it('uses PostgreSQL-compatible bindings while superseding undispatched work and settling dispatched work', async () => {
    let now = 1_800_100_000_000;
    const clock = () => now;
    const db = memoryDatabase(clock);
    const first = makeStore(db, 'dev', clock);
    await first.init();
    const firstMode = new FacebookConsumptionMode(first);
    const rev1 = await recordView(firstMode, 1, 10);
    assert.equal(rev1.kind, 'action_created');
    if (rev1.kind !== 'action_created') throw new Error('expected rev1 action');
    const claimed = await first.claimAction({
      actionId: rev1.action.actionId,
      accountId: 'fb-1',
      policyRevision: 1,
      ownerId: 'dead-worker',
      leaseMs: 1_000,
    });
    assert.equal(claimed.kind, 'claimed');

    now += 2_000;
    const restarted = makeStore(db, 'dev', clock);
    await restarted.init();
    const recovered = await restarted.getAction(rev1.action.actionId);
    assert.equal(recovered?.ownerId, null);
    assert.equal(recovered?.state, 'ready');
    assert.equal(recovered?.target.contentUrl, 'https://www.facebook.com/posts/10');

    const superseded = await restarted.supersedeAccount({
      accountId: 'fb-1',
      keepPolicyRevision: 2,
    });
    assert.equal(superseded[0]?.outcome, 'policy_superseded');
    assert.equal(superseded[0]?.state, 'terminal');

    const rev2 = await recordView(new FacebookConsumptionMode(restarted), 2, 20);
    assert.equal(rev2.kind, 'action_created');
    if (rev2.kind !== 'action_created') throw new Error('expected rev2 action');
    let dispatchedOld = await claim(restarted, rev2.action, 'worker-rev2');
    dispatchedOld = await dispatch(restarted, dispatchedOld, 'worker-rev2');
    const inFlightSuperseded = await restarted.supersedeAccount({
      accountId: 'fb-1',
      keepPolicyRevision: 3,
    });
    assert.equal(inFlightSuperseded[0]?.state, 'dispatched');
    assert.equal(inFlightSuperseded[0]?.downstreamEnabled, false);

    const lateConfirmed = await restarted.settleAction({
      actionId: dispatchedOld.actionId,
      accountId: 'fb-1',
      policyRevision: 2,
      sourceDedupeKey: 'late-like-receipt',
      outcome: 'confirmed_new_like',
      occurredAt: now + 1,
      expectedContentUrl: 'https://www.facebook.com/posts/20',
    });
    assert.equal(lateConfirmed.kind, 'settled');
    if (lateConfirmed.kind !== 'settled') throw new Error('expected late settlement');
    assert.equal(lateConfirmed.nextAction, null);
    assert.equal((await restarted.getRuntimeView('fb-1', 2))?.confirmedNewLikesSinceJoin, 0);

    const rev3 = await recordView(new FacebookConsumptionMode(restarted), 3, 30);
    assert.equal(rev3.kind, 'action_created');
    if (rev3.kind !== 'action_created') throw new Error('expected rev3 action');
    assert.equal(rev3.action.sequence, 1);
  });

  it('accepts the exact authoritative revision after rebinding to a numerically older environment policy', async () => {
    const now = 1_800_200_000_000;
    const db = memoryDatabase(() => now);
    const store = makeStore(db, 'dev', () => now);
    await store.init();
    const mode = new FacebookConsumptionMode(store);

    const newerNumericRevision = await recordView(mode, 100, 100);
    assert.equal(newerNumericRevision.kind, 'action_created');
    if (newerNumericRevision.kind !== 'action_created') {
      throw new Error('expected newer numeric revision action');
    }

    const currentAfterRebind = await recordView(mode, 20, 20);
    assert.equal(currentAfterRebind.kind, 'action_created');
    if (currentAfterRebind.kind !== 'action_created') {
      throw new Error('expected authoritative lower revision action');
    }
    assert.equal(currentAfterRebind.action.policyRevision, 20);
    assert.equal(
      (await store.getAction(newerNumericRevision.action.actionId))?.outcome,
      'policy_superseded',
    );
  });

  it('isolates the same account, revision, content, and source facts by execution target', async () => {
    let now = 1_800_200_000_000;
    const db = memoryDatabase(() => now);
    const dev = makeStore(db, 'dev', () => now);
    const ol = makeStore(db, 'ol', () => now);
    await dev.init();
    await ol.init();
    const input = {
      accountId: 'fb-shared',
      policy: { policyRevision: 1, snapshot: oneOneOne },
      contentKey: 'post-shared',
      contentUrl: 'https://www.facebook.com/posts/shared',
      sourceDedupeKey: 'view-shared',
      occurredAt: now,
    };
    const devResult = await dev.applyConfirmedView(input);
    const olResult = await ol.applyConfirmedView(input);
    assert.equal(devResult.kind, 'action_created');
    assert.equal(olResult.kind, 'action_created');
    if (devResult.kind !== 'action_created' || olResult.kind !== 'action_created') {
      throw new Error('expected target-isolated actions');
    }
    assert.notEqual(devResult.action.actionId, olResult.action.actionId);
    assert.equal(devResult.action.executionTarget, 'dev');
    assert.equal(olResult.action.executionTarget, 'ol');
  });
});

describe('facebook consumption migration contract', () => {
  it('redefines the active-action index per action type without renaming it', async () => {
    const sql = await readFile(
      new URL('../../migrations/0111_facebook_consumption_obligation_per_type.sql', import.meta.url),
      'utf8',
    );
    // 名字不变是硬要求：启动期契约门按名字查索引，改名会让回滚到旧码的进程起不来。
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_facebook_consumption_active_action[\s\S]*\(account_id, execution_target, action_type\)[\s\S]*WHERE state <> 'terminal'/,
    );
    assert.match(sql, /DROP INDEX IF EXISTS uq_facebook_consumption_active_action/);
    // 含 DROP INDEX ⇒ 只能标 contract。标成 expand 会绕过共库期那道「默认拒绝收缩」的闸。
    assert.match(sql, /^-- aidcp:kind=contract$/m);
  });

  it('persists exact content URLs and enforces one active action per account and target', async () => {
    const sql = await readFile(
      new URL('../../migrations/0102_facebook_consumption_runtime.sql', import.meta.url),
      'utf8',
    );
    assert.match(sql, /facebook_consumption_progress/);
    assert.match(sql, /facebook_consumption_view_fact[\s\S]*content_url\s+TEXT NOT NULL/);
    assert.match(sql, /facebook_consumption_action[\s\S]*content_url\s+TEXT/);
    assert.match(
      sql,
      /uq_facebook_consumption_active_action[\s\S]*account_id,\s*execution_target[\s\S]*WHERE state <> 'terminal'/,
    );
    assert.match(
      sql,
      /UNIQUE \(\s*account_id,\s*execution_target,\s*policy_revision,\s*source_dedupe_key\s*\)/,
    );
    assert.doesNotMatch(sql, /'no_target'/, 'target absence must remain waiting, not terminal');
    assert.doesNotMatch(sql, /joinFirst/);
    assert.match(
      sql,
      /facebook_group_join_audit_trigger_source_check[\s\S]*'consumption'/,
      'consumption join audits must be admitted by the deployed DB constraint',
    );
  });
});
