/**
 * 验收用例 AC-E2E-* — 真机/部署联调（运维视角，gated）
 *
 * 默认跳过；设置 AIDCP_E2E=1 后运行，验证目标 cloud 已部署且健康：
 *   AIDCP_E2E=1 AIDCP_CLOUD_URL=ws://121.89.85.150:8787 npm test
 *
 * 环境层级：本地真机联调 / ECS 部署验收。
 *
 * ECS 部署验证清单（人工执行，详见 aidcp/docs/acceptance-tests.md 第 4 节）：
 *   ssh -i ~/codes/isales-4.pem root@121.89.85.150
 *   systemctl status aidcp-cloud.service        # active (running)
 *   ss -ltnp | grep 8787                         # 0.0.0.0:8787 监听
 *   psql -h 127.0.0.1 -U aidcp -d aidcp -c 'select 1;'  # PG 直连
 *   journalctl -u aidcp-cloud -n 50 --no-pager   # 含"飞书长连接已建立"
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { makeEnvelope, parseEnvelope, type Envelope } from '../../src/comm/protocol.js';

const E2E = process.env.AIDCP_E2E === '1';
const CLOUD_URL = process.env.AIDCP_CLOUD_URL ?? 'ws://121.89.85.150:8787';

describe('AC-E2E 部署联调（cloud，gated AIDCP_E2E=1）', { skip: E2E ? false : '设 AIDCP_E2E=1 后运行' }, () => {
  it('AC-E2E-03 已部署 cloud 可握手：发 hello 收 welcome', async () => {
    const ws = new WebSocket(CLOUD_URL);
    const welcome = await new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error(`连接/握手超时：${CLOUD_URL}`)); }, 8000);
      ws.on('open', () => {
        ws.send(JSON.stringify(makeEnvelope('hello', 'e2e-ops', Date.now(), { edgeId: 'edge-ops-check', app: 'xhs' })));
      });
      ws.on('message', (data) => {
        const env = parseEnvelope(String(data));
        if (env?.type === 'welcome') { clearTimeout(timer); resolve(env); }
      });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    assert.equal(welcome.type, 'welcome');
    assert.ok((welcome.payload as { serverVersion?: string }).serverVersion, '应返回 serverVersion');
    ws.close();
  });
});
