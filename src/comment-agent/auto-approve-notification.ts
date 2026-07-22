/**
 * 免审通知是旁路可观测性，不参与授权判定，也不延迟提交链。
 * 缺口和发送失败只记录日志；调用方不得回退成人审或把评论标记为未授权。
 */
export function sendAutoApproveNotificationBestEffort<T>(input: {
  notify?: (payload: T) => Promise<void>;
  payload: T;
  context: string;
  logger: Pick<Console, 'log' | 'warn'>;
}): void {
  if (!input.notify) {
    input.logger.warn(`${input.context}免审通知口未接线，不影响提交`);
    return;
  }

  try {
    void input.notify(input.payload).then(
      () => input.logger.log(`${input.context}免审通知已发送`),
      (error: unknown) => input.logger.warn(
        `${input.context}免审通知失败，不影响提交：${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  } catch (error) {
    input.logger.warn(
      `${input.context}免审通知失败，不影响提交：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
