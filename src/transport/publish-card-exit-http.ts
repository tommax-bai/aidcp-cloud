/**
 * 发布候审卡片出口的跨进程三件套。范式逐字照 {@link file://./curated-content-http.ts}。
 * 服务端跑在 **api** 进程（飞书客户端、机器人会话表、授权台账都在那边），客户端跑在 **content** 进程。
 *
 * **六个方法一律原样抛**，理由写在 kernel 端口的文档里：发卡失败由发布出口角色自己接住并如实记账，
 * 授权写失败绝不能被吞成「已授权」，落点解析失败要让调用方诚实回「没有目标」。
 * 本文件因此**没有任何 catch** —— 与投递判定（fail-open）、管线日志（吵闹放过）刻意不同。
 */
import type { InternalHttpClient, InternalHttpServer } from './internal-http.js';
import type {
  ApprovalWriteResult,
  CommandResult,
  PublishApprovalCardData,
  PublishApprovalPayload,
} from '../kernel/feishu-card-contract.js';
import type { DefaultChatTarget } from '../kernel/default-chat-provider.js';
import type { PublishCardExitPort } from '../kernel/publish-card-exit-port.js';

/** 端口方法对应的内部 HTTP 路由名。server / client 两侧共用，防漂移。 */
export const PUBLISH_CARD_EXIT_ROUTES = {
  sendApprovalCard: 'publish-card-exit/send-approval-card',
  sendCommandResult: 'publish-card-exit/send-command-result',
  uploadImageFromUrl: 'publish-card-exit/upload-image-from-url',
  getDefaultChat: 'publish-card-exit/get-default-chat',
  resolveCardChatId: 'publish-card-exit/resolve-card-chat-id',
  writeApprovalSignal: 'publish-card-exit/write-approval-signal',
} as const;

/** 把一个本地卡片出口注册为内部 HTTP route。只做参数解包 → 转调 → 回传，零业务逻辑。 */
export function registerPublishCardExitRoutes(server: InternalHttpServer, local: PublishCardExitPort): void {
  server.register(PUBLISH_CARD_EXIT_ROUTES.sendApprovalCard, async (args) => {
    const a = args as { chatId: string; data: PublishApprovalCardData };
    await local.sendApprovalCard(a.chatId, a.data);
    return null;
  });
  server.register(PUBLISH_CARD_EXIT_ROUTES.sendCommandResult, async (args) => {
    const a = args as { chatId: string; data: CommandResult };
    await local.sendCommandResult(a.chatId, a.data);
    return null;
  });
  server.register(PUBLISH_CARD_EXIT_ROUTES.uploadImageFromUrl, (args) => {
    const a = args as { url: string };
    return local.uploadImageFromUrl(a.url);
  });
  server.register(PUBLISH_CARD_EXIT_ROUTES.getDefaultChat, () => local.getDefaultChat());
  server.register(PUBLISH_CARD_EXIT_ROUTES.resolveCardChatId, (args) => {
    const a = args as { originChatId: string | undefined | null; accountId: string | undefined };
    return local.resolveCardChatId(a.originChatId, a.accountId);
  });
  server.register(PUBLISH_CARD_EXIT_ROUTES.writeApprovalSignal, (args) => {
    const a = args as {
      requestId: string;
      approved: boolean;
      payload: PublishApprovalPayload;
      decidedBy: string;
    };
    return local.writeApprovalSignal(a.requestId, a.approved, a.payload, a.decidedBy);
  });
}

/** `PublishCardExitPort` 的 HTTP 实现：每个方法一次调用，失败原样抛。 */
export class PublishCardExitHttpClient implements PublishCardExitPort {
  constructor(private readonly http: InternalHttpClient) {}

  async sendApprovalCard(chatId: string, data: PublishApprovalCardData): Promise<void> {
    await this.http.call(PUBLISH_CARD_EXIT_ROUTES.sendApprovalCard, { chatId, data });
  }

  async sendCommandResult(chatId: string, data: CommandResult): Promise<void> {
    await this.http.call(PUBLISH_CARD_EXIT_ROUTES.sendCommandResult, { chatId, data });
  }

  uploadImageFromUrl(url: string): Promise<string> {
    return this.http.call<string>(PUBLISH_CARD_EXIT_ROUTES.uploadImageFromUrl, { url });
  }

  getDefaultChat(): Promise<DefaultChatTarget | null> {
    return this.http.call<DefaultChatTarget | null>(PUBLISH_CARD_EXIT_ROUTES.getDefaultChat, {});
  }

  resolveCardChatId(originChatId: string | undefined | null, accountId: string | undefined): Promise<string> {
    return this.http.call<string>(PUBLISH_CARD_EXIT_ROUTES.resolveCardChatId, { originChatId, accountId });
  }

  writeApprovalSignal(
    requestId: string,
    approved: boolean,
    payload: PublishApprovalPayload,
    decidedBy: string,
  ): Promise<ApprovalWriteResult> {
    return this.http.call<ApprovalWriteResult>(PUBLISH_CARD_EXIT_ROUTES.writeApprovalSignal, {
      requestId,
      approved,
      payload,
      decidedBy,
    });
  }
}
