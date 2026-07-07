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
      remoteAddr: 'rdp://ads-k1e0awu5',
    };
    const detected = await service.onDetected({ edgeId: 'edge-1', kind: 'captcha', url: 'https://x' }, session, 'restricted');

    assert.equal(detected?.incidentId, 'cap-1');
    assert.match(detected?.actionUrl ?? '', /^https:\/\/console\.example\/captcha-assist\/cap-1\?token=/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].edgeId, 'edge-1');
    assert.equal(sent[0].env.type, 'captcha.assist.capture');
    assert.equal(service.getIncident('cap-1')?.status, 'capture_pending');
    assert.equal(service.getIncident('cap-1')?.machineLabel, 'ads-k1e0awu5');
    assert.equal(service.getIncident('cap-1')?.remoteAddr, 'rdp://ads-k1e0awu5');
    assert.equal(service.getIncident('cap-1')?.riskStatus, 'restricted');

    const token = new URL(detected!.actionUrl).searchParams.get('token') ?? '';
    assert.deepEqual(service.verifyToken(token), { ok: true, incidentId: 'cap-1', iat: 10, exp: 1810 });

    now += 31 * 60_000;
    assert.equal(service.verifyToken(token).ok, false, '过期 scoped token 应拒绝');
  });

  it('snapshot makes incident ready, click dispatch validates snapshot and normalized points', async () => {
    const sent: Envelope[] = [];
    const service = new CaptchaAssistService({
      enabled: true,
      publicBaseUrl: 'https://console.example',
      tokenSecret: 'secret',
      clock: () => 20_000,
      idGen: () => 'cap-2',
      logger: silentLogger,
      pusher: { pushToEdges: (env) => { sent.push(env); return 1; } },
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
    assert.equal(service.getIncident('cap-2')?.status, 'click_pending');

    service.onClickResult({
      incidentId: 'cap-2',
      snapshotId: 'snap-1',
      status: 'still_blocked',
      checkedAt: 22_000,
      reason: 'captcha_visible',
    });
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
