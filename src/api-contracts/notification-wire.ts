/**
 * 通知项的**线上载荷形状**在 api 段的本地声明（定稿 §10.9）。
 * 见 publish-approval-wire.ts 文件头「为什么复制而不是 import」。
 */

/** 单条通知项（边缘抽取的原始数据）。 */
export interface NotificationItem {
  kind: 'comment' | 'mention' | 'like' | 'collect' | 'follow';
  fromUser: string;
  /** 发送者主页ID（取不到留空）= 跨类型稳定身份。 */
  fromUserId?: string;
  content: string;
  noteTitle?: string;
  itemKey?: string;
}
