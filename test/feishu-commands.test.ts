import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CommandRouter,
  DEFAULT_ACCOUNT_ID,
  parseCommand,
  type CommandActions,
} from '../src/feishu/commands.js';

test('parseCommand: /aidcp status acc-01', () => {
  const cmd = parseCommand('/aidcp status acc-01');
  assert.equal(cmd.action, 'status');
  assert.equal(cmd.accountId, 'acc-01');
});

test('parseCommand: 省略 accountId 落到默认账号', () => {
  const cmd = parseCommand('/aidcp pause');
  assert.equal(cmd.action, 'pause');
  assert.equal(cmd.accountId, DEFAULT_ACCOUNT_ID);
});

test('parseCommand: resume 大小写不敏感', () => {
  const cmd = parseCommand('/aidcp RESUME acc-09');
  assert.equal(cmd.action, 'resume');
  assert.equal(cmd.accountId, 'acc-09');
});

test('parseCommand: 非 /aidcp 前缀 → help', () => {
  const cmd = parseCommand('你好啊');
  assert.equal(cmd.action, 'help');
});

test('parseCommand: 未识别子命令 → help 带 hint', () => {
  const cmd = parseCommand('/aidcp foobar');
  assert.equal(cmd.action, 'help');
  assert.match(cmd.hint ?? '', /未识别的子命令/);
});

test('parseCommand: 多余空白被规整', () => {
  const cmd = parseCommand('  /aidcp   status   acc-03  ');
  assert.equal(cmd.action, 'status');
  assert.equal(cmd.accountId, 'acc-03');
});

test('parseCommand: publish-test 被识别', () => {
  const cmd = parseCommand('/aidcp publish-test');
  assert.equal(cmd.action, 'publish-test');
});

function makeActions(): { actions: CommandActions; log: string[] } {
  const log: string[] = [];
  const actions: CommandActions = {
    status: (id) => {
      log.push(`status:${id}`);
      return `状态 ${id} = normal`;
    },
    pause: (id) => {
      log.push(`pause:${id}`);
    },
    resume: (id) => {
      log.push(`resume:${id}`);
    },
  };
  return { actions, log };
}

test('CommandRouter: status 调用 actions.status 并回成功回执', async () => {
  const { actions, log } = makeActions();
  const router = new CommandRouter(actions);
  const res = await router.handle('/aidcp status acc-01');
  assert.equal(res.ok, true);
  assert.equal(res.title, '账号状态');
  assert.match(res.message, /normal/);
  assert.deepEqual(log, ['status:acc-01']);
});

test('CommandRouter: pause/resume 执行动作', async () => {
  const { actions, log } = makeActions();
  const router = new CommandRouter(actions);
  const p = await router.handle('/aidcp pause acc-01');
  assert.equal(p.ok, true);
  assert.match(p.title, /已暂停/);
  const r = await router.handle('/aidcp resume acc-01');
  assert.equal(r.ok, true);
  assert.match(r.title, /已恢复/);
  assert.deepEqual(log, ['pause:acc-01', 'resume:acc-01']);
});

test('CommandRouter: 未识别指令返回帮助（ok=false）', async () => {
  const { actions } = makeActions();
  const router = new CommandRouter(actions);
  const res = await router.handle('/aidcp wtf');
  assert.equal(res.ok, false);
  assert.equal(res.title, '需要帮助');
  assert.match(res.message, /\/aidcp status/);
});

test('CommandRouter: 动作抛错时回失败回执', async () => {
  const actions: CommandActions = {
    status: () => {
      throw new Error('调度器不可用');
    },
    pause: () => {},
    resume: () => {},
  };
  const router = new CommandRouter(actions);
  const res = await router.handle('/aidcp status acc-01');
  assert.equal(res.ok, false);
  assert.match(res.message, /调度器不可用/);
});

test('CommandRouter: publish-test 发送审批卡片', async () => {
  const sent: string[] = [];
  const messenger = {
    sendApprovalCard: async (_chatId: string, card: unknown) => {
      sent.push(JSON.stringify(card));
    },
  } as unknown as import('../src/feishu/messenger.js').FeishuMessenger;
  const router = new CommandRouter(
    {
      ...makeActions().actions,
      publishTest: () => ({
        title: '联调标题',
        content: '联调正文',
        tags: ['联调'],
      }),
    },
    messenger,
  );
  const res = await router.handle('/aidcp publish-test', { chatId: 'oc_chat' });
  assert.equal(res.ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /授权发布/);
});
