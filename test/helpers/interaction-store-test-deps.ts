/**
 * `InteractionStore` 的测试期依赖桩（Block③ L3 收口后新增的两个注入口）。
 *
 * ① **审计中继驱动器** —— 镜像 `server.ts` 里那条接线（automation 的 `event_outbox`
 *    → api 属主表 `interaction_audit_events`），但**同步排空**、不起定时器。
 *    配置面审计从「automation 直插 api 属主表」改成了最终一致投递，故断言
 *    `interaction_audit_events` 之前 MUST 先排空队列。这不是给测试开的后门 ——
 *    它调的就是生产同一个消费者与同一个 api 侧幂等写入方法。
 * ② **恒放行的授权闸桩** —— 给那些不测闸本身的既有用例用。
 */
import type pg from 'pg';
import {
  INTERACTION_AUDIT_OUTBOX_TOPIC,
  INTERACTION_AUDIT_RELAY_CONSUMER,
  decodeInteractionAuditEvent,
} from '../../src/kernel/interaction-audit-outbox.js';
import type { InteractionAuthGate } from '../../src/kernel/interaction-auth-gate-types.js';
import { InteractionApiWrites } from '../../src/interactions/interaction-api-writes.js';
import { OutboxConsumer } from '../../src/transport/event-outbox.js';

/** 集成测试统一用 dev target（真库通道本就只对 aidcp_test* 专用库生效）。 */
export const INTERACTION_TEST_EXECUTION_TARGET = 'dev' as const;

/**
 * 「闸恒放行」的桩：让不测闸的既有用例保持改动前的判定结果。
 * 闸的拒绝档与 fail-closed 由 `test/interactions/interaction-auth-gate.test.ts` 专测。
 */
export function allowAllAuthGate(): InteractionAuthGate {
  return {
    authorizeAuthStateWrite: async (input) => ({
      ok: true,
      receipt: {
        platform: input.platform, accountId: input.accountId, envKey: input.envKey,
        issuedAt: input.now, expiresAt: input.now + input.ttlMs,
        environmentSerialization: 'registered',
      },
    }),
    checkAccountScope: async () => ({ ok: true }),
  };
}

/** 排空审计 outbox，返回本次落地的事件条数。载荷解不出即抛错（与生产中继逐字同）。 */
export async function drainInteractionAuditRelay(pool: pg.Pool): Promise<number> {
  const writes = new InteractionApiWrites();
  const consumer = new OutboxConsumer({
    consumer: INTERACTION_AUDIT_RELAY_CONSUMER,
    executionTarget: INTERACTION_TEST_EXECUTION_TARGET,
    pool,
    handlers: new Map([[INTERACTION_AUDIT_OUTBOX_TOPIC, async (event) => {
      const record = decodeInteractionAuditEvent(event.payload);
      if (!record) throw new Error(`interaction_audit_relay_undecodable_payload id=${event.id}`);
      await writes.insertAuditEvent(pool, record);
    }]]),
    logger: { log: () => {}, warn: () => {} },
  });
  let total = 0;
  for (;;) {
    const processed = await consumer.runOnce();
    total += processed;
    if (processed === 0) return total;
  }
}
