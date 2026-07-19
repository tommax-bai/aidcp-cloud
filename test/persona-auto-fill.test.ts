import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PersonaAutoFillService } from '../src/agents/persona-auto-fill.js';
import type {
  PersonaAutoFillRun,
  PersonaAutoFillRunState,
  PersonaAutoFillTarget,
  PersonaAutoFillTargetState,
} from '../src/config/persona-auto-fill-store.js';
import type { PersonaAutoFillStore } from '../src/config/persona-auto-fill-store.js';
import type { ClientUserStore } from '../src/client-auth/client-user-store.js';
import type { PersonaStore } from '../src/config/persona-store.js';
import type { PanelPersonaConfig } from '../src/panel/types.js';
import type { PersonaGenerator } from '../src/agents/persona-generator.js';

const VALID_SOUL = `identity:\n  name: "自动人设"\n  role: "生活分享者"\n  background: "关注日常生活"\n  tone: "自然、亲切"\ninterests:\n  primary:\n    - "生活"\n  secondary:\n    - "旅行"\n  seed_keywords:\n    - "周末生活"\nwriting_language: "zh-CN"\n`;

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('wait timeout'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function harness(input: {
  bindings: Record<string, string | null | 'lost'>;
  existing?: string[];
  generationFails?: boolean;
  concurrentWinner?: boolean;
  recoverRun?: boolean;
}) {
  const run: PersonaAutoFillRun = {
    runId: 'run-1', userId: 'customer-a', idempotencyKey: 'batch-1', platform: 'facebook',
    strategy: 'facebook_auto_v1', writingLanguage: 'zh-CN', state: 'running',
  };
  const targets = new Map<string, PersonaAutoFillTarget>();
  for (const envKey of Object.keys(input.bindings)) {
    targets.set(envKey, {
      runId: run.runId, userId: run.userId, envKey, accountId: null, writingLanguage: 'zh-CN',
      state: 'pending', attempts: 0, reason: null,
    });
  }
  const existing = new Set(input.existing ?? []);
  let generateCalls = 0;
  const refresh = (): PersonaAutoFillRunState => {
    const states = [...targets.values()].map((target) => target.state);
    run.state = states.some((state) => ['waiting_binding', 'pending', 'running'].includes(state))
      ? 'running'
      : states.includes('failed') ? 'completed_with_failures' : 'completed';
    return run.state;
  };
  const store = {
    createRun: async () => ({ run: { ...run }, created: true }),
    listPendingForRun: async () => [...targets.values()].filter((target) => target.state === 'pending'),
    listWaitingForEnvironment: async (envKey: string) => {
      const target = targets.get(envKey);
      return target && ['waiting_binding', 'pending'].includes(target.state) ? [target] : [];
    },
    claimTarget: async (_runId: string, envKey: string, accountId: string) => {
      const target = targets.get(envKey)!;
      if (!['pending', 'waiting_binding'].includes(target.state)) return null;
      target.state = 'running';
      target.accountId = accountId;
      target.attempts += 1;
      return { ...target };
    },
    markTarget: async (_runId: string, envKey: string, state: PersonaAutoFillTargetState, reason: string | null) => {
      const target = targets.get(envKey)!;
      target.state = state;
      target.reason = reason;
      refresh();
    },
    refreshRunState: async () => refresh(),
    recoverRunnableRunIds: async () => input.recoverRun ? [run.runId] : [],
  } as unknown as PersonaAutoFillStore;
  const clientUsers = {
    resolveBoundAccountForEnv: async (_userId: string, envKey: string) => {
      const accountId = input.bindings[envKey];
      if (accountId === 'lost') return { ok: false as const, reason: 'environment_not_owned' as const };
      return accountId ? { ok: true as const, accountId } : { ok: false as const, reason: 'binding_unknown' as const };
    },
  } as Pick<ClientUserStore, 'resolveBoundAccountForEnv'>;
  const personas = {
    getForAccount: (accountId: string) => existing.has(accountId) ? VALID_SOUL : null,
  } as Pick<PersonaStore, 'getForAccount'>;
  const generator = {
    generate: async () => {
      generateCalls += 1;
      return input.generationFails
        ? { ok: false as const, reason: 'generation_failed' as const }
        : { ok: true as const, soulYaml: VALID_SOUL, identitySummary: '自动人设' };
    },
  } as Pick<PersonaGenerator, 'generate'>;
  const personaPanel = {
    setPersonaIfMissing: async (accountId: string) => {
      if (input.concurrentWinner || existing.has(accountId)) return { ok: true as const, created: false };
      existing.add(accountId);
      return { ok: true as const, created: true };
    },
  } as Pick<PanelPersonaConfig, 'setPersonaIfMissing'>;
  const service = new PersonaAutoFillService({ store, clientUsers, personas, generator, personaPanel });
  return { service, run, targets, bindings: input.bindings, getGenerateCalls: () => generateCalls };
}

test('已绑定缺失人设自动生成；未绑定 target 持久等待，未来握手后继续', async () => {
  const h = harness({ bindings: { 'env-bound': 'account-a', 'env-later': null } });
  await h.service.createRun({ userId: 'customer-a', idempotencyKey: 'batch-1', writingLanguage: 'zh-CN' });
  await waitFor(() => h.targets.get('env-bound')?.state === 'succeeded' && h.targets.get('env-later')?.state === 'waiting_binding');
  assert.equal(h.run.state, 'running');
  h.bindings['env-later'] = 'account-b';
  h.service.notifyEnvironmentBound('env-later');
  await waitFor(() => h.targets.get('env-later')?.state === 'succeeded');
  assert.equal(h.run.state, 'completed');
});

test('已有人工人设与并发人工抢先写入均跳过，不覆盖', async () => {
  const existing = harness({ bindings: { env: 'account-a' }, existing: ['account-a'] });
  await existing.service.createRun({ userId: 'customer-a', idempotencyKey: 'batch-1', writingLanguage: 'zh-CN' });
  await waitFor(() => existing.targets.get('env')?.state === 'skipped_existing');
  assert.equal(existing.getGenerateCalls(), 0);

  const race = harness({ bindings: { env: 'account-a' }, concurrentWinner: true });
  await race.service.createRun({ userId: 'customer-a', idempotencyKey: 'batch-1', writingLanguage: 'zh-CN' });
  await waitFor(() => race.targets.get('env')?.state === 'skipped_existing');
  assert.equal(race.targets.get('env')?.reason, 'persona_won_concurrent_race');
});

test('生成失败按持久 attempts 有界重试，最终诚实 completed_with_failures', async () => {
  const h = harness({ bindings: { env: 'account-a' }, generationFails: true });
  await h.service.createRun({ userId: 'customer-a', idempotencyKey: 'batch-1', writingLanguage: 'zh-CN' });
  await waitFor(() => h.targets.get('env')?.state === 'failed');
  assert.equal(h.targets.get('env')?.attempts, 2);
  assert.equal(h.getGenerateCalls(), 2);
  assert.equal(h.run.state, 'completed_with_failures');
});

test('归属已撤销时诚实失败；启动恢复会继续 pending target', async () => {
  const lost = harness({ bindings: { env: 'lost' } });
  await lost.service.createRun({ userId: 'customer-a', idempotencyKey: 'batch-1', writingLanguage: 'zh-CN' });
  await waitFor(() => lost.targets.get('env')?.state === 'failed');
  assert.equal(lost.targets.get('env')?.reason, 'environment_not_owned');
  assert.equal(lost.getGenerateCalls(), 0);

  const recovered = harness({ bindings: { env: 'account-a' }, recoverRun: true });
  await recovered.service.resume();
  await waitFor(() => recovered.targets.get('env')?.state === 'succeeded');
  assert.equal(recovered.run.state, 'completed');
});
