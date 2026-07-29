import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../../src/event-bus/index.js';
import {
  buildFacebookEdgeSteps,
  facebookCommentSubmitTimeoutMs,
  FACEBOOK_STEP_TIMEOUT_MS,
  FACEBOOK_OPEN_STEP_TIMEOUT_MS,
  FACEBOOK_FIRST_POST_OPEN_STEP_TIMEOUT_MS,
  FACEBOOK_COMMENT_SUBMIT_BASE_MS,
  FACEBOOK_COMMENT_SUBMIT_PER_CHAR_MS,
  FACEBOOK_COMMENT_SUBMIT_MAX_MS,
  isFacebookFirstPostTargetRef,
} from '../../src/comment-agent/facebook-edge-steps.js';

interface Env {
  id: string;
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
    assert.equal(sent[0].payload.purpose, 'task_targeting');
    assert.equal(sent[0].payload.scope, 'container');
    assert.equal(sent[0].payload.activityId, sent[0].id);
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

  it('search：明确 no_results 回执 → ok:true + 空候选，不等待超时', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher((env) => {
      if (env.type === 'search.execute') {
        bus.emit('action.completed', {
          action: 'search',
          ok: true,
          activityId: env.payload.activityId,
          searchOutcome: 'no_results',
          ts: 0,
        } as never);
      }
    });
    const r = await steps(bus, pusher, 5000).searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
    assert.equal(r.ok, true);
    assert.deepEqual(r.candidates, []);
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

  it('open：同帖等价 permalink 形态 → ok；note.open 保留原 url', async () => {
    const bus = new EventBus();
    const url = 'https://www.facebook.com/groups/1/posts/2';
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'note.open') {
        bus.emit('note.detail.arrived', {
          detail: { noteId: 'https://www.facebook.com/permalink.php?story_fbid=2&id=99' },
          ts: 0,
        } as never);
      }
    });
    const r = await steps(bus, pusher).openPost(url);
    assert.equal(r.ok, true);
    assert.equal(sent[0].payload.url, url);
  });

  it('openFirstPost：下发群内首帖选择，不发 search.execute，并接受实际群帖 permalink', async () => {
    const bus = new EventBus();
    const container = 'https://www.facebook.com/groups/1';
    const permalink = 'https://www.facebook.com/groups/1/posts/2';
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'note.open') {
        bus.emit('note.detail.arrived', {
          detail: { noteId: permalink, content: '首帖正文', comments: ['首条评论'] },
          ts: 0,
        } as never);
      }
    });
    const r = await steps(bus, pusher).openFirstPost(container);
    assert.deepEqual(r, {
      ok: true,
      permalink,
      postText: '首帖正文',
      comments: ['首条评论'],
    });
    assert.deepEqual(sent.map((env) => env.type), ['note.open']);
    assert.equal(sent[0].payload.selection, 'first_commentable_group_post');
    assert.equal(sent[0].payload.container, container);
    assert.equal(sent[0].payload.url, undefined);
  });

  it('openFirstPost：接受等价 canonical multi_permalinks 群帖身份', async () => {
    const bus = new EventBus();
    const permalink = 'https://www.facebook.com/groups/1?multi_permalinks=2';
    const { pusher } = makePusher((env) => {
      if (env.type === 'note.open') {
        bus.emit('note.detail.arrived', {
          detail: { noteId: permalink, content: '首帖正文' },
          ts: 0,
        } as never);
      }
    });

    const r = await steps(bus, pusher).openFirstPost('https://www.facebook.com/groups/1');
    assert.deepEqual(r, { ok: true, permalink, postText: '首帖正文' });
  });

  it('openFirstPost：接受严格的 Edge 同页 targetRef，并原样用于评论', async () => {
    const bus = new EventBus();
    const targetRef = `aidcp:facebook-group-feed-post:v1:${'a1'.repeat(32)}`;
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'note.open') {
        bus.emit('note.detail.arrived', {
          detail: { noteId: targetRef, content: '无 permalink 的首帖正文' },
          ts: 0,
        } as never);
      }
      if (env.type === 'interaction.comment') {
        bus.emit('action.completed', { action: 'comment', ok: true, ts: 0 } as never);
      }
    });

    const open = await steps(bus, pusher).openFirstPost('https://www.facebook.com/groups/1');
    assert.deepEqual(open, { ok: true, targetRef, postText: '无 permalink 的首帖正文' });
    assert.equal(isFacebookFirstPostTargetRef(targetRef), true);
    const submit = await steps(bus, pusher).submitComment(targetRef, 'good 6666');
    assert.equal(submit.ok, true);
    assert.equal(sent.at(-1)?.payload.noteId, targetRef);
  });

  it('openFirstPost：拒绝畸形 targetRef；ordinary open 也不接受严格 targetRef', async () => {
    const bus = new EventBus();
    const malformed = `aidcp:facebook-group-feed-post:v1:${'A1'.repeat(32)}`;
    const strict = `aidcp:facebook-group-feed-post:v1:${'b2'.repeat(32)}`;
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'note.open') {
        bus.emit('note.detail.arrived', { detail: { noteId: malformed }, ts: 0 } as never);
      }
    });
    const first = await steps(bus, pusher, 30).openFirstPost('https://www.facebook.com/groups/1');
    assert.equal(first.ok, false);
    assert.equal(first.reason, 'timeout');
    assert.equal(isFacebookFirstPostTargetRef(malformed), false);

    sent.length = 0;
    const ordinary = await steps(bus, pusher).openPost(strict);
    assert.deepEqual(ordinary, { ok: false, reason: 'invalid_target' });
    assert.deepEqual(sent, []);
  });

  it('openFirstPost：透传 Native 有界探测的具体失败原因', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher((env) => {
      if (env.type === 'note.open') {
        bus.emit('action.completed', {
          action: 'open_note',
          ok: false,
          reason: 'no_candidates',
          ts: 0,
        } as never);
      }
    });
    const r = await steps(bus, pusher).openFirstPost('https://www.facebook.com/groups/1');
    assert.deepEqual(r, { ok: false, reason: 'no_candidates' });
  });

  it('openFirstPost：边端回非群帖 permalink 不误认，最终诚实超时', async () => {
    const bus = new EventBus();
    const { pusher } = makePusher((env) => {
      if (env.type === 'note.open') {
        bus.emit('note.detail.arrived', {
          detail: { noteId: 'https://www.facebook.com/123/posts/2', content: '背景帖' },
          ts: 0,
        } as never);
      }
    });
    const r = await steps(bus, pusher, 30).openFirstPost('https://www.facebook.com/groups/1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
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

  it('open：缺少规范帖身份的目标立即诚实失败，不下发 note.open', async () => {
    const bus = new EventBus();
    const { pusher, sent } = makePusher(() => {});
    const r = await steps(bus, pusher).openPost('https://www.facebook.com/profile.php?id=123');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_target');
    assert.deepEqual(sent, []);
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

  it('comment：显式 fast return 透传 fastReturnToFeed=true，未确认结果原样返回', async () => {
    const bus = new EventBus();
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'interaction.comment') bus.emit('action.completed', { action: 'comment', ok: false, reason: 'verification_ambiguous', ts: 0 } as never);
    });
    const r = await steps(bus, pusher).submitComment('https://fb.com/g/1/posts/2', '很喜欢', undefined, true);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'verification_ambiguous');
    assert.equal(sent[0].payload.fastReturnToFeed, true);
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
    const target = 'https://www.facebook.com/groups/1/posts/2';
    const { pusher, sent } = makePusher((env) => {
      if (env.type === 'search.execute') bus.emit('page.cards.arrived', { cards: [{ noteId: target }], ts: 0 } as never);
      else if (env.type === 'note.open') bus.emit('note.detail.arrived', { detail: { noteId: target, content: '正文' }, ts: 0 } as never);
      else if (env.type === 'interaction.comment') bus.emit('action.completed', { action: 'comment', ok: true, ts: 0 } as never);
    });
    const s = buildFacebookEdgeSteps({ bus, pusher, edgeId: 'e-fb', taskId: 'task-xyz', stepTimeoutMs: 40, logger: { log: () => {}, warn: () => {} } });
    await s.searchInContainer('咖啡', 'https://www.facebook.com/groups/1');
    await s.openPost(target);
    await s.submitComment(target, '这篇不错');
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
    // Native-only 详情打开受 45s 原子命令上限保护（内部文档就绪 12s + 身份水合 23s）。
    // 低于此值 → 云端先掐表，把边端诚实的 open_failed 改判成 timeout。
    const EDGE_WORST_CASE_MS = 45_000;
    assert.ok(
      FACEBOOK_OPEN_STEP_TIMEOUT_MS >= EDGE_WORST_CASE_MS,
      `开帖步上界 ${FACEBOOK_OPEN_STEP_TIMEOUT_MS}ms 必须 >= 边端最坏 ${EDGE_WORST_CASE_MS}ms，否则边端答不完`,
    );
    assert.ok(
      FACEBOOK_OPEN_STEP_TIMEOUT_MS > FACEBOOK_STEP_TIMEOUT_MS,
      '开帖步必须脱离搜索步的固定预算（那正是 fb-comment-open-hydration-window 的成因）',
    );
    // 仍有界：不得超过评论提交上限，绝不无界等待。
    assert.ok(
      FACEBOOK_OPEN_STEP_TIMEOUT_MS <= FACEBOOK_COMMENT_SUBMIT_MAX_MS,
      '开帖步上界不得越过评论提交上限而无界化',
    );
  });

  it('搜索步与开帖步是两条预算：搜索步不得因开帖放宽而跟着放开', () => {
    // 2026-07-29 整体 ×1.5 后不再钉死具体秒数——钉死数值只会让下次调整变成"改测试"，
    // 这里真正要守的是两者的**关系**：搜索步的探测跑在催拉循环内、轮数未变，必须更短。
    assert.ok(
      FACEBOOK_STEP_TIMEOUT_MS < FACEBOOK_OPEN_STEP_TIMEOUT_MS,
      '搜索步预算必须短于开帖步',
    );
    assert.ok(FACEBOOK_STEP_TIMEOUT_MS >= 28_000, '不得低于历史下限，否则慢网下会误判 timeout');
  });

  it('首帖开帖另有上界：容得下边端 90s 原子上限，且按 URL 开帖预算不动', () => {
    // 首帖那条在边端是一串串行有界窗（就绪 12s + 首探 ~2s + 四轮下滚 ~18s + 可选二次导航就绪 12s +
    // 绑定 18s + 身份回读 30s ≈ 92s），外层原子上限因此为 135s。云端沿用按 URL 那条会在边端答话前
    // 先掐断，把一个具名失败改判成 timeout —— 那正是本 change 要消除的那类信息损失。
    const EDGE_FIRST_POST_CEILING_MS = 135_000;
    assert.ok(
      FACEBOOK_FIRST_POST_OPEN_STEP_TIMEOUT_MS >= EDGE_FIRST_POST_CEILING_MS,
      `首帖开帖步 ${FACEBOOK_FIRST_POST_OPEN_STEP_TIMEOUT_MS}ms 必须 >= 边端原子上限 ${EDGE_FIRST_POST_CEILING_MS}ms`,
    );
    assert.ok(
      FACEBOOK_FIRST_POST_OPEN_STEP_TIMEOUT_MS > FACEBOOK_OPEN_STEP_TIMEOUT_MS,
      '首帖与按 URL 开帖是两条预算，前者必须更宽',
    );
    // 两条路径的内层窗口不同，云端上界必须分开；这里守"分开"而不是守某个具体秒数。
    assert.ok(
      FACEBOOK_FIRST_POST_OPEN_STEP_TIMEOUT_MS > FACEBOOK_OPEN_STEP_TIMEOUT_MS * 1.5,
      '首帖步必须明显宽于按 URL 开帖步，否则等于又合并成一条预算',
    );
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
