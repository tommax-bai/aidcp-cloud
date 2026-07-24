// 纯发布排期策略（零 SQL / HTTP / LLM / 模块级 Set-Map，仅依赖 kernel 类型）已抬入 kernel
// （change decouple-longtail-sweep）。本文件保留为等值 re-export 桩，令同层既有消费方无感；
// 跨边界消费方（automation 侧 command-sequencer / content 侧 publish-mode-decider）直接从 kernel 导入。
export * from '../kernel/schedule-policy.js';
