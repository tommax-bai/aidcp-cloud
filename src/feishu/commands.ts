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
 * 单账号 MVP：accountId 可省略，缺省落到唯一账号（DEFAULT_ACCOUNT_ID）。
 *
 * 解析（parseCommand）与执行（CommandRouter）分离，便于单测：解析是纯函数，
 * 执行通过注入的 CommandActions 把动作落到云端调度器（这里先打桩为接口）。
 */

import type { CommandResult, PublishApprovalPayload } from './types.js';
import { buildPublishApprovalCard } from './cards.js';
import { FeishuMessenger } from './messenger.js';
import type { BotChatRecord } from '../cache/bot-chat-store.js';

/** 单账号 MVP 的缺省账号 id（统一为 'default'，对齐风控 RiskController 与 accounts 表 seed 行） */
export const DEFAULT_ACCOUNT_ID = 'default';

/** 已识别的指令动作 */
export type CommandAction = 'status' | 'pause' | 'resume' | 'publish-test' | 'publish' | 'bind' | 'help';

/** 解析后的指令结构 */
export interface ParsedCommand {
  action: CommandAction;
  accountId: string;
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
  '• `/aidcp publish-test [requestId]` — 发送测试审批卡片',
  '• `/aidcp bind` — 绑定当前群为默认审批群（开发中）',
  '',
  '（单账号 MVP：accountId 可省略，默认作用于唯一账号）',
].join('\n');

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
      return { action: 'status', accountId: args[0] ?? DEFAULT_ACCOUNT_ID, raw, args };
    case '/pause':
      return { action: 'pause', accountId: args[0] ?? DEFAULT_ACCOUNT_ID, raw, args };
    case '/resume':
      return { action: 'resume', accountId: args[0] ?? DEFAULT_ACCOUNT_ID, raw, args };
    case '/publish-test':
      return { action: 'publish-test', accountId: DEFAULT_ACCOUNT_ID, raw, args };
    case '/publish':
      return { action: 'publish', accountId: DEFAULT_ACCOUNT_ID, raw, args };
    case '/bind':
      return { action: 'bind', accountId: DEFAULT_ACCOUNT_ID, raw, args };
    default:
      return { action: 'help', accountId: DEFAULT_ACCOUNT_ID, raw, hint: '未识别的子命令' };
  }
}

/** 账号状态查询/启停的底层动作（落到云端调度器；MVP 可打桩） */
export interface CommandActions {
  /** 查询账号状态，返回一段可读描述 */
  status(accountId: string): Promise<string> | string;
  /** 暂停账号 */
  pause(accountId: string): Promise<void> | void;
  /** 恢复账号 */
  resume(accountId: string): Promise<void> | void;
  /** 发送审批测试卡片 */
  publishTest?(): Promise<PublishApprovalPayload> | PublishApprovalPayload;
  /** 手动触发一次发帖编排（A 阶段4 PublishScheduler 手动扳机；返回可读回执）。 */
  publish?(): Promise<string> | string;
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
      const msg = await this.actions.publish();
      return {
        command: cmd.raw,
        ok: true,
        title: '已触发发帖编排',
        message: `${msg}\n（人工授权越过风控，但发布前仍需飞书人审 approved=true 才会真发）`,
      };
    } catch (err) {
      return this.fail(cmd, '发帖触发失败', err);
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
