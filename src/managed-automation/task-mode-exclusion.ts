/**
 * 任务模式调度排除总开关（期1-3 任务模式通道与调度排除）。
 *
 * 语义：开关**开启**时，以 mode='task' 注册的会话被所有既有「云端主动挑环境派工」路径排除
 * （编排 RoleDispatcher 激活、account→edge 解析、在线账号扇出、评论接管连接解析）；
 * 开关**关闭**（默认）时过滤短路，全部路径行为与主干逐字节一致——mode 只登记、不参与判定。
 *
 * 配置模式沿用仓库既有 env 布尔开关（同 `AIDCP_CAPTCHA_ASSIST_ENABLED`）：
 * 只认字面 'true'，缺失 / 其它值一律按关闭处理（默认关闭，可秒级回滚）。
 */

/** 总开关 env 变量名。 */
export const TASK_MODE_SCHEDULING_EXCLUSION_ENV = 'AIDCP_TASK_MODE_SCHEDULING_EXCLUSION';

/** 纯归一：只认字面 'true'；缺省读进程 env。默认关闭。 */
export function resolveTaskModeSchedulingExclusionEnabled(
  raw: string | undefined = process.env[TASK_MODE_SCHEDULING_EXCLUSION_ENV],
): boolean {
  return raw === 'true';
}
