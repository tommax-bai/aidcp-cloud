import * as lark from '@larksuiteoapi/node-sdk';
import type pg from 'pg';
import type { AccountStore } from '../account-store.js';
import { BotChatStore } from '../cache/bot-chat-store.js';
import type {
  StructuredNotificationDeliveryPort,
} from '../kernel/api-direct-port.js';
import type {
  PublishApprovalDecisionWriterPort,
} from '../kernel/publish-approval-contract.js';
import type { PublishCardExitPort } from '../kernel/publish-card-exit-port.js';
import type { DelegatedTaskServicePort } from '../kernel/delegated-task-types.js';
import { StructuredNotificationDelivery } from './structured-notification-delivery.js';
import { FeishuMessenger } from './messenger.js';
import {
  buildCommandResultCard,
  buildPublishApprovalCard,
} from './cards.js';
import {
  resolveCardTarget,
  resolveChatIdForAccount,
  resolveDefaultChatId,
} from './chat-target.js';
import {
  buildDelegatedTaskConfirmationCard,
  buildDelegatedTaskProgressCard,
  handleDelegatedTaskCardAction,
  parseDelegatedTaskCardAction,
} from './delegated-task-card.js';
import {
  createCommandFace,
  type CommandFace,
  type CommandFaceDeps,
} from './command-face.js';
import { CommandRouter } from './commands.js';
import {
  FeishuWsReceiver,
  type FeishuWsReceiverOptions,
} from './ws-receiver.js';
import { FeishuBotChatEventHandler } from './bot-chat-events.js';
import { buildFeishuEventDispatcher } from './handler.js';
import { createBotChatsProvider } from './bot-chats-provider.js';
import { isFeishuWsEnabled } from './ws-config.js';

export interface ApiFeishuOwnerDeps {
  pool: pg.Pool;
  accountStore?: AccountStore;
  groupRoutes?: { getRoute(groupLabel: string): Promise<string | null> };
  accountDisplayName(accountId: string): string | undefined;
  publishApprovalDecisionWriter?: PublishApprovalDecisionWriterPort;
  deploymentTarget: 'dev' | 'ol' | null;
  fallbackChatId?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface StartApiFeishuIngressInput {
  commandFace: CommandFace;
  writeApproval: NonNullable<FeishuWsReceiverOptions['writeApproval']>;
  onApproved?: FeishuWsReceiverOptions['onApproved'];
  onRejected?: FeishuWsReceiverOptions['onRejected'];
  readLiveContentVersion?: FeishuWsReceiverOptions['readLiveContentVersion'];
  preflightApprovePublish?: FeishuWsReceiverOptions['preflightApprovePublish'];
  delegatedTasks?: DelegatedTaskServicePort;
}

export interface ApiFeishuOwner {
  botChatStore: BotChatStore;
  notificationDelivery: StructuredNotificationDeliveryPort;
  publishCardExit: PublishCardExitPort;
  createCommandFace(deps: CommandFaceDeps): CommandFace;
  buildDelegatedTaskConfirmationCard: typeof buildDelegatedTaskConfirmationCard;
  buildDelegatedTaskProgressCard: typeof buildDelegatedTaskProgressCard;
  resolveAccountChatId(accountId: string | undefined): Promise<string>;
  resolveCardChatId(
    originChatId: string | undefined | null,
    accountId: string | undefined,
  ): Promise<string>;
  sendCommandResult(
    accountId: string,
    input: Parameters<typeof buildCommandResultCard>[0],
  ): Promise<void>;
  startIngress(input: StartApiFeishuIngressInput): Promise<{
    botChatsProvider: ReturnType<typeof createBotChatsProvider>;
  }>;
}

export function createApiFeishuOwner(deps: ApiFeishuOwnerDeps): ApiFeishuOwner {
  const logger = deps.logger ?? console;
  const botChatStore = new BotChatStore({ pool: deps.pool });
  const messenger = new FeishuMessenger();
  const resolveAccountChatId = (accountId: string | undefined): Promise<string> =>
    resolveChatIdForAccount(accountId, {
      accountStore: deps.accountStore,
      groupRouteStore: deps.groupRoutes,
      botChatStore,
      fallbackChatId: deps.fallbackChatId,
      logger,
    });
  const resolveCardChatId = (
    originChatId: string | undefined | null,
    accountId: string | undefined,
  ): Promise<string> =>
    resolveCardTarget(
      { originChatId, accountId },
      {
        accountStore: deps.accountStore,
        groupRouteStore: deps.groupRoutes,
        botChatStore,
        fallbackChatId: deps.fallbackChatId,
        logger,
      },
    );
  const notificationDelivery = new StructuredNotificationDelivery({
    resolveCardChatId,
    resolveAccountChatId,
    resolveDefaultChatId: () =>
      resolveDefaultChatId({
        botChatStore,
        fallbackChatId: deps.fallbackChatId,
        logger,
      }),
    accountDisplayName: deps.accountDisplayName,
    messenger,
  });
  const withAccountName = <T extends { accountId?: string; accountName?: string }>(
    data: T,
  ): T =>
    data.accountName || !data.accountId
      ? data
      : { ...data, accountName: deps.accountDisplayName(data.accountId) };
  const publishCardExit: PublishCardExitPort = {
    sendApprovalCard: (chatId, data) =>
      messenger.sendApprovalCard(chatId, buildPublishApprovalCard(withAccountName(data))),
    sendCommandResult: (chatId, data) =>
      messenger.sendCard(chatId, buildCommandResultCard(withAccountName(data))),
    uploadImageFromUrl: (url) => messenger.uploadImageFromUrl(url),
    getDefaultChat: () => botChatStore.getDefaultChat(),
    resolveCardChatId,
    writeApprovalSignal: (requestId, approved, payload, decidedBy) => {
      if (!deps.publishApprovalDecisionWriter || !deps.deploymentTarget) {
        throw new Error('approval_decision_writer_unavailable');
      }
      return deps.publishApprovalDecisionWriter.writeDecision({
        requestId,
        approved,
        payload,
        context: {
          decidedBy,
          decidedVia: 'schedule_auto_approve',
        },
        executionTarget: deps.deploymentTarget,
      });
    },
  };

  return {
    botChatStore,
    notificationDelivery,
    publishCardExit,
    createCommandFace,
    buildDelegatedTaskConfirmationCard,
    buildDelegatedTaskProgressCard,
    resolveAccountChatId,
    resolveCardChatId,
    async sendCommandResult(accountId, input) {
      const chatId = await resolveAccountChatId(accountId);
      if (!chatId) throw new Error('command_result_chat_not_configured');
      await messenger.sendCard(chatId, buildCommandResultCard(withAccountName(input)));
    },
    async startIngress(input) {
      const commandRouter = new CommandRouter(
        input.commandFace.actions,
        undefined,
        undefined,
        input.commandFace.isCommandChatAuthorized,
      );
      const botChatEventHandler = new FeishuBotChatEventHandler(botChatStore);
      const feishuReceiver = new FeishuWsReceiver({
        commandRouter,
        messenger,
        writeApproval: input.writeApproval,
        onApproved: input.onApproved,
        onRejected: input.onRejected,
        readLiveContentVersion: input.readLiveContentVersion,
        preflightApprovePublish: input.preflightApprovePublish,
        onDelegatedTaskAction: input.delegatedTasks
          ? (value) => handleDelegatedTaskCardAction(input.delegatedTasks!, value)
          : async (value) =>
              parseDelegatedTaskCardAction(value)
                ? {
                    toast: {
                      type: 'error' as const,
                      content: 'automation_operator_command_unavailable',
                    },
                  }
                : null,
      });
      if (isFeishuWsEnabled()) {
        try {
          const wsClient = new lark.WSClient({
            appId: process.env.FEISHU_APP_ID ?? '',
            appSecret: process.env.FEISHU_APP_SECRET ?? '',
            onReady: () => logger.log('[aidcp-cloud] 飞书长连接已建立（WSClient onReady）'),
            onError: (error) => logger.error('[aidcp-cloud] 飞书长连接错误:', error.message),
            onReconnecting: () => logger.warn('[aidcp-cloud] 飞书长连接重连中…'),
            onReconnected: () => logger.log('[aidcp-cloud] 飞书长连接已重连'),
          });
          await wsClient.start({
            eventDispatcher: buildFeishuEventDispatcher(
              feishuReceiver,
              botChatEventHandler,
              logger,
            ),
          });
          logger.log('[aidcp-cloud] 飞书事件接收已启动（WSClient 长连接）');
        } catch (error) {
          logger.warn(
            '[aidcp-cloud] 飞书长连接启动失败（事件接收不可用）:',
            error instanceof Error ? error.message : String(error),
          );
        }
      } else {
        logger.warn(
          '[aidcp-cloud] 飞书长连接已禁用（AIDCP_FEISHU_WS_ENABLED=false）；当前进程不接收飞书事件',
        );
      }
      return {
        botChatsProvider: createBotChatsProvider({
          messenger,
          botChatStore,
          fallbackChatId: deps.fallbackChatId,
          logger,
        }),
      };
    },
  };
}
