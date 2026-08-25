# RouteLedger 0.10.9 Agent 回归反馈整理

> 状态：0.10.10 候选实现已完成，自动化回归通过；待构建发布产物及隔离工程复验
>
> 记录日期：2026-08-25
>
> 修复分支：`fix/agent-contract-regressions-0.10.10`
>
> 回归项目：`D:\Program\文档\RouteLedger-Agent-Test`

## 1. 测试背景

- 使用 RouteLedger Plugin `0.10.9` 从零重建测试项目。
- `contentLocale=zh`。
- Mission Control 始终为 `stopped`，未打开 UI。
- 底层 Version、Deferred、L3 admission、digest 校验、approval artifact 和提交链均可正常执行。

因此，本轮问题集中在 **Agent 引导响应契约**，不是 canonical 数据、生命周期状态机或 L3 安全机制失效。

## 2. 待修复问题与优先级

| 优先级 | 问题 | 影响 | 初步复杂度 |
| --- | --- | --- | --- |
| P0 | `next_action` 与 transition guide 缺少完整可执行输入 | Agent 无法按推荐动作直接继续，违反 Next Action Contract | 中 |
| P0 | `propose_l3_route_change` 未返回统一的 confirmation/execution envelope | proposal 已落盘但引导停在读取 proposal，形成流程死路 | 中 |
| P2 | `configure_binding` 成功响应混用写入前计划与写入后事实 | 同一响应短暂自相矛盾，但重新 inspect 后恢复 | 小 |

前两项都直接中断 Agent 自动编排，应作为同一版本的主要修复；第三项只修正时间语义和响应一致性，不扩大为 binding 重构。

## 3. P0：Next Action Contract 不完整

### 3.1 已复现的表现

#### V1 已关闭、V2 为 ready

`next_action` 返回：

- `actionType: advance_to_version`
- `requiresL3Approval: true`
- 缺少 `recommendedTool`
- 缺少 `toolInput`

`get_version_transition_guide` 虽能补充推荐工具，但投影后的 `toolInput` 只有 `operation` 和 `expectedRouteLedgerRoot`，缺少可由当前状态确定的：

- `projectId`
- `fromVersionId`
- `versionId`

#### 路线末尾 Version 已关闭

`next_action=create_version` 的推荐输入缺少：

- 可确定的 `projectId`
- 必须由 Agent/用户补充的 `title`
- 用于明确声明缺口的 `requiredInputs: ["title"]`

空路线首次创建 Version 的分支也存在同类缺口，应一并覆盖，避免只修路线末尾分支。

### 3.2 静态定位

- `packages/core/src/application/current-context-query.ts` 中，`advance_to_version` 分支只构造动作类型、说明和目标 ID，没有构造 `recommendedTool` 与 `toolInput`。
- 同文件的空路线 `create_version` 分支没有工具信息；路线末尾分支虽有 `recommendedTool`，但没有 `toolInput` 和 `requiredInputs`。
- `CurrentContextNextAction` 把 `recommendedTool`、`toolInput` 设计为可选，且顶层没有 `requiredInputs`，现有类型无法约束所有可执行分支。
- `VersionTransitionGuideStep` 当前只包含 `recommendedTool`、`actionType` 等说明字段，没有 `toolInput` 或 `requiredInputs`，所以 guide 的核心模型无法携带精确调用参数。后续公共工具投影只能补工具别名和根目录，无法恢复 project/version 语义参数。

这与回归现象完全一致，反馈成立。

### 3.3 修复目标

- 所有“可立即调用”的 next action/guide step 必须返回：
  - 公共 `recommendedTool`
  - 完整 `toolInput`
  - 当前状态已知的 `projectId`、目标 ID、来源 ID 和 `expectedRouteLedgerRoot`
- 需要 Agent 或用户新增内容时，不伪造值；使用 `requiredInputs` 明确列出，例如 `title`、`reason`。
- `advance_to_version` 的推荐输入至少应包含：

  ```json
  {
    "operation": "propose_version_advance",
    "projectId": "<project-id>",
    "fromVersionId": "<closed-current-version-id>",
    "versionId": "<ready-next-version-id>",
    "expectedRouteLedgerRoot": "<bound-root>"
  }
  ```

- `create_version` 的推荐输入至少应包含 `operation`、`projectId`、`expectedRouteLedgerRoot`，并声明 `requiredInputs: ["title"]`。
- 只读 guide 不创建 proposal；本次只增强返回信息。

### 3.4 验收场景

至少覆盖：

1. 空路线 -> `create_version`。
2. 已关闭的顶层路线末尾 -> `create_version`。
3. V1 `close`、直接后继 V2 `ready` -> `advance_to_version`。
4. 对同一状态调用 `get_version_transition_guide`，其 ready step 具有同等完整的执行输入。
5. 缺少 `title` 等不可推导字段时，必须出现在 `requiredInputs`，不能以缺字段的 toolInput 冒充“可直接执行”。
6. compact 投影不得裁掉上述执行必需字段。

## 4. P0：`propose_l3_route_change` 响应信封不一致

### 4.1 已复现的表现

启动 V1 时，`propose_l3_route_change` 只返回原始 proposal 实体，实体自身为 `status: pending`；没有：

- 顶层 `status: confirmation_required`
- `proposalPersisted: true`
- `pendingOperationId`
- `recommendedNextActions`
- 可直接调用的 `execute_admitted_proposal` 输入

随后 `next_action -> get_l3_proposal` 仍只读取并重复 proposal，无法告诉 Agent 如何继续。手工使用 proposal ID 和 digest 调用执行入口则能正常提交。

### 4.2 静态定位

- `packages/mcp/src/capabilities/l3-tools.ts` 的通用 `propose_l3_operation` 处理器直接把 `service.proposeL3Operation(...)` 的原始实体放入 `data`。
- 对外重命名为 `propose_l3_route_change` 时只改了工具名称和描述，没有增加响应适配。
- `propose_version_structure_change` 已有专用的 persisted-proposal adapter，会生成 `confirmation_required` 和后续执行动作；通用 route-change 入口没有进入该路径。
- 现有测试仍把 `proposed.data.id` 当作标准返回，实际上固定了旧的原始实体形态，缺少跨提案入口的一致性断言。

这解释了为什么底层提案与提交正常，而 Agent 引导层形成死路。

### 4.3 修复目标

- 成功持久化 proposal 后，三个公共提案入口使用一致的顶层语义：
  - `status: confirmation_required`
  - `proposalPersisted: true`
  - `pendingOperationId`
  - `digest`
  - `proposal`
  - `recommendedNextActions`
- 首选动作是公共工具 `execute_route_change` 的 `execute_admitted_proposal`，输入完整包含：
  - `operation`
  - `projectId`
  - `pendingOperationId`
  - `expectedOperationDigest`
  - `expectedRouteLedgerRoot`
- approve/reject/commit 分段入口继续保留作兼容、诊断和特殊 Host 使用。
- `next_action` 遇到 pending proposal 时，也必须提供恢复执行或拒绝所需信息，不能只推荐再次读取同一个实体。

### 4.4 验收场景

1. `start_version` 经 `propose_l3_route_change` 返回统一 confirmation envelope。
2. 返回的首选执行动作可原样调用并提交成功。
3. proposal 已存在时，`next_action` 能从 pending 状态继续，不形成 `next_action <-> get_l3_proposal` 循环。
4. digest 不匹配、Host 不准入、proposal stale 等原有 fail-closed 行为保持不变。
5. 结构变更和生命周期变更入口的既有信封保持兼容。

## 5. P2：`configure_binding` 成功响应的时间语义矛盾

### 5.1 已复现的表现

同一次成功响应中：

- `filesystemEffects` 表示 `.routeledger/config.json` 已创建。
- `bindingPlan.checks/risks` 仍表示文件不存在。
- 再调用 `inspect_runtime` 后状态正确。

### 5.2 静态定位

binding 激活成功响应会基于实时 runtime 构造 `activeBinding`，但 `activatedBindingPlan` 是从写入前的 `pendingRebind.bindingPlan` 展开而来。代码覆盖了 status、currentBinding 和后续动作，却没有重算或标注原有 `checks/risks` 的时间点，因此一个对象里混合了写入前计划和写入后事实。

### 5.3 修复目标

采用最小改动解决歧义，优先选择下列一种稳定契约：

- 成功后重新计算 checks/risks；或
- 明确把原计划命名/标注为 `preActivationPlan` / `evaluatedBeforeActivation`，并让当前事实只出现在 `activeBinding` 与 `filesystemEffects`。

不需要改变 binding 的落盘、rebind 或 restart 机制。

### 5.4 验收场景

1. 新建 workspace config 后，成功响应不再同时声称文件存在与不存在。
2. 已存在 config 的激活响应仍准确。
3. 响应与紧随其后的 `inspect_runtime` 在当前事实层一致。

## 6. 已确认改善与无需回归重做的范围

- compact 响应显著缩小，常规 `next_action` 可约为 825 字节。
- `agent_only` 初始化不再返回无关 README 人类入口建议。
- Deferred 缺少下游 Version 时，三步恢复计划完整有效。
- `pendingOperationId`、digest 和新 Version ID 的绑定路径可实际执行。
- Deferred 创建、到期 gate、review/activate、Todo 转换正常。
- `prepare -> start -> complete -> close -> advance` 底层生命周期正常。
- Host admission、digest 校验、approval artifact 和提交链正常。
- 中文项目内容及约束正常保存。

这些能力应做针对性防回归，不需要在本轮重新设计。

## 7. 建议实施顺序

1. 先为三组原始复现场景补契约测试，固定缺失字段和死路行为。
2. 统一 next action 与 transition guide 的 executable action 数据结构及公共工具投影。
3. 统一 `propose_l3_route_change` 的 confirmation/execution envelope，并补 pending proposal 恢复动作。
4. 最后修正 binding 计划快照的时间语义。
5. 运行相关包测试、typecheck/lint、插件 smoke，再在隔离测试工程做一次无 UI 回归。

## 8. 测试工程最终状态

### 8.1 0.10.10 实施结果

- `next_action` 与 transition guide 已补齐状态可知的项目、来源 Version、目标 Version 和绑定根目录输入；需要新内容的分支通过 `requiredInputs` 声明缺口。
- 公共 `propose_l3_route_change` 已返回统一 confirmation envelope；pending proposal 的 `next_action` 可直接恢复到 `execute_admitted_proposal`。
- binding 激活成功后重新计算计划，`checks/risks` 与写入后的文件状态一致。
- 相关契约测试、全量测试、typecheck 与 lint 作为本候选版本的发布前验证项。

### 8.2 原 0.10.9 测试工程状态

- V1：`close`
- V2：`close`
- 开放 Todo：0
- 未处理 Deferred：0
- 待处理 L3 proposal：0
- 中文项目约束：有效
- Mission Control：未启动
- RouteLedger 落盘文件：56 个

本轮不为复现而继续改动该测试工程。
