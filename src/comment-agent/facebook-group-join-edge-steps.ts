import { randomUUID } from 'node:crypto';

import { makeEnvelope } from '../comm/protocol.js';
import type { EventBus } from '../event-bus/index.js';
import type { EdgePusher } from './edge-steps.js';
import type { FacebookGroupJoinObservation } from '../agents/facebook-group-join-judge.js';

export const FACEBOOK_GROUP_JOIN_STEP_TIMEOUT_MS = 28_000;

export interface FacebookGroupJoinEdgeStepsDeps {
  bus: EventBus;
  pusher: EdgePusher;
  edgeId: string;
  taskId: string;
  stepTimeoutMs?: number;
  logger?: Pick<Console, 'warn'>;
}

export interface FacebookGroupJoinStepResult {
  ok: boolean;
  reason?: string;
  groupUrl?: string;
  clicked?: boolean;
  observation?: FacebookGroupJoinObservation;
  postObservation?: FacebookGroupJoinObservation;
}

interface ActionCompleted {
  action: string;
  ok: boolean;
  reason?: string;
  groupUrl?: string;
  clicked?: boolean;
  observation?: unknown;
  postObservation?: unknown;
}

function asObservation(value: unknown): FacebookGroupJoinObservation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as FacebookGroupJoinObservation;
}

function sendAndAwaitJoin(
  bus: EventBus,
  timeoutMs: number,
  send: () => number,
): Promise<FacebookGroupJoinStepResult | null> {
  return new Promise((resolve) => {
    let done = false;
    const off = bus.on('action.completed', (data) => {
      const d = data as ActionCompleted;
      if (d.action !== 'join_group') return;
      finish({
        ok: d.ok,
        ...(d.reason ? { reason: d.reason } : {}),
        ...(d.groupUrl ? { groupUrl: d.groupUrl } : {}),
        ...(typeof d.clicked === 'boolean' ? { clicked: d.clicked } : {}),
        ...(asObservation(d.observation) ? { observation: asObservation(d.observation) } : {}),
        ...(asObservation(d.postObservation) ? { postObservation: asObservation(d.postObservation) } : {}),
      });
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    const finish = (value: FacebookGroupJoinStepResult | null): void => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve(value);
    };
    const sent = send();
    if (sent <= 0) finish(null);
  });
}

export function buildFacebookGroupJoinEdgeSteps(deps: FacebookGroupJoinEdgeStepsDeps): {
  observeGroup(groupUrl: string): Promise<FacebookGroupJoinStepResult>;
  clickJoin(groupUrl: string, thinkMs?: number): Promise<FacebookGroupJoinStepResult>;
} {
  const timeout = deps.stepTimeoutMs ?? FACEBOOK_GROUP_JOIN_STEP_TIMEOUT_MS;
  const push = (env: unknown): number => deps.pusher.pushToEdges(env, deps.edgeId);
  const logger = deps.logger ?? console;

  async function run(groupUrl: string, click: boolean, thinkMs?: number): Promise<FacebookGroupJoinStepResult> {
    const result = await sendAndAwaitJoin(
      deps.bus,
      timeout,
      () =>
        push(
          makeEnvelope('group.join', randomUUID(), Date.now(), {
            taskId: deps.taskId,
            groupUrl,
            click,
            ...(typeof thinkMs === 'number' ? { thinkMs } : {}),
          }),
        ),
    );
    if (result === null) {
      logger.warn?.(`[fb-group-join-steps] ${click ? 'join' : 'observe'} 超时/离线 group=${groupUrl}`);
      return { ok: false, reason: 'timeout', groupUrl, clicked: false };
    }
    return result;
  }

  return {
    observeGroup: (groupUrl) => run(groupUrl, false),
    clickJoin: (groupUrl, thinkMs) => run(groupUrl, true, thinkMs),
  };
}
