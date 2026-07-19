import type { DelegatedActionFamily, DelegatedTask, DelegatedTaskStatus, TaskConstraints } from './types.js';

export interface DelegatedOwnershipTask {
  id: string;
  accountId: string;
  actionFamily: DelegatedActionFamily;
  status: DelegatedTaskStatus;
  sourceConstraints: TaskConstraints;
}

const ACTIVE_OWNERSHIP_STATUSES = new Set<DelegatedTaskStatus>([
  'planning',
  'waiting_approval',
  'executing',
]);

export function delegatedRewriteSourceId(task: Pick<DelegatedTask, 'actionFamily' | 'sourceConstraints'>): string | null {
  if (task.actionFamily !== 'publish') return null;
  const sourceId = task.sourceConstraints.sourceId;
  return typeof sourceId === 'string' && sourceId.trim() ? sourceId.trim() : null;
}

/**
 * Delegated publish work has two independent ownership lanes:
 * - rewrite generation: account + sourceId;
 * - autonomous publishing: account (no sourceId).
 *
 * A persisted rewrite draft waiting for approval no longer owns its generation
 * lane. The publish scheduler still enforces the global and per-source limits.
 */
export function delegatedTasksConflict(candidate: DelegatedOwnershipTask, active: DelegatedOwnershipTask): boolean {
  if (candidate.id === active.id) return false;
  if (candidate.accountId !== active.accountId || candidate.actionFamily !== active.actionFamily) return false;
  if (!ACTIVE_OWNERSHIP_STATUSES.has(active.status)) return false;

  if (candidate.actionFamily !== 'publish') return true;

  const candidateSourceId = delegatedRewriteSourceId(candidate);
  const activeSourceId = delegatedRewriteSourceId(active);
  if (candidateSourceId && activeSourceId) {
    if (active.status === 'waiting_approval') return false;
    return candidateSourceId === activeSourceId;
  }

  // Rewrite generation and autonomous publishing use separate scheduler lanes.
  if (candidateSourceId || activeSourceId) return false;

  // Autonomous publishing remains single-flight per account.
  return true;
}
