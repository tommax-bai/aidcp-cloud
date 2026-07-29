/**
 * Facebook 发帖素材池的跨域契约段（纯 DTO + 结构化错误识别）。
 *
 * 析出理由：素材池的属主实现 src/publish-agent/facebook-publish-media-store.ts（content）自建 pg 池、
 * 走对象存储、带建表 DDL 字面量，整文件 MUST NOT 进 kernel；但它的读写视图被 api 属主的面板层
 * （src/panel/types.ts 的注入端口 + src/panel/panel-server.ts 的 HTTP 外观）逐字消费，
 * 留在 content 必然造两条 api -> content 跨边界边。
 *
 * 错误识别 MUST 走结构化守卫、MUST NOT 靠 instanceof：拆进程后面板层拿到的是反序列化后的普通对象，
 * `instanceof` 恒 false，会把真实 reason 静默退化成 'unavailable'（400），
 * 把 object_store_unavailable（503）/ status_locked（409）这类原因整片吞掉——正是「MUST NOT 静默假成功」那一类。
 *
 * 零 import、零 SQL、零 HTTP/LLM、零进程内活状态。
 */

export const FACEBOOK_PUBLISH_MEDIA_STATUSES = [
  'available',
  'reserved',
  'used',
  'disabled',
  'deleted',
  'quarantine',
] as const;

export type FacebookPublishMediaStatus = (typeof FACEBOOK_PUBLISH_MEDIA_STATUSES)[number];

export const FACEBOOK_PUBLISH_MEDIA_ERROR_REASONS = [
  'retired_account',
  'account_not_found',
  'non_facebook_account',
  'object_store_unavailable',
  'invalid_file',
  'body_too_large',
  'not_found',
  'status_locked',
  'invalid_value',
] as const;

export type FacebookPublishMediaErrorReason = (typeof FACEBOOK_PUBLISH_MEDIA_ERROR_REASONS)[number];

/**
 * 收窄一个来路不明的 reason。跨进程收到的取值不受本进程枚举约束，
 * 调用方要把它塞回自家闭集合字段时 MUST 先过这一道，认不出来的由调用方显式处置。
 */
export function isFacebookPublishMediaErrorReason(value: unknown): value is FacebookPublishMediaErrorReason {
  return typeof value === 'string'
    && (FACEBOOK_PUBLISH_MEDIA_ERROR_REASONS as readonly string[]).includes(value);
}

/**
 * 属主错误类的 `name` 取值——**跨进程识别键**，属主侧构造时 MUST 逐字写入实例
 * （见 facebook-publish-media-store.ts 的 FacebookPublishMediaError 构造器）。
 * 它必须是实例自有的可枚举属性：Error 子类不显式赋 name 时继承的是 'Error'，JSON 序列化后什么都不剩。
 */
export const FACEBOOK_PUBLISH_MEDIA_ERROR_NAME = 'FacebookPublishMediaError';

/**
 * 线上 `code` 的前缀。完整取值恒为 `facebook_publish_media_<reason>`。
 *
 * 为什么 `name` + `reason` 还不够、非要再有一个 `code`：内部 HTTP 传输把抛出物编码成线格式时
 * **只保 `code` + `message`**（带 string `code` 的按 code 原样透传，否则一律记成 `handler_error`，
 * 见 `src/transport/internal-http.ts` 的 `encodeHandlerError`）。素材池属主一旦拆到另一个进程，
 * 没有 `code` 的抛出物过了那一跳就只剩 `handler_error` —— 面板层看到的不再是
 * `object_store_unavailable`(503) / `status_locked`(409)，而是一坨兜底，
 * 与本文件头点名的那个静默退化一模一样。加前缀是为了不与传输层自己的码撞名。
 */
export const FACEBOOK_PUBLISH_MEDIA_ERROR_CODE_PREFIX = 'facebook_publish_media_';

/** 由 reason 生成线上 code。两侧共用这一个函数，防止各拼各的。 */
export function facebookPublishMediaErrorCode(reason: FacebookPublishMediaErrorReason): string {
  return `${FACEBOOK_PUBLISH_MEDIA_ERROR_CODE_PREFIX}${reason}`;
}

/**
 * 由线上 code 还原 reason；**还原不出来返回 `null`，绝不套默认值**。
 *
 * 传输适配层拿到的是传输层自己的错误对象（`name` / `reason` 都已在那一跳丢掉），MUST 用本函数
 * 还原后重建素材池错误再抛；还原不出来 MUST 显式当成未知处置，MUST NOT 默默套一个 reason ——
 * 那会把「对象存储挂了」说成「你这个文件不合法」。形状逐字照 `content-port-error.ts` 的判例。
 */
export function facebookPublishMediaReasonFromCode(code: unknown): FacebookPublishMediaErrorReason | null {
  if (typeof code !== 'string' || !code.startsWith(FACEBOOK_PUBLISH_MEDIA_ERROR_CODE_PREFIX)) return null;
  const reason = code.slice(FACEBOOK_PUBLISH_MEDIA_ERROR_CODE_PREFIX.length);
  return isFacebookPublishMediaErrorReason(reason) ? reason : null;
}

/** 跨进程边界上素材池错误的最小可识别形状（JSON 往返后仍成立的字段）。 */
export interface FacebookPublishMediaErrorShape {
  name: typeof FACEBOOK_PUBLISH_MEDIA_ERROR_NAME;
  reason: string;
  /**
   * 线上 code（`facebook_publish_media_<reason>`）。守卫**不**看它：过了内部 HTTP 那一跳的对象
   * 只剩 code、`name` 已经没了，认它是**传输适配层**的职责（用上面那个还原函数重建后再抛），
   * 不是守卫的。守卫认的是「还带着 name 的那种对象」——同进程实例与 JSON 往返裸对象。
   */
  code?: string;
  message?: string;
}

/**
 * 结构化识别素材池错误。**同进程实例与跨进程反序列化对象一视同仁**。
 *
 * reason 故意收成 string 而不是 FacebookPublishMediaErrorReason：跨进程来的取值不受本进程枚举约束，
 * 收窄成闭集合会让「没见过的原因」再次退化回兜底文案。未知取值由调用方按默认状态码处置、原样回报。
 */
export function isFacebookPublishMediaError(e: unknown): e is FacebookPublishMediaErrorShape {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as { name?: unknown; reason?: unknown };
  return o.name === FACEBOOK_PUBLISH_MEDIA_ERROR_NAME && typeof o.reason === 'string' && o.reason !== '';
}

export interface FacebookPublishImageInput {
  filename: string;
  contentType?: string | null;
  bytes: Buffer;
  captionHint?: string | null;
}

export interface FacebookPublishImageView {
  id: number;
  setId: number;
  url: string;
  objectKey: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  sortOrder: number;
  duplicateOfImageId: number | null;
  createdAt: string;
}

export interface FacebookPublishImageSetView {
  id: number;
  accountId: string;
  status: FacebookPublishMediaStatus;
  captionHint: string | null;
  sortOrder: number;
  reservedBy: string | null;
  reservedAt: string | null;
  usedByPublishLogId: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  images: FacebookPublishImageView[];
}

export interface FacebookPublishMediaListView {
  accountId: string;
  sets: FacebookPublishImageSetView[];
  statusCounts: Record<FacebookPublishMediaStatus, number>;
}

export type FacebookPublishUploadResult =
  | { ok: true; filename: string; set: FacebookPublishImageSetView; duplicate: boolean }
  | { ok: false; filename: string; reason: FacebookPublishMediaErrorReason; message?: string };

export type FacebookPublishSetPatch =
  | { captionHint?: string | null; status?: Exclude<FacebookPublishMediaStatus, 'reserved' | 'used' | 'quarantine'> };
