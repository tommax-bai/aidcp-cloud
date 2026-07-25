import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { SessionContext } from '../../src/agents/session-context.js';
import {
  NicknameEnricher,
  type NicknameCapturePlan,
} from '../../src/agents/nickname-enricher.js';
import type { Soul } from '../../src/kernel/soul-types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
};

const REAL = 'acc-real-userid';
const SELF_PROFILE_PLAN: NicknameCapturePlan = {
  command: 'identity.read_self_profile',
  restore: 'feed',
};
const CURRENT_PAGE_PLAN: NicknameCapturePlan = {
  command: 'identity.read_current',
  restore: 'none',
};

interface CaptureRequest extends NicknameCapturePlan {
  captureId: string;
}

interface Harness {
  bus: EventBus;
  ctx: SessionContext;
  setCalls: { accountId: string; nickname: string }[];
  requests: CaptureRequest[];
  fireTimeout: () => void;
  timerCleared: () => boolean;
  backToFeed: number;
}

function setup(opts: {
  accountId?: string;
  nicknameByAccount?: Record<string, string | null>;
  plan?: NicknameCapturePlan | null;
  requestSent?: boolean;
} = {}): Harness {
  const bus = new EventBus();
  const ctx = new SessionContext();
  const setCalls: { accountId: string; nickname: string }[] = [];
  const requests: CaptureRequest[] = [];
  let timeoutCb: (() => void) | null = null;
  let cleared = false;
  let backToFeed = 0;

  const role = new NicknameEnricher({
    eventBus: bus,
    soul: mockSoul,
    sessionContext: ctx,
    getAccountId: () => opts.accountId ?? REAL,
    getCapturePlan: () => opts.plan === undefined ? SELF_PROFILE_PLAN : opts.plan,
    requestIdentityCapture: (request) => {
      requests.push(request);
      return opts.requestSent ?? true;
    },
    createCaptureId: () => `capture-${requests.length + 1}`,
    getNickname: (accountId) => opts.nicknameByAccount?.[accountId] ?? null,
    setNickname: (accountId, nickname) => { setCalls.push({ accountId, nickname }); },
    setTimeoutFn: (fn) => { timeoutCb = fn; return { id: 1 }; },
    clearTimeoutFn: () => { cleared = true; },
  });
  role.subscribe();
  bus.on('feed.entered', (p) => { if (p.trigger === 'back_to_feed') backToFeed++; });

  return {
    bus,
    ctx,
    setCalls,
    requests,
    fireTimeout: () => { if (timeoutCb) timeoutCb(); },
    timerCleared: () => cleared,
    get backToFeed() { return backToFeed; },
  };
}

function edgeReady(bus: EventBus, startupId = 'startup-1'): void {
  bus.emit('page.cards.arrived', { cards: [], startupId, ts: Date.now() });
}

function observed(
  bus: EventBus,
  request: CaptureRequest,
  nickname?: string,
  accountId = REAL,
): void {
  const current = request.command === 'identity.read_current';
  bus.emit('identity.observed.arrived', {
    observation: {
      captureId: request.captureId,
      accountId,
      ...(nickname === undefined ? {} : { nickname }),
      source: current ? 'current_page' : 'self_profile',
      pageEffect: current ? 'none' : 'navigated_self_profile',
    },
    accountId: REAL,
    ts: Date.now(),
  });
}

describe('NicknameEnricher（平台身份采集编排）', () => {
  it('XHS 首批启动 cards 下发本人主页命令，并在采集期间暂停浏览', () => {
    const h = setup();
    edgeReady(h.bus);
    assert.equal(h.ctx.browseSuspended, true);
    assert.equal(h.ctx.selfCaptureInFlight, true);
    assert.deepEqual(h.requests, [{
      command: 'identity.read_self_profile',
      restore: 'feed',
      captureId: 'capture-1',
    }]);
  });

  it('Facebook 当前页读取不暂停浏览，完成后不发返回 feed', () => {
    const h = setup({ plan: CURRENT_PAGE_PLAN });
    edgeReady(h.bus);
    assert.equal(h.ctx.browseSuspended, false, '无导航命令不得冻结浏览链');
    observed(h.bus, h.requests[0], '真实FB昵称');
    assert.deepEqual(h.setCalls, [{ accountId: REAL, nickname: '真实FB昵称' }]);
    assert.equal(h.backToFeed, 0, '当前页读取后不得 back/refresh/scroll 恢复');
  });

  it('旧 Edge 无能力计划或无 startupId 时零扰动', () => {
    const unsupported = setup({ plan: null });
    edgeReady(unsupported.bus);
    assert.equal(unsupported.requests.length, 0);
    assert.equal(unsupported.ctx.selfCaptureInFlight, false);

    const old = setup();
    old.bus.emit('page.cards.arrived', { cards: [], ts: Date.now() });
    assert.equal(old.requests.length, 0);
  });

  it('同一 startupId 只采一次，新 startupId 可再次刷新', () => {
    const h = setup();
    edgeReady(h.bus, 'startup-a');
    observed(h.bus, h.requests[0], '工程师大白');
    edgeReady(h.bus, 'startup-a');
    assert.equal(h.requests.length, 1);
    edgeReady(h.bus, 'startup-b');
    assert.equal(h.requests.length, 2);
  });

  it('缺账号不采；命令未下发会解除暂停且不假装导航恢复', () => {
    const missing = setup({ accountId: '' });
    edgeReady(missing.bus);
    assert.equal(missing.requests.length, 0);

    const refused = setup({ requestSent: false });
    edgeReady(refused.bus);
    assert.equal(refused.ctx.selfCaptureInFlight, false);
    assert.equal(refused.ctx.browseSuspended, false);
    assert.equal(refused.backToFeed, 0);
  });

  it('关联的本人观察写入非空昵称，XHS 恢复 feed', () => {
    const h = setup();
    edgeReady(h.bus);
    observed(h.bus, h.requests[0], '工程师大白');
    assert.deepEqual(h.setCalls, [{ accountId: REAL, nickname: '工程师大白' }]);
    assert.equal(h.ctx.selfCaptureInFlight, false);
    assert.equal(h.ctx.browseSuspended, false);
    assert.equal(h.timerCleared(), true);
    assert.equal(h.backToFeed, 1);
  });

  it('相同昵称不重复写；空昵称不写并递增有界尝试', () => {
    const same = setup({ nicknameByAccount: { [REAL]: '工程师大白' } });
    edgeReady(same.bus);
    observed(same.bus, same.requests[0], '工程师大白');
    assert.equal(same.setCalls.length, 0);

    const empty = setup();
    edgeReady(empty.bus);
    observed(empty.bus, empty.requests[0], '   ');
    assert.equal(empty.setCalls.length, 0);
    assert.equal(empty.ctx.selfCaptureAttempts, 1);
  });

  it('普通 profile.detail、错误 captureId、跨账号观察都不能写入本人昵称', () => {
    const h = setup();
    edgeReady(h.bus);
    h.bus.emit('profile.detail.arrived', {
      detail: { authorId: REAL, postsCount: 0, followersCount: 0, extracted: true, nickname: '作者管线' },
      accountId: REAL,
      ts: Date.now(),
    });
    h.bus.emit('identity.observed.arrived', {
      observation: {
        captureId: 'late-capture',
        accountId: REAL,
        nickname: '迟到观察',
        source: 'self_profile',
        pageEffect: 'navigated_self_profile',
      },
      accountId: REAL,
      ts: Date.now(),
    });
    observed(h.bus, h.requests[0], '别的账号', 'other-account');
    assert.equal(h.setCalls.length, 0);
    assert.equal(h.ctx.selfCaptureInFlight, true);
  });

  it('超时有界收尾：XHS 恢复 feed，Facebook 不发页面恢复命令', () => {
    const xhs = setup();
    edgeReady(xhs.bus);
    xhs.fireTimeout();
    assert.equal(xhs.ctx.selfCaptureInFlight, false);
    assert.equal(xhs.backToFeed, 1);

    const fb = setup({ plan: CURRENT_PAGE_PLAN });
    edgeReady(fb.bus);
    fb.fireTimeout();
    assert.equal(fb.ctx.selfCaptureInFlight, false);
    assert.equal(fb.backToFeed, 0);
  });

  it('空昵称累计到上限后不再采集', () => {
    const h = setup();
    for (let i = 0; i < h.ctx.selfCaptureMaxAttempts; i++) h.ctx.incrementSelfCaptureAttempts();
    edgeReady(h.bus);
    assert.equal(h.requests.length, 0);
  });
});
