/**
 * 评论人审 requestId 的单一构造出口。
 *
 * 为什么必须归一（理由由 change publish-approval-signal-to-database 重述，结论不变）：
 * requestId 现在是**持久授权记录的主键**与**面板审批接口的 URL 路径段**，被后台 web 审批路由以
 * `^[A-Za-z0-9_-]+$` 白名单校验。它不再参与任何文件落盘路径拼接，但仍必须保持受控字符集，
 * 把标识符与路径段的注入面收敛为零。
 *
 * 历史事故（保留作教训）：Facebook 的 noteId 是**完整帖子 URL**（含 `/ : ? = .`），当授权还落在
 * `/tmp/aidcp-publish-approve-<requestId>.json` 时，直接嵌 URL 会让 `posix.join` 把 `/` 当目录分隔 →
 * 写入抛 ENOENT → 读侧恒 false → 人已点「同意」仍超时丢评论。这类「路径拼接」失效面已随授权迁库消失，
 * 但归一仍是必需的输入约束。
 *
 * 无损于关联：requestId 是**不透明关联令牌**——note 定位始终走独立的 noteId 字段
 * （事件 payload / 边缘命令 params.noteId），全仓无任何代码从 requestId 反解 noteId
 * （唯一的 requestId 解析是 `/^publish-(\d+)$/` 抽 publish recordId）。唯一性由毫秒时间戳保证，
 * 即便两个不同 URL 归一后相同，`-${ts}` 仍区分之。
 */

/** 归一为记录主键 / 面板路径段安全的字符集：非 [A-Za-z0-9_-] 的连续片段折叠为单个 '_'。 */
export function sanitizeApprovalRequestSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]+/g, '_');
}

/** 构造评论人审 requestId：`comment-<归一 noteId>-<ts>`。两处生成点（浏览闭环人审闸 / /comment 撰写审批）统一走此出口。 */
export function buildCommentApprovalRequestId(noteId: string, ts: number): string {
  return `comment-${sanitizeApprovalRequestSegment(noteId)}-${ts}`;
}
