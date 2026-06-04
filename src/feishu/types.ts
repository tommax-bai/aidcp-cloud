/**
 * 飞书 Bot 模块的类型定义。
 *
 * 覆盖：交互式卡片结构（FeishuCard）、三类业务卡片的数据模型
 * （DailySummaryData / AlertData / CommandResult）、事件订阅回调
 * （FeishuEvent 及其子类型）。
 *
 * 卡片结构按飞书开放平台 `interactive` 消息规范裁剪，与 product-feishu.md §3 对齐。
 */

/* ------------------------------------------------------------------ */
/* 交互式卡片（飞书 interactive card）                                 */
/* ------------------------------------------------------------------ */

/** 卡片头部模板色（飞书内置枚举的子集，够 MVP 用） */
export type FeishuHeaderTemplate =
  | 'blue'
  | 'wathet'
  | 'turquoise'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'carmine'
  | 'violet'
  | 'purple'
  | 'indigo'
  | 'grey';

/** 文本对象：plain_text 纯文本 / lark_md 富文本 */
export interface FeishuText {
  tag: 'plain_text' | 'lark_md';
  content: string;
}

/** div 元素里的字段（支持双列短排版） */
export interface FeishuField {
  is_short: boolean;
  text: FeishuText;
}

/** 按钮：可携带 value（回调载体）或 url（跳转逃生口） */
export interface FeishuButton {
  tag: 'button';
  text: FeishuText;
  type?: 'default' | 'primary' | 'danger';
  /** 回调时由飞书原样回传，用于云端识别意图 */
  value?: Record<string, unknown>;
  /** 新版交互行为定义 */
  behaviors?: Array<{
    type: 'callback';
    value: Record<string, unknown>;
  }>;
  /** 跳转链接（引导回 Web） */
  url?: string;
}

/** 卡片元素（MVP 仅用到 div / hr / action / img） */
export type FeishuElement =
  | { tag: 'div'; text?: FeishuText; fields?: FeishuField[] }
  | { tag: 'hr' }
  | { tag: 'action'; actions: FeishuButton[] }
  | { tag: 'img'; img_key: string; alt: FeishuText };

/** 卡片头部 */
export interface FeishuHeader {
  template?: FeishuHeaderTemplate;
  title: FeishuText;
}

/** 完整的飞书交互式卡片 */
export interface FeishuCard {
  config?: { wide_screen_mode?: boolean };
  header?: FeishuHeader;
  elements: FeishuElement[];
}

/* ------------------------------------------------------------------ */
/* 业务数据模型                                                        */
/* ------------------------------------------------------------------ */

/** 账号风控状态（与 risk-control.md §7 / product-dashboard.md §2.1 枚举对齐） */
export type AccountStatus = 'normal' | 'warned' | 'restricted' | 'banned';

/** 异常严重度（与 product-exception.md §1 对齐） */
export type AlertSeverity = 'P0' | 'P1' | 'P2' | 'P3';

/** 每日汇总卡片数据（对应 product-feishu.md §2.1 / §3 每日汇总卡片） */
export interface DailySummaryData {
  /** 汇总日期，如 2026-05-30 */
  date: string;
  /** 在线账号数 */
  onlineAccounts: number;
  /** 账号总数 */
  totalAccounts: number;
  /** 总浏览数 */
  totalViews: number;
  /** 点赞率（0~1） */
  likeRate: number;
  /** 点赞率是否健康（risk-control.md §1.1） */
  likeRateHealthy: boolean;
  /** 今日发布数 */
  publishCount: number;
  /** 涨粉数 */
  newFollowers?: number;
  /** 各状态账号数量分布 */
  statusBreakdown: Partial<Record<AccountStatus, number>>;
  /** 查看大盘的链接 */
  dashboardUrl?: string;
}

/** 告警卡片数据（对应 product-feishu.md §2.4 实时通知） */
export interface AlertData {
  severity: AlertSeverity;
  /** 告警标题，如 "验证码弹出" */
  title: string;
  /** 涉及账号 id */
  accountId?: string;
  /** 账号展示名 */
  accountName?: string;
  /** 详细描述（lark_md） */
  detail: string;
  /** 引导动作按钮文案，默认"去处理" */
  actionText?: string;
  /** 引导动作链接（去 Web） */
  actionUrl?: string;
}

/** 指令回执卡片数据（对应 product-feishu.md §2.2 指令回执） */
export interface CommandResult {
  /** 原始指令文本，如 "/pause acc-01" */
  command: string;
  /** 执行是否成功 */
  ok: boolean;
  /** 回执标题 */
  title: string;
  /** 回执正文（lark_md） */
  message: string;
  /** 相关账号 id */
  accountId?: string;
}

export interface PublishApprovalPayload {
  title: string;
  content: string;
  tags: string[];
}

export interface PublishApprovalCardData extends PublishApprovalPayload {
  requestId: string;
}

/* ------------------------------------------------------------------ */
/* 事件订阅回调（飞书 → 云端）                                          */
/* ------------------------------------------------------------------ */

/** URL 验证（飞书首次配置事件订阅地址时发送 challenge） */
export interface FeishuChallengeEvent {
  type: 'url_verification';
  challenge: string;
  token?: string;
}

/** 事件头部（schema 2.0） */
export interface FeishuEventHeader {
  event_id: string;
  event_type: string;
  token?: string;
  app_id?: string;
  tenant_key?: string;
  create_time?: string;
}

/** 消息接收事件 im.message.receive_v1 */
export interface FeishuMessageReceiveEvent {
  schema: '2.0';
  header: FeishuEventHeader & { event_type: 'im.message.receive_v1' };
  event: {
    sender: {
      sender_id?: { open_id?: string; user_id?: string; union_id?: string };
      sender_type?: string;
    };
    message: {
      message_id: string;
      chat_id: string;
      chat_type?: string;
      message_type: string;
      /** JSON 字符串，文本消息形如 {"text":"..."} */
      content: string;
      mentions?: { key: string; id?: { open_id?: string } }[];
    };
  };
}

/** 卡片回调动作（按钮点击） */
export interface FeishuCardActionEvent {
  schema: '2.0';
  header: FeishuEventHeader & { event_type: 'card.action.trigger' };
  event: {
    operator?: { open_id?: string; union_id?: string };
    token?: string;
    action: {
      tag: string;
      /** 按钮上 value 携带的业务载荷 */
      value?: Record<string, unknown>;
    };
    /** 卡片所在的会话上下文 */
    context?: { open_chat_id?: string; open_message_id?: string };
  };
}

export interface FeishuBotAddedEvent {
  schema: '2.0';
  header: FeishuEventHeader & { event_type: 'im.chat.member.bot.added_v1' };
  event: {
    chat_id?: string;
    name?: string;
    i18n_names?: {
      zh_cn?: string;
      en_us?: string;
      ja_jp?: string;
    };
  };
}

export interface FeishuBotDeletedEvent {
  schema: '2.0';
  header: FeishuEventHeader & { event_type: 'im.chat.member.bot.deleted_v1' };
  event: {
    chat_id?: string;
    name?: string;
    i18n_names?: {
      zh_cn?: string;
      en_us?: string;
      ja_jp?: string;
    };
  };
}

/** 兜底通用事件（其它未细化的 event_type） */
export interface FeishuGenericEvent {
  schema: '2.0';
  header: FeishuEventHeader;
  event: Record<string, unknown>;
}

/** 飞书回调的联合类型 */
export type FeishuEvent =
  | FeishuChallengeEvent
  | FeishuMessageReceiveEvent
  | FeishuCardActionEvent
  | FeishuBotAddedEvent
  | FeishuBotDeletedEvent
  | FeishuGenericEvent;
