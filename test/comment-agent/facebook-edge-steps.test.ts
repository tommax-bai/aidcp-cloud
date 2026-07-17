import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../../src/event-bus/index.js';
import {
  buildFacebookEdgeSteps,
  facebookCommentSubmitTimeoutMs,
  FACEBOOK_STEP_TIMEOUT_MS,
  FACEBOOK_OPEN_STEP_TIMEOUT_MS,
  FACEBOOK_COMMENT_SUBMIT_BASE_MS,
  FACEBOOK_COMMENT_SUBMIT_PER_CHAR_MS,
  FACEBOOK_COMMENT_SUBMIT_MAX_MS,
} from '../../src/comment-agent/facebook-edge-steps.js';

interface Env {
  type: string;
  payload: Record<string, unknown>;
}

/** 假边端：订阅已先建立，pushToEdges 内同步 emit 配置的上报（behavior 闭包持有 bus）。可配 offline / silent。 */
function makePusher(
  behavior: (env: Env) => void,
  opts: { offline?: boolean; silent?: boolean } = {},
): { pusher: { pushToEdges: (e: unknown) => number }; sent: Env[] } {
  const sent: Env[] = [];
  const pusher = {
    pushToEdges: (envelope: unknown): number => {
      const env = envelope as Env;
      sent.push(env);
      if (opts.offline) return 0;
      if (!opts.silent) behavior(env);
      return 1;
    },
  };
  return { pusher, sent };
}

function steps(bus: EventBus, pusher: { pushToEdges: (e: unknown) => number }, stepTimeoutMs = 40) {
  return buildFacebookEdgeSteps({ bus, pusher, edgeId: 'e-fb', stepTimeoutMs, logger: { log: () => {}, warn: () => {} } });
}

describe('buildFacebookEdgeSteps', () => {
  it('search：命中 page.cards → 候选 permalink；search.execute 带 container', async () => {
    const bus = new EventBus();
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'search.execute') {
        bus.emit('page.cards.arrived', { cards: [{ noteId: 'https://fb.com/g/1/posts/2' }, { noteId: 'https://fb.com/g/1/posts/3' }], ts: 0 } as never);
      }
    });
    const r = await steps(bus, pusher).searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
    assert.equal(r.ok, true);
    assert.deepEqual(r.candidates.map((c) => c.permalink), ['https://fb.com/g/1/posts/2', 'https://fb.com/g/1/posts/3']);
    assert.equal(sent[0].payload.container, 'https://www.facebook.com/groups/1');
    assert.equal(sent[0].payload.keyword, '咖啡');
  });

  it('search：诚实失败回执 action.completed{search} → ok:false + reason', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher((env) => {
      if (env.type === 'search.execute') bus.emit('action.completed', { action: 'search', ok: false, reason: 'login_required', ts: 0 } as never);
    });
    const r = await steps(bus, pusher).searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'login_required');
  });

  it('search：无在线边端（命中0）→ ok:false timeout', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher(() => {}, { offline: true });
    const r = await steps(bus, pusher).searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
  });

  it('search：边端静默无回执 → 有界超时 timeout（不无限等）', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher(() => {}, { silent: true });
    const r = await steps(bus, pusher, 30).searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
  });

  it('open：note.detail.arrived 匹配 url → ok；note.open 带 url', async () => {
    const bus = new EventBus();
    const url = 'https://www.facebook.com/groups/1/posts/2';
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'note.open') bus.emit('note.detail.arrived', { detail: { noteId: (env.payload as { url?: string }).url }, ts: 0 } as never);
    });
    const r = await steps(bus, pusher).openPost(url);
    assert.equal(r.ok, true);
    assert.equal(sent[0].payload.url, url);
  });

  it('open：note.detail 的 noteId 不匹配 url → 不误认（超时）', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher((env) => {
      if (env.type === 'note.open') bus.emit('note.detail.arrived', { detail: { noteId: 'OTHER' }, ts: 0 } as never);
    });
    const r = await steps(bus, pusher, 30).openPost('https://www.facebook.com/groups/1/posts/2');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
  });

  it('open：诚实失败回执 action.completed{open_note} → ok:false + reason', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher((env) => {
      if (env.type === 'note.open') bus.emit('action.completed', { action: 'open_note', ok: false, reason: 'editor_not_found', ts: 0 } as never);
    });
    const r = await steps(bus, pusher).openPost('https://www.facebook.com/groups/1/posts/2');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'editor_not_found');
  });

  it('comment：action.completed{comment,ok:true} → ok:true；interaction.comment 带 noteId+text', async () => {
    const bus = new EventBus();
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'interaction.comment') bus.emit('action.completed', { action: 'comment', ok: true, ts: 0 } as never);
    });
    const r = await steps(bus, pusher).submitComment('https://fb.com/g/1/posts/2', '很喜欢');
    assert.equal(r.ok, true);
    assert.equal(sent[0].payload.noteId, 'https://fb.com/g/1/posts/2');
    assert.equal(sent[0].payload.text, '很喜欢');
  });

  it('comment：action.completed{comment,ok:false,reason} → ok:false + reason', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher((env) => {
      if (env.type === 'interaction.comment') bus.emit('action.completed', { action: 'comment', ok: false, reason: 'verification_ambiguous', ts: 0 } as never);
    });
    const r = await steps(bus, pusher).submitComment('https://fb.com/g/1/posts/2', '很喜欢');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'verification_ambiguous');
  });
});

describe('facebookCommentSubmitTimeoutMs（P0-1 长度感知提交超时）', () => {
  const STEP = FACEBOOK_STEP_TIMEOUT_MS;
  it('短评论回落到传入步超时（≥28s 下限，绝不缩短）', () => {
    assert.equal(facebookCommentSubmitTimeoutMs('hi', STEP), STEP);
    assert.equal(facebookCommentSubmitTimeoutMs('', STEP), STEP);
  });
  it('长评论按字符数放大、单调不减（让慢但成功的提交等到真回执→打去重、不重复真发）', () => {
    const t100 = facebookCommentSubmitTimeoutMs('a'.repeat(100), STEP);
    const t200 = facebookCommentSubmitTimeoutMs('a'.repeat(200), STEP);
    assert.ok(t200 > t100);
    assert.equal(t200, FACEBOOK_COMMENT_SUBMIT_BASE_MS + FACEBOOK_COMMENT_SUBMIT_PER_CHAR_MS * 200);
  });
  it('超长评论 clamp 到上限（防边端真挂时无界等待，超上限仍诚实 timeout）', () => {
    assert.equal(facebookCommentSubmitTimeoutMs('a'.repeat(5000), STEP), FACEBOOK_COMMENT_SUBMIT_MAX_MS);
  });
  it('多字节按 code point 计（对齐边端 Array.from 逐字）', () => {
    assert.equal(
      facebookCommentSubmitTimeoutMs('中'.repeat(100), STEP),
      FACEBOOK_COMMENT_SUBMIT_BASE_MS + FACEBOOK_COMMENT_SUBMIT_PER_CHAR_MS * 100,
    );
  });
});

describe('buildFacebookEdgeSteps — keep-open 租约 taskId 透传（change facebook-manual-comment-keepopen-lease）', () => {
  it('三条命令 search.execute / note.open / interaction.comment 都带 lease taskId（否则被自己的租约挡死）', async () => {
    const bus = new EventBus();
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'search.execute') bus.emit('page.cards.arrived', { cards: [{ noteId: 'p1' }], ts: 0 } as never);
      else if (env.type === 'note.open') bus.emit('note.detail.arrived', { detail: { noteId: 'p1', content: '正文' }, ts: 0 } as never);
      else if (env.type === 'interaction.comment') bus.emit('action.completed', { action: 'comment', ok: true, ts: 0 } as never);
    });
    const s = buildFacebookEdgeSteps({ bus, pusher, edgeId: 'e-fb', taskId: 'task-xyz', stepTimeoutMs: 40, logger: { log: () => {}, warn: () => {} } });
    await s.searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
    await s.openPost('p1');
    await s.submitComment('p1', '这篇不错');
    for (const t of ['search.execute', 'note.open', 'interaction.comment']) {
      const env = sent.find((e) => e.type === t);
      assert.ok(env, `应下发 ${t}`);
      assert.equal(env!.payload.taskId, 'task-xyz', `${t} 必须带 lease taskId`);
    }
  });

  it('无 taskId（无租约旧构造）→ 命令不带 taskId 字段（零回归）', async () => {
    const bus = new EventBus();
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'search.execute') bus.emit('page.cards.arrived', { cards: [{ noteId: 'p1' }], ts: 0 } as never);
    });
    await steps(bus, pusher).searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
    const env = sent.find((e) => e.type === 'search.execute');
    assert.ok(env);
    assert.equal('taskId' in env!.payload, false, '无租约构造不应带 taskId');
  });
});

describe('开帖步超时上界（change fb-comment-open-hydration-window）', () => {
  it('开帖步上界必须容纳边端详情水合窗最坏耗时，且严格大于固定步超时（边端先答）', () => {
    // 边端 openPost 最坏 ≈ settle 2.5s + 详情窗 22 轮×600ms(12.6s) + 催拉 6×(滚动+4 探测×600ms)(≈12s) + CDP 往返(≈3s) ≈ 30s。
    // 低于此值 → 云端先掐表，把边端诚实的 open_failed 改判成 timeout（塌进同一 outcome、运营看到的卡片一模一样）。
    const EDGE_WORST_CASE_MS = 30_000;
    assert.ok(
      FACEBOOK_OPEN_STEP_TIMEOUT_MS >= EDGE_WORST_CASE_MS,
      `开帖步上界 ${FACEBOOK_OPEN_STEP_TIMEOUT_MS}ms 必须 >= 边端最坏 ${EDGE_WORST_CASE_MS}ms，否则边端答不完`,
    );
    assert.ok(
      FACEBOOK_OPEN_STEP_TIMEOUT_MS > FACEBOOK_STEP_TIMEOUT_MS,
      '开帖步必须脱离固定 28s（那正是本 change 的成因）',
    );
    // 仍有界：对齐加群步 90s 上限，绝不无界等待。
    assert.ok(FACEBOOK_OPEN_STEP_TIMEOUT_MS <= FACEBOOK_COMMENT_SUBMIT_MAX_MS, '开帖步上界不得超过 90s 无界化');
  });

  it('搜索步不跟着放宽：仍用固定 28s（其探测在催拉循环内、预算未变）', () => {
    assert.equal(FACEBOOK_STEP_TIMEOUT_MS, 28_000);
  });

  it('显式注入 stepTimeoutMs 时开帖步按注入值走（测试可快速验超时，不被 45s 默认拖死）', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher(() => {
      /* 边端不回执 → 走超时路径 */
    });
    const t0 = Date.now();
    const r = await steps(bus, pusher, 40).openPost('https://www.facebook.com/groups/1/posts/2');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
    assert.ok(Date.now() - t0 < 5_000, '注入值必须优先于 45s 默认，否则整个测试套会被拖垮');
  });
});
