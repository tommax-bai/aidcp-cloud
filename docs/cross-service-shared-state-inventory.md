# 拆分前非表状态盘点表（阶段 0 初版）

> change `publish-approval-signal-to-database`。对应控制仓 `docs/cloud-service-decomposition-proposal.md`
> §12 阶段 0 的六类盘点范围。本表只覆盖本 change 已**坐实**的条目，不是全量盘点——阶段 0 收口时须补齐。

每行必填字段（缺任一即视为该行未盘完）：

1. 引用点 `文件:行`
2. 拆分后归属服务
3. 是否跨服务边界
4. 跨服务时的替代机制
5. **不替代会怎样失效——必须写出失效方向是「静默」还是「报错」**

「失效方向」这一列是本次两个问题共同暴露出来的：两者都是**静默**方向，也正因为静默，
它们长期没有被登记为拆分阻塞项。

---

## 类别 4：本机文件系统信号与共享路径

| 引用点 | 归属 | 跨服务 | 替代机制 | 不替代的失效（方向） |
| --- | --- | --- | --- | --- |
| `src/feishu/ws-receiver.ts` `writeApprovalSignal` / `getApprovalSignalPath` | api | 是 | `publish_approval_decision` 表 + 唯一写出口 `publish-approval-outlet.ts` | **静默**：读方永远读不到 `approved===true`，运营点了通过、稿件永不发出、界面仍显示「待审批」、安全断言全绿 |
| `src/publish-agent/publish-dispatcher.ts` 下发前复核 / 兜底扫描 / 三处作废 | automation | 是 | 窄内部接口 `publish-approval-api.ts`（`GET`/`POST .../void`）+ `PublishApproved` 命令 | **静默**：同上；且作废语义（删文件）跨机后完全失效 |
| `src/agents/comment-approval-gate.ts` 审批轮询 | automation | 是 | 同上（`isApproved` 读活跃行） | **静默**：人点了「同意」仍超时丢评论 |
| `aidcp-edge/src/publish/approval-gate.ts` 文件闸 | edge（本机开发夹具） | 否（已降级） | 无需替代：生产链路无读者，已加显式启用门 | 若不加启用门：**静默**——配置遗漏看起来像「运营没点通过」 |

> 影子写（`AIDCP_PUBLISH_APPROVAL_LEGACY_SIGNAL_FILE`，默认开）**只写不读**，且只在写方与消费者同机时有意义。
> 它 MUST NOT 被任何生产判定路径读取；关闭它是独立、可单独回滚的一步。

## 类别 5：本机进程内锁与内存事实表

| 引用点 | 归属 | 跨服务 | 替代机制 | 不替代的失效（方向） |
| --- | --- | --- | --- | --- |
| `src/publish-agent/publish-dispatcher.ts` `inFlight` / `accountTail` / `openBreakers` | automation | 否（单服务内） | 保留；但**投影不得依赖它** | **静默**：进程重启后「已批准·待下发」退回「待审批」——本 change 已把投影判据改到持久 `dispatch_state` |

## 类别 6a：数据库级 advisory lock

| 引用点 | key 命名空间 | 归属 | 跨服务 | 替代机制 | 不替代的失效（方向） |
| --- | --- | --- | --- | --- | --- |
| `src/client-auth/client-user-store.ts` `beginEnvironmentOffboard` | `interaction-env:` | api | **是** | `client_environments` 行锁（`lockEnvironmentRow`） | **静默**：拆库 / 读写分离 / 指向副本后两侧各自加锁均成功，互斥消失、零报错 |
| `src/client-auth/client-user-store.ts` 客户禁用批量解绑 | `interaction-env:` | api | **是** | 同上（按 `env_key` 升序逐个取行锁，取锁顺序不变） | 同上（**静默**） |
| `src/client-auth/client-user-store.ts` 环境归属批量改派 | `interaction-env:` | api | **是** | 同上 | 同上（**静默**） |
| ~~`src/client-auth/client-user-store.ts` `reconcileRevocationHolds`~~（已消除） | `interaction-env:` | api | 否 | change block3-l3-offboard-eventual-consistency 起改名 `reconcileCleanupAdmissions`，**不再取环境级锁**：串行点是 api 属主准入表的 `UNIQUE(env_key)`，物化本身由属主侧按 `offboard_id` 幂等，重复投递（含 dev/ol 共库双跑）落到同一条台账行 | — |
| `src/interactions/interaction-store.ts` `upsertAuthStatus` | `interaction-env:` | automation | **是** | 同上 | 同上（**静默**）；首次授权与客户解绑可交叉执行 |
| `src/interactions/interaction-store.ts` 收件箱批次幂等 | `<platform>\|<accountId>\|<batchId>` | automation | 否 | 保留 advisory lock，静态检查白名单显式登记 | — |
| `src/interactions/interaction-store.ts` 发送串行 | `interaction-send\|` | automation | 否 | 保留 advisory lock，静态检查白名单显式登记 | — |

自动化检查：`test/acceptance/advisory-lock-ownership.test.ts`（AC-LOCK-01 / AC-LOCK-02）。
新的跨边界引用会让验收失败，MUST NOT 只靠人工评审发现。

**取锁不成立的那一支**：`SELECT ... FOR UPDATE` 命中 0 行时既不加锁也不报错。注册表尚无该环境时走的就是这一支，
而 `upsertAuthStatus` 到达时并不要求环境已注册（上游校验不查注册表；握手时的自动登记还是 fire-and-forget，
存在真实时间窗）。故 `lockEnvironmentRow` 把它作为**可判定返回值** `unregistered` 交出并记日志，
`upsertAuthStatus` 据此回落去锁该环境的客户归属行 `client_env_scope` —— 客户停用 / 解绑侧正是遍历那张表找环境的
（对注册表只做 LEFT JOIN、注册行缺失照样往下走），锁住归属行即与之串行。两张表都无行 ⇒ 解绑侧遍历不到该环境
⇒ 确无对手；此时不加锁是**有依据的**且照样留痕，与「没锁到也当锁到了」不是一回事。

**残留缺口（未在本 change 内闭合）**：`upsertAuthStatus` 的写点仍在 automation 侧。
行锁已经消除了「静默失去互斥」这一形态（拆库后 automation 连不到 `client_environments` 是**响亮**的失败），
但把写点收敛到数据所有者服务（窄内部端点 `PUT /internal/environments/{envKey}/auth-state`）仍待做。

## 类别 6b：常驻定时任务

计数 MUST 同时给出两个口径、且 MUST 在实施当天重测——两者不是一回事，只写一个数会让盘点者提前收工：

- **宿主数**：定稿 §4.6.5 / §12 阶段 0 记 **14**（其第 13、14 项并非 `setInterval`）。
- **调用点数**：`grep -rn setInterval src | wc -l`，2026-07-23 在本 change 分支实测 **26**
  （含本 change 新增的待下发看门狗）。

本 change 新增 / 变更的常驻任务：

| 宿主 | 扫描 / 写入的表 | 归属 | `execution_target` 归属 | 备注 |
| --- | --- | --- | --- | --- |
| `PendingDispatchWatchdog`（`src/publish-agent/pending-dispatch-watchdog.ts`） | 读 `publish_approval_decision`，写 `alerts` | api（授权所有者） | 按本机 `AIDCP_DEPLOY_ENV` 过滤 | 同一任务 MUST NOT 在两个服务里各跑一份 |
| `PublishApproved` Inbox 泵（`src/server.ts` 与兜底扫描同一 timer） | 认领 `publish_approval_outbox` | automation | 只认领本机 target 的命令 | 原子认领即去重 |
