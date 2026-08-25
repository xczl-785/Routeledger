# RouteLedger 暂缓体验项：Version 启动的 L3 表面流程

> 状态：保留观察，暂不修改
>
> 首次记录：2026-08-24
>
> 当前判断：安全模型合理，主要问题是 Agent 可见的操作步骤偏多

## 问题

`wait -> ready` 很顺畅，但 `ready -> running` 必须经历显式的 L3 提案、Host admission 和提交链。对长期、多人或高风险工程，这套机制有明确价值；对隔离测试和低风险个人项目，Agent 感知到的流程稍重。

当前可见流程：

```text
创建 L3 proposal -> Host 确认/admission -> 执行已准入 proposal
```

期望研究的表面流程：

```text
Agent 请求启动 -> Host 确认一次 -> RouteLedger 内部完成提案、授权与提交
```

## 保留边界

- 不移除 L3，也不把 `start_version` 降级为普通写入。
- proposal、精确 digest 绑定、approval artifact、提交与审计证据仍需完整保留。
- 不新增独立的“轻量安全等级”。
- 显式 propose/approve/commit 操作仍保留给特殊 Host、诊断和故障恢复。
- 如果未来提供预授权，只考虑当前项目、精确动作与 Version、短时效、有限次数、显式开启的有界授权。

## 暂缓原因

这项修改会同时影响 Next Action、Host admission、L3 编排、失败恢复和兼容路径，复杂度较高。当前链路功能正确且安全，本项属于体验优化，不是阻塞性缺陷，因此暂不实施。
