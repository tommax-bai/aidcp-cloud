/**
 * 飞书通知/审批目标群解析（共享口径）。
 *
 * 解析顺序：默认群（bot_chats，经 /bind 设定）→ fallbackChatId（通常 FEISHU_CHAT_ID）→ 空串。
 * 发布审批与验证码告警共用此解析，避免在多处复制同一段逻辑。
 */

import type { BotChatStore } from '../cache/bot-chat-store.js';

export interface ChatTargetDeps {
  botChatStore?: Pick<BotChatStore, 'getDefaultChat'>;
  /** 兜底群（通常来自 FEISHU_CHAT_ID） */
  fallbackChatId?: string;
  logger?: Pick<Console, 'warn'>;
}

/** 解析目标群 chatId；查询默认群失败时回退 fallbackChatId / FEISHU_CHAT_ID；都没有则返回空串。 */
export async function resolveDefaultChatId(deps: ChatTargetDeps): Promise<string> {
  let defaultChat = null;
  try {
    defaultChat = (await deps.botChatStore?.getDefaultChat()) ?? null;
  } catch (error) {
    deps.logger?.warn(
      '[feishu] 默认群查询失败，回退 fallbackChatId:',
      error instanceof Error ? error.message : String(error),
    );
  }
  return defaultChat?.chatId ?? deps.fallbackChatId ?? process.env.FEISHU_CHAT_ID ?? '';
}

/**
 * 账号级出站目标解析（change feishu-per-team-notification-routing）。
 *
 * 层叠在**不动的** resolveDefaultChatId 之上：账号 → group_label → group_route.chat_id 命中即用；
 * 命不中 / 无 accountId / 任一层读失败 → 回落默认群链。**空表 = 今天行为逐字一致，未绑定账号一律落默认群、绝不静默丢。**
 *
 * 红线：每层读各自 try/catch、失败向下穿透，**绝不把异常抛入调用方投递闭包**（异常路径静默作废整批 = 静默假成功）。
 * 有非空 group_label 却未命中路由 → config-gap 日志（供运营发现漏配 / 拼写错配），仍落默认群。
 */
export interface AccountChatTargetDeps extends ChatTargetDeps {
  /** 账号存储（读 group_label）。缺省 / 缺方法 → 一律落默认群。 */
  accountStore?: { getGroupLabel?(accountId: string): Promise<string | null> };
  /** 团队 → 群路由存储（精确相等查，绝不模糊匹配）。缺省 → 落默认群。 */
  groupRouteStore?: { getRoute(groupLabel: string): Promise<string | null> };
}

export async function resolveChatIdForAccount(
  accountId: string | undefined,
  deps: AccountChatTargetDeps,
): Promise<string> {
  // 无归属账号（config-error / 无可解析账号的告警）→ 直接默认群，不臆造 scope。
  if (!accountId) return resolveDefaultChatId(deps);

  // ① 读 group_label（读失败按「无团队路由」向下穿透，绝不外抛）。
  let groupLabel: string | null = null;
  try {
    groupLabel = (await deps.accountStore?.getGroupLabel?.(accountId)) ?? null;
  } catch (error) {
    deps.logger?.warn(
      `[feishu-routing] group_label 读失败 account=${accountId}，回落默认群:`,
      error instanceof Error ? error.message : String(error),
    );
    return resolveDefaultChatId(deps);
  }

  const key = (groupLabel ?? '').trim();
  if (!key) return resolveDefaultChatId(deps); // 未分组 → 默认群

  // ② 查团队路由（读失败向下穿透）。精确相等由 store 保证，绝不模糊匹配（防映射错群 → 跨客户 PII 泄漏）。
  try {
    const chatId = await deps.groupRouteStore?.getRoute(key);
    if (chatId) return chatId;
  } catch (error) {
    deps.logger?.warn(
      `[feishu-routing] group_route 查询失败 account=${accountId} team=${key}，回落默认群:`,
      error instanceof Error ? error.message : String(error),
    );
    return resolveDefaultChatId(deps);
  }

  // 有非空 group_label 却未命中路由 → config-gap（拼写 / 大小写 / 空白不一致 / 未配置），仍落默认群、绝不丢。
  deps.logger?.warn(
    `[feishu-routing] config-gap：账号 ${accountId} 的团队键「${key}」未命中任何 group_route 映射，落默认群（请在后台补映射或核对拼写）`,
  );
  return resolveDefaultChatId(deps);
}
