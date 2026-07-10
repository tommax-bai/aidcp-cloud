import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CommandRouter,
  parseCommand,
  resolvePublishApprovalRequestId,
  matchAccountByNickname,
  type CommandActions,
} from '../src/feishu/commands.js';

test('parseCommand: /status acc-01', () => {
  const cmd = parseCommand('/status acc-01');
  assert.equal(cmd.action, 'status');
  assert.equal(cmd.accountId, 'acc-01');
});

test('parseCommand: legacy /aidcp prefix remains compatible', () => {
  const cmd = parseCommand('/aidcp status acc-01');
  assert.equal(cmd.action, 'status');
  assert.equal(cmd.accountId, 'acc-01');
});

test('parseCommand: 省略 accountId → undefined（执行层解析唯一真实账号，retire-default-account：绝不回落 default）', () => {
  const cmd = parseCommand('/pause');
  assert.equal(cmd.action, 'pause');
  assert.equal(cmd.accountId, undefined);
});

test('parseCommand: resume 大小写不敏感', () => {
  const cmd = parseCommand('/RESUME acc-09');
  assert.equal(cmd.action, 'resume');
  assert.equal(cmd.accountId, 'acc-09');
});

test('parseCommand: 非命令文本 → help', () => {
  const cmd = parseCommand('你好啊');
  assert.equal(cmd.action, 'help');
});

test('parseCommand: 未识别子命令 → help 带 hint', () => {
  const cmd = parseCommand('/foobar');
  assert.equal(cmd.action, 'help');
  assert.match(cmd.hint ?? '', /未识别的子命令/);
});

test('parseCommand: 多余空白被规整', () => {
  const cmd = parseCommand('  /status   acc-03  ');
  assert.equal(cmd.action, 'status');
  assert.equal(cmd.accountId, 'acc-03');
});

test('parseCommand: publish-test 被识别', () => {
  const cmd = parseCommand('/publish-test');
  assert.equal(cmd.action, 'publish-test');
});

test('parseCommand: publish-test 保留显式 requestId 参数', () => {
  const cmd = parseCommand('/publish-test req-fixed');
  assert.equal(cmd.action, 'publish-test');
  assert.deepEqual(cmd.args, ['req-fixed']);
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
  const res = await router.handle('/status acc-01');
  assert.equal(res.ok, true);
  assert.equal(res.title, '账号状态');
  assert.match(res.message, /normal/);
  assert.deepEqual(log, ['status:acc-01']);
});

test('CommandRouter: pause/resume 执行动作', async () => {
  const { actions, log } = makeActions();
  const router = new CommandRouter(actions);
  const p = await router.handle('/pause acc-01');
  assert.equal(p.ok, true);
  assert.match(p.title, /已暂停/);
  const r = await router.handle('/resume acc-01');
  assert.equal(r.ok, true);
  assert.match(r.title, /已恢复/);
  assert.deepEqual(log, ['pause:acc-01', 'resume:acc-01']);
});

test('CommandRouter: 未识别指令返回帮助（ok=false）', async () => {
  const { actions } = makeActions();
  const router = new CommandRouter(actions);
  const res = await router.handle('/wtf');
  assert.equal(res.ok, false);
  assert.equal(res.title, '需要帮助');
  assert.match(res.message, /\/status/);
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
  const res = await router.handle('/status acc-01');
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
  const res = await router.handle('/publish-test', { chatId: 'oc_chat' });
  assert.equal(res.ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /授权发布/);
});

test('resolvePublishApprovalRequestId: 显式参数优先于环境变量', () => {
  process.env.AIDCP_PUBLISH_APPROVAL_REQUEST_ID = 'env-request-id';
  const requestId = resolvePublishApprovalRequestId(
    { requestId: 'arg-request-id' },
    () => 'generated-request-id',
  );
  assert.equal(requestId, 'arg-request-id');
  delete process.env.AIDCP_PUBLISH_APPROVAL_REQUEST_ID;
});

test('resolvePublishApprovalRequestId: 环境变量优先于自动生成', () => {
  process.env.AIDCP_PUBLISH_APPROVAL_REQUEST_ID = 'env-request-id';
  const requestId = resolvePublishApprovalRequestId({}, () => 'generated-request-id');
  assert.equal(requestId, 'env-request-id');
  delete process.env.AIDCP_PUBLISH_APPROVAL_REQUEST_ID;
});

test('CommandRouter: publish-test 使用显式 requestId', async () => {
  const sent: string[] = [];
  const messenger = {
    sendApprovalCard: async (_chatId: string, card: unknown) => {
      sent.push(JSON.stringify(card));
    },
  } as unknown as import('../src/feishu/messenger.js').FeishuMessenger;
  const router = new CommandRouter(makeActions().actions, messenger);
  const res = await router.handle('/publish-test req-fixed', { chatId: 'oc_chat' });
  assert.equal(res.ok, true);
  assert.match(res.message, /req-fixed/);
  assert.match(sent[0], /req-fixed/);
});

test('parseCommand: /publish 无参 → action publish、nickname undefined（执行层解析唯一账号）', () => {
  const cmd = parseCommand('/publish');
  assert.equal(cmd.action, 'publish');
  assert.equal(cmd.nickname, undefined);
});

test('parseCommand: /publish <昵称> → nickname 取昵称（不再当 accountId）', () => {
  const cmd = parseCommand('/publish 工程师大白');
  assert.equal(cmd.action, 'publish');
  assert.equal(cmd.nickname, '工程师大白');
});

test('parseCommand: /publish 多词昵称（含空格）整段捕获', () => {
  const cmd = parseCommand('/publish 大白 工程师');
  assert.equal(cmd.action, 'publish');
  assert.equal(cmd.nickname, '大白 工程师');
});

test('parseCommand: /comment <昵称> → action comment、nickname 取昵称', () => {
  const cmd = parseCommand('/comment 工程师大白');
  assert.equal(cmd.action, 'comment');
  assert.equal(cmd.nickname, '工程师大白');
});

test('parseCommand: /comment 无参 → action comment、nickname undefined（执行层解析唯一账号）', () => {
  const cmd = parseCommand('/comment');
  assert.equal(cmd.action, 'comment');
  assert.equal(cmd.nickname, undefined);
});

// ── change generalize-contact-info：/comment 尾部联系方式开关 --contact（present=on，缺省=off；旧 group:on/off 已废） ──

test('parseCommand: /comment <昵称> --contact → injectContact true、昵称不含开关', () => {
  const cmd = parseCommand('/comment 工程师大白 --contact');
  assert.equal(cmd.action, 'comment');
  assert.equal(cmd.nickname, '工程师大白');
  assert.equal(cmd.injectContact, true);
});

test('parseCommand: 联系方式开关大小写不敏感（--CONTACT）', () => {
  const cmd = parseCommand('/comment 工程师大白 --CONTACT');
  assert.equal(cmd.nickname, '工程师大白');
  assert.equal(cmd.injectContact, true);
});

test('parseCommand: /comment 无开关 → injectContact undefined、昵称完整（零回归）', () => {
  const cmd = parseCommand('/comment 工程师大白');
  assert.equal(cmd.nickname, '工程师大白');
  assert.equal(cmd.injectContact, undefined);
});

test('parseCommand: 含空格昵称 + 尾部开关正确切分', () => {
  const cmd = parseCommand('/comment 大白 工程师 --contact');
  assert.equal(cmd.nickname, '大白 工程师');
  assert.equal(cmd.injectContact, true);
});

test('parseCommand: 开关只认末尾（trailing-only）——中间的 --contact token 不当开关，并入昵称', () => {
  const cmd = parseCommand('/comment --contact 工程师');
  assert.equal(cmd.injectContact, undefined); // 末尾是「工程师」，非开关
  assert.equal(cmd.nickname, '--contact 工程师'); // 整段作昵称（执行层再诚实解析/报错）
});

test('parseCommand: 仅 --contact 无昵称 → injectContact true、nickname undefined（单账号）', () => {
  const cmd = parseCommand('/comment --contact');
  assert.equal(cmd.injectContact, true);
  assert.equal(cmd.nickname, undefined);
});

test('parseCommand: 旧 group:on 已不识别 → 并入昵称、injectContact undefined（无向后兼容）', () => {
  const cmd = parseCommand('/comment 工程师大白 group:on');
  assert.equal(cmd.injectContact, undefined);
  assert.equal(cmd.nickname, '工程师大白 group:on'); // 旧 token 被并入昵称，走既有找不到账号的诚实失败
});

// ── change facebook-manual-join-comment：/comment 尾部加群开关 --join（可与 --contact 任意顺序组合） ──

test('parseCommand: /comment <昵称> --join → joinGroup true、injectContact undefined、昵称干净', () => {
  const cmd = parseCommand('/comment 工程师大白 --join');
  assert.equal(cmd.action, 'comment');
  assert.equal(cmd.nickname, '工程师大白');
  assert.equal(cmd.joinGroup, true);
  assert.equal(cmd.injectContact, undefined);
});

test('parseCommand: /comment <昵称> --join --contact → 两开关都 true、昵称干净', () => {
  const cmd = parseCommand('/comment 工程师大白 --join --contact');
  assert.equal(cmd.nickname, '工程师大白');
  assert.equal(cmd.joinGroup, true);
  assert.equal(cmd.injectContact, true);
});

test('parseCommand: /comment <昵称> --contact --join → 顺序无关，两开关都 true', () => {
  const cmd = parseCommand('/comment 工程师大白 --contact --join');
  assert.equal(cmd.nickname, '工程师大白');
  assert.equal(cmd.joinGroup, true);
  assert.equal(cmd.injectContact, true);
});

test('parseCommand: 加群开关大小写不敏感（--JOIN）', () => {
  const cmd = parseCommand('/comment 工程师大白 --JOIN');
  assert.equal(cmd.nickname, '工程师大白');
  assert.equal(cmd.joinGroup, true);
});

test('parseCommand: --join 也 trailing-only——中间的 --join token 不当开关，并入昵称', () => {
  const cmd = parseCommand('/comment --join 工程师');
  assert.equal(cmd.joinGroup, undefined); // 末尾是「工程师」，非开关
  assert.equal(cmd.nickname, '--join 工程师');
});

test('parseCommand: 含空格昵称 + 尾部 --join --contact 正确切分', () => {
  const cmd = parseCommand('/comment 大白 工程师 --join --contact');
  assert.equal(cmd.nickname, '大白 工程师');
  assert.equal(cmd.joinGroup, true);
  assert.equal(cmd.injectContact, true);
});

test('CommandRouter: /comment --contact/--join 把开关透传给 comment 动作', async () => {
  let seen: { nickname?: string; options?: { injectContact?: boolean; joinGroup?: boolean } } | null = null;
  const router = new CommandRouter({
    ...makeActions().actions,
    comment: async (nickname?: string, options?: { injectContact?: boolean; joinGroup?: boolean }) => {
      seen = { nickname, options };
      return { ok: true as const, level: 'success' as const, title: '已触发', message: 'ok' };
    },
  });
  await router.handle('/comment 工程师大白 --contact');
  assert.deepEqual(seen, { nickname: '工程师大白', options: { injectContact: true, joinGroup: undefined } });

  await router.handle('/comment 工程师大白');
  assert.deepEqual(seen, { nickname: '工程师大白', options: { injectContact: undefined, joinGroup: undefined } });

  await router.handle('/comment 工程师大白 --join --contact');
  assert.deepEqual(seen, { nickname: '工程师大白', options: { injectContact: true, joinGroup: true } });
});

test('CommandRouter: publish 编排失败 → 回执 ok:false / level:error（红 ❌，绝不再绿色）+ 透传失败原因', async () => {
  const router = new CommandRouter({
    ...makeActions().actions,
    publish: async (nickname?: string) => ({
      ok: false,
      level: 'error',
      title: '发帖编排失败',
      message: `账号 \`${nickname}\` 已触发（manual_feishu）→ 编排状态 failed\n原因：Pipeline timed out after 120000ms`,
    }),
  });
  const res = await router.handle('/publish Tmax');
  assert.equal(res.ok, false, '「触发成功但编排 failed」不再被当成功');
  assert.equal(res.level, 'error', '红色 ❌');
  assert.match(res.title, /失败/);
  assert.match(res.message, /原因：/, '把失败原因带给人，而非只给干瘪 failed');
});

test('CommandRouter: publish 未产出 → 回执 ok:false / level:warning（黄 ⚠️，非失败也别染绿）', async () => {
  const router = new CommandRouter({
    ...makeActions().actions,
    publish: async () => ({ ok: false, level: 'warning', title: '发帖未产出', message: '编排状态 skipped' }),
  });
  const res = await router.handle('/publish Tmax');
  assert.equal(res.ok, false);
  assert.equal(res.level, 'warning');
  assert.match(res.title, /未产出/);
});

test('CommandRouter: publish 成功 → 回执 ok:true / level:success（绿 ✅）', async () => {
  const router = new CommandRouter({
    ...makeActions().actions,
    publish: async () => ({ ok: true, level: 'success', title: '已触发发帖编排', message: '编排状态 pending_approval' }),
  });
  const res = await router.handle('/publish Tmax');
  assert.equal(res.ok, true);
  assert.equal(res.level, 'success');
  assert.match(res.title, /已触发发帖编排/);
});

test('CommandRouter: publish 把来源 chatId 透传给执行层', async () => {
  let seen: { nickname?: string; sourceChatId?: string } | null = null;
  const router = new CommandRouter({
    ...makeActions().actions,
    publish: async (nickname, options) => {
      seen = { nickname, sourceChatId: options?.sourceChatId };
      return { ok: true, level: 'success', title: '已触发发帖编排', message: '编排状态 pending_approval' };
    },
  });
  const res = await router.handle('/publish Tmax', { chatId: 'chat-private' });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, { nickname: 'Tmax', sourceChatId: 'chat-private' });
});

test('CommandRouter: publish 抛错（账号解析失败）→ honest fail 红色回执', async () => {
  const router = new CommandRouter({
    ...makeActions().actions,
    publish: async () => {
      throw new Error('找不到昵称「X」的账号。可用昵称：Tmax');
    },
  });
  const res = await router.handle('/publish X');
  assert.equal(res.ok, false);
  assert.match(res.message, /找不到昵称/);
});

test('CommandRouter: comment 触发成功 → 结构化回执 ok:true / level:success（绿✅）透传', async () => {
  const calls: (string | undefined)[] = [];
  const router = new CommandRouter({
    ...makeActions().actions,
    comment: (nickname) => {
      calls.push(nickname);
      return { ok: true, level: 'success', title: '已触发按需评论', message: '已为账号 工程师大白 启动按需评论任务（评论前仍需人审）' };
    },
  });
  const res = await router.handle('/comment 工程师大白');
  assert.equal(res.ok, true);
  assert.equal(res.level, 'success', '成功=绿色样式');
  assert.match(res.title, /已触发按需评论/);
  assert.deepEqual(calls, ['工程师大白']);
});

test('CommandRouter: comment 未触发 → ok:false / level:warning（黄⚠️，非崩也别染绿）', async () => {
  const router = new CommandRouter({
    ...makeActions().actions,
    comment: () => ({ ok: false, level: 'warning', title: '未触发按需评论', message: '该账号已有评论任务在跑' }),
  });
  const res = await router.handle('/comment Tmax');
  assert.equal(res.ok, false);
  assert.equal(res.level, 'warning', '未触发=黄色样式，区别于失败红');
  assert.match(res.title, /未触发/);
});

test('CommandRouter: comment 触发失败 → ok:false / level:error（红❌）透传', async () => {
  const router = new CommandRouter({
    ...makeActions().actions,
    comment: () => ({ ok: false, level: 'error', title: '按需评论触发失败', message: '边端离线' }),
  });
  const res = await router.handle('/comment Tmax');
  assert.equal(res.ok, false);
  assert.equal(res.level, 'error', '失败=红色样式');
  assert.match(res.message, /边端离线/);
});

test('CommandRouter: comment 未接线 → honest fail（不静默成功）', async () => {
  const router = new CommandRouter(makeActions().actions);
  const res = await router.handle('/comment 工程师大白');
  assert.equal(res.ok, false);
  assert.match(res.title, /按需评论触发失败|未接线/);
});

test('CommandRouter: comment 执行层抛错（如边端离线/昵称无匹配）→ 失败回执', async () => {
  const router = new CommandRouter({
    ...makeActions().actions,
    comment: () => {
      throw new Error('该账号暂无在线边端');
    },
  });
  const res = await router.handle('/comment 工程师大白');
  assert.equal(res.ok, false);
  assert.match(res.message, /在线边端/);
});

test('matchAccountByNickname: 精确命中（trim + 大小写不敏感）', () => {
  const cands = [
    { accountId: 'id-a', nickname: '工程师大白' },
    { accountId: 'id-b', nickname: 'Tmax' },
  ];
  assert.deepEqual(matchAccountByNickname('工程师大白', cands), { ok: true, accountId: 'id-a' });
  assert.deepEqual(matchAccountByNickname('  tmax ', cands), { ok: true, accountId: 'id-b' });
});

test('matchAccountByNickname: 找不到 → not_found（带可用昵称清单）', () => {
  const cands = [{ accountId: 'id-a', nickname: '工程师大白' }];
  const r = matchAccountByNickname('不存在的名', cands);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'not_found');
  assert.deepEqual(r.ok === false && r.available, ['工程师大白']);
});

test('matchAccountByNickname: 严格只认昵称——给 account id 也按昵称查、查不到即 not_found', () => {
  const cands = [{ accountId: 'id-a', nickname: '工程师大白' }];
  const r = matchAccountByNickname('id-a', cands);
  assert.equal(r.ok, false, 'id 不当昵称命中（不接 id 兜底）');
});

test('matchAccountByNickname: 重名 → ambiguous', () => {
  const cands = [
    { accountId: 'id-a', nickname: '小白' },
    { accountId: 'id-b', nickname: '小白' },
  ];
  const r = matchAccountByNickname('小白', cands);
  assert.equal(r.ok === false && r.reason, 'ambiguous');
});

test('matchAccountByNickname: 空昵称 → not_found（不静默命中）', () => {
  const r = matchAccountByNickname('   ', [{ accountId: 'id-a', nickname: '小白' }]);
  assert.equal(r.ok === false && r.reason, 'not_found');
});
