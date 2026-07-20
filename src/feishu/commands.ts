/**
 * 飞书命令解析与执行。
 *
 * MVP 支持结构化命令（product-feishu.md §5）：
 *   /status [accountId]        查账号状态
 *   /pause  [accountId]        暂停账号
 *   /resume [accountId]        恢复账号
 *   /publish-test [requestId]  发送测试审批卡片
 *   /bind                      绑定当前群为默认审批群（占位）
 * 未识别 → 返回帮助信息。
 *
 * retire-default-account：accountId 可省略，缺省由执行层解析「唯一真实账号」；0 或多个则要求显式指定（绝不回落 default）。
 *
 * 解析（parseCommand）与执行（CommandRouter）分离，便于单测：解析是纯函数，
 * 执行通过注入的 CommandActions 把动作落到云端调度器（这里先打桩为接口）。
 */

import type { CommandResult, CommandResultLevel, PublishApprovalPayload } from './types.js';
import { buildPublishApprovalCard } from './cards.js';
import { FeishuMessenger } from './messenger.js';
import type { BotChatRecord } from '../cache/bot-chat-store.js';

/** 已识别的指令动作 */
export type CommandAction = 'status' | 'pause' | 'resume' | 'publish-test' | 'publish' | 'comment' | 'bind' | 'help';

/** 单条飞书消息允许携带的最大原子命令数，防止一次消息无界放大后台工作。 */
export const MAX_COMMANDS_PER_MESSAGE = 8;

const COMMAND_AFTER_SEPARATOR =
  /[;；](?=\s*\/(?:aidcp\s+\/?(?:status|pause|resume|publish-test|publish|comment|bind|help)|(?:status|pause|resume|publish-test|publish|comment|bind|task|help))\b)/giu;

/**
 * 只在分号后紧跟已支持 slash 命令时拆分。URL、昵称和普通参数里的分号原样保留。
 * 单命令返回原文本本身，使既有解析/路由路径保持不变。
 */
export function splitCommandBatch(text: string): string[] {
  const source = text ?? '';
  const parts = source.split(COMMAND_AFTER_SEPARATOR);
  if (parts.length === 1) return [source];
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** 解析后的指令结构 */
export interface ParsedCommand {
  action: CommandAction;
  /** retire-default-account：缺省 undefined（执行层解析唯一真实账号），绝不回落 'default'。 */
  accountId?: string;
  /**
   * `/publish` 的目标账号**昵称**（用户输入的人类可读名，可含空格 → 取 `/publish ` 之后整段）。
   * 由执行层按昵称解析为真实 account_id（严格只认昵称，不接 id）。缺省 undefined → 执行层解析唯一真实账号。
   */
  nickname?: string;
  /** 原始指令文本 */
  raw: string;
  /** help 场景携带的提示原因（如未识别的子命令） */
  hint?: string;
  args?: string[];
  /**
   * `/comment` 的联系方式开关（change generalize-contact-info）：尾部 `--contact` present → true、
   * 缺省 undefined（= 关 = 今天的普通评论、零回归）。命中该字段时执行层把账号的「联系方式」注入本次评论。
   */
  injectContact?: boolean;
  /**
   * `/comment` 的加群开关（change facebook-manual-join-comment）：尾部 `--join` present → true、缺省 undefined（零回归）。
   * 命中时执行层先让该账号加入**一个新群**（复用云端加群调度器），确认加入后再在该新群里发一条评论；仅 Facebook 账号有效。
   * 可与 `--contact` 同时给（任意顺序）：加群 + 发一条带联系方式的评论（走既有人审通道）。
   */
  joinGroup?: boolean;
  /**
   * `/comment` 的「加入指定群」链接（change facebook-comment-review-and-targeted-join）：尾部 `--join=<群链接>` present → 该 url、
   * 缺省 undefined（bare `--join` 仍走「下一个库内群」）。命中时执行层加入**这个指定群**（只归该账号）后在群内评论；仅 Facebook。
   * 与 `--contact` 可任意顺序同给。
   */
  joinGroupUrl?: string;
  /**
   * `/comment` 的强制开关（change manual-comment-force-flag）：尾部 `--force` present → true、缺省 undefined（零回归）。
   * 命中时**仅手动命令路径**放开两道软筛选——① 相关性校验（小红书强相关甄选 + Facebook `weak_relevance`）；
   * ② 每笔记/每帖去重（允许对已评过的目标再评一条）。一个开关同时放开这两项。
   * MUST NOT 放开人审 / 内容安全校验（链接/联系方式/@提及/刷屏/长度）/ 边端诚实闸 / 账号隔离。
   * 可与 `--contact` / `--join` 任意顺序组合。自动 / 排期路径绝不带此旗标。
   */
  force?: boolean;
  /**
   * `/comment` 的快速回首页开关（change comment-feed-fast-return）：尾部 `--feed` present → true。
   * 仅手工单次评论生效；提交派发后不等平台确认，500ms 后回平台首页，并诚实落 submitted-unconfirmed。
   */
  fastReturnToFeed?: boolean;
}

const HELP_TEXT = [
  '可用指令：',
  '• `/status [accountId]` — 查账号状态',
  '• `/pause [accountId]` — 暂停账号',
  '• `/resume [accountId]` — 恢复账号',
  '• `/publish <昵称>` — 触发该账号发帖（按昵称指定，发布前仍需人审）',
  '• `/comment <昵称>` — 触发该账号按需评论（搜最近一天最多收藏的强相关笔记，评论前仍需人审）',
  '• `/comment <昵称> --contact` — 同上，并在评论末尾注入该账号后台配置的「联系方式」（未配则拦下告警、不发）',
  '• `/comment <昵称> --join` — 仅 Facebook：加入一个新群，加入成功后在该新群里发一条评论',
  '• `/comment <昵称> --join=<群链接>` — 仅 Facebook：加入指定的这个群（若已是成员则直接在群内评论），再发一条评论',
  '• `/comment <昵称> --join --contact` — 加群 + 在新群里发一条带「联系方式」的评论（走人审；任意顺序）',
  '• `/comment <昵称> --force` — 跳过「强相关 + 已评过去重」两道软筛选（没强相关目标也评、已评过的也能再评）；仍走人审、仍拦链接/联系方式/刷屏；可与 --contact / --join 组合',
  '• `/comment <昵称> --feed` — 评论提交后不等待平台结果，500ms 后直接回首页；结果记为「已提交、未确认」，不会冒充成功或自动重试',
  '• `/publish-test [requestId]` — 发送测试审批卡片',
  '• `/bind` — 绑定当前群为默认审批群（开发中）',
  '',
  '（单账号时 accountId / 昵称可省略，默认作用于唯一账号）',
].join('\n');

/** 账号昵称匹配的候选项（执行层从账号存储拼出）。 */
export interface AccountNickCandidate {
  accountId: string;
  /** 统一解析后的首选可读名，仅用于清单和回执。 */
  displayName?: string | null;
  /** 允许人工输入匹配的全部历史/当前可读名，不含机器 accountId。 */
  names?: string[];
  /** @deprecated 兼容旧调用/测试；新调用使用 displayName + names。 */
  nickname?: string | null;
}

/** 按昵称解析账号的结果。 */
export type NicknameResolution =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'not_found' | 'ambiguous'; available: string[] };

/**
 * 纯函数：按昵称（trim + 大小写不敏感、精确相等）在候选账号里解析唯一 account_id。
 * 严格只认昵称（不接 id 兜底）；空昵称视为 not_found。0 个 → not_found（带可用昵称清单）、多个 → ambiguous。
 */
export function matchAccountByNickname(
  nickname: string,
  candidates: AccountNickCandidate[],
): NicknameResolution {
  const norm = (nickname ?? '').trim().toLowerCase();
  const available = candidates.map((c) => c.displayName?.trim() || c.nickname?.trim() || '（未获取昵称）');
  if (!norm) return { ok: false, reason: 'not_found', available };
  const hits = candidates.filter((c) => {
    const names = c.names?.length ? c.names : [c.nickname ?? c.displayName ?? ''];
    return names.some((name) => name.trim().toLowerCase() === norm);
  });
  if (hits.length === 1) return { ok: true, accountId: hits[0].accountId };
  if (hits.length === 0) return { ok: false, reason: 'not_found', available };
  return {
    ok: false,
    reason: 'ambiguous',
    available: hits.map((c) => c.displayName?.trim() || c.nickname?.trim() || '（未获取昵称）'),
  };
}

/**
 * 解析一条文本指令为结构化命令。
 *
 * 规则：
 * - 直接输入 `/status`、`/pause`、`/resume`、`/publish`、`/comment`、`/publish-test`、`/bind` 之一；
 * - 旧 `/aidcp <cmd>` 前缀仍兼容，但不再作为用户提示示例；
 * - `/status`、`/pause`、`/resume` 的第二个 token 视为 accountId，缺省交由执行层解析唯一真实账号；
 * - `/publish-test` 的第二个 token 视为 requestId（可省略）；
 * - 其余输入归为 help。
 */
export function parseCommand(text: string): ParsedCommand {
  const raw = (text ?? '').trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  const hasAidcpPrefix = (tokens[0] ?? '').toLowerCase() === '/aidcp';
  const commandIndex = hasAidcpPrefix ? 1 : 0;
  const commandToken = (tokens[commandIndex] ?? '').toLowerCase();
  const command = commandToken.startsWith('/') ? commandToken : `/${commandToken}`;
  const args = tokens.slice(commandIndex + 1);

  switch (command) {
    case '/status':
      return { action: 'status', accountId: args[0], raw, args };
    case '/pause':
      return { action: 'pause', accountId: args[0], raw, args };
    case '/resume':
      return { action: 'resume', accountId: args[0], raw, args };
    case '/publish-test':
      return { action: 'publish-test', raw, args };
    case '/publish':
      // /publish <昵称>：`/publish ` 之后整段视为目标账号**昵称**（可含空格），由执行层按昵称解析为真实 id（严格只认昵称、不接 id）；
      // 缺省由执行层解析唯一真实账号（retire-default-account：绝不回落 default）。
      return { action: 'publish', nickname: args.join(' ').trim() || undefined, raw, args };
    case '/comment': {
      // /comment <昵称> [--contact] [--join]：与 /publish 同构——`/comment ` 之后（去掉尾部开关）整段视为**昵称**。
      // 尾开关（change generalize-contact-info + facebook-manual-join-comment）：**从末尾起**连续吃掉已知开关 token
      // （`--contact` 注入联系方式、`--join` 加入一个新群再评论；均大小写不敏感、任意顺序），其余 join 为昵称；
      // trailing-only：昵称中间出现的 flag 样式 token 不被吃掉、留作昵称一部分（避免误切昵称）。
      // 缺开关 → undefined（关、零回归）。无向后兼容：旧 `group:on/off` 不再识别，会被并入昵称、走既有找不到账号的诚实失败。
      let commentArgs = args;
      let injectContact: boolean | undefined;
      let joinGroup: boolean | undefined;
      let joinGroupUrl: string | undefined;
      let force: boolean | undefined;
      let fastReturnToFeed: boolean | undefined;
      while (commentArgs.length > 0) {
        const lastToken = commentArgs[commentArgs.length - 1] ?? '';
        if (/^--contact$/i.test(lastToken)) {
          injectContact = true;
          commentArgs = commentArgs.slice(0, -1);
          continue;
        }
        // `--force`（change manual-comment-force-flag）：放开相关性 + 每笔记去重两道软筛选（仅手动路径），任意顺序可组合。
        if (/^--force$/i.test(lastToken)) {
          force = true;
          commentArgs = commentArgs.slice(0, -1);
          continue;
        }
        if (/^--feed$/i.test(lastToken)) {
          fastReturnToFeed = true;
          commentArgs = commentArgs.slice(0, -1);
          continue;
        }
        // `--join` 或 `--join=<url>`（change facebook-comment-review-and-targeted-join）：FB 群链接无空格 → 一整 token。
        // 带 url → 加入指定群；无 url（bare --join）→ 下一个库内群（既有行为）。
        const joinMatch = /^--join(?:=(\S+))?$/i.exec(lastToken);
        if (joinMatch) {
          joinGroup = true;
          if (joinMatch[1]) joinGroupUrl = joinMatch[1];
          commentArgs = commentArgs.slice(0, -1);
          continue;
        }
        break;
      }
      return { action: 'comment', nickname: commentArgs.join(' ').trim() || undefined, injectContact, joinGroup, joinGroupUrl, force, fastReturnToFeed, raw, args };
    }
    case '/bind':
      return { action: 'bind', raw, args };
    default:
      return { action: 'help', raw, hint: '未识别的子命令' };
  }
}

/**
 * /publish 执行层回执：执行层据真实编排终态自判 ok/level（不再让路由层一律当成功）。
 * - ok=true + level 'success'：已生成稿件并进入人审（pending_approval / published / draft）。
 * - ok=false + level 'warning'：未触发 / 未产出稿件（未解析到账号、已有编排在跑、选题判定不发等）。
 * - ok=false + level 'error'：编排失败（异常 / 中止 / 超时）或触发器不可用。
 * message 已含失败/未产出的原因，路由层原样透传，不再二次包装。
 */
export interface PublishCommandReceipt {
  ok: boolean;
  level: CommandResultLevel;
  title: string;
  message: string;
}

/**
 * /comment 执行层回执：执行层据**触发结果**自判 ok/level（与 publish 同构，不再一律绿色 ✅）。
 * - ok=true + 'success'：任务已成功触发开跑（账号解析到、边端在线）。
 * - ok=false + 'warning'：未触发（未解析到账号 / 已有任务在跑等，没成功但非崩）。
 * - ok=false + 'error'：触发失败（边端离线 / 异常）。
 * 注：评论任务异步（搜索→甄选→人审→发布），**最终**结果（评了/没合适/失败）经后续结果卡片补达；
 * 本回执只表「触发」态——失败/未触发与成功在飞书卡片上分别走红❌/黄⚠️/绿✅，不同样式。
 */
export interface CommentCommandReceipt {
  ok: boolean;
  level: CommandResultLevel;
  title: string;
  message: string;
  /**
   * 机器可读的未触发原因（change browser-slot-scheduling）。仅**瞬时、值得在同一小时格内重试**的原因才置位
   * （`edge_offline` / `browser_wake_failed` / `lease_unavailable`）；持久性拒绝（未绑人设 / 缺联系方式 / 配额到顶）
   * 刻意不置位——重试它们无用，只会每分钟刷一张飞书告警卡。缺省 = 不可重试（沿旧行为，零回归）。
   */
  code?: string;
}

export interface PublishCommandOptions {
  /** Source Feishu conversation that delivered this command; approval cards should prefer this target. */
  sourceChatId?: string;
}

/** 账号状态查询/启停的底层动作（落到云端调度器；MVP 可打桩） */
export interface CommandActions {
  /** 查询账号状态，返回一段可读描述。accountId 缺省由执行层解析唯一真实账号。 */
  status(accountId?: string): Promise<string> | string;
  /** 暂停账号。accountId 缺省由执行层解析唯一真实账号。 */
  pause(accountId?: string): Promise<void> | void;
  /** 恢复账号。accountId 缺省由执行层解析唯一真实账号。 */
  resume(accountId?: string): Promise<void> | void;
  /** 发送审批测试卡片 */
  publishTest?(): Promise<PublishApprovalPayload> | PublishApprovalPayload;
  /**
   * 手动触发一次发帖编排（PublishScheduler 手动扳机）。
   * nickname 按昵称指定发哪个账号（执行层解析为真实 id，严格只认昵称）；缺省由执行层解析唯一真实账号。
   *
   * 返回结构化回执 PublishCommandReceipt：执行层据**编排终态**判 ok/level（成功=绿、未触发/未产出=黄、失败=红），
   * 并把失败原因带进 message——杜绝「触发成功 ≠ 编排成功」被一律染成绿色 ✅ 的误导。
   */
  publish?(nickname?: string, options?: PublishCommandOptions): Promise<PublishCommandReceipt> | PublishCommandReceipt;
  /**
   * 手动触发一次按需评论任务（CommentScheduler 手动扳机）。
   * nickname 按昵称指定评哪个账号（执行层解析为真实 id，严格只认昵称）；缺省由执行层解析唯一真实账号。
   *
   * 返回结构化回执 CommentCommandReceipt：执行层据**触发结果**判 ok/level（开跑=绿、未触发=黄、失败=红），
   * 与 publish 同构——杜绝「触发」被无脑染绿（最终评/未评结果另由结果卡片补达）。
   *
   * options.injectContact（change generalize-contact-info）：true 时把账号「联系方式」注入本次评论；
   * 该账号未配联系方式 → 执行层 fail-closed（回黄色告警、本次不发），绝不静默发无联系方式评论。缺省 = 不注入 = 零回归。
   *
   * options.joinGroup（change facebook-manual-join-comment）：true 时先让该账号加入**一个新群**（复用云端加群调度器），
   * 加入确认成功后再在该新群里发一条评论；仅 Facebook 账号有效、非 FB 诚实拒。可与 injectContact 同开（加群 + 带联系方式评论）。
   *
   * options.joinGroupUrl（change facebook-comment-review-and-targeted-join）：给定时加入**这个指定群**（只归该账号）而非库内下一个；
   * 已是成员则直接评论。缺省 = bare --join 的「下一个库内群」行为。
   *
   * options.force（change manual-comment-force-flag）：true 时放开**相关性 + 每笔记去重**两道软筛选（仅手动路径）——
   * 没强相关目标也评、已评过的也能再评；MUST NOT 放开人审 / 内容安全校验 / 边端诚实闸。缺省 = 不放开 = 零回归。
   */
  comment?(
    nickname?: string,
    options?: { injectContact?: boolean; joinGroup?: boolean; joinGroupUrl?: string; force?: boolean; fastReturnToFeed?: boolean },
  ): Promise<CommentCommandReceipt> | CommentCommandReceipt;
  /** 绑定当前群为默认审批群 */
  bindChat?(record: BotChatRecord): Promise<void> | void;
  /** Unified natural-language / legacy-write ingestion. Returns a confirmation or task-status card, never a direct write. */
  delegate?(
    text: string,
    context?: { chatId?: string; messageId?: string },
  ): Promise<CommandResult> | CommandResult;
}

export interface PublishTestOptions {
  requestId?: string;
}

export function resolvePublishApprovalRequestId(
  options: PublishTestOptions = {},
  generateRequestId: () => string = globalThis.crypto.randomUUID.bind(globalThis.crypto),
): string {
  const explicitRequestId = options.requestId?.trim();
  if (explicitRequestId) return explicitRequestId;
  const envRequestId = process.env.AIDCP_PUBLISH_APPROVAL_REQUEST_ID?.trim();
  if (envRequestId) return envRequestId;
  return generateRequestId();
}

/** 指令路由器：解析 + 执行，产出指令回执数据 */
export class CommandRouter {
  constructor(
    private readonly actions: CommandActions,
    private readonly messenger?: FeishuMessenger,
    private readonly approvalChatId?: string,
    /**
     * 命令作用域闸（change feishu-per-team-notification-routing）：给定来源 chatId 是否为可下达账号命令的「管理群」。
     * 缺省（未注入）→ 放行全部（零回归 / 旧装配 / 测试）。返回 false → 对**非 help** 命令诚实拒（外部客户群纯通知投递）。
     * 据此 `/bind` 等提权命令也被同一闸拦住，无法被任意群自助获得管理权。
     */
    private readonly isChatAuthorized?: (chatId?: string) => boolean,
  ) {}

  /** 并发受理一条消息里的原子命令；每个子命令独立失败、独立使用稳定幂等来源。 */
  async handleBatch(text: string, context?: { chatId?: string; messageId?: string }): Promise<CommandResult[]> {
    const commands = splitCommandBatch(text);
    if (commands.length === 1) return [await this.handle(text, context)];
    if (commands.length > MAX_COMMANDS_PER_MESSAGE) {
      return [{
        command: text,
        ok: false,
        level: 'warning',
        title: '批命令过多',
        message: `一条消息最多可提交 ${MAX_COMMANDS_PER_MESSAGE} 条命令；本批未受理，请拆成多条消息。`,
      }];
    }

    return Promise.all(commands.map(async (command, index) => {
      const childContext = context?.messageId
        ? { ...context, messageId: `${context.messageId}:command:${index + 1}` }
        : context;
      try {
        return await this.handle(command, childContext);
      } catch (err) {
        return {
          command,
          ok: false,
          level: 'error' as const,
          title: '子命令处理失败',
          message: (err as Error).message ?? String(err),
        };
      }
    }));
  }

  /** 处理一条文本指令，返回回执（CommandResult，交给 cards 渲染卡片） */
  async handle(text: string, context?: { chatId?: string; messageId?: string }): Promise<CommandResult> {
    const cmd = parseCommand(text);
    const trimmed = text.trim();
    const naturalBusinessGoal = !trimmed.startsWith('/') &&
      /(?:评论|发布|发稿|稿件|候选稿|暂停任务|恢复任务|取消任务|查看任务|优先执行|安全空档)/.test(trimmed);
    const delegatedText = cmd.action === 'help' && (/^\/task\b/i.test(trimmed) || naturalBusinessGoal);
    // 作用域闸（change feishu-per-team-notification-routing）：非管理群不受理会影响账号的命令
    // （发帖 / 评论 / 启停 / 绑定 / 测试卡）；help 放行（无害）。诚实拒、绝不静默假受理。
    if ((cmd.action !== 'help' || delegatedText) && this.isChatAuthorized && !this.isChatAuthorized(context?.chatId)) {
      return {
        command: cmd.raw || text,
        ok: false,
        level: 'warning',
        title: '本群无权下达账号命令',
        message: '当前群仅用于接收通知。账号命令（发帖 / 评论 / 启停 / 绑定等）请在管理群操作。',
      };
    }
    switch (cmd.action) {
      case 'status':
        return this.runStatus(cmd);
      case 'pause':
        return this.runPause(cmd);
      case 'resume':
        return this.runResume(cmd);
      case 'publish-test':
        return this.runPublishTest(cmd, context?.chatId);
      case 'publish':
        return this.actions.delegate ? this.runDelegated(cmd.raw, context) : this.runPublish(cmd, context?.chatId);
      case 'comment':
        return this.actions.delegate ? this.runDelegated(cmd.raw, context) : this.runComment(cmd);
      case 'bind':
        return this.runBind(cmd, context?.chatId);
      case 'help':
      default:
        if (delegatedText && this.actions.delegate) return this.runDelegated(cmd.raw || text, context);
        return {
          command: cmd.raw || '/help',
          ok: false,
          title: '需要帮助',
          message: `${cmd.hint ? cmd.hint + '\n\n' : ''}${HELP_TEXT}`,
        };
    }
  }

  private async runDelegated(text: string, context?: { chatId?: string; messageId?: string }): Promise<CommandResult> {
    try {
      return await this.actions.delegate!(text, context);
    } catch (err) {
      return {
        command: text,
        ok: false,
        level: 'warning',
        title: '委托任务需要补充信息',
        message: (err as Error).message ?? String(err),
      };
    }
  }

  private async runStatus(cmd: ParsedCommand): Promise<CommandResult> {
    try {
      const desc = await this.actions.status(cmd.accountId);
      return {
        command: cmd.raw,
        ok: true,
        title: '账号状态',
        message: desc,
        accountId: cmd.accountId,
      };
    } catch (err) {
      return this.fail(cmd, '状态查询失败', err);
    }
  }

  private async runPublish(cmd: ParsedCommand, sourceChatId?: string): Promise<CommandResult> {
    if (!this.actions.publish) {
      return this.fail(cmd, '发帖未接线', new Error('publish action not wired'));
    }
    try {
      // nickname → 执行层按昵称解析真实账号（严格只认昵称）；解析失败由执行层抛错、走 fail 分支。
      // 回执的 ok/level/title/message 由执行层据**真实编排终态**给出（成功绿、未触发/未产出黄、失败红），
      // 路由层不再一律当成功——杜绝「触发成功但编排 failed」被染成绿色 ✅。
      const r = await this.actions.publish(cmd.nickname, { sourceChatId });
      return {
        command: cmd.raw,
        ok: r.ok,
        level: r.level,
        title: r.title,
        message: r.message,
        accountId: cmd.accountId,
      };
    } catch (err) {
      return this.fail(cmd, '发帖触发失败', err);
    }
  }

  private async runComment(cmd: ParsedCommand): Promise<CommandResult> {
    if (!this.actions.comment) {
      return this.fail(cmd, '按需评论未接线', new Error('comment action not wired'));
    }
    try {
      // nickname → 执行层按昵称解析真实账号（严格只认昵称）；解析失败 / 边端离线由执行层抛错、走 fail 分支。
      // 回执 ok/level/title/message 由执行层据**真实触发结果**给出（开跑绿、未触发黄、触发失败红），
      // 路由层不再一律当成功——杜绝「触发」被无脑染绿 ✅（评论任务最终结果另由结果卡片补达）。
      const r = await this.actions.comment(cmd.nickname, {
        injectContact: cmd.injectContact,
        joinGroup: cmd.joinGroup,
        joinGroupUrl: cmd.joinGroupUrl,
        force: cmd.force,
        fastReturnToFeed: cmd.fastReturnToFeed,
      });
      return {
        command: cmd.raw,
        ok: r.ok,
        level: r.level,
        title: r.title,
        message: r.message,
        accountId: cmd.accountId,
      };
    } catch (err) {
      return this.fail(cmd, '按需评论触发失败', err);
    }
  }

  private async runPause(cmd: ParsedCommand): Promise<CommandResult> {
    try {
      await this.actions.pause(cmd.accountId);
      return {
        command: cmd.raw,
        ok: true,
        title: '已暂停账号',
        message: `账号 \`${cmd.accountId}\` 已暂停。`,
        accountId: cmd.accountId,
      };
    } catch (err) {
      return this.fail(cmd, '暂停失败', err);
    }
  }

  private async runResume(cmd: ParsedCommand): Promise<CommandResult> {
    try {
      await this.actions.resume(cmd.accountId);
      return {
        command: cmd.raw,
        ok: true,
        title: '已恢复账号',
        message: `账号 \`${cmd.accountId}\` 已恢复运行。`,
        accountId: cmd.accountId,
      };
    } catch (err) {
      return this.fail(cmd, '恢复失败', err);
    }
  }

  private async runPublishTest(cmd: ParsedCommand, chatId?: string): Promise<CommandResult> {
    if (!this.messenger) {
      return {
        command: cmd.raw,
        ok: false,
        title: '测试审批卡片发送失败',
        message: '未配置 FeishuMessenger，无法发送审批卡片。',
      };
    }
    const targetChatId = this.approvalChatId ?? chatId;
    if (!targetChatId) {
      return {
        command: cmd.raw,
        ok: false,
        title: '测试审批卡片发送失败',
        message: '缺少目标 chatId，无法发送审批卡片。',
      };
    }
    const payload = await this.actions.publishTest?.() ?? {
      title: 'AIDCP 测试发布标题',
      content: '这是一条用于联调飞书审批卡片授权链路的测试内容，请点击按钮验证回调与信号文件写入。',
      tags: ['AIDCP', 'PublishTest'],
    };
    const requestId = resolvePublishApprovalRequestId({ requestId: cmd.args?.[0] });
    await this.messenger.sendApprovalCard(
      targetChatId,
      buildPublishApprovalCard({
        requestId,
        ...payload,
      }),
    );
    return {
      command: cmd.raw,
      ok: true,
      title: '测试审批卡片已发送',
      message: `已向会话 \`${targetChatId}\` 发送审批卡片。\n授权 requestId：\`${requestId}\``,
    };
  }

  private async runBind(cmd: ParsedCommand, chatId?: string): Promise<CommandResult> {
    if (!chatId) {
      return {
        command: cmd.raw || '/bind',
        ok: false,
        title: '绑定失败',
        message: '当前消息不在群聊中，或未拿到真实 chat_id，无法绑定默认审批群。',
      };
    }
    if (!this.actions.bindChat) {
      return {
        command: cmd.raw || '/bind',
        ok: false,
        title: '绑定失败',
        message: '未配置绑群存储逻辑，无法设置默认审批群。',
      };
    }
    const chatName = cmd.args?.join(' ').trim() || null;
    try {
      await this.actions.bindChat({
        chatId,
        chatName,
        chatType: 'group',
      });
      return {
        command: cmd.raw || '/bind',
        ok: true,
        title: '默认审批群已更新',
        message: `当前群已设为默认审批群${chatName ? `：${chatName}` : ''}。\nchat_id：\`${chatId}\``,
      };
    } catch (err) {
      return {
        command: cmd.raw || '/bind',
        ok: false,
        title: '绑定失败',
        message: (err as Error).message ?? String(err),
      };
    }
  }

  private fail(cmd: ParsedCommand, title: string, err: unknown): CommandResult {
    return {
      command: cmd.raw,
      ok: false,
      title,
      message: (err as Error).message ?? String(err),
      accountId: cmd.accountId,
    };
  }
}

export { HELP_TEXT };
