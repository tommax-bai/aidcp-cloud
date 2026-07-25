/**
 * 概念池的**纯数据模型**（change cloud-coupling-phase5 从 `src/event-bus/types.ts` 抬入）。
 *
 * 抬入理由不是「共导多」，而是**拆仓后 content 仓的 src 里没有 event-bus/types.ts**：
 * 概念池 store（`src/cache/concept-store.ts`，content 属主）以它为返回类型，
 * 留在 automation 会让 content 仓直接编译不过——豁免管得住门禁，管不住模块解析。
 *
 * 零 import、零 SQL、零 HTTP、零 LLM、无进程内活状态，满足 §4.7 kernel 准入。
 *
 * **`source` 字段已删（本 change）**：它原为 `Map<string, string>`（关键词 → 来源笔记标题），
 * 全仓**只有写入点、零读取点**（`concept-store.ts` 建池时 set，`role-dispatcher` / `search-evaluator`
 * 的空池常量各构造一个空 Map）。留着它在拆仓后会变成一个**静默假成功**：
 * 概念池由 content 装载、由 automation 的调度器与搜索评估器消费，跨进程后这一跳要过 JSON，
 * `Map` 序列化恒为 `{}`——读方拿到的永远是空表，却没有任何一处会报错。
 * 与其把一个没人读的字段改成 `Record` 再养着，不如现在删掉。
 * 关键词的来源归属并没有丢：它落在 `concept_pool.source_note` 列上，
 * 经 `ConceptRecord.sourceNote` 读出，那条路径有真实消费者。
 */
export interface ConceptPool {
  known: string[];
  candidates: string[];
}
