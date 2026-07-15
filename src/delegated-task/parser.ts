import type { DelegatedTaskIntent, JsonValue, TaskConstraints } from './types.js';

export type DelegatedControlAction = 'pause' | 'resume' | 'cancel' | 'status';

export type ParsedDelegatedRequest =
  | { ok: true; kind: 'intent'; nickname: string; intent: DelegatedTaskIntent }
  | { ok: true; kind: 'control'; action: DelegatedControlAction; taskId: string }
  | { ok: false; code: string; message: string };

export interface ParseDelegatedTextOptions {
  now?: number;
  source?: DelegatedTaskIntent['source'];
  sourceRef?: string;
  /** 命令来源会话（飞书 chatId），随所有 intent 透传；缺省 → 回落既有路由。 */
  originChatId?: string;
}

const HOUR_MS = 60 * 60 * 1000;

function shanghaiEndOfDay(now: number): number {
  const local = new Date(now + 8 * HOUR_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 15, 59, 59, 999);
}

function parseExplicitShanghaiTime(text: string): number | null {
  const m = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s*(\d{1,2})(?::|点)(\d{1,2})?分?/.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map((v) => Number(v ?? 0));
  const parsed = Date.parse(
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`,
  );
  return Number.isFinite(parsed) ? parsed : null;
}

function scheduleFor(text: string, now: number): {
  deadlineAt: number;
  notBefore: number;
  executionWindow: DelegatedTaskIntent['executionWindow'];
} | { error: string } {
  const explicit = parseExplicitShanghaiTime(text);
  let deadlineAt = /今晚前|今天内|今日内/.test(text) ? shanghaiEndOfDay(now) : now + 24 * HOUR_MS;
  if (/截止|前完成|之前完成/.test(text) && explicit !== null) deadlineAt = explicit;
  if (deadlineAt <= now) return { error: '指定的截止时间已经过去' };
  if (/下一(?:个)?安全空档/.test(text)) {
    return { deadlineAt, notBefore: now, executionWindow: { mode: 'next_safe_slot' } };
  }
  if (/(?:指定时间|定时|于).*(?:执行|开始|发布|评论)/.test(text)) {
    if (explicit === null) return { error: '无法解析指定执行时间，请使用 YYYY-MM-DD HH:mm' };
    if (explicit <= now) return { error: '指定的执行时间已经过去' };
    return { deadlineAt: Math.max(deadlineAt, explicit + HOUR_MS), notBefore: explicit, executionWindow: { mode: 'at_time', startAt: explicit } };
  }
  return { deadlineAt, notBefore: now, executionWindow: { mode: 'immediate' } };
}

function countFor(text: string, fallback = 1): number {
  const m = /(\d+)\s*(?:条|个|篇)/.exec(text);
  return m ? Number(m[1]) : fallback;
}

function maxAttemptsFor(text: string, target: number): number {
  const m = /最多(?:尝试)?\s*(\d+)\s*次/.exec(text);
  return m ? Number(m[1]) : Math.max(target, target * 2);
}

function baseIntent(
  text: string,
  action: DelegatedTaskIntent['action'],
  target: number,
  opts: ParseDelegatedTextOptions,
  constraints: { source?: TaskConstraints; target?: TaskConstraints } = {},
): DelegatedTaskIntent | { error: string } {
  const now = opts.now ?? Date.now();
  const schedule = scheduleFor(text, now);
  if ('error' in schedule) return schedule;
  const maxAttempts = maxAttemptsFor(text, target);
  if (!Number.isInteger(target) || target < 1 || target > 50) return { error: '目标数量必须是 1 到 50 的整数' };
  if (!Number.isInteger(maxAttempts) || maxAttempts < target || maxAttempts > 200) {
    return { error: '最大尝试次数必须不少于目标数且不超过 200' };
  }
  return {
    action,
    targetSuccessCount: target,
    maxAttempts,
    deadlineAt: schedule.deadlineAt,
    notBefore: schedule.notBefore,
    executionWindow: schedule.executionWindow,
    sourceConstraints: constraints.source ?? {},
    targetConstraints: constraints.target ?? {},
    approvalMode: action === 'generate_candidates' ? 'draft_only' : 'review',
    priority: /优先(?:执行|处理)?/.test(text) ? 'high' : 'normal',
    source: opts.source ?? 'feishu',
    ...(opts.sourceRef ? { sourceRef: opts.sourceRef } : {}),
    ...(opts.originChatId ? { originChatId: opts.originChatId } : {}),
  };
}

function withIntent(
  nickname: string | null,
  intent: DelegatedTaskIntent | { error: string },
): ParsedDelegatedRequest {
  if (!nickname) return { ok: false, code: 'account_name_required', message: '请写出可读账号昵称，Feishu 不接受裸 accountId。' };
  if ('error' in intent) return { ok: false, code: 'invalid_task', message: intent.error };
  return { ok: true, kind: 'intent', nickname, intent: { ...intent, accountName: nickname } };
}

export function parseDelegatedText(text: string, opts: ParseDelegatedTextOptions = {}): ParsedDelegatedRequest {
  const raw = (text ?? '').trim();
  if (!raw) return { ok: false, code: 'empty_request', message: '请描述要委托的业务目标。' };

  const control = /^(?:\/task\s+)?(暂停|恢复|取消|查看|状态)\s*(?:任务)?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw);
  if (control) {
    const actionMap: Record<string, DelegatedControlAction> = { 暂停: 'pause', 恢复: 'resume', 取消: 'cancel', 查看: 'status', 状态: 'status' };
    return { ok: true, kind: 'control', action: actionMap[control[1]], taskId: control[2].toLowerCase() };
  }

  const slashPublish = /^\/?(?:aidcp\s+)?\/?publish\s+(.+)$/i.exec(raw);
  if (slashPublish) {
    const nickname = slashPublish[1].trim();
    return withIntent(nickname, baseIntent(raw, 'publish_post', 1, { ...opts, source: 'legacy_command' }, {
      target: { manualSingle: true },
    }));
  }
  const slashComment = /^\/?(?:aidcp\s+)?\/?comment\s+(.+)$/i.exec(raw);
  if (slashComment) {
    const tokens = slashComment[1].trim().split(/\s+/);
    const flags = tokens.filter((v) => /^--/.test(v));
    const nickname = tokens.filter((v) => !/^--/.test(v)).join(' ').trim();
    const join = flags.find((v) => /^--join(?:=|$)/i.test(v));
    const targetConstraints: TaskConstraints = { manualSingle: true };
    if (join) {
      targetConstraints.joinGroup = true;
      const url = join.includes('=') ? join.slice(join.indexOf('=') + 1) : '';
      if (url) targetConstraints.groupUrl = url;
    }
    if (flags.some((v) => /^--contact$/i.test(v))) targetConstraints.injectContact = true;
    if (flags.some((v) => /^--force$/i.test(v))) targetConstraints.force = true;
    return withIntent(nickname, baseIntent(raw, join ? 'facebook_group_comment' : 'comment_batch', 1, { ...opts, source: 'legacy_command' }, { target: targetConstraints }));
  }

  const candidateControl = /^(?:让|请)?(?<nickname>.+?)\s*(批准|驳回|修改)\s*候选稿\s*#?(\d+)(?:\s+(.+))?$/.exec(raw);
  if (candidateControl?.groups?.nickname) {
    const action = candidateControl[2] === '批准' ? 'approve_candidate' : candidateControl[2] === '驳回' ? 'reject_candidate' : 'modify_candidate';
    const patch = candidateControl[4]?.trim();
    if (action === 'modify_candidate' && !patch) {
      return { ok: false, code: 'candidate_patch_required', message: '修改候选稿时请同时给出要修改的标题或正文。' };
    }
    return withIntent(candidateControl.groups.nickname, baseIntent(raw, action, 1, opts, {
      target: { candidateId: candidateControl[3], ...(patch ? { patch } : {}) },
    }));
  }

  const curated = /^(?:让|请)?(?<nickname>.+?)\s*(?:对|评论)\s*(?:指定)?精选(?:内容)?\s*#?(\d+)\s*(?:发起)?评论/.exec(raw);
  if (curated?.groups?.nickname) {
    return withIntent(curated.groups.nickname, baseIntent(raw, 'comment_curated', 1, opts, {
      target: { curatedId: curated[2] },
    }));
  }
  if (/精选(?:内容)?.*评论/.test(raw) && !/#?\d+/.test(raw)) {
    return { ok: false, code: 'curated_target_required', message: '请提供明确的精选内容 id，系统不会改选相似内容。' };
  }

  const candidates = /^(?:让|请)?(?<nickname>.+?)\s*生成\s*(\d+)\s*(?:个|篇)候选稿(?:但)?(?:暂不|不要|不)发布/.exec(raw);
  if (candidates?.groups?.nickname) {
    const count = Number(candidates[2]);
    return withIntent(candidates.groups.nickname, baseIntent(raw, 'generate_candidates', count, opts));
  }

  const groupComment = /^(?:让|请)?(?<nickname>.+?)\s*(?:在|加入)?(?:指定)?(?:Facebook|FB)?\s*群(?:组)?(?:里)?(?:完成|发布|发)\s*(\d+)?\s*条?评论/.exec(raw);
  if (groupComment?.groups?.nickname) {
    const count = groupComment[2] ? Number(groupComment[2]) : 1;
    const url = /https?:\/\/\S+/.exec(raw)?.[0];
    return withIntent(groupComment.groups.nickname, baseIntent(raw, 'facebook_group_comment', count, opts, {
      target: { joinGroup: true, ...(url ? { groupUrl: url } : {}) },
    }));
  }

  const comment = /^(?:让|请)?(?<nickname>.+?)(?:在?今晚前|今天内|今日内)?\s*完成\s*(\d+)\s*条(?:有效)?评论/.exec(raw);
  if (comment?.groups?.nickname) {
    const targetConstraints: TaskConstraints = {};
    const url = /https?:\/\/\S+/.exec(raw)?.[0];
    if (url) targetConstraints.url = url;
    return withIntent(comment.groups.nickname, baseIntent(raw, 'comment_batch', Number(comment[2]), opts, { target: targetConstraints }));
  }

  const publish = /^(?:让|请)?(?<nickname>.+?)\s*(?:参考今日灵感)?\s*发布一篇稿件/.exec(raw);
  if (publish?.groups?.nickname) {
    const inspired = /参考今日灵感/.test(raw);
    return withIntent(publish.groups.nickname, baseIntent(raw, inspired ? 'publish_from_inspiration' : 'publish_post', 1, opts, {
      source: inspired ? { inspirationWindow: 'today' } : {},
    }));
  }

  const vagueCount = countFor(raw, 1);
  if (/评论/.test(raw) && vagueCount > 0) {
    return { ok: false, code: 'unparsed_comment_request', message: '请使用“让 <账号昵称> 完成 N 条有效评论”，并可补充截止时间和最多尝试次数。' };
  }
  return { ok: false, code: 'unsupported_request', message: '暂未识别该委托。Phase 1 支持评论、发稿、今日灵感、精选定向评论、候选稿和任务控制。' };
}

export function formatConstraint(value: JsonValue): string {
  if (value === null) return '无';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
