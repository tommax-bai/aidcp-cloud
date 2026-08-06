/**
 * P4（cloud-coupling-phase4-runtime-ports）：可选注入端口的机械守卫 —— 派生根形态。
 *
 * 这些端口不注入时的语义是「恒不停手 / 预览退化成诚实说明」——与端口引入前逐位一致，所以漏接线
 * 既不抛错、也不会被 typecheck 抓到，只会在生产上静默失去一整层闸。单体版守卫自己的注释写着
 * 「物理拆仓后本断言 MUST 跟着复制到 automation 仓并指向它自己的组合根」，而那次复制没有发生 ——
 * 本文件就是那份缺失的守卫，落在集成仓、经兄弟仓路径读**现役**组装根
 * （invert-split-fact-source 5.6 re-anchor）。
 *
 * 单体版的其余五条启动顺序断言已删除，各自的家：
 *  - 「先建连接运行时登记处再监听」「hello 不提前起业务」→ 派生根把登记处做成边缘接入层的
 *    构造参数、监听推迟到 `edgeAccess.start()`（automation-main 的启动外壳），并由
 *    aidcp-automation 的组合根用例（automation-main / automation-connection-runtime /
 *    composition-root-4a-mode-wiring，后者真启动整根）看守；
 *  - 「委托恢复先于就绪宣告」→ 收敛进 `DelegatedTaskWorker.start()` 自身（先收敛遗留 claim
 *    再开泵，automation-main 的启动外壳 await 它）；
 *  - 「risk 缺席不连带禁其它路由」→ aidcp-automation `served-route-inventory` + automation-main；
 *  - 「飞书接收器注入持久审批写权威」→ aidcp-api `feishu-ws-receiver.test.ts` 与
 *    api-composition-root-4a。
 *
 * 单体版 P4 的第四个端口（提示词预览接收发布/配图 builders）**按裁定退休**：拆分后渲染器在
 * 内容/自动化进程，api 面板预览显式声明 rendererElsewhereNote（restore-panel-capability-wiring
 * 批次 3 的诚实缺席），不再是「必须接线」的口——它的缺席有具名说明，不是静默丢失。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { siblingRepoRoot } from './helpers/sibling-repos.js';

const automationSrc = (rel: string) =>
  readFile(join(siblingRepoRoot('aidcp-automation'), 'src', rel), 'utf8');

test('P4: 配置镜像停手闸真的交到消息处理器手里（automation 边缘接入层）', async () => {
  const source = await automationSrc('automation-edge-access.ts');
  const at = source.indexOf('new DefaultMessageHandler({');
  assert.ok(at >= 0, '边缘接入层必须构造消息处理器');
  assert.match(
    source.slice(at, at + 400),
    /configMirrorGate:\s*options\.configMirrorGate,/,
    '消息处理器必须收到停手闸 —— 漏接不报错，只是镜像过期时整层闸静默消失',
  );
});

test('P4: 配置镜像停手闸真的交到角色调度器手里（automation 连接调度层）', async () => {
  const source = await automationSrc('automation-connection-dispatcher.ts');
  assert.match(
    source,
    /configMirrorGate:\s*deps\.configMirrorGate,/,
    '调度器构造选项必须带停手闸',
  );
  assert.match(
    source,
    /new RoleDispatcher\(o\)\)\)\(options\)/,
    '构造选项必须真的流进 RoleDispatcher（改了接线形状请同步本断言）',
  );
});

test('P4: 风控底座拿到的是真实的镜像过期读数，不是永远新鲜的桩', async () => {
  // automation-risk-foundation 已把 mirrorStale 做成必填参数（在场由编译期保证）；
  // 这里守的是喂进去的是**真读数**——一个 `() => false` 的桩同样能过 typecheck，
  // 而它的含义是「镜像永远新鲜」，闸恒开。
  const main = await automationSrc('automation-main.ts');
  assert.match(
    main,
    /mirrorStale:\s*\(mirrorKey\)\s*=>\s*configMirrorGate\.isStale\(mirrorKey\)/,
    '风控底座的 mirrorStale 必须委托停手闸的真实读数',
  );
  const foundation = await automationSrc('automation-risk-foundation.ts');
  assert.match(
    foundation,
    /mirrorStale:\s*options\.mirrorStale,/,
    '风控底座必须把读数原样传进注册表，不得在中途换成常量',
  );
});
