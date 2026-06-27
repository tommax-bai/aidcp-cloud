# 机器人主动问审批发布闭环方案（aidcp-cloud / aidcp-edge）

> ✅ **已实现（as-built 记录）**：本文最初为“方案”，其描述的 `publish.approval_request` 主动审批闭环**已在 cloud 与 edge 落地**（cloud `src/comm/handler.ts` `onPublishApprovalRequest`、protocol `PublishApprovalRequestPayload`；edge `src/main.ts` 在发布前发送 `publish.approval_request`）。请按“实现记录”阅读；审批标识统一为 `requestId`（非 token）。

## 文档目标

在 **aidcp-cloud** 与 **aidcp-edge** 两仓内，基于现有飞书审批卡片、信号文件、发布前审批门禁、以及既有 edge↔cloud WebSocket 协议，设计一套“**edge 主动发审批请求 → cloud 主动推卡 → 用户授权/取消 → edge 轮询信号 → 真发 → 回传结果**”的正式发布授权闭环，替代当前“用户手动敲 `/publish-test` 才发卡”的反向触发逻辑。

> ⚠️ **历史前提已失效**：本文写作时定位为“只出方案，不改业务代码、不真发”；该前提现已不成立——下述闭环**已在 cloud 与 edge 实现并合入**。以下保留原设计推理，并在关键处用“✅ 已落地”标注对应的真实符号与文件。

---

## 1. 现状与可复用资产

### 1.1 cloud 侧已具备能力

#### 飞书审批卡片构造
- 文件：**aidcp-cloud/src/feishu/cards.ts**
- 现有函数：`buildPublishApprovalCard(...)`
- 已具备：
  - 卡片展示 `title / content / tags`
  - 按钮使用 `behaviors: [{ type: 'callback', value: ... }]`
  - callback value 已携带 `requestId + payload(title/content/tags)`

#### 飞书消息发送
- 文件：**aidcp-cloud/src/feishu/messenger.ts**
- 现有函数：`sendApprovalCard(chatId, card)`
- 可直接复用为主动审批流的发卡出口

#### 飞书卡片回调接收与写信号文件
- 文件：**aidcp-cloud/src/feishu/ws-receiver.ts**
- 已具备：
  - 注册 `card.action.trigger`
  - 解析 `approve / cancel + requestId + payload`
  - 写入 `/tmp/aidcp-publish-approve-<requestId>.json`
  - `approve` 写 `approved: true`
  - `cancel` 写 `approved: false`

#### 手动联调入口
- 文件：**aidcp-cloud/src/feishu/commands.ts**
- 现有命令：`/publish-test`
- 当前作用：手动发送审批卡片
- 结论：**保留作为后备入口，不移除**

### 1.2 edge 侧已具备能力

#### 审批门禁轮询
- 文件：**aidcp-edge/src/publish/approval-gate.ts**
- 现有函数：`waitForPublishApproval(...)`
- 已具备：
  - 轮询 `/tmp/aidcp-publish-approve-<requestId>.json`
  - 校验 `requestId / approved / ts / payload`
  - 支持 `approved=true / approved=false / timeout`
  - 支持消费信号文件

#### 真实发布流程
- 文件：**aidcp-edge/src/flows/publish-post.ts**
- 现状：
  - 已在 `submit_publish` 前调用 `waitForPublishApproval(...)`
  - 审批通过后才会继续点击 Shadow DOM 发布按钮
  - 审批拒绝或超时会直接返回失败

#### 主入口接线
- 文件：**aidcp-edge/src/main.ts**
- 现状：
  - 收到 `publish.request`
  - 生成或读取 requestId（`buildPublishApprovalRequestId()`）
  - 调用 `publishPost(..., approvalGate)`
  - 最终回 `publish.result`

### 1.3 双端协议现状

#### cloud 协议文件
- **aidcp-cloud/src/comm/protocol.ts**

#### edge 协议文件
- **aidcp-edge/src/comm/protocol.ts**

#### 当前已有发布相关消息
- `publish.request`：cloud → edge
- `publish.result`：edge → cloud

#### 原缺口（已补齐）
- 写作时：**没有 edge → cloud 的“审批请求”消息**，cloud 无法在 edge 真发前被主动通知去发审批卡
- ✅ **已落地**：双端协议已新增 `publish.approval_request`（edge → cloud），payload 为 `PublishApprovalRequestPayload { requestId, title, content, tags, edgeId? }`（cloud `src/comm/protocol.ts`、edge `src/comm/protocol.ts`）；edge `src/main.ts` 在发布前发送该消息，cloud `src/comm/handler.ts` 的 `onPublishApprovalRequest` 接收并发卡。

---

## 2. 推荐总体设计

### 2.1 推荐结论

采用 **“edge 生成 requestId，并通过新消息 `publish.approval_request` 主动上送 cloud”** 的方案。（✅ 已按此结论落地）

### 2.2 推荐原因

#### 原因一：彻底消除 requestId 对齐问题
当前 `/publish-test` 仍依赖环境变量或显式参数对齐 requestId。改为 edge 生成后直接随协议上传，cloud 发卡与 edge 轮询天然使用同一 requestId，不再需要人工对齐。

#### 原因二：职责边界更清晰
edge 是真实执行发布的一方，最清楚本次发布上下文与 requestId；cloud 负责通知与审批编排，不负责猜测 requestId。

#### 原因三：最小改动复用现有资产
- cloud 继续复用：
  - **aidcp-cloud/src/feishu/cards.ts** 的 `buildPublishApprovalCard(...)`
  - **aidcp-cloud/src/feishu/messenger.ts** 的 `sendApprovalCard(...)`
  - **aidcp-cloud/src/feishu/ws-receiver.ts** 的 `card.action.trigger → 写信号文件`
- edge 继续复用：
  - **aidcp-edge/src/publish/approval-gate.ts** 的 `waitForPublishApproval(...)`
  - **aidcp-edge/src/flows/publish-post.ts** 的 Shadow DOM 真发逻辑

#### 原因四：与现有 `publish.request/result` 关系自然
- `publish.request/result` 继续承担“正式发布任务下发 / 结果回传”
- `publish.approval_request` 只承担“审批通知触发”
- 三者并列，语义清晰，不污染已有发布任务契约

### 2.3 不推荐方案

#### 方案 A：cloud 生成 requestId，再回传给 edge
不推荐原因：
- 会引入额外往返或状态同步
- edge 在进入审批门禁前还要等待 cloud 分配 requestId
- 与“执行方掌握执行上下文”的职责边界相反

#### 方案 B：继续复用 `/publish-test` 逻辑，由 cloud 在收到 `publish.request` 后自行生成 requestId 发卡
不推荐原因：
- requestId 仍存在双端对齐风险
- `publish.request` 语义已是“请求执行发布”，再塞审批触发会让消息职责混杂
- 不利于后续扩展卡片状态回写与审批审计

---

## 3. 新协议消息定义

### 3.1 新增消息名

在以下两个文件同步新增：
- **aidcp-cloud/src/comm/protocol.ts**
- **aidcp-edge/src/comm/protocol.ts**

新增消息：
- `publish.approval_request`：**edge → cloud**，请求 cloud 主动发送飞书审批卡片

> ✅ **已落地**：该消息已加入双端 `MessageType`/`PayloadMap`（cloud `src/comm/protocol.ts`、edge `src/comm/protocol.ts`），与 `publish.request` / `publish.result` 并列。

### 3.2 payload 契约（as-built）

> ✅ **已落地**：实际落地的类型见 cloud `src/comm/protocol.ts` `PublishApprovalRequestPayload`（edge 同名类型镜像）。最终未引入提案中的 `chatId` / `timeoutMs` 字段（chatId 改由 cloud 侧解析，见 §5.3），`requestId` 也由“可选”收敛为**必填**主标识。

```ts
export interface PublishApprovalRequestPayload {
  /** 单次发布请求唯一标识 */
  requestId: string;
  /** 帖子标题（小红书标题） */
  title: string;
  /** 正文（200-500 字） */
  content: string;
  /** 话题标签（3-5 个） */
  tags: string[];
  /** 可选边缘节点标识（观测用） */
  edgeId?: string;
}
```

### 3.3 字段说明

- `requestId`：**必填**，由 edge 生成（`buildPublishApprovalRequestId()`），cloud 发卡与回调写信号时原样透传，是审批全链路唯一主标识
- `title / content / tags`：**必填**，用于构造审批卡片内容
- `edgeId`：可选，便于 cloud 记录来源边缘节点（观测用）
- ~~`chatId` / `timeoutMs`~~：**提案中曾考虑、最终未纳入 as-built 类型**。目标群由 cloud 侧解析（§5.3）；超时由 edge 轮询门禁控制，不进协议

### 3.4 在 `MessageType` 与 `PayloadMap` 中的位置

建议放在现有发布编排消息旁边：
- `publish.approval_request`
- `publish.request`
- `publish.result`

具体建议：
- 在 `MessageType` 中，插入到 `publish.request` 前
- 在 `PayloadMap` 中，插入到 `'publish.request'` 前

### 3.5 与现有 `publish.request/result` 的关系

推荐：**并列，不复用**。

#### 语义划分
- `publish.request`：表示“请 edge 执行这次发布任务”
- `publish.approval_request`：表示“请 cloud 为这次任务发审批卡”
- `publish.result`：表示“这次任务最终执行结果”

#### 推荐链路
1. cloud 生成发布内容
2. cloud → edge：`publish.request`
3. edge 生成 requestId
4. edge → cloud：`publish.approval_request`
5. cloud 发飞书审批卡
6. 用户点击授权/取消
7. cloud 写 `/tmp/aidcp-publish-approve-<requestId>.json`
8. edge `waitForPublishApproval(...)`
9. 若 approved=true，则 edge 真点发布按钮
10. edge → cloud：`publish.result`

---

## 4. requestId 生成策略评估与推荐

### 4.1 推荐方案

**requestId 由 edge 生成并随 `publish.approval_request` 上传。**（✅ 已按此落地：edge `src/main.ts` 调用 `buildPublishApprovalRequestId()` 后随消息上送）

### 4.2 具体策略

edge 在收到 `publish.request` 后、进入 `publishPost(...)` 前生成 requestId；该 requestId 同时用于：
1. `publish.approval_request.payload.requestId`
2. `waitForPublishApproval({ requestId })`
3. 飞书卡片 callback value 中的 `requestId`
4. `/tmp/aidcp-publish-approve-<requestId>.json`

### 4.3 推荐保留的兼容逻辑

- **aidcp-cloud/src/feishu/commands.ts** 中 `/publish-test` 仍保留 `resolvePublishApprovalRequestId(...)` 逻辑，作为手动联调后备（优先级：显式命令参数 → 环境变量 `AIDCP_PUBLISH_APPROVAL_REQUEST_ID` → 自动生成）
- 但正式主动审批流不再依赖环境变量对齐

### 4.4 与其它方案对比

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| edge 生成 requestId | 单一来源、无对齐问题、最贴近执行方 | cloud 需信任 edge 传入 requestId | 推荐（✅ 已落地） |
| cloud 生成 requestId | cloud 可统一管理 | 需额外回传/同步，流程更绕 | 不推荐 |
| 环境变量/手工指定 | 联调简单 | 正式流脆弱、易错 | 仅保留作后备 |

---

## 5. cloud 端接线方案

### 5.1 接收 `publish.approval_request`

#### 目标位置（as-built）
- **aidcp-cloud/src/comm/handler.ts**：消息分支 `case 'publish.approval_request'` → `onPublishApprovalRequest(env, session)`
- **aidcp-cloud/src/comm/protocol.ts**：`PublishApprovalRequestPayload` 类型 + `MessageType`/`PayloadMap` 已新增

> ✅ **已落地**：cloud WebSocket 业务 handler 已识别并处理该消息，无需再额外接线。

### 5.2 收到后调用 `sendApprovalCard(...)`

> ✅ **已落地**：实际未拆出独立 service，而是作为 handler 方法 `onPublishApprovalRequest(env, session)` 实现于 **aidcp-cloud/src/comm/handler.ts**，在消息分支 `case 'publish.approval_request'` 中调用。

职责（as-built）：
1. 校验 payload（`requestId / title / content / tags`，缺失抛 `invalid_publish_approval_request`）
2. 解析目标 `chatId`（见 §5.3）
3. 调用：
   - `buildPublishApprovalCard({ requestId, title, content, tags })`
   - `messenger.sendApprovalCard(chatId, card)`
4. 第二阶段可选：记录 `requestId → card/message 上下文` 映射，供卡片状态更新使用

### 5.3 chatId 来源（as-built）

> ✅ **已落地**：`onPublishApprovalRequest` 在 cloud 侧解析目标群，**不**从 payload 取 chatId。实际解析优先级（**aidcp-cloud/src/comm/handler.ts**）：
> 1. 由 `/bind` 设定的默认审批群：`botChatStore.getDefaultChat()` 返回的 `chatId`
> 2. 注入的全局 `approvalChatId`
> 3. 环境变量 `FEISHU_CHAT_ID`（兜底）
>
> 三者皆空时抛错并提示“请先在目标飞书群发送 `/bind` 设为默认审批群，或配置 `FEISHU_CHAT_ID`”。因此提案里的 `payload.chatId` 路由未落地（见 §3.3）。

### 5.4 卡片 payload 如何带 requestId

无需重做，直接复用现有实现：
- **aidcp-cloud/src/feishu/cards.ts**
  - `buildPublishApprovalCard(...)` 已将 `requestId` 放入 callback value
- **aidcp-cloud/src/feishu/ws-receiver.ts**
  - `parseApprovalActionValue(...)` 已能解析 `action + requestId + payload`
  - `handleCardAction(...)` 已能写信号文件

### 5.5 cloud 侧改动文件清单

#### 第一阶段必改
- **aidcp-cloud/src/comm/protocol.ts**
  - 新增 `publish.approval_request` 与 payload 类型
- **aidcp-cloud/src/comm/** 下实际业务 handler 文件
  - 新增对 `publish.approval_request` 的路由处理
- **aidcp-cloud/docs/feishu-publish-approval-e2e.md**
  - 更新为“主动审批流”联调文档

#### 第一阶段大概率复用、不必改动主体逻辑
- **aidcp-cloud/src/feishu/cards.ts**
- **aidcp-cloud/src/feishu/messenger.ts**
- **aidcp-cloud/src/feishu/ws-receiver.ts**

#### 第二阶段可改
- **aidcp-cloud/src/feishu/ws-receiver.ts**
  - 扩展卡片状态更新回调返回
- **aidcp-cloud/src/feishu/messenger.ts**
  - 若飞书更新卡片需要额外 API，可在此扩展
- **aidcp-cloud/src/feishu/types.ts**
  - 增补卡片更新相关类型

---

## 6. edge 端接线方案

### 6.1 在真发流程中主动发出 `publish.approval_request`

#### 推荐主接线点
- **aidcp-edge/src/main.ts**

原流程：
1. 收到 `publish.request`
2. 生成 requestId
3. 调用 `publishPost(..., approvalGate)`
4. 完成后回 `publish.result`

as-built 流程（✅ 已落地于 **aidcp-edge/src/main.ts**）：
1. 收到 `publish.request`
2. 生成 requestId（`buildPublishApprovalRequestId()`）
3. **先 `client.send('publish.approval_request', { requestId, title, content, tags, edgeId })` 到 cloud**
4. 再调用 `publishPost(..., approvalGate)` 进入轮询
5. 轮询通过后继续 Shadow DOM 真发
6. 最终回 `publish.result`

### 6.2 为什么放在 `main.ts` 而不是 `publish-post.ts`

- **aidcp-edge/src/flows/publish-post.ts** 当前职责是浏览器内发布动作编排
- `publish.approval_request` 属于跨端通信编排，更适合留在 **aidcp-edge/src/main.ts** 的消息收发层
- 这样 `publishPost(...)` 仍保持“给定 payload + approvalGate 就执行”的纯业务职责

### 6.3 `publishPost(...)` 与已有审批门禁的衔接

无需推翻现有逻辑：
- **aidcp-edge/src/flows/publish-post.ts** 继续在 `submit_publish` 前调用 `waitForPublishApproval(...)`
- 唯一变化是：进入 `waitForPublishApproval(...)` 之前，cloud 已经因为 `publish.approval_request` 发出了卡片

### 6.4 是否需要 edge 等待 cloud 对审批请求 ACK

#### 第一阶段建议：不引入强 ACK
- edge 发出 `publish.approval_request` 后直接进入 `waitForPublishApproval(...)`
- 若 cloud 发卡失败，edge 最终会走 `approval_timeout`
- cloud 侧应记录日志，便于排查

#### 第二阶段增强
可新增：
- `publish.approval_request` 的同步响应或 `publish.approval_result`
- 用于明确区分“发卡失败”与“用户未审批”

第一阶段不建议引入，避免协议复杂化。

### 6.5 edge 侧改动文件清单

#### 第一阶段必改
- **aidcp-edge/src/comm/protocol.ts**
  - 新增 `publish.approval_request` 与 payload 类型
- **aidcp-edge/src/main.ts**
  - 在收到 `publish.request` 后发送 `publish.approval_request`

#### 第一阶段通常只需类型补齐，不一定要改逻辑
- **aidcp-edge/src/client/edge-client.ts**
  - 若 `send(...)` 已支持任意消息类型，则通常无需改逻辑，仅补类型即可
- **aidcp-edge/src/flows/publish-post.ts**
  - 原则上无需结构性改动，仅保持 approvalGate 现有位置

#### 第二阶段可改
- **aidcp-edge/src/main.ts**
  - 在 `publish.result` 后追加卡片状态回写触发
- **aidcp-edge/src/flows/publish-post.ts**
  - 若要细分失败原因，可补充更结构化错误码

---

## 7. 卡片状态回写方案

### 7.1 已确认策略

- **第一阶段：不做卡片状态更新，只保留按钮点击 toast + 信号文件写入**
- **第二阶段：补卡片状态更新**

### 7.2 最小可行方案（第一阶段）

#### 行为
- 用户点击“授权发布”
  - 飞书 toast：`已授权发布`
  - cloud 写 `approved: true`
  - edge 继续发布
- 用户点击“取消”
  - 飞书 toast：`已取消发布`
  - cloud 写 `approved: false`
  - edge 返回失败：`approval_gate` 返回 `reason: 'approval_rejected'`（结果对象携带 `requestId`）
- 卡片本身不更新

#### 优点
- 完全复用 **aidcp-cloud/src/feishu/ws-receiver.ts**
- 不需要额外保存 `message_id / open_message_id / card token` 映射
- 风险最低

### 7.3 完整方案（第二阶段）

#### 推荐状态机
- `待授权`
- `已授权，等待发布`
- `已取消`
- `已发布`
- `发布失败`
- `审批超时`

#### 第二阶段所需最小新增能力
1. cloud 在发卡成功时保存：
   - `requestId`
   - `chatId`
   - `messageId` 或飞书可更新卡片所需上下文（即下文的 card token）
2. cloud 在收到：
   - `card.action.trigger`
   - `publish.result`
   - 超时事件
   时，按 requestId 查上下文并更新卡片

#### 推荐实现方式
- 第一版先做内存态映射：`Map<requestId, CardContext>`
- 若后续要求进程重启可恢复，再升级到持久化存储

---

## 8. 取消 / 超时 / 异常路径设计

### 8.1 用户点取消

#### 现有可复用行为
- cloud：写 `/tmp/aidcp-publish-approve-<requestId>.json`，内容 `approved:false`
- edge：`waitForPublishApproval(...)` 返回 `approval_rejected`
- `publishPost(...)` 返回：
  - `ok: false`
  - `error`：`approval_rejected`（结果对象携带 `requestId`）

#### 推荐处理
- cloud：记录 info 日志
- edge：回 `publish.result`，标记失败但原因明确为 `approval_rejected`
- 第二阶段：卡片更新为“已取消”

### 8.2 用户长时间不点

#### 第一阶段
- edge 轮询超时后返回：`approval_timeout`
- cloud 不主动补写信号文件
- `publish.result` 回传失败

#### 第二阶段增强
- cloud 可在发卡时登记超时任务
- 若在超时时间内未收到 approve/cancel，则更新卡片为“审批超时”

### 8.3 edge 发布失败

#### 场景
- 已授权，但 Shadow DOM 点击失败
- 页面校验失败
- 缺少 `postId`

#### 推荐处理
- edge 继续沿用现有 `publish.result.ok=false + error` 回传
- cloud 记录失败结果
- 第二阶段：卡片更新为“发布失败”，并展示简短错误摘要

### 8.4 cloud 发卡失败

#### 第一阶段
- cloud handler 返回错误日志或错误响应
- edge 不等待 ACK，最终表现为 `approval_timeout`

#### 风险说明
- 用户侧感知会偏弱，因为看不到卡片

#### 第二阶段增强
- 为 `publish.approval_request` 增加显式响应，区分：
  - `approval_card_sent`
  - `approval_card_send_failed`

---

## 9. 分阶段实现计划

### Phase 1：打通主动审批最小闭环

> ✅ **已落地**：Phase 1 闭环已在双端实现并合入——edge `src/main.ts` 发布前发送 `publish.approval_request`，cloud `src/comm/handler.ts` `onPublishApprovalRequest` 接收并发卡，`requestId` 全链路一致。以下变更范围/验收标准作为实现记录保留。

#### 目标
让 edge 在收到 `publish.request` 后，主动通知 cloud 发审批卡；用户授权后 edge 能继续真发；取消/超时能正确失败返回。

#### 变更范围

##### cloud
- **aidcp-cloud/src/comm/protocol.ts**
- **aidcp-cloud/src/comm/** 下实际业务 handler 文件
- **aidcp-cloud/docs/feishu-publish-approval-e2e.md**

##### edge
- **aidcp-edge/src/comm/protocol.ts**
- **aidcp-edge/src/main.ts**

#### 验收标准
- edge 收到 `publish.request` 后，会发送 `publish.approval_request`
- cloud 收到后，会主动向审批群发送飞书卡片
- 卡片 callback 写出的信号文件 requestId 与 edge 轮询 requestId 一致
- 用户点击“授权发布”后，edge 继续执行 `submit_publish`
- 用户点击“取消”后，edge 不执行 `submit_publish`
- 超时后 edge 返回 `approval_timeout`
- `/publish-test` 仍可用作后备联调入口

#### 测试策略

##### cloud
- 协议单测：新增 `publish.approval_request` 的 envelope 构造/解析测试
- handler 单测：收到 `publish.approval_request` 时调用 `sendApprovalCard(...)`
- 回归：现有 Feishu 回调与命令测试继续通过

##### edge
- 协议单测：新增 `publish.approval_request` 类型测试
- 主流程单测：收到 `publish.request` 后先发 `publish.approval_request`，再进入 `publishPost(...)`
- 回归：现有审批门禁测试继续通过

### Phase 2：补齐卡片状态回写

#### 目标
在不改变 Phase 1 主链路的前提下，让飞书卡片能反映“已授权 / 已取消 / 已发布 / 发布失败 / 审批超时”。

#### 变更范围

##### cloud
- **aidcp-cloud/src/feishu/ws-receiver.ts**
- **aidcp-cloud/src/feishu/messenger.ts**
- **aidcp-cloud/src/feishu/cards.ts**
- **aidcp-cloud/src/feishu/types.ts**
- **aidcp-cloud/src/comm/** 下处理 `publish.result` 的业务文件

##### edge
- **aidcp-edge/src/main.ts**（如需补充更明确的结果字段）

#### 验收标准
- 用户点击授权后，卡片可更新为“已授权，等待发布”
- 用户点击取消后，卡片更新为“已取消”
- edge 发布成功后，卡片更新为“已发布”
- edge 发布失败后，卡片更新为“发布失败”
- 审批超时后，卡片更新为“审批超时”

#### 测试策略
- 卡片模板单测：不同状态渲染正确
- `requestId → card context` 映射单测
- `publish.result` 驱动卡片更新单测
- 超时状态更新单测

### Phase 3：增强可观测性与失败区分（可选）

#### 目标
把“用户未审批”“cloud 发卡失败”“edge 发布失败”区分得更清楚，便于运维与排障。

#### 变更范围
- **aidcp-cloud/src/comm/protocol.ts**
- **aidcp-edge/src/comm/protocol.ts**
- **aidcp-cloud/src/comm/** 下相关 handler 文件
- **aidcp-edge/src/main.ts**

#### 可选增强项
- 为 `publish.approval_request` 增加 ACK/结果响应
- 为 `publish.result.error` 细分结构化错误码
- 增加 `requestId` 维度日志串联

#### 验收标准
- 能明确区分：发卡失败 / 审批取消 / 审批超时 / 发布失败
- 日志可按 `requestId` 串联完整链路

---

## 10. 风险与回滚策略

### 10.1 是否保留 `/publish-test`

#### 推荐结论
**保留，不移除。**

#### 原因
- 它是当前唯一稳定的人工联调与故障绕行入口
- 当主动审批流出现问题时，可快速验证：
  - 飞书卡片发送是否正常
  - `card.action.trigger` 是否正常
  - 信号文件写入是否正常
- 对正式流无侵入，只需在帮助文案中标注其为“联调 / 后备入口”

### 10.2 回滚方式

若 Phase 1 上线后出现问题，可快速回滚到：
- cloud 不处理 `publish.approval_request`
- edge 不主动发送 `publish.approval_request`
- 继续使用 `/publish-test` 手动发卡联调

由于现有审批门禁与手动入口都保留，回滚成本低。

### 10.3 主要风险

#### 风险 A：cloud handler 接线位置不集中
- 需要先确认 cloud 当前 WebSocket 业务 handler 的实际文件位置
- 本方案已预留为 **aidcp-cloud/src/comm/** 下实际业务 handler 文件

#### 风险 B：审批群 chatId 来源不统一
- 第一阶段建议先复用默认审批群配置
- 第二阶段再支持 `payload.chatId` 覆盖

#### 风险 C：cloud 发卡失败被 edge 误判为超时
- 第一阶段接受该限制
- 第二阶段通过 ACK / 状态回写增强区分

---

## 11. 实施顺序建议

1. 先补协议定义：双端 `publish.approval_request`
2. 再接 cloud handler：收到请求即发卡
3. 再接 edge main：收到 `publish.request` 后主动发审批请求
4. 最后更新联调文档与测试
5. 第二阶段再做卡片状态回写

---

## 12. DoD（完成定义）

- 双端协议已支持 `publish.approval_request`
- edge 正式发布前会主动触发 cloud 发审批卡
- cloud 发卡使用 edge 传入 requestId，无需人工对齐
- 用户授权 / 取消后，edge 能正确继续或中止发布
- 超时与失败路径有明确返回
- `/publish-test` 仍保留为后备入口
- 文档更新为主动审批流说明
- 相关单测覆盖新增协议与接线逻辑

---

## 13. 步骤 → 目标文件 → 验证 映射

| 步骤 | 目标文件 | 关键验证 |
|---|---|---|
| 新增协议消息 | **aidcp-cloud/src/comm/protocol.ts**、**aidcp-edge/src/comm/protocol.ts** | 双端 envelope 构造/解析测试通过 |
| cloud 接审批请求发卡 | **aidcp-cloud/src/comm/** 下 handler、**aidcp-cloud/src/feishu/cards.ts**、**aidcp-cloud/src/feishu/messenger.ts** | 收到 `publish.approval_request` 后调用 `sendApprovalCard(...)` |
| edge 主动发审批请求 | **aidcp-edge/src/main.ts** | 收到 `publish.request` 后先发 `publish.approval_request` |
| 复用审批门禁 | **aidcp-edge/src/flows/publish-post.ts**、**aidcp-edge/src/publish/approval-gate.ts** | approve / cancel / timeout 三路径回归通过 |
| 文档与后备入口保留 | **aidcp-cloud/docs/feishu-publish-approval-e2e.md**、**aidcp-cloud/src/feishu/commands.ts** | 主动流文档可执行，`publish-test` 仍可联调 |
| 第二阶段卡片状态回写 | **aidcp-cloud/src/feishu/** 下相关文件、**aidcp-cloud/src/comm/** 下处理 `publish.result` 的文件 | 卡片状态与 `publish.result` 一致 |
