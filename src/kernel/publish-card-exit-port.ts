/**
 * 发布候审的**卡片出口**（kernel）：发飞书审批卡 / 通知、解析卡片落点、写免审预授权。
 *
 * 六个方法是一组，因为它们服务同一件事——「稿子落库候审之后，让人知道并且能批」。
 * 它们的实现全都长在 api 域：飞书客户端与卡片构造（`src/feishu/`）、机器人会话表、授权台账。
 * 内容域交出的一律是**结构化数据**（`PublishApprovalCardData` / `CommandResult` 等 kernel 类型），
 * 卡片长什么样、发到哪个会话，由属主侧决定。这与既有的「飞书契约缝」同向：
 * 业务侧只给数据，组合根侧构卡 + 发送。
 *
 * **依赖后果**：内容仓因此**不需要飞书 SDK**。这不是顺带的好处，是这条口存在的一半理由——
 * 三仓依赖集重算时飞书已被判给 api，而内容段当时仍在直接调它，两者只能有一个成立。
 *
 * **失败语义：六个方法一律原样抛，与那两条只读口刻意不同。**
 *   - 发卡失败：发布出口角色**自己接得住**（它把结果记成 `sent:false` + 真实 error 交出去），
 *     吞在端口这一层反而会让它记成「发出去了」——那正是红线点名的静默假成功。
 *   - 授权写失败：更不能吞。「以为已授权其实没写」会让一篇稿子既不在候审也不会被发。
 *   - 落点解析失败：抛出去才能让调用方诚实回「没有目标」，吞掉会把卡发进一个猜出来的会话。
 */
import type {
  ApprovalWriteResult,
  CommandResult,
  PublishApprovalCardData,
  PublishApprovalPayload,
} from './feishu-card-contract.js';
import type { DefaultChatTarget } from './default-chat-provider.js';

export interface PublishCardExitPort {
  /** 发审批卡。入参是结构化数据，卡片由属主侧构造。 */
  sendApprovalCard(chatId: string, data: PublishApprovalCardData): Promise<void>;
  /** 命令结果通知（免审提示等）。 */
  sendCommandResult(chatId: string, data: CommandResult): Promise<void>;
  /** 把外链图转存成可在卡片里引用的图，返回属主侧的图 key。 */
  uploadImageFromUrl(url: string): Promise<string>;
  /** 默认群目标；没有配则 null（调用方据此诚实回「没有落点」）。 */
  getDefaultChat(): Promise<DefaultChatTarget | null>;
  /** 卡片落点统一解析：来源会话 → 账号团队群 → 默认群。 */
  resolveCardChatId(originChatId: string | undefined | null, accountId: string | undefined): Promise<string>;
  /**
   * 排期免审预授权：与人审**同一个**授权写出口，写同一张持久授权记录。
   * `decidedBy` = 触发本次免审的排期规则标识（真实决策主体，MUST NOT 常量占位）。
   */
  writeApprovalSignal(
    requestId: string,
    approved: boolean,
    payload: PublishApprovalPayload,
    decidedBy: string,
  ): Promise<ApprovalWriteResult>;
}
