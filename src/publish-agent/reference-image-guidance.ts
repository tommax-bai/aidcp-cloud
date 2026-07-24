// 纯参考图引导（零 SQL / HTTP / LLM / 模块级 Set-Map，仅依赖 kernel 发布管线类型）已抬入 kernel
// （change decouple-longtail-sweep）。本文件保留为等值 re-export 桩，令同层既有消费方无感；
// 跨边界消费方（api 侧 publish-scheduler）直接从 kernel 导入。
export * from '../kernel/reference-image-guidance.js';
