import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { InteractionStore } from '@automation/interactions/interaction-store.js';
import { ReplyConfigStore } from '@api/interactions/reply-config-store.js';
import { ReplyConfigScopeStore } from '@api/interactions/reply-config-scope-store.js';

/**
 * Block③ L3 回归：互动域三个 store 接组合根注入的 **automation 属主池**后，
 * `close()` MUST NOT 把那个池 end 掉 —— 它被本域十几个 store 共用。
 *
 * 为什么值得一条专门的用例：互动域的构造被 try/catch 包着（schema / 迁移未就位时整域降级不启用），
 * **失败分支会调这三个 store 的 close()**（server.ts 的 interaction 域 catch 块）。
 * 若那时 end 了共享池，一次**局部**子系统失败会升级成进程级瘫痪 ——
 * 其余 automation store 全部报「Cannot use a pool after calling end on the pool」。
 * 这正是本仓红线「自愈不自残」的形状，故用机械断言钉住。
 */
function spyPool(): { pool: pg.Pool; endCalls: number } {
  const state = { endCalls: 0 };
  const pool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }),
    end: async () => { state.endCalls += 1; },
  } as unknown as pg.Pool;
  return { pool, get endCalls() { return state.endCalls; } } as { pool: pg.Pool; endCalls: number };
}

test('互动域三 store：close() 绝不 end 组合根注入的共享属主池', async () => {
  const a = spyPool();
  const b = spyPool();
  const c = spyPool();

  await new InteractionStore({ pool: a.pool }).close();
  await new ReplyConfigStore({ pool: b.pool }).close();
  await new ReplyConfigScopeStore({ pool: c.pool }).close();

  assert.equal(a.endCalls, 0, 'InteractionStore.close() 不得 end 注入的共享池');
  assert.equal(b.endCalls, 0, 'ReplyConfigStore.close() 不得 end 注入的共享池');
  assert.equal(c.endCalls, 0, 'ReplyConfigScopeStore.close() 不得 end 注入的共享池');
});

test('互动域三 store：未注入池时 close() 照旧释放自己建的池（不因守卫而泄漏连接）', async () => {
  // 不传 pool ⇒ store 自建池（pg.Pool 构造不建连，故此处不触达真库）。
  // close() MUST 真的 end 它，否则每个自建池都成了泄漏。
  for (const store of [new InteractionStore(), new ReplyConfigStore(), new ReplyConfigScopeStore()]) {
    const pool = (store as unknown as { pool: pg.Pool }).pool;
    let ended = false;
    (pool as unknown as { end: () => Promise<void> }).end = async () => { ended = true; };
    await store.close();
    assert.equal(ended, true, `${store.constructor.name}.close() 必须 end 自建池`);
  }
});
