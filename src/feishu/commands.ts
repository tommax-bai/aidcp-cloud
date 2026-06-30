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
}

const HELP_TEXT = [
  '可用指令：',
  '• `/aidcp status [accountId]` — 查账号状态',
  '• `/aidcp pause [accountId]` — 暂停账号',
  '• `/aidcp resume [accountId]` — 恢复账号',
  '• `/aidcp publish <昵称>` — 触发该账号发帖（按昵称指定，发布前仍需人审）',
  '• `/aidcp comment <昵称>` — 触发该账号按需评论（搜最近一天最多收藏的强相关笔记，评论前仍需人审）',
  '• `/aidcp publish-test [requestId]` — 发送测试审批卡片',
  '• `/aidcp bind` — 绑定当前群为默认审批群（开发中）',
  '',
  '（单账号时 accountId / 昵称可省略，默认作用于唯一账号）',
].join('\n');

/** 账号昵称匹配的候选项（执行层从账号存储拼出）。 */
export interface AccountNickCandidate {
  accountId: string;
  nickname: string | null;
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
  const available = candidates.map((c) => c.nickname ?? `(无昵称:${c.accountId})`);
  if (!norm) return { ok: false, reason: 'not_found', available };
  const hits = candidates.filter((c) => (c.nickname ?? '').trim().toLowerCase() === norm);
  if (hits.length === 1) return { ok: true, accountId: hits[0].accountId };
  if (hits.length === 0) return { ok: false, reason: 'not_found', available };
  return { ok: false, reason: 'ambiguous', available: hits.map((c) => c.accountId) };
}

/**
 * 解析一条文本指令为结构化命令。
 *
 * 规则：
 * - 必须直接输入 `/status`、`/pause`、`/resume`、`/publish-test`、`/bind` 之一；
 * - `/status`、`/pause`、`/resume` 的第二个 token 视为 accountId，缺省用 DEFAULT_ACCOUNT_ID；
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
    case '/comment':
      // /comment <昵称>：与 /publish 同构——`/comment ` 之后整段视为目标账号**昵称**，执行层按昵称解析真实 id；
      // 缺省由执行层解析唯一真实账号（retire-default-account：绝不回落 default）。
      return { action: 'comment', nickname: args.join(' ').trim() || undefined, raw, args };
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
  publish?(nickname?: string): Promise<PublishCommandReceipt> | PublishCommandReceipt;
  /**
   * 手动触发一次按需评论任务（CommentScheduler 手动扳机；返回可读回执）。
   * nickname 按昵称指定评哪个账号（执行层解析为真实 id，严格只认昵称）；缺省由执行层解析唯一真实账号。
   */
  comment?(nickname?: string): Promise<string> | string;
  /** 绑定当前群为默认审批群 */
  bindChat?(record: BotChatRecord): Promise<void> | void;
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
  ) {}

  /** 处理一条文本指令，返回回执（CommandResult，交给 cards 渲染卡片） */
  async handle(text: string, context?: { chatId?: string }): Promise<CommandResult> {
    const cmd = parseCommand(text);
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
        return this.runPublish(cmd);
      case 'comment':
        return this.runComment(cmd);
      case 'bind':
        return this.runBind(cmd, context?.chatId);
      case 'help':
      default:
        return {
          command: cmd.raw || '/help',
          ok: false,
          title: '需要帮助',
          message: `${cmd.hint ? cmd.hint + '\n\n' : ''}${HELP_TEXT}`,
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

  private async runPublish(cmd: ParsedCommand): Promise<CommandResult> {
    if (!this.actions.publish) {
      return this.fail(cmd, '发帖未接线', new Error('publish action not wired'));
    }
    try {
      // nickname → 执行层按昵称解析真实账号（严格只认昵称）；解析失败由执行层抛错、走 fail 分支。
      // 回执的 ok/level/title/message 由执行层据**真实编排终态**给出（成功绿、未触发/未产出黄、失败红），
      // 路由层不再一律当成功——杜绝「触发成功但编排 failed」被染成绿色 ✅。
      const r = await this.actions.publish(cmd.nickname);
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
      const msg = await this.actions.comment(cmd.nickname);
      return {
        command: cmd.raw,
        ok: true,
        title: '已触发按需评论',
        message: `${msg}\n（账号昵称 \`${cmd.nickname ?? '(唯一账号)'}\`；搜「最近一天·最多收藏」的强相关笔记，评论前仍需飞书人审 approved=true 才会真发）`,
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
