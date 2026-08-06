import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  PacingConfigCatalogView,
  PanelPacingConfig,
  PanelQuotaConfig,
  PanelResumeConfig,
  PanelSessionLimits,
  QuotaConfigCatalogView,
  ResumeConfigView,
  SessionLimitView,
} from '@kernel/kernel/config-panel-ports.js';
import {
  PanelPacingConfigHttpClient,
  PanelQuotaConfigHttpClient,
  PanelResumeConfigHttpClient,
  PanelSessionLimitsHttpClient,
  registerPanelConfigRoutes,
} from '@automation/transport/panel-config-http.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '@automation/transport/internal-http.js';

const quotaView: QuotaConfigCatalogView = {
  quotas: [{
    tier: 'normal',
    action: 'like',
    daily: 10,
    perMinute: 2,
    perHour: 5,
    overridden: true,
    updatedAt: '2026-07-26T00:00:00.000Z',
    updatedBy: 'alice',
  }],
};
const pacingView: PacingConfigCatalogView = {
  pacing: [{
    operation: 'action',
    minMs: 2_000,
    maxMs: 5_000,
    overridden: true,
    updatedAt: '2026-07-26T00:00:00.000Z',
    updatedBy: 'alice',
  }],
};
const sessionView: SessionLimitView = {
  maxDurationMin: 10,
  budget: {
    likes: 10,
    collects: 5,
    follows: 3,
    searches: 5,
    comments: 2,
    comment_likes: 3,
    join_groups: 1,
  },
  collectSaveLikeDenom: 3,
  followFansDenom: 8,
  activeWeekMask: null,
  overridden: false,
  updatedAt: null,
  updatedBy: null,
};
const resumeView: ResumeConfigView = {
  restRatioPct: 10,
  activeWindowStartMin: 0,
  activeWindowEndMin: 1_440,
  dailyMaxSessions: 0,
  dailyMaxMinutes: 0,
  idleNudgeMs: 90_000,
  idleEndMs: 300_000,
  overridden: false,
  updatedAt: null,
  updatedBy: null,
};

async function withServer(
  ports: {
    quota: PanelQuotaConfig;
    pacing: PanelPacingConfig;
    session: PanelSessionLimits;
    resume: PanelResumeConfig;
  },
  run: (http: InternalHttpClient) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerPanelConfigRoutes(server, ports);
  const port = await server.listen(0);
  try {
    await run(new InternalHttpClient(`http://127.0.0.1:${port}`));
  } finally {
    await server.close();
  }
}

test('四个配置 facade 的八个方法逐字段往返，updatedBy 与写后 owner 真态不丢', async () => {
  const calls: unknown[] = [];
  await withServer({
    quota: {
      getCatalog: async () => quotaView,
      setQuota: async (patch, updatedBy) => {
        calls.push(['quota', patch, updatedBy]);
        return { ok: true, view: quotaView };
      },
    },
    pacing: {
      getCatalog: async () => pacingView,
      setPacing: async (patch, updatedBy) => {
        calls.push(['pacing', patch, updatedBy]);
        return { ok: false, reason: 'invalid_value' };
      },
    },
    session: {
      getView: async () => sessionView,
      set: async (patch, updatedBy) => {
        calls.push(['session', patch, updatedBy]);
        return { ok: true, view: sessionView };
      },
    },
    resume: {
      getView: async () => resumeView,
      set: async (patch, updatedBy) => {
        calls.push(['resume', patch, updatedBy]);
        return { ok: true, view: resumeView };
      },
    },
  }, async (http) => {
    const quota = new PanelQuotaConfigHttpClient(http);
    const pacing = new PanelPacingConfigHttpClient(http);
    const session = new PanelSessionLimitsHttpClient(http);
    const resume = new PanelResumeConfigHttpClient(http);

    assert.deepEqual(await quota.getCatalog(), quotaView);
    assert.deepEqual(
      await quota.setQuota({ tier: 'normal', action: 'like', daily: 10 }, 'alice'),
      { ok: true, view: quotaView },
    );
    assert.deepEqual(await pacing.getCatalog(), pacingView);
    assert.deepEqual(
      await pacing.setPacing({ operation: 'action', minMs: 2_000, maxMs: 5_000 }, 'bob'),
      { ok: false, reason: 'invalid_value' },
    );
    assert.deepEqual(await session.getView(), sessionView);
    assert.deepEqual(
      await session.set({ activeWeekMask: '0'.repeat(168) }, 'carol'),
      { ok: true, view: sessionView },
    );
    assert.deepEqual(await resume.getView(), resumeView);
    assert.deepEqual(
      await resume.set({ dailyMaxSessions: 0 }, 'dave'),
      { ok: true, view: resumeView },
    );
  });
  assert.deepEqual(calls, [
    ['quota', { tier: 'normal', action: 'like', daily: 10 }, 'alice'],
    ['pacing', { operation: 'action', minMs: 2_000, maxMs: 5_000 }, 'bob'],
    ['session', { activeWeekMask: '0'.repeat(168) }, 'carol'],
    ['resume', { dailyMaxSessions: 0 }, 'dave'],
  ]);
});

test('owner 读取失败向客户端抛错，绝不回默认、陈旧值或空成功', async () => {
  await withServer({
    quota: {
      getCatalog: async () => {
        throw new Error('quota owner unavailable');
      },
      setQuota: async () => ({ ok: false, reason: 'no_valid_fields' }),
    },
    pacing: {
      getCatalog: async () => pacingView,
      setPacing: async () => ({ ok: false, reason: 'no_valid_fields' }),
    },
    session: {
      getView: async () => sessionView,
      set: async () => ({ ok: false, reason: 'no_valid_fields' }),
    },
    resume: {
      getView: async () => resumeView,
      set: async () => ({ ok: false, reason: 'no_valid_fields' }),
    },
  }, async (http) => {
    await assert.rejects(
      () => new PanelQuotaConfigHttpClient(http).getCatalog(),
      (error: unknown) =>
        error instanceof InternalHttpError
        && error.code === 'handler_error'
        && error.message === 'quota owner unavailable',
    );
  });
});
