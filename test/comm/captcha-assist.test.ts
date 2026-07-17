import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CaptchaAssistService } from '../../src/comm/captcha-assist.js';
import type { Envelope } from '../../src/comm/protocol.js';
import type { EdgeSession } from '../../src/comm/ws-server.js';

const silentLogger = { error() {}, warn() {}, log() {} };

describe('CaptchaAssistService', () => {
  it('detected creates scoped action URL and sends capture to the original edge', async () => {
    const sent: { env: Envelope; edgeId?: string }[] = [];
    let now = 10_000;
    const service = new CaptchaAssistService({
      enabled: true,
      publicBaseUrl: 'https://console.example',
      tokenSecret: 'secret',
      clock: () => now,
      idGen: () => 'cap-1',
      logger: silentLogger,
      getAccountName: () => '小红书账号 A',
      pusher: { pushToEdges: (env, edgeId) => { sent.push({ env, edgeId }); return 1; } },
    });

    const session: EdgeSession = {
      sessionId: 's1',
      edgeId: 'edge-1',
      accountId: 'acc-1',
      machineLabel: 'ads-k1e0awu5',
    };
    const detected = await service.onDetected({ edgeId: 'edge-1', kind: 'captcha', url: 'https://x' }, session, 'restricted');

    assert.equal(detected?.incidentId, 'cap-1');
    assert.match(detected?.actionUrl ?? '', /^https:\/\/console\.example\/captcha-assist\/cap-1\?token=/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].edgeId, 'edge-1');
    assert.equal(sent[0].env.type, 'captcha.assist.capture');
    assert.equal(service.getIncident('cap-1')?.status, 'capture_pending');
    assert.equal(service.getIncident('cap-1')?.machineLabel, 'ads-k1e0awu5');
    assert.equal(service.getIncident('cap-1')?.riskStatus, 'restricted');

    const token = new URL(detected!.actionUrl).searchParams.get('token') ?? '';
    assert.deepEqual(service.verifyToken(token), { ok: true, incidentId: 'cap-1', iat: 10, exp: 1810 });

    now += 31 * 60_000;
    assert.equal(service.verifyToken(token).ok, false, '过期 scoped token 应拒绝');
  });

  it('snapshot makes incident ready, click dispatch validates snapshot and normalized points', async () => {
    const sent: Envelope[] = [];
    const leaseEvents: string[] = [];
    const service = new CaptchaAssistService({
      enabled: true,
      publicBaseUrl: 'https://console.example',
      tokenSecret: 'secret',
      clock: () => 20_000,
      idGen: () => 'cap-2',
      logger: silentLogger,
      pusher: { pushToEdges: (env) => { sent.push(env); return 1; } },
      taskLeases: {
        acquire: async (request) => {
          leaseEvents.push(`acquire:${request.priority}`);
          return { taskId: 'task-captcha-1', edgeId: request.edgeId, kind: request.kind, priority: request.priority };
        },
        release: async (lease) => { leaseEvents.push(`release:${lease.taskId}`); },
      },
    });
    await service.onDetected({ edgeId: 'edge-2', kind: 'captcha' }, { sessionId: 's2', edgeId: 'edge-2' }, 'restricted');

    service.onSnapshot({
      incidentId: 'cap-2',
      edgeId: 'edge-2',
      snapshotId: 'snap-1',
      capturedAt: 20_100,
      kind: 'captcha',
      url: 'https://x',
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      crop: { x: 0, y: 0, width: 800, height: 600 },
      image: { mime: 'image/png', data: 'base64-image', width: 800, height: 600 },
      overlay: { kind: 'captcha', capturedAt: 20_100, candidates: [] },
    });
    assert.equal(service.getIncident('cap-2')?.status, 'ready');

    const bad = await service.submitClick({
      incidentId: 'cap-2',
      snapshotId: 'snap-1',
      points: [{ x: 1.2, y: 0.5 }],
      actor: 'tester',
    });
    assert.deepEqual(bad, { ok: false, reason: 'invalid_points', incident: service.getIncident('cap-2') });

    const clicked = await service.submitClick({
      incidentId: 'cap-2',
      snapshotId: 'snap-1',
      points: [{ x: 0.2, y: 0.4, label: '烘焙食物' }],
      actor: 'tester',
      settleMs: 1500,
    });
    assert.equal(clicked.ok, true);
    assert.equal(sent.at(-1)?.type, 'captcha.assist.click');
    assert.equal((sent.at(-1)?.payload as { taskId?: string }).taskId, 'task-captcha-1');
    assert.deepEqual(leaseEvents, ['acquire:system_recovery']);
    assert.equal(service.getIncident('cap-2')?.status, 'click_pending');

    service.onClickResult({
      incidentId: 'cap-2',
      snapshotId: 'snap-1',
      status: 'still_blocked',
      checkedAt: 22_000,
      reason: 'captcha_visible',
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(leaseEvents, ['acquire:system_recovery', 'release:task-captcha-1']);
    assert.equal(service.getIncident('cap-2')?.status, 'still_blocked');

    service.onClickResult({
      incidentId: 'cap-2',
      snapshotId: 'snap-1',
      status: 'cleared',
      checkedAt: 23_000,
    });
    assert.equal(service.getIncident('cap-2')?.status, 'cleared');
  });
});

// ── 实时抓帧（change captcha-assist-live-snapshot）─────────────────────────────

function snap(incidentId: string, snapshotId: string, now: number) {
  return {
    incidentId,
    edgeId: 'edge-live',
    snapshotId,
    capturedAt: now,
    kind: 'captcha' as const,
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    crop: { x: 0, y: 0, width: 800, height: 600 },
    image: { mime: 'image/jpeg' as const, data: `d-${snapshotId}`, width: 800, height: 600 },
  };
}

describe('CaptchaAssistService · live snapshot', () => {
  it('迟到实时帧不复活已清除态', async () => {
    const service = new CaptchaAssistService({
      enabled: true,
      publicBaseUrl: 'https://c.example',
      tokenSecret: 's',
      clock: () => 30_000,
      idGen: () => 'cap-live-1',
      logger: silentLogger,
      pusher: { pushToEdges: () => 1 },
    });
    await service.onDetected({ edgeId: 'edge-live', kind: 'captcha' }, { sessionId: 's', edgeId: 'edge-live' }, 'restricted');
    service.onSnapshot(snap('cap-live-1', 'snap-1', 30_100));
    assert.equal(service.getIncident('cap-live-1')?.status, 'ready');
    // 清除后，实时循环在途帧到达 → 必须被忽略，MUST NOT 翻回 ready。
    service.onClickResult({ incidentId: 'cap-live-1', snapshotId: 'snap-1', status: 'cleared', checkedAt: 30_200 });
    assert.equal(service.getIncident('cap-live-1')?.status, 'cleared');
    service.onSnapshot(snap('cap-live-1', 'snap-late', 30_300));
    assert.equal(service.getIncident('cap-live-1')?.status, 'cleared', '迟到帧不得复活为 ready');
  });

  it('submitClick 接受最近 N 帧内的稍旧 snapshotId，拒绝环外的', async () => {
    const service = new CaptchaAssistService({
      enabled: true,
      publicBaseUrl: 'https://c.example',
      tokenSecret: 's',
      clock: () => 40_000,
      idGen: () => 'cap-live-2',
      logger: silentLogger,
      pusher: { pushToEdges: () => 1 },
    });
    await service.onDetected({ edgeId: 'edge-live', kind: 'captcha' }, { sessionId: 's', edgeId: 'edge-live' }, 'restricted');
    // 实时推进：snap-1 → snap-2 → snap-3（最新）。近期集 = [snap-1,snap-2,snap-3]。
    service.onSnapshot(snap('cap-live-2', 'snap-1', 40_100));
    service.onSnapshot(snap('cap-live-2', 'snap-2', 40_200));
    service.onSnapshot(snap('cap-live-2', 'snap-3', 40_300));
    // 环外 snapshotId → snapshot_mismatch（诚实拒绝，不盲点）。
    const stale = await service.submitClick({ incidentId: 'cap-live-2', snapshotId: 'snap-unknown', points: [{ x: 0.5, y: 0.5 }], actor: 't' });
    assert.equal(stale.ok, false);
    assert.equal(stale.ok === false && stale.reason, 'snapshot_mismatch');
    // 稍旧但在近期集内的 snap-1 → 放行（运营点的是被冻结的稍旧帧）。
    const ok = await service.submitClick({ incidentId: 'cap-live-2', snapshotId: 'snap-1', points: [{ x: 0.5, y: 0.5 }], actor: 't' });
    assert.equal(ok.ok, true, '近期集内的稍旧 snapshotId 应放行');
  });

  it('live 开启：capture 带 live hint 并置 liveUntil；关闭则零回归', async () => {
    const sent: { env: Envelope }[] = [];
    const withLive = new CaptchaAssistService({
      enabled: true,
      publicBaseUrl: 'https://c.example',
      tokenSecret: 's',
      clock: () => 50_000,
      idGen: () => 'cap-live-3',
      logger: silentLogger,
      pusher: { pushToEdges: (env) => { sent.push({ env }); return 1; } },
      liveCapture: { enabled: true, intervalMs: 900, maxDurationMs: 25_000, maxFrames: 40 },
    });
    await withLive.onDetected({ edgeId: 'edge-live', kind: 'captcha' }, { sessionId: 's', edgeId: 'edge-live' }, 'restricted');
    const payload = sent[0].env.payload as { live?: { intervalMs?: number; maxDurationMs?: number; maxFrames?: number } };
    assert.deepEqual(payload.live, { intervalMs: 900, maxDurationMs: 25_000, maxFrames: 40 });
    assert.equal(withLive.getIncident('cap-live-3')?.liveUntil, 75_000);

    const sentOff: Envelope[] = [];
    const off = new CaptchaAssistService({
      enabled: true,
      publicBaseUrl: 'https://c.example',
      tokenSecret: 's',
      clock: () => 50_000,
      idGen: () => 'cap-off',
      logger: silentLogger,
      pusher: { pushToEdges: (env) => { sentOff.push(env); return 1; } },
      // liveCapture 未配 = 关闭。
    });
    await off.onDetected({ edgeId: 'edge-live', kind: 'captcha' }, { sessionId: 's', edgeId: 'edge-live' }, 'restricted');
    assert.equal((sentOff[0].payload as { live?: unknown }).live, undefined, 'live 关闭时 capture 不带 live 字段');
    assert.equal(off.getIncident('cap-off')?.liveUntil, undefined);
  });

  it('noteViewerPresence：窗口到期才重新武装；窗口内/终态/关闭均 no-op', async () => {
    let now = 60_000;
    const captures: number[] = [];
    const service = new CaptchaAssistService({
      enabled: true,
      publicBaseUrl: 'https://c.example',
      tokenSecret: 's',
      clock: () => now,
      idGen: () => 'cap-live-4',
      logger: silentLogger,
      pusher: { pushToEdges: (env) => { if (env.type === 'captcha.assist.capture') captures.push(now); return 1; } },
      liveCapture: { enabled: true, maxDurationMs: 30_000 },
    });
    await service.onDetected({ edgeId: 'edge-live', kind: 'captcha' }, { sessionId: 's', edgeId: 'edge-live' }, 'restricted');
    assert.equal(captures.length, 1); // 初始 capture
    service.onSnapshot(snap('cap-live-4', 'snap-1', now)); // → ready，liveUntil=90_000

    // 窗口内轮询 → 不重新武装。
    now = 80_000;
    service.noteViewerPresence('cap-live-4');
    assert.equal(captures.length, 1, '窗口内不 re-arm');

    // 窗口到期后轮询 → 重新武装一次。
    now = 91_000;
    service.noteViewerPresence('cap-live-4');
    assert.equal(captures.length, 2, '窗口到期后 re-arm 一次');

    // 终态（cleared）→ no-op。
    service.onClickResult({ incidentId: 'cap-live-4', snapshotId: 'snap-1', status: 'cleared', checkedAt: now });
    now = 200_000;
    service.noteViewerPresence('cap-live-4');
    assert.equal(captures.length, 2, 'cleared 后不再 re-arm');
  });

  it('noteViewerPresence：live 关闭时恒为 no-op（零回归）', async () => {
    let now = 70_000;
    const captures: number[] = [];
    const service = new CaptchaAssistService({
      enabled: true,
      publicBaseUrl: 'https://c.example',
      tokenSecret: 's',
      clock: () => now,
      idGen: () => 'cap-nolive',
      logger: silentLogger,
      pusher: { pushToEdges: (env) => { if (env.type === 'captcha.assist.capture') captures.push(now); return 1; } },
    });
    await service.onDetected({ edgeId: 'edge-live', kind: 'captcha' }, { sessionId: 's', edgeId: 'edge-live' }, 'restricted');
    now = 200_000;
    service.noteViewerPresence('cap-nolive');
    assert.equal(captures.length, 1, 'live 关闭时 noteViewerPresence 不发 capture');
  });
});

// ── 真实轨迹透传（change captcha-assist-trajectory-replay）─────────────────────

describe('CaptchaAssistService · trajectory', () => {
  const mkService = (sent: Envelope[]) =>
    new CaptchaAssistService({
      enabled: true,
      publicBaseUrl: 'https://c.example',
      tokenSecret: 's',
      clock: () => 100,
      idGen: () => 'cap-traj',
      logger: silentLogger,
      pusher: { pushToEdges: (env) => { sent.push(env); return 1; } },
    });

  it('有效轨迹随 click 透传给边缘', async () => {
    const sent: Envelope[] = [];
    const service = mkService(sent);
    await service.onDetected({ edgeId: 'e', kind: 'captcha' }, { sessionId: 's', edgeId: 'e' }, 'restricted');
    service.onSnapshot(snap('cap-traj', 'snap-1', 100));
    sent.length = 0;

    const r = await service.submitClick({
      incidentId: 'cap-traj',
      snapshotId: 'snap-1',
      points: [{ x: 0.5, y: 0.5 }],
      actor: 't',
      trajectory: { v: 1, samples: [{ x: 0.1, y: 0.1, t: 0 }, { x: 0.5, y: 0.5, t: 50 }], clicks: [1] },
    });
    assert.equal(r.ok, true);
    const clickEnv = sent.find((e) => e.type === 'captcha.assist.click')!;
    const payload = clickEnv.payload as { trajectory?: { samples: unknown[] }; points: unknown[] };
    assert.ok(payload.trajectory, '有效轨迹应透传');
    assert.equal(payload.trajectory!.samples.length, 2);
  });

  it('畸形轨迹（clicks 长度不符）被丢弃、保留 points 继续', async () => {
    const sent: Envelope[] = [];
    const service = mkService(sent);
    await service.onDetected({ edgeId: 'e', kind: 'captcha' }, { sessionId: 's', edgeId: 'e' }, 'restricted');
    service.onSnapshot(snap('cap-traj', 'snap-1', 100));
    sent.length = 0;

    const r = await service.submitClick({
      incidentId: 'cap-traj',
      snapshotId: 'snap-1',
      points: [{ x: 0.5, y: 0.5 }],
      actor: 't',
      trajectory: { v: 1, samples: [{ x: 0.1, y: 0.1, t: 0 }], clicks: [0, 0] }, // 长度 2 ≠ 点数 1
    });
    assert.equal(r.ok, true);
    const clickEnv = sent.find((e) => e.type === 'captcha.assist.click')!;
    const payload = clickEnv.payload as { trajectory?: unknown; points: unknown[] };
    assert.equal(payload.trajectory, undefined, '畸形轨迹应被丢弃');
    assert.equal(payload.points.length, 1, 'points 仍保留继续');
  });
});

describe('CaptchaAssistService · text answer（change captcha-assist-text-answer）', () => {
  // caps 省略 = edgeCapabilities 未接（undefined 路径）；传数组 = live 返回该能力集。
  const mkTextService = (sent: Envelope[], caps?: string[]) =>
    new CaptchaAssistService({
      enabled: true,
      publicBaseUrl: 'https://c.example',
      tokenSecret: 's',
      clock: () => 100,
      idGen: () => 'cap-text',
      logger: silentLogger,
      pusher: {
        pushToEdges: (env) => { sent.push(env); return 1; },
        ...(caps !== undefined ? { edgeCapabilities: () => caps } : {}),
      },
    });

  const seed = async (service: CaptchaAssistService): Promise<void> => {
    await service.onDetected({ edgeId: 'e', kind: 'captcha' }, { sessionId: 's', edgeId: 'e' }, 'restricted');
    service.onSnapshot(snap('cap-text', 'snap-1', 100));
  };

  const base = { incidentId: 'cap-text', snapshotId: 'snap-1', points: [{ x: 0.5, y: 0.5 }], actor: 'op', submit: 'enter' as const };

  it('畸形答案（空/超长/表外字符）→ invalid_text，整单拒绝、绝不下发', async () => {
    for (const text of ['', 'x'.repeat(25), '验证']) {
      const sent: Envelope[] = [];
      const service = mkTextService(sent, ['captcha_assist_text_v1']);
      await seed(service);
      sent.length = 0;
      const r = await service.submitClick({ ...base, text });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, 'invalid_text');
      assert.equal(sent.length, 0, '畸形答案绝不下发（绝不"只帮你点一下"）');
    }
  });

  it('带 text 但落点不是恰好 1 个 → text_requires_single_focus_point，不下发', async () => {
    const sent: Envelope[] = [];
    const service = mkTextService(sent, ['captcha_assist_text_v1']);
    await seed(service);
    sent.length = 0;
    const r = await service.submitClick({ ...base, points: [{ x: 0.3, y: 0.3 }, { x: 0.6, y: 0.6 }], text: 'ab' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'text_requires_single_focus_point');
    assert.equal(sent.length, 0);
  });

  it('能力闸 fail-closed：未声明→edge_lacks_text_capability，连接未知→edge_capability_unknown，皆不下发', async () => {
    // 在线但没声明该能力。
    const s1: Envelope[] = [];
    const svc1 = mkTextService(s1, ['identity', 'overlay']);
    await seed(svc1); s1.length = 0;
    const r1 = await svc1.submitClick({ ...base, text: 'ab3' });
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.reason, 'edge_lacks_text_capability');
    assert.equal(s1.length, 0, '未声明能力时命令绝不下发');

    // 无在线连接（edgeCapabilities 未接 = undefined）。
    const s2: Envelope[] = [];
    const svc2 = mkTextService(s2); // 不传 caps ⇒ edgeCapabilities 缺 ⇒ undefined
    await seed(svc2); s2.length = 0;
    const r2 = await svc2.submitClick({ ...base, text: 'ab3' });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.reason, 'edge_capability_unknown');
    assert.equal(s2.length, 0);
  });

  it('声明了能力 → 下发且 payload 带 text/submit；纯点击零回归（不查能力）', async () => {
    const sent: Envelope[] = [];
    const service = mkTextService(sent, ['captcha_assist_text_v1']);
    await seed(service);
    sent.length = 0;

    const r = await service.submitClick({ ...base, text: 'AB3x' });
    assert.equal(r.ok, true);
    const clickEnv = sent.find((e) => e.type === 'captcha.assist.click')!;
    const payload = clickEnv.payload as { text?: string; submit?: string };
    assert.equal(payload.text, 'AB3x');
    assert.equal(payload.submit, 'enter');

    // 纯点击（无 text）绝不经能力闸——即便能力缺失也照常下发（零回归）。
    const sent2: Envelope[] = [];
    const svcNoCap = mkTextService(sent2); // 无 edgeCapabilities
    await seed(svcNoCap); sent2.length = 0;
    const r2 = await svcNoCap.submitClick({ incidentId: 'cap-text', snapshotId: 'snap-1', points: [{ x: 0.5, y: 0.5 }], actor: 'op' });
    assert.equal(r2.ok, true, '纯点击不查能力，零回归');
  });

  it('明文答案边界（D10）：incident / lastDispatch 只留 textLen，绝不含答案本身', async () => {
    const sent: Envelope[] = [];
    const service = mkTextService(sent, ['captcha_assist_text_v1']);
    await seed(service);
    await service.submitClick({ ...base, text: 'S3cr3tAns' });
    const incident = service.getIncident('cap-text')!;
    assert.equal(incident.lastDispatch?.textLen, 9, 'lastDispatch 只记字符数');
    assert.doesNotMatch(JSON.stringify(incident), /S3cr3tAns/, '答案明文绝不落进 incident 任何字段');
  });

  it('版本偏斜：下发了 text 但回执 inputMode≠click_type ⇒ 标 textNotExecuted', async () => {
    const sent: Envelope[] = [];
    const service = mkTextService(sent, ['captcha_assist_text_v1']);
    await seed(service);
    await service.submitClick({ ...base, text: 'ab3' });
    // 老边缘忽略了 text、只点了 points，回执 inputMode 缺失（视作 'click'）。
    service.onClickResult({ incidentId: 'cap-text', snapshotId: 'snap-1', status: 'cleared', checkedAt: 200 });
    assert.equal(service.getIncident('cap-text')?.lastResult?.textNotExecuted, true);
  });

  it('回执 no_target / typeReport 透传：状态归 failed，typeReport 原样带回', async () => {
    const sent: Envelope[] = [];
    const service = mkTextService(sent, ['captcha_assist_text_v1']);
    await seed(service);
    await service.submitClick({ ...base, text: 'ab3' });
    service.onClickResult({
      incidentId: 'cap-text',
      snapshotId: 'snap-1',
      status: 'no_target',
      reason: 'focus_not_landed',
      checkedAt: 200,
      inputMode: 'click_type',
      typeReport: { focus: 'none', typed: 0, submitted: false },
    });
    const inc = service.getIncident('cap-text')!;
    assert.equal(inc.status, 'failed');
    assert.equal(inc.lastResult?.status, 'no_target');
    assert.equal(inc.lastResult?.inputMode, 'click_type');
    assert.deepEqual(inc.lastResult?.typeReport, { focus: 'none', typed: 0, submitted: false });
    assert.equal(inc.lastResult?.textNotExecuted, undefined, 'inputMode=click_type ⇒ 无偏斜标记');
  });
});
