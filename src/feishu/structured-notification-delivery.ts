import crypto from 'node:crypto';
import type {
  StructuredNotificationCommand,
  StructuredNotificationDeliveryInput,
  StructuredNotificationDeliveryPort,
  StructuredNotificationDeliveryResult,
} from '../kernel/api-direct-port.js';
import type { FeishuCard } from './types.js';
import { buildAlertCard, buildCommandResultCard, buildPublishApprovalCard } from './cards.js';
import { buildCommentApprovalCard } from './comment-approval-card.js';
import {
  buildMandatoryCommentOutcomeCard,
  buildMandatoryCommentPreAuthorizationCard,
} from './mandatory-comment-cards.js';

const MAX_PROCESS_RECEIPTS = 65_536;

interface DeliveryReceipt {
  payloadHash: string;
  result: StructuredNotificationDeliveryResult;
}

interface InFlightDelivery {
  payloadHash: string;
  result: Promise<StructuredNotificationDeliveryResult>;
}

export interface StructuredNotificationDeliveryDeps {
  resolveCardChatId(
    originChatId: string | undefined | null,
    accountId: string | undefined,
  ): Promise<string | null>;
  resolveAccountChatId(accountId: string): Promise<string | null>;
  resolveDefaultChatId(): Promise<string | null>;
  accountDisplayName(accountId: string): string | null | undefined;
  messenger: {
    sendCard(chatId: string, card: FeishuCard): Promise<void>;
    sendApprovalCard(chatId: string, card: FeishuCard): Promise<void>;
    sendText(chatId: string, text: string): Promise<void>;
  };
}

type PreparedNotification =
  | {
      kind: 'card';
      routeAccountId: string | null;
      originChatId: string | null;
      approval: boolean;
      card: FeishuCard;
    }
  | { kind: 'text'; routeAccountId: string | null; text: string };

function hashPayload(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function accountName(
  accountId: string | undefined,
  resolve: StructuredNotificationDeliveryDeps['accountDisplayName'],
): string | undefined {
  if (!accountId) return undefined;
  return resolve(accountId)?.trim() || undefined;
}

function originChatId(input: object): string | null {
  const value = (input as { originChatId?: unknown }).originChatId;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error('originChatId must be a string');
  }
  return value.trim() || null;
}

function inboxText(items: Extract<StructuredNotificationCommand, { kind: 'notification_inbox' }>['items']): string {
  const lines = items.map(
    (item) =>
      `• ${item.fromUser?.trim() || '某用户'}（${item.kind === 'mention' ? '@你' : item.kind === 'comment' ? '评论' : item.kind}）：${item.content}`
      + (item.noteTitle ? ` · 《${item.noteTitle}》` : ''),
  );
  return `📬 小红书新消息（${items.length}）\n${lines.join('\n')}`;
}

function explicitFeishuRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /飞书消息发送失败：(HTTP \d+|code=)/.test(message);
}

export class StructuredNotificationDelivery implements StructuredNotificationDeliveryPort {
  private readonly receipts = new Map<string, DeliveryReceipt>();
  private readonly inFlight = new Map<string, InFlightDelivery>();

  constructor(private readonly deps: StructuredNotificationDeliveryDeps) {}

  async deliver(
    input: StructuredNotificationDeliveryInput,
  ): Promise<StructuredNotificationDeliveryResult> {
    if (
      typeof input?.commandId !== 'string'
      || input.commandId.trim().length === 0
      || input.commandId.length > 200
      || !input.notification
      || typeof input.notification !== 'object'
    ) {
      return { outcome: 'not_delivered', reason: 'invalid_command' };
    }
    let payloadHash: string;
    try {
      payloadHash = hashPayload(input.notification);
    } catch {
      return { outcome: 'not_delivered', reason: 'invalid_command' };
    }
    const previous = this.receipts.get(input.commandId);
    if (previous) {
      return previous.payloadHash === payloadHash
        ? previous.result
        : { outcome: 'not_delivered', reason: 'invalid_command' };
    }
    const pending = this.inFlight.get(input.commandId);
    if (pending) {
      return pending.payloadHash === payloadHash
        ? pending.result
        : { outcome: 'not_delivered', reason: 'invalid_command' };
    }

    // Receipts are never evicted during this process lifetime. Once the exact
    // ledger is full, failing closed is safer than accepting a command whose
    // old receipt might have been discarded and sending a duplicate card.
    if (this.receipts.size + this.inFlight.size >= MAX_PROCESS_RECEIPTS) {
      return { outcome: 'not_delivered', reason: 'invalid_command' };
    }
    const result = this.deliverOnce(input)
      .then((receipt) => {
        this.receipts.set(input.commandId, { payloadHash, result: receipt });
        return receipt;
      })
      .finally(() => {
        this.inFlight.delete(input.commandId);
      });
    this.inFlight.set(input.commandId, { payloadHash, result });
    return result;
  }

  private async deliverOnce(
    input: StructuredNotificationDeliveryInput,
  ): Promise<StructuredNotificationDeliveryResult> {
    let prepared: PreparedNotification;
    try {
      prepared = this.prepare(input.notification);
    } catch {
      return {
        outcome: 'not_delivered',
        reason: 'invalid_command',
      };
    }

    let chatId: string | null;
    try {
      chatId = prepared.kind === 'card'
        ? await this.deps.resolveCardChatId(
            prepared.originChatId,
            prepared.routeAccountId ?? undefined,
          )
        : prepared.routeAccountId
          ? await this.deps.resolveAccountChatId(prepared.routeAccountId)
          : await this.deps.resolveDefaultChatId();
    } catch {
      return {
        outcome: 'not_delivered',
        reason: 'owner_rejected',
      };
    }
    if (!chatId) {
      return {
        outcome: 'not_delivered',
        reason: 'no_chat',
      };
    }

    try {
      if (prepared.kind === 'text') {
        await this.deps.messenger.sendText(chatId, prepared.text);
      } else if (prepared.approval) {
        await this.deps.messenger.sendApprovalCard(chatId, prepared.card);
      } else {
        await this.deps.messenger.sendCard(chatId, prepared.card);
      }
      return {
        outcome: 'delivered',
        deliveryId: input.commandId,
      };
    } catch (error) {
      return explicitFeishuRejection(error)
        ? { outcome: 'not_delivered', reason: 'owner_rejected' }
        : { outcome: 'unknown', reason: 'delivery_result_unknown' };
    }
  }

  private prepare(notification: StructuredNotificationCommand): PreparedNotification {
    switch (notification.kind) {
      case 'comment_approval': {
        const input = {
          ...notification.input,
          accountName: accountName(notification.input.accountId, this.deps.accountDisplayName),
        };
        return {
          kind: 'card',
          routeAccountId: input.accountId ?? null,
          originChatId: originChatId(notification.input),
          approval: true,
          card: buildCommentApprovalCard(input),
        };
      }
      case 'mandatory_comment_outcome': {
        const input = {
          ...notification.input,
          accountName: accountName(notification.input.accountId, this.deps.accountDisplayName),
        };
        return {
          kind: 'card',
          routeAccountId: input.accountId ?? null,
          originChatId: originChatId(notification.input),
          approval: false,
          card: buildMandatoryCommentOutcomeCard(input),
        };
      }
      case 'mandatory_comment_pre_authorization': {
        const input = {
          ...notification.input,
          accountName: accountName(notification.input.accountId, this.deps.accountDisplayName),
        };
        return {
          kind: 'card',
          routeAccountId: input.accountId ?? null,
          originChatId: originChatId(notification.input),
          approval: false,
          card: buildMandatoryCommentPreAuthorizationCard(input),
        };
      }
      case 'notification_inbox':
        return {
          kind: 'text',
          routeAccountId: notification.accountId,
          text: inboxText(notification.items),
        };
      case 'command_result': {
        const input = {
          ...notification.input,
          accountName: accountName(notification.input.accountId, this.deps.accountDisplayName),
        };
        return {
          kind: 'card',
          routeAccountId: input.accountId ?? null,
          originChatId: originChatId(notification.input),
          approval: false,
          card: buildCommandResultCard(input),
        };
      }
      case 'publish_approval': {
        const input = {
          ...notification.input,
          accountName: accountName(notification.input.accountId, this.deps.accountDisplayName),
        };
        return {
          kind: 'card',
          routeAccountId: input.accountId ?? null,
          originChatId: originChatId(notification.input),
          approval: true,
          card: buildPublishApprovalCard(input),
        };
      }
      case 'operational_text':
        if (notification.input.route === 'account' && !notification.input.accountId) {
          throw new Error('operational notification account route requires accountId');
        }
        return {
          kind: 'text',
          routeAccountId: notification.input.route === 'account'
            ? notification.input.accountId ?? null
            : null,
          text: notification.input.text,
        };
      case 'alert': {
        const input = notification.input;
        return {
          kind: 'card',
          routeAccountId: input.accountId ?? null,
          originChatId: originChatId(notification.input),
          approval: false,
          card: buildAlertCard({
            severity: input.severity === 'critical'
              ? 'P0'
              : input.severity === 'error'
                ? 'P1'
                : input.severity === 'warning'
                  ? 'P2'
                  : 'P3',
            title: input.title,
            detail: input.detail,
            accountId: input.accountId,
            accountName: accountName(input.accountId, this.deps.accountDisplayName),
            actionText: input.actionText,
            actionUrl: input.actionUrl,
          }),
        };
      }
      default: {
        const exhaustive: never = notification;
        throw new Error(`unknown structured notification kind: ${String(exhaustive)}`);
      }
    }
  }

}
