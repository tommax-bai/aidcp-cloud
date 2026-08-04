# deploy/ — 部署工件

## multi-service/ 已于 2026-08-04 退役

这里曾有一套 `multi-service/`：4 个按角色切段的 systemd unit
（`aidcp-cloud-{api,automation,content,core}.service`）+ 一个三进程部署脚本 `deploy-multi.sh`
+ 一份说明。它实现的是「**一份代码、多入口**」那个过渡形态 —— 同一份 `/opt/aidcp/cloud`
靠 `AIDCP_SERVICE` 决定跑哪几段组合根。

**它被派生仓这条路取代了**，整目录随 change `deploy-derived-services-to-dev` task 8.0 删除。

### 现在该用什么

| 角色 | 现在由谁承担 | 入口 |
| --- | --- | --- |
| api（面板 / 客户鉴权 / 飞书） | 派生仓 `aidcp-api` | `src/api-service-entry.ts` |
| automation（边-云 8787 / 风控 / 编排） | 派生仓 `aidcp-automation` | `src/server.ts` |
| content | 派生仓 `aidcp-content` | `src/content-service-entry.ts` |
| core | **没有对应派生仓** —— 它是 automation+api 合进一个进程的过渡形态，已一并取消 |

本仓 `aidcp-cloud` 只剩 **monolith 一种跑法**，它是 **OL 的生产形态**与 **dev 的回滚路径**，
两处都不设 `AIDCP_SERVICE`。以那四个角色名启动单体会 **fail-closed 抛错**
（`src/gateway/service-mode.ts` 的 `RetiredServiceModeError`），**不会**回落成完整单体 ——
回落等于静默抢走自动化写者锁与边-云 8787。

### 为什么是删除而不是留着

判定材料（2026-08-04 实测）：那四个 unit 在 dev 上全是 `inactive` + `disabled`，
journal 里最后一次运行是 **7月26 10:55**（那次正是三进程脚本 fail-closed 自动回滚单体），
其中 `core` 从未跑过。OL 只有 `aidcp-cloud.service` 一个 unit。

留着的代价不是磁盘，是**下一个人看到的是「有这么四套东西可以用」** —— 而它们既没跑通过，
现在也已经被取代。要追溯实现细节请查 git 历史（本目录删除前的最后一版）。
