/**
 * 评论人审 requestId 的单一构造出口。
 *
 * 为什么必须归一：评论人审 requestId 会被**逐字拼进审批信号落盘路径**
 * `/tmp/aidcp-publish-approve-<requestId>.json`（写侧飞书回调 writeApprovalSignal、
 * 读侧 isPublishApproved→readFile、删侧 voidApprovalSignal 三方共用 getApprovalSignalPath），
 * 并被后台面板 web 审批路由以 `^[A-Za-z0-9_-]+$` 白名单校验（排除 '.' '/' 堵死 '../' 穿越）。
 *
 * Facebook 的 noteId 是**完整帖子 URL**（含 `/ : ? = .`），XHS 的 noteId 是不含分隔符的十六进制。
 * 若把 URL 直接嵌进 requestId，posix.join 会把其中的 `/` 当目录分隔、造出不存在的子目录 →
 * writeFile(flag 'wx') 抛 ENOENT → 飞书回调「处理审批回调失败」；读侧 readFile 恒失败 →
 * isPublishApproved 永远 false → 人已点「同意」仍超时丢评论。故此处把 noteId 归一到受控字符集，
 * 保证 requestId 恒为**文件系统安全 + 无路径穿越 + 通过面板白名单**。
 *
 * 无损于关联：requestId 是**不透明关联令牌**——note 定位始终走独立的 noteId 字段
 * （事件 payload / 边缘命令 params.noteId），全仓无任何代码从 requestId 反解 noteId
 * （唯一的 requestId 解析是 `/^publish-(\d+)$/` 抽 publish recordId）。唯一性由毫秒时间戳保证，
 * 即便两个不同 URL 归一后相同，`-${ts}` 仍区分之。
 */

/** 归一为审批信号路径 / 面板白名单安全的字符集：非 [A-Za-z0-9_-] 的连续片段折叠为单个 '_'。 */
export function sanitizeApprovalRequestSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]+/g, '_');
}

/** 构造评论人审 requestId：`comment-<归一 noteId>-<ts>`。两处生成点（浏览闭环人审闸 / /comment 撰写审批）统一走此出口。 */
export function buildCommentApprovalRequestId(noteId: string, ts: number): string {
  return `comment-${sanitizeApprovalRequestSegment(noteId)}-${ts}`;
}
