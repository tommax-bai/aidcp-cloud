/**
 * EdgeCommand → 协议 Envelope 桥接层。
 *
 * 将 RoleDispatcher 产出的 EdgeCommand 翻译为协议 Envelope，
 * 以便通过 ws-server.pushToEdges 下发给边缘节点。
 */

import { randomUUID } from 'node:crypto';
import { makeEnvelope, type Envelope, type MessageType } from './protocol.js';
import type { EdgeCommand } from '../orchestrator/role-dispatcher.js';

/** 构造一个带随机 id 的信封 */
function createEnvelope(type: MessageType, payload: Record<string, unknown>): Envelope {
  return makeEnvelope(type, randomUUID(), Date.now(), payload as never);
}

/**
 * 将 RoleDispatcher 的 EdgeCommand 转换为协议 Envelope。
 */
export function edgeCommandToEnvelope(command: EdgeCommand): Envelope {
  switch (command.action) {
    case 'scroll':
      // feed-scroll-card-floor：透传 params（如 dwellMs）；旧行为只带 reason 会丢弃 params。
      return createEnvelope('page.scroll', { reason: command.reason, ...command.params });
    case 'open_note':
      return createEnvelope('note.open', command.params ?? {});
    case 'close_note':
      return createEnvelope('note.close', command.params ?? {});
    case 'like':
      return createEnvelope('interaction.like', command.params ?? {});
    case 'collect':
      return createEnvelope('interaction.collect', command.params ?? {});
    case 'follow':
      return createEnvelope('interaction.follow', command.params ?? {});
    case 'comment':
      return createEnvelope('interaction.comment', command.params ?? {});
    case 'comment_like':
      return createEnvelope('interaction.like_comment', command.params ?? {});
    case 'search':
      return createEnvelope('search.execute', command.params ?? {});
    case 'back':
      return createEnvelope('navigation.back', { reason: command.reason, ...command.params });
    case 'browse_images':
      return createEnvelope('note.browse_images', command.params ?? {});
    case 'scroll_comments':
      return createEnvelope('note.scroll_comments', command.params ?? {});
    case 'profile_open':
      return createEnvelope('profile.open', command.params ?? {});
    case 'open_notifications':
      return createEnvelope('notification.open', command.params ?? {});
    case 'browse_notification_comments':
      return createEnvelope('notification.browse_comments', command.params ?? {});
    case 'browse_notification_likes':
      return createEnvelope('notification.browse_likes', command.params ?? {});
    case 'browse_notification_follows':
      return createEnvelope('notification.browse_follows', command.params ?? {});
    case 'notification_back_home':
      return createEnvelope('notification.back_home', command.params ?? {});
    case 'session.end':
      return createEnvelope('session.end', { reason: command.reason });
    default:
      throw new Error(`Unknown edge command action: ${(command as EdgeCommand).action}`);
  }
}
