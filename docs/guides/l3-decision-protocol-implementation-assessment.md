# L3 决策协议实施评估

状态：exact-only 实施基线。

当前实现已经收敛到一条统一主链：proposal、精确授权、artifact、receipt、claim、实时校验、
原子提交、finalize 和精确重放。Codex、通用 MCP、CLI、delegated 和 preauthorized 的区别，
只在“谁为当前 proposal 做决定”；进入 RouteLedger 内核后，它们使用相同的安全语义。

## 已建立的边界

- `PendingOperation` 和 `operationDigest` 是规范提案，不删除。
- 授权严格绑定 proposal、project、物理 RouteLedger root、action、target、digest。
- `authorizationId` 与 `artifactId` 分离；一个授权只能产生一个 artifact 并消费一次。
- standing policy 每次只评估当前 proposal，不能产生可复用权限。
- 通用 elicitation 只有 approve 字段；decline 才拒绝，cancel 和畸形响应不产 artifact。
- 恢复状态带认证并重新核对 live tuple；过期、篡改、root 变化全部 fail closed。
- 所有来源统一走 receipt claim/finalize；host admission 没有旁路。

## 持久化与旧数据

新写入只保存 exact authorization。旧 host state、JSON 和 SQLite 数据只由迁移层读取：
活动旧记录会被撤销并 tombstone，重新执行必须重新授权；已经提交的历史审计可读但不可执行。

## 公开面验收

公开 MCP schema、CLI 输出、TypeScript exports、文档示例和构建产物只描述 exact-only 模型。
复用型权限的旧字段和接口不得出现在活动源码或最终 package/plugin payload。迁移器内部保留的
旧字段不属于公开 API，也不能被运行时授权路径导入。
