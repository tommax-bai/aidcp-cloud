# aidcp-cloud — 整图集成测试仓（原云端单体，已瘦身）

> **2026-08-06 起本仓不再承载任何业务源码**（change `invert-split-fact-source`）。
> 云端业务代码的事实源是四个兄弟仓：
> [`aidcp-api`](../aidcp-api)（面板 / 客户鉴权 / 飞书）、
> [`aidcp-automation`](../aidcp-automation)（边-云 WS + 编排 + 风控）、
> [`aidcp-content`](../aidcp-content)(生成 + 发布管线）、
> [`aidcp-kernel`](../aidcp-kernel)（零副作用契约）+ [`aidcp-transport`](../aidcp-transport)（跨进程原语）。
> **改业务代码去对应仓改；本仓 MUST NOT 被部署到任何环境**（CLAUDE §8.0 不变）。

## 本仓现在是什么

**跨属主 / 整图用例的唯一试验场**——那些必须把多个服务摆在一起才成立的检查：

- 跨服务行为契约（如面板契约 ↔ ws-server、发布审批跨进程链路）；
- 全部迁移的**三仓并集**审计（编号 / 顺序 / DDL 对齐 / 每属主库可执行性；同名副本断言校验和一致）；
- 协议红线 `AC-PROTO-*`（edge ↔ automation 两份 protocol.ts 不漂移）等验收族。

测试直接引用兄弟仓源码：编译期走 tsconfig 别名 `@api/* @automation/* @content/* @kernel/*`
（双布局回退，canonical 与 `.wt` worktree 通用）；运行时数据读取走
`test/helpers/sibling-repos.ts` / `test/helpers/migration-union.ts`（找不到兄弟仓即响亮失败）。

**硬前置**：四个兄弟仓已 clone 且各自 `npm ci` 过（跨仓 import 依赖它们自己的 node_modules）。

## 命令

- `npm test` — 全量整图套件（PG 集成用例无库自跳过）
- `npm run test:acceptance` — 验收红线族
- `npm run test:pg` — `AIDCP_PG_INTEGRATION=1` 门控的库集成用例
- `npm run typecheck`

## 历史与冻结物

- `boundaries/` — 拆仓期归属清单，**冻结史料**（见 `boundaries/FROZEN.md`），测试仍按原路径读它做属主查表；
- 单体源码史（含 `src/` / `migrations/` 全史）在 git 历史里，冻结点 `2d34e06`（`aidcp` 控制仓
  `scripts/fact-source.json` 的 `frozenCloudRef`）；
- 拆仓过程与归属裁定：控制仓 `docs/cloud-service-decomposition-proposal.md`、
  `docs/cloud-retirement-blockers-2026-08-05.md`、openspec change `invert-split-fact-source`。
