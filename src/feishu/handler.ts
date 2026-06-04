import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuWsReceiver } from './ws-receiver.js';
import type { FeishuBotChatEventHandler } from './bot-chat-events.js';
import type { FeishuWsMessage } from './ws-receiver.js';

export function buildFeishuEventDispatcher(
  receiver: Pick<FeishuWsReceiver, 'handleMessage' | 'handleCardAction'>,
  botChatHandler: Pick<FeishuBotChatEventHandler, 'handleBotAdded' | 'handleBotDeleted'>,
  logger: Pick<Console, 'error'> = console,
): lark.EventDispatcher {
  return new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: { message: FeishuWsMessage }) => {
      try {
        await receiver.handleMessage(data.message);
      } catch (err) {
        logger.error('[feishu] 处理消息事件失败:', (err as Error).message);
      }
    },
    'card.action.trigger': async (data: { action?: { value?: unknown } }) => {
      try {
        return await receiver.handleCardAction(data.action?.value);
      } catch (err) {
        logger.error('[feishu] 处理卡片回调失败:', (err as Error).message);
        return {
          toast: { type: 'error', content: '处理审批回调失败' },
        };
      }
    },
    'im.chat.member.bot.added_v1': async (data) => {
      try {
        await botChatHandler.handleBotAdded({
          chat_id: data.chat_id,
          name: data.name,
          i18n_names: data.i18n_names,
        });
      } catch (err) {
        logger.error('[feishu] 处理机器人进群事件失败:', (err as Error).message);
      }
    },
    'im.chat.member.bot.deleted_v1': async (data) => {
      try {
        await botChatHandler.handleBotDeleted({
          chat_id: data.chat_id,
          name: data.name,
          i18n_names: data.i18n_names,
        });
      } catch (err) {
        logger.error('[feishu] 处理机器人退群事件失败:', (err as Error).message);
      }
    },
  });
}