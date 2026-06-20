/**
 * 面板 API 层的注入依赖与配置类型。
 *
 * 面板是进程内 BFF：只读组合现有存储 + 进程内活态，加薄命令外观。
 * 注入镜像 DefaultMessageHandler 的构造方式（main() 已接好的单例）。
 * task 1（骨架）仅用到 edgeServer；其余依赖留待 task 5 只读接口与 task 4 写接口。
 */

import type { RiskController } from '../risk/index.js';
import type { ConceptStore, BotChatStore } from '../cache/index.js';
import type { PublishLogStore } from '../publish-agent/publish-log-store.js';
import type { EventBus } from '../event-bus/index.js';
import type { PanelUser } from './auth.js';
import type { PanelStoreReader } from './panel-store.js';

export interface PanelDeps {
  riskController: RiskController;
  publishLogStore: PublishLogStore;
  conceptStore?: ConceptStore;
  botChatStore: BotChatStore;
  eventBus: EventBus;
  /** 在线边缘登记（结构类型，便于测试造桩）。onlineEdgeCount 为 staleness 校验后的真实在线数（D9）。 */
  edgeServer: { edgeCount(): number; onlineEdgeCount(): number };
  /** 只读查询层（dashboard / accounts / content / analytics 聚合）。 */
  panelStore: PanelStoreReader;
  /** 发布编排器 in-flight 队列状态（/api/content/queue）。 */
  publishOrchestrator: { getStatus(): { status: string; snapshot: unknown } };
}

export interface PanelConfig {
  /** 面板监听端口（独立于 8787 边-云 ws）；0 表示交由 OS 分配（测试用）。 */
  port: number;
  /** JWT 签名密钥（来自 .env，绝不硬编码）。 */
  jwtSecret: string;
  /** 内置登录用户。 */
  users: PanelUser[];
  /** JWT 有效期（秒）。 */
  jwtTtlSeconds: number;
  /** 启动自检拒绝绑定的保留端口（8787 边-云 / 5432 PG / 8788 调试 / isales 等，部署时经 env 补充）。 */
  forbiddenPorts: number[];
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export type PanelStartReason = 'forbidden_port' | 'missing_secret' | 'no_users' | 'listen_error';

export interface PanelHandle {
  started: boolean;
  /** 未启动时的原因。 */
  reason?: PanelStartReason;
  /** listen_error 时的底层 code/message。 */
  detail?: string;
  /** 实际监听端口（port=0 时为 OS 分配的真实端口）。 */
  port?: number;
  close(): Promise<void>;
}
