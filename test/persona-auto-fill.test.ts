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

const SELECTED_SOUL = `identity:\n  name: "旅行兴趣分享者"\n  role: "旅行内容爱好者"\n  background: "关注城市散步与周末出游"\n  tone: "亲切接地气"\nwriting_language: "zh-CN"\ninterests:\n  primary:\n    - "城市散步"\n  secondary:\n    - "旅行"\n  seed_keywords:\n    - "周末出游"\nbehavior_guidelines:\n  style: "亲切接地气；自然互动"\n  privacy: "不编造私人经历"\n  collection_principle: "只收藏长期有用的内容"\n  like_principle: "只在真正喜欢时点赞"\n  like_affinity: "normal"\n`;

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
  concurrentWinner?: boolean;
  recoverRun?: boolean;
  legacyRun?: boolean;
}) {
  const run: PersonaAutoFillRun = {
    runId: 'run-1', userId: 'customer-a', idempotencyKey: 'selected-1', platform: 'facebook',
    strategy: input.legacyRun ? 'facebook_auto_v1' : 'selected_persona_v1',
    writingLanguage: 'zh-CN', soulYaml: input.legacyRun ? null : SELECTED_SOUL, state: 'running',
  };
  const targets = new Map<string, PersonaAutoFillTarget>();
  for (const envKey of Object.keys(input.bindings)) {
    targets.set(envKey, {
      runId: run.runId, userId: run.userId, envKey, accountId: null,
      strategy: run.strategy, writingLanguage: 'zh-CN', soulYaml: run.soulYaml,
      state: 'pending', attempts: 0, reason: null,
    });
  }
  const existing = new Set(input.existing ?? []);
  const writes: Array<{ accountId: string; soulYaml: string; updatedBy: string }> = [];
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
    getForAccount: (accountId: string) => existing.has(accountId) ? SELECTED_SOUL : null,
  } as Pick<PersonaStore, 'getForAccount'>;
  const personaPanel = {
    setPersonaIfMissing: async (accountId: string, soulYaml: string, updatedBy: string) => {
      writes.push({ accountId, soulYaml, updatedBy });
      if (input.concurrentWinner || existing.has(accountId)) return { ok: true as const, created: false };
      existing.add(accountId);
      return { ok: true as const, created: true };
    },
  } as Pick<PanelPersonaConfig, 'setPersonaIfMissing'>;
  const service = new PersonaAutoFillService({ store, clientUsers, personas, personaPanel });
  return { service, run, targets, bindings: input.bindings, writes };
}

test('已绑定缺失账号写入同一份所选人设；未绑定目标等待真实握手', async () => {
  const h = harness({ bindings: { 'env-bound': 'account-a', 'env-later': null } });
  await h.service.createRun({ userId: 'customer-a', idempotencyKey: 'selected-1', soulYaml: SELECTED_SOUL });
  await waitFor(() => h.targets.get('env-bound')?.state === 'succeeded' && h.targets.get('env-later')?.state === 'waiting_binding');
  h.bindings['env-later'] = 'account-b';
  h.service.notifyEnvironmentBound('env-later');
  await waitFor(() => h.targets.get('env-later')?.state === 'succeeded');
  assert.deepEqual(h.writes.map((write) => write.accountId).sort(), ['account-a', 'account-b']);
  assert.deepEqual(new Set(h.writes.map((write) => write.soulYaml)), new Set([SELECTED_SOUL]));
  assert.equal(h.run.state, 'completed');
});

test('已有人工人设与并发人工抢先写入均跳过，不覆盖', async () => {
  const existing = harness({ bindings: { env: 'account-a' }, existing: ['account-a'] });
  await existing.service.createRun({ userId: 'customer-a', idempotencyKey: 'selected-1', soulYaml: SELECTED_SOUL });
  await waitFor(() => existing.targets.get('env')?.state === 'skipped_existing');
  assert.equal(existing.writes.length, 0);

  const race = harness({ bindings: { env: 'account-a' }, concurrentWinner: true });
  await race.service.createRun({ userId: 'customer-a', idempotencyKey: 'selected-1', soulYaml: SELECTED_SOUL });
  await waitFor(() => race.targets.get('env')?.state === 'skipped_existing');
  assert.equal(race.targets.get('env')?.reason, 'persona_won_concurrent_race');
});

test('历史自动生成运行没有已确认模板时 fail-closed，绝不写人设', async () => {
  const h = harness({ bindings: { env: 'account-a' }, legacyRun: true, recoverRun: true });
  await h.service.resume();
  await waitFor(() => h.targets.get('env')?.state === 'failed');
  assert.equal(h.targets.get('env')?.reason, 'selected_persona_required');
  assert.equal(h.writes.length, 0);
  assert.equal(h.run.state, 'completed_with_failures');
});

test('归属撤销时诚实失败；启动恢复继续持久模板', async () => {
  const lost = harness({ bindings: { env: 'lost' } });
  await lost.service.createRun({ userId: 'customer-a', idempotencyKey: 'selected-1', soulYaml: SELECTED_SOUL });
  await waitFor(() => lost.targets.get('env')?.state === 'failed');
  assert.equal(lost.targets.get('env')?.reason, 'environment_not_owned');
  assert.equal(lost.writes.length, 0);

  const recovered = harness({ bindings: { env: 'account-a' }, recoverRun: true });
  await recovered.service.resume();
  await waitFor(() => recovered.targets.get('env')?.state === 'succeeded');
  assert.equal(recovered.writes[0]?.soulYaml, SELECTED_SOUL);
});
