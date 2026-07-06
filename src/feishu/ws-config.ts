export function isFeishuWsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AIDCP_FEISHU_WS_ENABLED !== 'false';
}
