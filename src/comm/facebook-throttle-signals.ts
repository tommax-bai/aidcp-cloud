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
  // 'we removed your' 已删（change fb-throttle-popup-zh-frequency-copy）：
  // 它此前是**死代码**——边缘判据不含它 ⇒ 边缘不分类就永不上报 ⇒ 云端永远收不到能命中它的文本。
  // 清理时二选一（补齐边缘 / 删除云端），此条选删：措辞过于宽泛，"We removed your post/comment…" 会出现在
  // 通知中心与历史记录里，一条**陈年**内容删除通知就能把账号打进 restricted（钉住恢复窗且不自动回滚、
  // 只能人工恢复）。误报代价不对称 ⇒ 不使其可达。同批的 'we restrict certain content and actions' 反向
  // 处理：特异性足够，已补进边缘判据使其真正可达。
  // 中文 FB 界面变体：「封锁 / 不可用」框架
  '暂时被限制',
  '操作被封锁',
  '你暂时无法使用',
  '功能暂时不可用',
  '此功能暂时无法使用',
  // 中文 FB 界面变体：「频率」框架（change fb-throttle-popup-zh-frequency-copy）。
  // 既有条目全是「封锁 / 不可用」措辞，对真实文案「为让社群免受垃圾信息打扰，我们限制了你发帖、评论或
  // 执行其他操作的频率。你可以稍后再试。」零命中 ⇒ 该弹窗此前对系统全静默（账号已被平台限流，风控态仍
  // 停 normal 继续按原节奏发）。
  // 词条纪律详见边缘 FB_THROTTLE_ZH_FREQUENCY_PHRASES（aidcp-edge/src/facebook/overlay.ts）：只用长专属
  // 句片段、不含标点（转录差异）、不含「社群/社区」（地区差异）、绝不加裸词「限制」/「频率」。
  // **本段三条必须与边缘那份逐条一致**（两仓无共享模块，两侧单测各锁一份集合，任一侧漂移即失败）。
  '我们限制了你发帖',
  '我们限制了您发帖',
  '执行其他操作的频率',
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
