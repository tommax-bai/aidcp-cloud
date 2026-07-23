/**
 * 统一命令受理 + 鉴权面（api 侧单一命令面；change consolidate-command-face，设计档 §4.6.7）。
 *
 * 背景：飞书 Bot 与管理后台是同类的人机操作入口，MUST 共用同一套命令受理与鉴权，再由 api 侧
 * 按边界转给自动化运行时实现（cloud-service-decomposition-proposal §4.6.2 / §4.6.7）。此前
 * 两条入口各自在组合根（src/server.ts）里内联拼一份命令对象：
 *   - 飞书 CommandRouter 消费一份 `CommandActions`（status/pause/resume/bindChat/delegate/publish/comment）；
 *   - 面板 `POST /api/accounts/:id/dispatch`（及 pause/resume）消费另一份 `panelCommandActions`。
 * 两份各自实现 pause / resume + 恢复 edge 的原子动作、且没有共享的受理鉴权口径。
 *
 * 本面把这两份收敛成**一处 api 侧工厂**：账号级原子命令（暂停 / 恢复 / 状态 / 恢复 edge）在此定义一次、
 * 两条入口共用；飞书命令作用域鉴权（哪个群可下达账号命令）也在此构造。复杂 / 依赖自动化运行时的处理器
 * （delegate / publish / comment / dispatch 引擎启停）由组合根以**窄端口**注入 —— 本面**绝不** import
 * 自动化层模块（保持 api→api，不新增跨边界 import 豁免；组合根 = composition 层，注入自动化实现合法）。
 *
 * 行为零变更：受理的命令集合、鉴权口径、每个处理器的行为逐位等价，只是调用通道从「两处内联」变成
 * 「经单一命令面」。
 */

import type { AccountState } from '../account-state.js';
import type { CommandActions } from './commands.js';

/**
 * 面板命令动作（与 `PanelServerDeps['commandActions']` 结构对齐）：durable，与飞书命令面共用同一套
 * 账号级底层动作。dispatch / dispatchActive 为调度引擎启停（现役单全局 RoleDispatcher）。
 */
export interface PanelCommandActions {
  pause(accountId: string): Promise<{ accountId: string; status: 'paused' }>;
  resume(accountId: string): Promise<{ accountId: string; status: 'active'; resumedEdges: number }>;
  dispatch(
    accountId: string,
    action: 'start' | 'stop',
  ): Promise<{ accountId: string; dispatch: 'started' | 'stopped'; changed: boolean; edgesOnline: number }>;
  dispatchActive(): boolean;
}

/**
 * 账号级命令原子动作（窄端口，由组合根注入）。这是飞书 status/pause/resume 与面板 pause/resume 唯一
 * 共享的底层动作面，收敛掉此前「两处各写一份」。全部只读 / 写账号暂停态与恢复 edge，不碰风控单写。
 */
export interface AccountCommandPort {
  /** 解析命令目标账号：飞书无参命令解析「唯一真实账号」，0 或多个则抛错（由路由层回报）。 */
  requireCommandAccount(accountId?: string): Promise<string>;
  /** 读账号暂停态三态副本（paused/active/unknown）。 */
  getStatus(accountId: string): AccountState;
  /** 暂停账号（写暂停态；持久化 + 热缓存同步）。 */
  pause(accountId: string): Promise<void>;
  /** 恢复账号暂停态（不含解除 edge，见 resumeEdgesForAccount）。 */
  resume(accountId: string): Promise<void>;
  /** 解除该账号名下被验证码暂停的 edge，返回真实恢复数（绝不乐观）。 */
  resumeEdgesForAccount(accountId: string): number;
}

export interface CommandFaceDeps {
  /** 账号级原子命令端口（飞书 + 面板共用）。 */
  account: AccountCommandPort;
  /** 绑定当前群为默认审批群。 */
  bindChat: NonNullable<CommandActions['bindChat']>;
  /** 自然语言 / 旧写命令统一受理（→ 委托任务服务）。 */
  delegate: NonNullable<CommandActions['delegate']>;
  /** 手动发帖扳机（→ 发布排期器）。 */
  publish: NonNullable<CommandActions['publish']>;
  /** 手动按需评论扳机（→ 评论调度器）。 */
  comment: NonNullable<CommandActions['comment']>;
  /** 调度引擎启停（面板 /dispatch；现役单全局 RoleDispatcher）。 */
  dispatch: PanelCommandActions['dispatch'];
  /** 调度引擎当前是否活跃（dashboard summary 读）。 */
  dispatchActive: PanelCommandActions['dispatchActive'];
  /**
   * 飞书命令作用域鉴权：管理群白名单（FEISHU_MANAGEMENT_CHAT_IDS 解析结果）。
   * 空集合 → 未启用作用域 → 放行全部命令（零回归 / 滚动上线）。
   */
  managementChatIds: ReadonlySet<string>;
  logger?: Pick<Console, 'log'>;
}

export interface CommandFace {
  /** 飞书 CommandRouter 消费的命令动作。 */
  actions: CommandActions;
  /** 面板 deps.commandActions 消费的命令动作（与飞书共用账号级底层动作）。 */
  panelCommandActions: PanelCommandActions;
  /** 飞书命令作用域鉴权：给定来源群是否可下达账号命令（非 help 命令）。 */
  isCommandChatAuthorized(chatId?: string): boolean;
  /** 是否配置了非空管理群白名单（启用了命令作用域）。 */
  commandScopingEnabled: boolean;
}

/**
 * 构造统一命令面。组合根在此注入自动化运行时的窄端口；本函数只做受理装配 + 鉴权口径，
 * 逐位复刻此前 src/server.ts 两处内联对象的行为。
 */
export function createCommandFace(deps: CommandFaceDeps): CommandFace {
  const log = deps.logger ?? console;

  // 命令作用域（change feishu-per-team-notification-routing）：账号影响类命令只在「管理群」受理，
  // 外部 / 非管理群一律诚实拒。管理群 = 独立显式 env 白名单（不由 /bind 授予、不复用 is_default，防自助提权）。
  // 未配置（空集合）→ 放行全部（零回归 / 滚动上线 ramp）。
  const commandScopingEnabled = deps.managementChatIds.size > 0;
  const isCommandChatAuthorized = (chatId?: string): boolean =>
    !commandScopingEnabled || (!!chatId && deps.managementChatIds.has(chatId));
  log.log(
    commandScopingEnabled
      ? `[aidcp-cloud] 飞书命令作用域已启用：仅 ${deps.managementChatIds.size} 个管理群可下达账号命令（外部群纯通知投递）`
      : '[aidcp-cloud] 飞书命令作用域未启用（FEISHU_MANAGEMENT_CHAT_IDS 为空）→ 放行全部命令（零回归）',
  );

  const actions: CommandActions = {
    status: async (accountId) => {
      const acct = await deps.account.requireCommandAccount(accountId);
      const state = deps.account.getStatus(acct);
      // 三态：`unknown` = 暂停态副本已陈旧、云端此刻读不到。如实说「读不到」，
      // MUST NOT 把它显示成 active——那正是「未知压成否」在运营界面上的样子。
      const emoji = state.status === 'paused' ? '⏸️' : state.status === 'unknown' ? '❓' : '🟢';
      const statusText =
        state.status === 'paused'
          ? 'paused'
          : state.status === 'unknown'
            ? '暂时读不到（云端配置副本陈旧，已停止下发新命令）'
            : 'active';
      const extra = state.pausedAt ? `\n暂停时间：${new Date(state.pausedAt).toLocaleString()}` : '';
      return `账号 \`${acct}\` 当前状态：${statusText} ${emoji}${extra}`;
    },
    pause: async (accountId) => {
      const acct = await deps.account.requireCommandAccount(accountId);
      await deps.account.pause(acct);
      log.log(`[feishu] 已暂停账号：${acct}`);
    },
    resume: async (accountId) => {
      const acct = await deps.account.requireCommandAccount(accountId);
      await deps.account.resume(acct);
      // 验证码人工恢复快路：解除该账号名下被暂停的 edge。
      const resumedEdges = deps.account.resumeEdgesForAccount(acct);
      log.log(`[feishu] 已恢复账号：${acct}（恢复 edge 数=${resumedEdges}）`);
    },
    bindChat: deps.bindChat,
    delegate: deps.delegate,
    publish: deps.publish,
    comment: deps.comment,
  };

  const panelCommandActions: PanelCommandActions = {
    pause: async (accountId) => {
      await deps.account.pause(accountId);
      return { accountId, status: 'paused' as const };
    },
    resume: async (accountId) => {
      await deps.account.resume(accountId);
      const resumedEdges = deps.account.resumeEdgesForAccount(accountId);
      return { accountId, status: 'active' as const, resumedEdges };
    },
    dispatch: deps.dispatch,
    dispatchActive: deps.dispatchActive,
  };

  return { actions, panelCommandActions, isCommandChatAuthorized, commandScopingEnabled };
}
