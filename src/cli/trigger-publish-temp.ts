import WebSocket from 'ws';
import { makeEnvelope, type PublishRequestPayload } from '../comm/protocol.js';

const cloudUrl = process.env.AIDCP_CLOUD_URL ?? 'ws://127.0.0.1:8787';

const payload: PublishRequestPayload = {
  title: '【测试请忽略】AIDCP 主动审批联调',
  content: '这是一条自动化测试笔记，用于验证 AIDCP 新版主动审批发布链路，请忽略。',
  tags: ['测试'],
};

const ws = new WebSocket(cloudUrl);

ws.on('open', () => {
  const env = makeEnvelope('publish.request', `temp-publish-${Date.now()}`, Date.now(), payload);
  ws.send(JSON.stringify(env));
  console.log(
    JSON.stringify(
      {
        ok: true,
        cloudUrl,
        payload,
        note: 'TODO(temp): 临时联调入口，正式触发链路后续由调度器/风控接管。',
      },
      null,
      2,
    ),
  );
  ws.close();
});

ws.on('error', (error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        cloudUrl,
        error: error.message,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});