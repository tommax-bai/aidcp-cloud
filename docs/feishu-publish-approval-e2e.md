# 飞书审批卡片真发联调

## 目标

让 cloud 与 edge 使用同一个 `AIDCP_PUBLISH_APPROVAL_REQUEST_ID`，确保飞书审批卡片回调写出的信号文件与 edge 轮询读取的文件完全一致。

## 两端契约

- 信号文件路径：`/tmp/aidcp-publish-approve-<requestId>.json`
- 信号文件结构：

```json
{
  "requestId": "<requestId>",
  "approved": true,
  "ts": 1717400000000,
  "payload": {
    "title": "标题",
    "content": "正文",
    "tags": ["标签1", "标签2"]
  }
}
```

- cloud 卡片回调：
  - 点击“授权发布”写入 `approved: true`
  - 点击“取消”写入 `approved: false`
- edge 轮询要求：
  - 文件名中的 `<requestId>` 与 JSON 内 requestId 必须都等于 edge 当前使用的 requestId
  - `payload` 必须包含 `title`、`content`、`tags`

## 推荐联调方式

先手工固定一个 requestId，例如：

```bash
export AIDCP_PUBLISH_APPROVAL_REQUEST_ID=req-e2e-001
```

cloud 与 edge 都使用同一个值。cloud 的 `/publish-test`（`resolvePublishApprovalRequestId`）按以下优先级确定 requestId：

1. 优先使用命令里显式传参：`/publish-test req-e2e-001`
2. 其次读取环境变量 `AIDCP_PUBLISH_APPROVAL_REQUEST_ID`
3. 两者都未提供时，cloud 才会自动生成 requestId

## 启动 cloud

`cloud` 部署在 ECS（`/opt/aidcp/cloud`，systemd 服务 `aidcp-cloud.service`），通常已在运行，**不在本地启动**。若需让新代码生效或刷新环境变量，在 ECS 上重启即可：

```bash
systemctl restart aidcp-cloud
```

确保飞书长连接已建立，并且 bot 能收到群消息。联调用的 requestId 推荐直接在 `/publish-test` 命令里显式传参（见上文优先级），无需为 cloud 单独设置环境变量。

## 启动 edge

在 edge 仓库根目录（`aidcp-edge`）：

```bash
export AIDCP_PUBLISH_APPROVAL_REQUEST_ID=req-e2e-001
export AIDCP_REAL_PUBLISH=true
export AIDCP_PUBLISH_APPROVAL_TIMEOUT_MS=300000
npm start
```

说明：

- `AIDCP_REAL_PUBLISH=true` 才会在发布前进入审批轮询
- 未设置 `AIDCP_PUBLISH_APPROVAL_REQUEST_ID` 时，edge 会自动生成 requestId，不适合双端真发联调

## 发送飞书审批卡片

在飞书群里发送以下任一命令：

```text
/publish-test
```

或显式指定 requestId：

```text
/publish-test req-e2e-001
```

推荐联调时显式带 requestId，便于肉眼核对。

## 预期流程

1. cloud 收到 `/publish-test`
2. cloud 发送“待授权发布”卡片，卡片内携带 requestId
3. edge 在真发模式下轮询 `/tmp/aidcp-publish-approve-req-e2e-001.json`
4. 在飞书点击“授权发布”
5. cloud 收到 `card.action.trigger`，写入信号文件
6. edge 读到 `approved: true` 后继续点击 Shadow DOM 发布按钮
7. 若点击“取消”，edge 会收到 `approval_rejected`

## 常见失败排查

### 1. requestId 不匹配

现象：

- edge 最终超时，或报 `signal_request_id_mismatch:*`
- 飞书卡片显示的 requestId 与 edge 日志里的 requestId 不一致

排查：

- 检查 cloud/edge 两端的 `AIDCP_PUBLISH_APPROVAL_REQUEST_ID`
- 若飞书命令显式传了 requestId，确认它与 edge 环境变量一致
- 检查信号文件名是否为 `/tmp/aidcp-publish-approve-<requestId>.json`

### 2. 超时

现象：

- edge 返回 `approval_timeout`

排查：

- 是否真的点击了飞书卡片按钮
- cloud 是否收到 `card.action.trigger`
- `AIDCP_PUBLISH_APPROVAL_TIMEOUT_MS` 是否过短
- `/tmp` 下是否生成了对应 requestId 的信号文件

### 3. 信号文件未生成

现象：

- `/tmp/aidcp-publish-approve-<requestId>.json` 不存在

排查：

- cloud 进程是否正常运行
- 飞书卡片回调权限/订阅是否正常
- cloud 日志中是否有“处理卡片回调失败”
- 卡片按钮是否来自最新发送的审批卡片

### 4. 文件生成了但 edge 仍失败

排查：

- 打开文件确认 JSON 中 `requestId` 与文件名 requestId 完全一致
- 确认 `approved` 是布尔值，不是字符串
- 确认 `payload.tags` 是数组
- 若 edge 配置了消费信号，成功读取后文件会被删除，属正常现象

## 部署与重启提醒

- 本次修复属于代码变更，部署后必须重启对应进程才能生效，不会热加载。
- `cloud` 对应提交：`18c6f2b`。
- 本次修复点：`src/feishu/ws-receiver.ts` 中飞书审批卡回调已改为按 `card.action.trigger` 规范返回 `card: { type: raw, data: ... }` 包装，用于修复 `200672`。
- 重启对象：`cloud` 进程部署在 ECS（`/opt/aidcp/cloud`），主监听端口为 `8787`（edge↔cloud WebSocket）；`8788` 仅为可选调试端口（`AIDCP_DEBUG_PORT`），主服务并不依赖它。启动入口为 `src/server.ts`。
- 重启方式：在 ECS 上执行 `systemctl restart aidcp-cloud`（systemd 服务 `aidcp-cloud.service`）；切勿在本地运行 cloud。
- 数据库连接：`cloud` 与 PostgreSQL 同机部署（`127.0.0.1:5432`），**直连即可，无需任何 SSH 隧道**。
- 验证修复前，务必确认当前运行中的 `cloud` 进程是在部署 `18c6f2b` 之后重启拉起的。