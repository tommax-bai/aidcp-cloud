/**
 * 人设绑定三态契约（从 src/config/persona-store.ts 抬入 kernel）。
 *
 * 纯类型，零 import、无 SQL、无 HTTP、无进程内活状态。被 automation/api 多边 type-only 共导
 * （role-dispatcher / ui-snapshot / comment-scheduler / publish-scheduler / account-persona-service）。
 * 「未知≠否」不变量的类型载体，见 change persona-bound-tristate。
 */
export type PersonaBinding = 'bound' | 'unbound' | 'unknown';
