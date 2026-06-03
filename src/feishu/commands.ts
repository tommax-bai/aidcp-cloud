/**
 * 飞书 /aidcp 指令解析与执行。
 *
 * MVP 支持结构化命令（product-feishu.md §5）：
 *   /aidcp status [accountId]   查账号状态
 *   /aidcp pause  [accountId]   暂停账号
 *   /aidcp resume [accountId]   恢复账号
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

/** 单账号 MVP 的缺省账号 id */
export const DEFAULT_ACCOUNT_ID = 'acc-default';

/** 已识别的指令动作 */
export type CommandAction = 'status' | 'pause' | 'resume' | 'publish-test' | 'help';

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
  '• `/aidcp publish-test` — 发送测试审批卡片',
  '',
  '（单账号 MVP：accountId 可省略，默认作用于唯一账号）',
].join('\n');

/**
 * 解析一条文本指令为结构化命令。
 *
 * 规则：
 * - 必须以 `/aidcp` 前缀开头，否则归为 help；
 * - 子命令仅识别 status/pause/resume，其余归为 help；
 * - 第二个 token 视为 accountId，缺省用 DEFAULT_ACCOUNT_ID。
 */
export function parseCommand(text: string): ParsedCommand {
  const raw = (text ?? '').trim();
  const tokens = raw.split(/\s+/).filter(Boolean);

  if (tokens.length === 0 || tokens[0] !== '/aidcp') {
    return { action: 'help', accountId: DEFAULT_ACCOUNT_ID, raw, hint: '未识别的指令' };
  }

  const sub = (tokens[1] ?? '').toLowerCase();
  const accountId = tokens[2] ?? DEFAULT_ACCOUNT_ID;
  const args = tokens.slice(2);

  switch (sub) {
    case 'status':
    case 'pause':
    case 'resume':
      return { action: sub, accountId, raw, args };
    case 'publish-test':
      return { action: 'publish-test', accountId: DEFAULT_ACCOUNT_ID, raw, args };
    default:
      return {
        action: 'help',
        accountId: DEFAULT_ACCOUNT_ID,
        raw,
        hint: sub ? `未识别的子命令：${sub}` : '缺少子命令',
      };
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
}

export interface PublishTestOptions {
  token?: string;
}

export function resolvePublishApprovalToken(
  options: PublishTestOptions = {},
  generateToken: () => string = globalThis.crypto.randomUUID.bind(globalThis.crypto),
): string {
  const explicitToken = options.token?.trim();
  if (explicitToken) return explicitToken;
  const envToken = process.env.AIDCP_PUBLISH_APPROVAL_TOKEN?.trim();
  if (envToken) return envToken;
  return generateToken();
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
      case 'help':
      default:
        return {
          command: cmd.raw || '/aidcp',
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
    const token = resolvePublishApprovalToken({ token: cmd.args?.[0] });
    await this.messenger.sendApprovalCard(
      targetChatId,
      buildPublishApprovalCard({
        token,
        ...payload,
      }),
    );
    return {
      command: cmd.raw,
      ok: true,
      title: '测试审批卡片已发送',
      message: `已向会话 \`${targetChatId}\` 发送审批卡片。\n授权 token：\`${token}\``,
    };
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
