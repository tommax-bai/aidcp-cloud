/**
 * 告警「按 id 勾销」的**窄操作端口**（kernel 段）。
 *
 * 面板（api）的 POST /api/alerts/:id/resolve 只需要这一个方法；告警存储本体
 * （AlertStore / PgAlertStore，含建表、SQL、分级 AlertSeverity）留 src/alerts/（automation 属主）。
 *
 * **有意不抬 AlertStore 整型**：它传递依赖 AlertSeverity（automation 的告警合同
 * src/alerts/alert-notification.ts），整体抬入会造出 kernel → automation 的反向边——
 * 那个方向没有豁免通道，AC-BOUND-03 当场判失败。
 *
 * 同进程期由 PgAlertStore **结构性**满足本端口，组合根注入点零改动；
 * 若实现侧签名漂移，组合根那一处赋值会当场编译不过（不是静默通过）。
 * 拆进程后同一端口换成指向 automation 服务的客户端，面板侧零改动。
 *
 * kernel 门禁（§4.7）：零 import、纯接口；无库访问 / 无 HTTP 路由 / 无模型调用 / 无进程内活状态。
 */

/** 告警勾销端口。 */
export interface AlertResolutionPort {
  /**
   * 按 alert_id 勾销单条未解决告警。不依赖 edge_id——故 edge_id 为空的告警
   * （如节奏过载）与从未收到配对清除的告警都可勾销。
   * 返回**真实**勾销条数（0=没这条 / 已解决，1=本次解决），绝不假成功。
   */
  resolveById(alertId: number, at?: number): Promise<number>;
}
