/**
 * 面板事件单帧的**大小闸**（kernel 纯契约，零 import、零副作用）。
 *
 * ## 为什么必须抬到 kernel
 *
 * 这个上限有**两个**执行点，分属两个服务层：
 *   - 推送端（api·`src/panel/panel-ws.ts`）：广播给浏览器之前；
 *   - 旁路端（automation·`src/transport/eventbus-outbox-bridge.ts`）：tee 写 outbox 之前。
 *
 * 两处若各写一份常量，迟早漂移成「一端截断、另一端照写几十 KB 进库」——而旁路端写的是**共库**的
 * 生产 PostgreSQL，漂移的代价直接落在磁盘上。抬到 kernel 后两层同源引用（任意层 → kernel 恒允许），
 * 改一处即两处齐动。
 *
 * ## 红线
 *
 * 超限 MUST 降级为**带标记的摘要帧**，MUST NOT 静默丢弃：收帧方要能看出「这里原本有内容、只是太大
 * 被截了、原始体积是多少」。丢一条大帧却装作它不存在，就是「静默假成功」。
 */

/** 单帧载荷上限（字节，UTF-8）。超过即降级为摘要帧。 */
export const PANEL_FRAME_MAX_BYTES = 256 * 1024;

/** 降级摘要帧的 data 形状：如实标出「已截断」+ 原始体积。 */
export interface PanelPayloadTruncated {
  truncated: true;
  reason: 'payload_too_large';
  bytes: number;
}

/** 构造降级摘要（两端同一份形状，前端只需认一种 truncated 标记）。 */
export function panelPayloadTruncated(bytes: number): PanelPayloadTruncated {
  return { truncated: true, reason: 'payload_too_large', bytes };
}

/** 统一的字节口径（UTF-8）：两端 MUST 用同一把尺子量，否则阈值形同虚设。 */
export function panelPayloadByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
