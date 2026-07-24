/**
 * 每账号 Facebook 定时评论配置的**纯数据模型类型**（原定义在 src/config/facebook-comment-config-store.ts，automation）。
 * 抬入 kernel（change decouple-longtail-sweep）供 automation 侧评论调度器跨边界共导 EffectiveFacebookCommentConfig。
 * 零 import、零 SQL、零 HTTP、零 LLM、无进程内活状态，满足 §4.7 kernel 准入。
 * SCHEMA_SQL + FacebookCommentConfigStore 类 + 强制/校验函数留 facebook-comment-config-store.ts。
 */

/**
 * 容器（群/主页）配置项（change facebook-container-display-name）。
 * `url` 是功能主键（边缘据此导航 + 建站内搜索链，含群 id）；`name` 是人类可读群名（边缘从群页自动解析回填），
 * 未解析出前为空。
 */
export interface FacebookContainer {
  url: string;
  name?: string;
}

export type FacebookCommentMode = 'generated' | 'template';

/** fail-closed 生效判定：关键词 + 正文模式配置（目标群由 joined ledger 另行选择）。 */
export interface EffectiveFacebookCommentConfig {
  enabled: boolean;
  keywords: string[];
  containers: FacebookContainer[];
  commentMode: FacebookCommentMode;
  commentTemplates: string[];
}
