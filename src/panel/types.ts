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
import type { PublishApprovalPayload, ApprovalWriteResult } from '../feishu/index.js';

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
  /** 发布审批写回（first-writer-wins，与飞书共享信号文件契约 AC-PUB-*）；返回 written/alreadyDecided，绝不 published。 */
  writeApprovalSignal: (
    requestId: string,
    approved: boolean,
    payload: PublishApprovalPayload,
  ) => Promise<ApprovalWriteResult>;
  /** 账号命令（durable，与飞书 actions 共享 accountState 底层）；返回真实结果（resume 带恢复 edge 数）。 */
  commandActions: {
    pause(accountId: string): Promise<{ accountId: string; status: 'paused' }>;
    resume(accountId: string): Promise<{ accountId: string; status: 'active'; resumedEdges: number }>;
    /**
     * 调度启停（V1 task 9.4）：start/stop 现役单全局 RoleDispatcher；回报真实在线 edge 数。
     * 偏离：单账号现实下为全局开关（accountId 信息性）；per-edge 拆分留到真多账号（design 步骤 8）。
     * 未注入则 /dispatch 返回 503（向后兼容）。
     */
    dispatch?(
      accountId: string,
      action: 'start' | 'stop',
    ): Promise<{ accountId: string; dispatch: 'started' | 'stopped'; changed: boolean; edgesOnline: number }>;
    /** 调度引擎当前是否活跃（dashboard summary 读）。 */
    dispatchActive?(): boolean;
  };
  /** 风控注册表（V1 写路由 risk/status、risk/quota 按账号取 controller；单写 PER ACCOUNT）。 */
  riskRegistry: { getController(accountId: string): Promise<RiskController> };
  /**
   * 模型与凭据配置（change console-model-provider-config）。未注入则 /api/config/* 返回 503。
   * 明文密钥绝不经此外观回传；setCredential 主密钥缺失以 {ok:false} 诚实可辨，绝不假成功。
   */
  modelConfig?: PanelModelConfig;
}

/** 凭据视图（永不含明文）。source：db=库内加密凭据 / env=回退环境变量 / none=未配置。 */
export interface ModelConfigCredentialView {
  field: string;
  configured: boolean;
  maskedHint: string | null;
  source: 'db' | 'env' | 'none';
}

/** GET /api/config/model 的形状（永不含明文密钥）。 */
export interface ModelConfigView {
  provider: string;
  baseUrl: string;
  textModel: string;
  imageModel: string;
  credential: ModelConfigCredentialView;
  /** 主加密密钥是否就位——凭据能否在后台编辑。 */
  canEditCredential: boolean;
}

export type SetCredentialResult =
  | { ok: true; field: string; maskedHint: string }
  | { ok: false; reason: 'cred_key_missing' };

export interface PanelModelConfig {
  getView(): Promise<ModelConfigView>;
  /** 改模型名（热加载即时生效），返回写后真态视图。 */
  setModel(patch: { textModel?: string; imageModel?: string }, updatedBy: string): Promise<ModelConfigView>;
  /** 加密保存密钥（重启生效）；主密钥缺失返回 {ok:false}，明文绝不回传。 */
  setCredential(field: string, value: string, updatedBy: string): Promise<SetCredentialResult>;
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
