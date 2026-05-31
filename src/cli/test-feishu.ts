/**
 * test-feishu：向指定群发送一张测试卡片（飞书集成联调脚本）。
 *
 * 直接用 FeishuMessenger 调飞书消息发送 API，验证 token 获取 + 卡片下发链路。
 *
 * 用法：
 *   npx tsx --env-file=.env src/cli/test-feishu.ts                 # 发每日汇总测试卡片
 *   npx tsx --env-file=.env src/cli/test-feishu.ts text 你好        # 发纯文本
 *   FEISHU_CHAT_ID=oc_xxx npx tsx --env-file=.env src/cli/test-feishu.ts
 *
 * 环境变量：
 *   FEISHU_APP_ID / FEISHU_APP_SECRET  应用凭证（必填）
 *   FEISHU_CHAT_ID                     目标群 chat_id（必填，或用第二参数覆盖）
 */

import { FeishuMessenger, buildDailySummaryCard } from '../feishu/index.js';

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'card';
  const chatId = process.env.FEISHU_CHAT_ID ?? '';
  if (!chatId) {
    console.error('[test-feishu] 缺少 FEISHU_CHAT_ID（目标群 chat_id）');
    process.exitCode = 1;
    return;
  }

  const messenger = new FeishuMessenger();

  if (mode === 'text') {
    const text = process.argv.slice(3).join(' ') || 'AIDCP 飞书联调：纯文本测试 ✅';
    await messenger.sendText(chatId, text);
    console.log(`[test-feishu] 已发送文本到 ${chatId}`);
    return;
  }

  const card = buildDailySummaryCard({
    date: new Date().toISOString().slice(0, 10),
    onlineAccounts: 6,
    totalAccounts: 8,
    totalViews: 920,
    likeRate: 0.26,
    likeRateHealthy: true,
    publishCount: 3,
    newFollowers: 42,
    statusBreakdown: { normal: 6, warned: 1, restricted: 1 },
    dashboardUrl: 'https://console.aidcp.local/dashboard',
  });
  await messenger.sendCard(chatId, card);
  console.log(`[test-feishu] 已发送每日汇总测试卡片到 ${chatId}`);
}

main().catch((err) => {
  console.error('[test-feishu] 失败：', (err as Error).message);
  process.exitCode = 1;
});
