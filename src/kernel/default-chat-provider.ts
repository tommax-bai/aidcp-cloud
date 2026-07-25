/**
 * 默认群目标的窄读端口（change cloud-coupling-phase4-runtime-ports）。
 *
 * automation 侧发布审批卡在没有会话来源群时，要问一次「默认群是谁」。它只需要这一个方法，
 * 不需要机器人会话仓的其余读写面。`chatName` 保留是因为调用点把它打进了「默认群查询完成」
 * 那条日志——端口砍掉它就等于静默抹掉一条可观测性。
 */
export interface DefaultChatTarget {
  chatId: string;
  chatName?: string | null;
}

export interface DefaultChatProvider {
  getDefaultChat(): Promise<DefaultChatTarget | null>;
}
