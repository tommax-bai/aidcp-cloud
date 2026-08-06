# 冻结史料（2026-08-06，change invert-split-fact-source）

本目录的归属清单曾是「cloud → 派生仓重放」的机械输入。事实源翻转（frozenCloudRef=2d34e06）后
重放退役，这些 JSON 转为**冻结的历史记录**：整图测试仍按原路径读取它们做属主查表，但它们
不再驱动任何同步，也不再由 `boundaries:refresh` 再生（该脚本已随单体源码一并退役）。
属主归属的活事实源＝控制仓 `docs/cloud-service-decomposition-proposal.md` §4.7 与各派生仓自身。
