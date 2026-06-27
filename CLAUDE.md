# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本仓是 **aidcp\*** 家族的一员（云端编排 + 面板 API 后端）。家族级契约、架构与完整工作约定以中控仓 `../aidcp/CLAUDE.md` 为权威；本文件只固化「跨仓通用、需随 git 换机器仍生效」的沟通偏好，确保在本仓直接工作时也加载。

## 沟通方式（默认模式，用户偏好）

- **问题 / 根因 / 方案的说明方式**：讲逻辑、讲因果，**不用比喻**；**不点代码内部标识符**（变量 / 类 / 函数 / 消息类型名），改用**功能性正文**描述组件与机制（如「执行端 / 决策端 / 监测体」「发命令给执行端的统一出口」「会话凭证失效后的统一兜底」）。
- 分点、句子短，让非工程视角也能跟上；确需落到代码时再补具体 `文件:行`，且放在解释之后。诊断阶段重逻辑，实现阶段才落到具体文件。
- 正文默认中文；代码 / 注释 / commit / PR / 命令 / 文件名保持英文。

## 提交 / 推送 / 部署

- **提交 / 推送 / 部署默认直接做、不用逐次问**（用户长期授权，2026-06-27）。推默认分支 `master`；commit message 末尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 部署形态与安全序列（先备份 → 同步 → restart → healthcheck → 失败回滚）、isales 红线、生产机访问细节，以中控仓 `../aidcp/CLAUDE.md` §5/§6 为权威。
