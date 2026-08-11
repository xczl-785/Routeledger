# L3 决策协议实施评估

状态：基于 2026-08-11 源码的实施分析；不表示代码已经完成迁移。

设计基线见 [`L3 route-transition decision protocol`](l3-route-transition-decision-protocol.md)。
本文回答四个问题：现在有什么、真正缺什么、应该怎样改、工作量大约多少。

## 1. 一句话结论

RouteLedger 现在并不是“没有 L3 状态机”，而是已经有一条相当完整的安全执行链，
但它的**决策机制、宿主交互和核心提交编排缠在一起**，并且对“可信”的定义过度依赖
额外的 RouteLedger 授权仪式。

正确的改法不是删掉现有安全链，而是：

1. 保留 proposal、grant、artifact、live validation、atomic commit、receipt 和 audit；
2. 把“这次决定从哪里来”抽成统一接口；
3. 用 Codex adapter 和通用 MCP adapter 分别回答这个接口；
4. 在 adapter 外面提供一调用完成的编排，让高权限模式自动走完整条内部链。

## 2. 当前实现到底是什么

### 2.1 已经存在、而且应该保留的部分

核心层已经实现了以下能力：

- `PendingOperation` 保存精确 action、target、payload、gate snapshot 和 operation digest；
- `authorizeL3Operation` 消费匹配 grant，生成并持久化 `ApprovalArtifact`；
- `commitL3Operation` 在提交前重新读取项目并验证 project、operation、action、target、
  digest、artifact 状态、有效期、profile epoch 和授权 receipt；
- 提交时会重新计算 live gate/digest，状态已变化就拒绝旧 proposal；
- canonical mutation、pending operation、artifact 和 audit event 一起持久化；
- grant/receipt 有匹配、消费、commit claim、finalize 和 replay 恢复机制；
- 已提交 operation 只能携带原始、完全匹配的 artifact 做幂等重放。

这部分已经接近我们现在定义的“L3 路线转换协议内核”。它不是多余摩擦，反而是当前最有
价值的资产。

### 2.2 当前决策路径

目前 `approve_l3_operation` 在一个 MCP tool handler 内串行处理多种情况：

1. 查找已经消费过的授权，处理精确重放；
2. 查找已有的 preauthorized/session grant；
3. preauthorized profile 未命中时直接失败；
4. delegated 模式调用 host-managed authority，校验并写入一次性 grant；
5. 其余情况请求 structured elicitation；
6. 接受后生成 interaction grant，再调用核心 `authorizeL3Operation`；
7. Agent 还要再调用 `commit_l3_operation` 才真正提交。

也就是说，三种模式的基本能力并非没有，而是藏在一个很长的 handler 里；对外又暴露成
“提案—授权—提交”多次工具往返。

### 2.3 Codex 当前做了什么

Codex 包当前主要是配置生成器。它为每个 MCP tool 写固定的 `approval_mode`：

- 读取工具是 `auto`；
- `approve_l3_operation`、proposal 和普通写操作大多是 `prompt`；
- `commit_l3_operation` 是 `approve`。

这是一份**静态的工具级配置**，不是当前对话权限模式的动态读取。因此，现有插件没有一个
接口能在每次调用时直接问 Codex：“这个对话现在是请求批准还是完全访问？”

### 2.4 通用 MCP 当前做了什么

通用 MCP 已经支持 structured elicitation，也允许启动时注入 grant store、interaction、
profile、trusted client identity 和 delegated authority。但这些入口仍服务于当前
`approve_l3_operation` 的授权模型，还没有形成一个清晰、可供不同宿主实现的“决策 adapter”
契约。

## 3. 当前模型与新定义的关键差异

| 方面 | 当前实现 | 目标状态 |
| --- | --- | --- |
| L3 的中心概念 | 授权与可信证明 | 路线转换决策协议 |
| 权限模式作用 | 选择不同授权路径，部分路径强调额外证明 | 决定 proposal 如何自动得到 decision |
| 对外流程 | 通常 proposal、approve、commit 多次调用 | 可一调用完成，内部步骤不减少 |
| 核心与宿主边界 | MCP handler 同时做决策选择、交互、grant 和编排 | core 只认决策结果；adapter 处理宿主差异 |
| Codex | 静态 tool approval 配置 | 独立 adapter；能取模式就映射，取不到就用明确 fallback |
| 通用 MCP | elicitation 和本地 authority 是实现细节 | 与 Codex 平级的 adapter |
| 用户点击证明 | V3 profile 下被视为通用硬门槛 | 仅在特定 adapter/部署需要时要求 |
| Profile | 接近产品中心，承载模式和可信边界 | 兼容期保留为内部能力记录，不强迫用户理解 |
| 状态可见性 | persisted 状态主要是 pending/rejected/committed，决策状态分散在 artifact/receipt | 对外投影统一的 decision phase，不急于改存储 schema |

## 4. 应该形成的接口

### 4.1 核心决策接口

核心只需要把一个精确 proposal 交给 adapter，并接收三类结果：

```ts
type DecisionResolution =
  | { status: "resolved"; decision: ExactDecision }
  | { status: "input_required"; request: DecisionRequest }
  | { status: "denied"; code: string; reason: string };

interface L3DecisionAdapter {
  readonly id: string;
  resolve(request: ExactProposalDecisionRequest): Promise<DecisionResolution>;
}
```

`ExactDecision` 必须绑定 proposal/digest，并标记来源：`user_interaction`、
`delegated_policy` 或 `preauthorized`。兼容期可以继续携带现有 `authorizationGrantId`，由现有
grant/receipt 内核验证和消费。

### 4.2 编排接口

在现有 service 外增加一层 orchestrator：

```text
propose -> adapter.resolve -> issue/consume exact grant
        -> create decision artifact -> commit -> receipt/result
```

它有两种返回：

- 已解决：直接返回最终 committed result；
- 需要用户：返回结构化 `input_required`，保留 proposal，收到决定后从同一状态继续。

原来的 `propose_l3_operation`、`approve_l3_operation`、`commit_l3_operation` 暂时保留，作为
兼容和诊断用的低层工具。新的高层调用不能绕过它们拥有的语义，只是把调用次数折叠起来。

## 5. 状态机怎样落地

逻辑状态建议统一为：

```text
proposed
  -> decision_required -> decision_resolved -> committing -> committed
                       \-> rejected          \-> stale
                                             \-> failed
  -> decision_resolved -> committing -> committed
```

关键点不是立刻给 JSON schema 增加七种持久化状态。第一阶段可以从现有数据投影：

- pending 且没有 approved artifact：`proposed` 或 `decision_required`；
- pending 且有 approved artifact：`decision_resolved`；
- commit receipt 已 claim：`committing`；
- pending operation committed：`committed`；
- pending operation rejected：`rejected`；
- live digest mismatch：本次返回 `stale`，原 proposal 保持不可提交；
- 写入或 receipt finalize 异常：返回 `failed` 和明确恢复信息。

这样先统一行为和接口，不需要一开始就做高风险数据迁移。等投影稳定后，再判断是否值得把
中间 phase 显式持久化。

## 6. 具体 adapter 怎么分

### 6.1 Codex adapter

职责：

- 接收 Codex 能提供的有效权限信息；
- 映射为 `interactive`、`delegated` 或 `preauthorized`；
- 在请求批准模式使用 Codex 原生 tool approval/interaction；
- 在替我审批模式调用确定性 RouteLedger policy；
- 在完全访问模式消费当前项目、会话或时间窗内的有限 capability；
- 生成宿主来源信息，但不直接提交路线数据。

当前最大的不确定项是 Codex 是否暴露“当前对话权限模式”的运行时字段。这个不再阻塞整体
架构：

- 如果可取，adapter 直接动态映射；
- 如果不可取，先由插件配置确定 RouteLedger mode，交互模式仍利用 Codex 的原生 tool
  approval；
- 绝不把 Codex 专用字段塞进 core。

### 6.2 通用 MCP adapter

职责：

- 有 elicitation 能力时返回/处理 `input_required`；
- 有宿主注入的 delegated resolver 时执行确定性规则；
- 有显式部署配置的有限 capability 时自动解决；
- 什么都没有时清晰返回需要配置或需要输入，而不是假装自己知道 Codex 模式。

通用 MCP 的三档不必在所有宿主上长得一样。协议只统一结果，不强迫所有宿主提供同一块 GUI。

### 6.3 兼容 adapter

现有 profile、local authority broker、grant store、structured elicitation 不应推倒重写。
先各自包成 adapter 或 adapter dependency，让新 orchestrator 调用；稳定后再删掉重复仪式和
不再必要的 proof 字段。

## 7. 推荐实施顺序

### 阶段 A：抽象但不改行为

- 定义 decision request/result、state projection 和 transition guard；
- 把当前 grant/interaction/delegated/preauthorized 分支包装到统一 resolver；
- 现有工具和数据格式保持不变；
- 用现有大量 L3 测试证明行为没有退化。

结果：内部边界清楚，但用户交互次数暂时不变。

### 阶段 B：一调用编排

- 增加高层 `execute_l3_operation` 或等价 application API；
- 自动模式在一次请求中完成 proposal、decision、artifact 和 commit；
- 交互模式返回可恢复的 `input_required`；
- 保留低层工具兼容旧 Agent 和脚本。

结果：完全访问和匹配的替我审批真正变成低摩擦。

### 阶段 C：Codex 接入

- 做 Codex live capability probe；
- 能读取当前对话模式就动态映射；
- 不能读取就采用插件配置 + 原生 tool approval 的可解释 fallback；
- 更新生成配置、状态展示和真实 Desktop 验收。

结果：Codex GUI 体验接近用户看到的三级权限，同时不把 Codex 当成核心模型。

### 阶段 D：通用 MCP 收口

- 把 MCP 2025 elicitation 接到统一 adapter；
- 增加 2026 `InputRequiredResult`/request state 适配；
- 做一个非 Codex stdio conformance harness；
- 补齐 retry、disconnect、duplicate、timeout 和 capability miss 矩阵。

结果：通用 MCP 有清晰的接入合同和可验证 fallback。

### 阶段 E：清理产品负担

- 默认 UI/状态隐藏 profileId、digest、epoch 等内部字段；
- 把 `ApprovalArtifact` 在新 API 中投影为 `DecisionArtifact`；
- 删除已经被 adapter 契约取代的物理点击通用门槛；
- 保留安全迁移和旧数据读取兼容。

## 8. 工作量估算

以下按一名熟悉代码的开发者估算，包含测试和文档，不包含正式发布等待时间：

| 内容 | 通俗解释 | 估算 |
| --- | --- | --- |
| 核心接口与状态投影 | 把现有散落状态统一成一套语言，不改数据格式 | 2～3 人日 |
| 现有授权路径 adapter 化 | 把长 handler 拆开，但先保持原行为 | 3～5 人日 |
| 一调用编排与兼容工具 | 让自动模式一次走完，同时不弄坏旧调用 | 3～5 人日 |
| Codex adapter | 探测能力、模式映射、配置 fallback、Desktop 验收 | 3～5 人日 |
| 通用 MCP adapter | 2025/2026 交互、无 UI fallback、stdio 验收 | 4～7 人日 |
| 状态展示与内部概念降噪 | 用户只看模式、等待原因和剩余额度 | 2～4 人日 |
| 回归、迁移和异常矩阵 | 重放、并发、崩溃、过期、撤销、旧 profile | 3～5 人日 |

总量约 **20～34 人日**，比较现实的是一名开发者 **4～7 周**。其中：

- 第一段可验证的内部切片（接口、状态投影、兼容 adapter）约 5～8 人日；
- 第一段用户能明显感知的低摩擦体验（再加一调用编排）约 8～13 人日；
- Codex 与通用 MCP 都完整收口，再加异常矩阵，才是上面的全量。

最大的变量不是状态机编码，而是 Codex 当前宿主到底暴露多少实时权限上下文，以及 MCP
2026 交互在目标客户端上的真实兼容情况。

## 9. 当前不应该做的事

- 不应先删除 grant、receipt、digest 或 live validation；
- 不应立即迁移 canonical JSON schema；
- 不应让 core 直接读取 Codex 配置；
- 不应假设所有 MCP 客户端都有三级权限；
- 不应为了追求“自动”而让 adapter 直接写项目数据；
- 不应继续把“无法证明物理点击”当成整个方向的阻塞条件。

## 10. 下一步的合理完成标准

进入代码前，第一阶段应以以下标准为边界：

1. 新接口能表达 resolved、input required 和 denied；
2. 状态机不允许从 proposed 直接跳过 decision 去 commit；
3. 现有 interactive、delegated、preauthorized 和 replay 都通过同一 resolver 边界；
4. canonical JSON 无迁移；
5. 现有 approve/commit 工具行为和回归测试保持不变；
6. 文档明确 Codex adapter 与通用 MCP adapter 是平级实现。

达到这里以后，再开始一调用编排，风险最可控，也最容易判断是否真的减少了摩擦。

