/**
 * Facebook 软阻断 / 限流信号词库（change account-nurture-discipline-spine，§3）。
 *
 * FB 的主力限流不是 URL 跳 /checkpoint，而是 inline 弹窗 / toast：
 * "Action Blocked" / "We limit how often you can do this" / "It looks like you were
 * misusing this feature" / "You can't use this feature right now" 等。边缘把这类阻断遮罩
 * 作为 risk.captcha_detected 上报（kind='unknown' + overlay.text），若云端按既有 'unknown'→light→warned
 * 只降速 ×0.7，不足以让已被限流的号真正刹车。用户定案：**软阻断=激进退避，直接 restricted**。
 *
 * 本模块只做 overlay 文案匹配（纯函数、可单测）；命中 → 云端把风控信号从 light 升级为 confirmed
 * （→restricted）。绝不改协议（复用既有 CaptchaDetectedPayload/overlay.text），迁移仍云端 RiskController
 * 单写、不改状态机迁移表。词库偏 FB 专属文案，小红书 overlay 不会命中 → 小红书零回归。
 */

/** FB 限流/软阻断的判别短语（已归一：小写、直引号、单空格）。命中即视为硬限流信号。 */
export const FB_THROTTLE_PHRASES: readonly string[] = [
  'action blocked',
  'we limit how often you can do this',
  'you are temporarily blocked', // "You're temporarily blocked"（撇号被归一为无）
  'youre temporarily blocked',
  'temporarily blocked',
  'misusing this feature',
  'were misusing this feature',
  'you cant use this feature right now',
  'this feature is not available to you right now',
  'this feature isnt available',
  'you are going too fast',
  'youre going too fast',
  'going too fast',
  'your account is restricted',
  'we restrict certain content and actions',
  'we removed your',
  // 中文 FB 界面变体
  '暂时被限制',
  '操作被封锁',
  '你暂时无法使用',
  '功能暂时不可用',
  '此功能暂时无法使用',
];

/** 归一化：小写、去撇号/智能引号、折叠空白，便于稳定子串匹配。 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * overlay 文案是否命中 FB 软阻断/限流词库。空/undefined → false（诚实：无文案不臆断限流）。
 */
export function isFacebookThrottleText(text?: string | null): boolean {
  if (!text) return false;
  const normalized = normalize(text);
  if (!normalized) return false;
  return FB_THROTTLE_PHRASES.some((phrase) => normalized.includes(phrase));
}
