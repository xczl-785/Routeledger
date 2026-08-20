# Agent 多角度测试反馈：临时修复分析

> 状态：临时分析，尚未批准为产品契约或实施计划。
>
> 创建时间：2026-08-20（Asia/Hong_Kong）
>
> 所在分支：`fix/agent-test-feedback`
>
> 删除条件：相关修复完成并合入正式 capability 文档与自动化测试后删除；如果方案被否决，也应直接删除。

## 1. 范围与结论

本次反馈说明 RouteLedger 的核心状态机、JSON-first 分片、Git 冲突拒绝、L3 审批审计和恢复边界总体成立。需要处理的主要不是核心正确性，而是公开响应契约、字段作用域和仓库使用体验。

反馈中的一次约 132 秒 `prepare` 延迟由宿主权限申请造成，用户当时未看到授权提示。本分析明确将其排除，不作为 RouteLedger 性能缺陷，不安排超时修复。

建议优先级：

| 优先级 | 主题 | 判断 |
| --- | --- | --- |
| P0 | 生命周期提案返回契约不一致 | 确认缺陷，应优先修复 |
| P1 | 绑定落盘副作用表达不清 | 行为合理，公开措辞和结果应修复 |
| P1 | `storage.conflict` 与 `json_invalid` 的诊断模型割裂 | 内部语义合理，公开模型应统一 |
| P1 | `sourceTreeState` 作用域容易误解 | 字段命名缺少 build/runtime 作用域，应兼容性修复 |
| P1 | Windows JSON 行尾提示 | 宿主项目缺少托管 attributes，应提供低侵入修复 |
| P2 | 幂等重放返回历史快照 | 正确性成立、易用性不足，先澄清再考虑双视图 |
| P2 | 审计文件增长 | 需要先量化，不应直接牺牲分片与审计完整性 |

## 2. 已验证的正向行为

- 绑定逻辑能拒绝把插件缓存 cwd 当成宿主项目根目录。
- `content_locale` 必须由用户明确选择，不能使用 `auto` 猜测。
- Todo、Deferred、Constraint 和 Version 生命周期均能完整运行。
- close gate 正确覆盖 Version 状态、开放 Todo、Deferred 路由/复审、Constraint 和 residual audit。
- L3 proposal、approval artifact、digest、commit 和 replay 均留下持久审计。
- 不同对象并行新增能够自动合并；同一对象并行修改把冲突限制在共享 Todo/Work Item 文件。
- canonical JSON 无效时写操作 fail closed；`git merge --abort` 后运行时可以立即恢复。

这些行为不应在修复过程中回退。

## 3. 问题分析与建议

### 3.1 会话绑定会创建 `.routeledger/config.json`

#### 现状

`activate_routeledger_binding` 的公开描述是 “Activate an explicit MCP binding”，容易被理解为纯内存会话操作。但绑定和存储初始化默认允许创建 workspace config：

- `packages/mcp/src/workspace-config.ts` 的 `writeWorkspaceConfig` 会创建 `.routeledger/config.json`。
- `resolveWorkspaceConfigSync(... autoCreate: true)` 会触发创建。
- `packages/mcp/src/binding.ts` 和 `packages/mcp/src/json-first-storage.ts` 默认 `autoCreateWorkspaceConfig=true`。
- 正式文档已经说明 activation 可能创建或规范化 binding config，且不会创建 canonical project data；问题主要存在于工具描述和响应可见性。

#### 判断

创建配置是当前绑定模型的一部分，不建议改成完全不落盘。否则新 registry 无法通过相同入口稳定解析 `workspaceRoot -> dataRoot`，并会增加会话内绑定与后续会话绑定不一致的风险。

#### 建议修复

1. 将工具描述改为明确的效果说明，例如：
   - “Activate an explicit MCP binding and ensure the workspace binding config exists.”
   - warning 明确 “may create `.routeledger/config.json`; does not initialize canonical project data”。
2. 在返回中增加结构化副作用：
   - `workspaceConfig.path`
   - `workspaceConfig.effect: created | existing | normalized`
   - `canonicalProjectCreated: false`
3. `plan_routeledger_binding` 在缺少 config 时明确预告下一步将创建该文件，而不仅仅返回 `needs_init`。

#### 测试

- activation 前 config 不存在：返回 `effect=created`，文件存在，canonical `project.json` 不存在。
- config 已存在：返回 `effect=existing`，内容不被无故覆盖。
- 高置信绑定切换未确认：不得创建目标 config。

### 3.2 生命周期接口返回不一致

#### 现状

创建 Version 的路径通过 `CONFIRMATION_REQUIRED` 和 `buildPersistedProposalResponse` 统一返回：

- `status: confirmation_required`
- `proposalPersisted: true`
- `pendingOperationId`
- approve/reject 的精确下一步输入

但 `closeVersionWorkflow`、transition/start workflow 在 `mode=propose` 且 gate 通过后，会先持久化 pending proposal，再沿用 preflight 的 `status: ready`。其结果类型只允许 `ready | blocked`（或加 `noop`），输出 schema 也没有 `recommendedNextActions`。

因此 `ready` 同时表示两种不同事实：

1. dry-run 表示“门已通过，可以提案”；
2. propose 表示“提案已经创建，正在等待决策”。

这是实质性的状态契约缺陷。

#### 建议修复

采用一个统一状态机：

| 状态 | 含义 | 是否写入 |
| --- | --- | --- |
| `blocked` | gate 未通过 | 否 |
| `ready` | dry-run 通过，可以创建 proposal | 否 |
| `confirmation_required` | pending proposal 已持久化，等待 approve/reject | 是 |
| `noop` / `no_op` | 目标已满足，不需要写入 | 否 |

具体修改：

1. 扩展 Core workflow result 类型，在成功创建 proposal 后返回 `confirmation_required` 和 `proposalPersisted: true`。
2. 在 MCP 层抽取共享的 persisted-proposal response decorator，供 Version creation、transition、advance、close、shutdown 使用。
3. 下一步必须引用公开工具面，而不是让 Agent 猜内部工具：
   - approve：`execute_route_change` + `operation=approve_l3_operation` + `projectId/pendingOperationId`
   - reject：`execute_route_change` + `operation=reject_l3_operation` + `projectId/pendingOperationId/reason`
4. approval 成功后再返回 commit 的完整输入（包含新产生的 `approvalArtifactId`）。
5. 同时统一 `noop` 与 `no_op` 拼写；这是兼容性变更，需要决定保留别名还是在下一个次版本直接统一。

#### 测试

- 对 creation、transition/start、advance、close、shutdown 做表驱动协议测试。
- 每个 `mode=dry_run` 的 passing gate 必须是 `ready` 且无 pending proposal。
- 每个 `mode=propose` 的成功结果必须是 `confirmation_required`、包含 proposal ID 和 approve/reject 输入。
- 重复读取上下文不得把已有 pending proposal误认为新的 `ready`。

### 3.3 幂等 create 重放返回首次历史快照

#### 现状

`executeOrdinaryWrite` 将首次命令的 `result` 原样保存进 `OrdinaryWriteReceipt`。同一 `commandName + idempotencyKey + inputDigest` 重放时，直接 clone 该结果，并添加 `idempotency.replayed=true`。

所以 Todo 在首次创建时为 `wait`，后来关闭后再次重放 create，返回仍是首次提交时的 `wait`。这是确定性的 exactly-once 回执语义，不是数据回退，也不会重新打开 Todo。

#### 方案选择

1. **只返回当前状态**：易理解，但破坏重放结果稳定性，不推荐。
2. **保持历史结果，只补充语义标记和刷新动作**：改动小、兼容性好，建议先做。
3. **双视图返回**：同时提供 immutable committed result 和 fresh current resource，体验最好，但需要逐命令定义当前资源投影。

#### 推荐方案

分两阶段：

第一阶段（P1/P2 小修）：

- 保持 receipt 中的历史结果不变。
- 扩展 idempotency metadata：
  - `resultScope: original_commit`
  - `originalCommittedAt`
  - `currentStateRefreshed: false`
- 重放响应附精确查询下一步，明确调用 `inspect_route_progress` 获取当前上下文。

第二阶段（需要单独设计批准）：

- 返回 `committedResult` 与 `currentResource` 两个命名清晰的视图。
- 为 create/close Todo、Deferred、Constraint 分别实现 current projection，不能在通用函数里靠不稳定字段猜对象类型。

#### 测试

- 创建 Todo、关闭 Todo、重放创建：历史结果仍为 `wait`，metadata 明确历史语义，当前查询为 `close`。
- key 相同但输入 digest 不同仍必须 fail closed。
- 并发首次调用只能产生一个 receipt。

### 3.4 审计文件数量增长较快

#### 现状

canonical JSON 按对象分片保存：Version、Work Item、Todo、Deferred、Constraint、Event、Pending Operation、Approval Artifact、ordinary write receipt 都有独立文件；Event 还按年月分目录。该设计换取了：

- 不同对象并行新增时冲突概率低；
- L3 决策链和普通写入幂等证据可独立审计；
- Git 能精确显示语义竞争的对象。

测试反馈中的“69 个文件、2121 行”目前缺少一次操作前后的基线，不能确定是单次 lifecycle commit，还是此前多次未提交 RouteLedger 操作的累计结果。当前编码器会遍历完整 aggregate，但相同内容不会被 Git 计为修改；因此应先测量实际新增/修改对象构成。

#### 不建议立即采用的方案

- 把全部 Event 或 Receipt 合并成单个大 JSON：会显著放大 Git 冲突范围，直接损害本次测试确认的 JSON-first 优势。
- 无证明地删除或压缩历史审计：会破坏 digest、proposal、artifact、receipt 的可追溯性。

#### 建议修复

1. 增加 footprint 基准测试或诊断脚本，分别测量 Todo create/close、Deferred 全链路、单个 L3 proposal/approve/commit、完整 Version close 的：
   - 新增文件数
   - 修改文件数
   - 新增字节数
   - 各对象类型占比
2. 为单次命令设“预期文件预算”，只对异常增长报警，不把审计数量本身判错。
3. 优先检查 payload 重复和大段 human review 文本是否可用 digest/reference 去重，而不是合并分片。
4. 如果长期项目仍不可接受，再单独设计带 hash manifest 的归档/压实机制；该机制必须保证历史可验证并明确 Git merge 策略。

#### 已落地的测量基线（2026-08-20）

新增 `pnpm measure:audit-footprint`，在隔离临时项目中逐步测量 canonical JSON，而不是把此前未提交操作累计量误算为一次命令。当前基线如下：

| 操作 | 新增文件 | 修改文件 | 新增字节 | 净增字节 |
| --- | ---: | ---: | ---: | ---: |
| create Todo | 5 | 0 | 5564 | 5564 |
| close Todo | 3 | 2 | 4391 | 4429 |
| create Version proposal | 2 | 0 | 2573 | 2573 |
| approve Version proposal | 2 | 0 | 4002 | 4002 |
| commit Version proposal | 5 | 3 | 3909 | 4023 |

一次 Version 创建的 proposal → approve → commit 合计涉及 14 个新增文件和 3 个被修改文件；其中 commit 阶段的 8 个变化文件由 4 个 Event、2 个 Version、1 个 Pending Operation 和 1 个 Approval Artifact 构成。该结果支持“先保留分片与审计完整性”的判断，也说明反馈中的 69 文件更可能包含多次累计操作，后续可在 CI 中基于该脚本增加预算报警。

### 3.5 Windows Git 的 LF -> CRLF 提示

#### 现状

RouteLedger 自身仓库已经有 `* text=auto eol=lf`，但插件写入的是任意宿主项目，不能假设宿主根目录存在等价规则。因此 canonical JSON 虽以 `\n` 写出，仍可能受宿主 Git 属性和 `core.autocrlf` 影响。

#### 建议修复

优先让 RouteLedger 在自己的数据目录内管理 `.routeledger/.gitattributes`，而不是擅自修改宿主根 `.gitattributes`。候选内容应覆盖根 config 和所有下级 JSON，例如：

```gitattributes
*.json text eol=lf
**/*.json text eol=lf
```

在实现前需要用 Git 的 `check-attr` 和 Windows checkout 测试确认递归规则。公开响应应把创建 attributes 文件列入 filesystem effects。

如果团队不接受 RouteLedger 管理 `.gitattributes`，次选方案是在 init 结果中返回可复制的根规则 `.routeledger/**/*.json text eol=lf`，但这不能自动消除警告。

### 3.6 Git 冲突时 `storage.conflict=null`

#### 现状

这里存在两个不同的内部概念：

- `storage.conflict` / `mode=conflict`：canonical JSON 与 SQLite read model 的双源冲突，或多个 SQLite 项目冲突。
- `mode=json_invalid` / `jsonError`：canonical JSON 无法解析或验证；Git 冲突标记只是造成 JSON 无效的一种原因。

因此当前内部判断没有错，但公开字段 `conflict` 太宽泛，调用方自然会把它理解为包括 Git merge conflict。

#### 建议修复

采用向后兼容的统一诊断层，不要在 JSON 解析失败时简单伪造现有 `conflict`：

```text
storage.blockingIssue = {
  kind: canonical_json_invalid | json_sqlite_divergence | multiple_sqlite_projects | write_in_progress,
  source: canonical_json | sqlite | writer_lock,
  code,
  message,
  details
}
```

- 保留旧 `conflict/jsonError/sqliteError/writeLock` 字段至少一个兼容周期。
- 将旧 `conflict` 在描述和 schema 中改称 “JSON/SQLite divergence details”。
- 如果未来需要识别 Git 冲突，只能在检测到真实 conflict markers 或宿主 Git unmerged entries 时返回 `likelyGitMergeConflict=true`；不能把所有 JSON 语法错误都叫 Git 冲突。

#### 测试

- 普通 JSON 语法损坏：`kind=canonical_json_invalid`，不得声称 Git 冲突。
- 含 conflict marker 的 JSON：仍 fail closed，可在证据充分时标记 likely Git conflict。
- JSON/SQLite revision 分叉：`kind=json_sqlite_divergence`。
- 兼容字段与 unified field 必须指向同一底层错误。

### 3.7 `sourceTreeState: clean` 的作用域不清楚

#### 现状

`RuntimeIdentity` 的源码注释明确该结构识别“正在执行的 MCP server bytes”；`sourceTreeState` 来自构建 provenance，表示构建输入树是否干净。插件制品里的 `clean` 不代表宿主工作区 Git 状态。

问题是公开 JSON 只出现通用名称 `sourceTreeState`，调用方看不到源码注释，容易理解成当前宿主项目。

#### 建议修复

采用兼容性迁移：

1. 新增明确结构：
   - `runtimeIdentity.buildProvenance.sourceTreeState`
   - `runtimeIdentity.buildProvenance.scope: runtime_build_inputs`
2. 暂时保留顶层 `sourceTreeState` 作为 deprecated alias。
3. 如需宿主 Git 状态，应另设 `workspaceVcsState`，且只在显式检查 Git 后返回；绝不能复用 build provenance。
4. 更新 `inspect_runtime` 的字段描述和 capability 文档。

#### 测试

- 插件 runtime build clean、宿主 workspace dirty：build provenance 仍为 clean，但 scope 明确，且不得生成假的 workspace 状态。
- source/package/plugin 三种 artifact kind 均保持现有 attestation 语义。

## 4. 建议实施顺序

### 第一批：公开契约一致性

1. 统一 lifecycle workflow status 和 persisted proposal 下一步。
2. 明确 binding 的 filesystem effects。
3. 增加统一 `storage.blockingIssue`。
4. 增加 scoped build provenance，并保留兼容 alias。

这一批主要是 additive/contract 修复，风险可控，但需要同步：Core 类型、MCP output schema、agent response normalization、tool description contract、source tests 和 bundled plugin runtime。

### 第二批：宿主仓库体验

1. 设计并验证 `.routeledger/.gitattributes` 托管规则。
2. 为幂等 replay 增加历史结果语义 metadata 和刷新动作。
3. 增加 audit footprint 测量与预算。

### 第三批：需单独批准的设计

1. 幂等响应双视图 `committedResult/currentResource`。
2. 审计归档或压实协议。
3. 旧字段和旧 status 拼写的移除时间表。

## 5. 验收边界

修复完成后应满足：

- Agent 能仅凭一次 lifecycle proposal 响应判断“是否已写入 proposal”以及 approve/reject 的精确输入。
- Agent 在绑定前能预知会创建哪些文件，绑定后能确认实际 filesystem effects。
- 幂等重放不会被误解为对象当前状态，也不会破坏历史结果稳定性。
- 所有 storage 阻断状态都有一个统一、互斥、可机器判断的 blocking issue。
- build provenance 与宿主工作区状态在命名和结构上不可混淆。
- Windows 宿主项目的 canonical JSON 有可验证的 LF 策略。
- 审计规模优化不得降低 append-only 证据、exact authorization 或不同对象并行合并能力。

## 6. 当前不做的事项

- 不处理由宿主权限申请造成的约 132 秒等待。
- 不直接减少或删除现有审计文件。
- 不把所有 JSON 解析错误都标记为 Git 冲突。
- 不改变 `content_locale` 必须由用户明确确认的规则。
- 本文仍是临时分析记录；已实现的行为以源码、测试和同步后的插件 runtime 为准，不把本文当作长期公开契约。

## 7. 本分支已实施状态（2026-08-20）

- lifecycle proposal 成功后统一返回 `confirmation_required`、`proposalPersisted=true` 和 approve/reject 精确输入。
- 绑定描述明确 `.routeledger/config.json` 落盘，并在结果中报告 filesystem effects 与 `canonicalProjectCreated=false`。
- 幂等重放保留原提交快照，同时返回 scope、提交时间、刷新状态以及当前上下文查询动作。
- storage 增加统一、互斥的 `blockingIssue`，保留旧字段兼容。
- runtime identity 增加 `buildProvenance.scope=runtime_build_inputs`，保留旧 `sourceTreeState` alias。
- workspace/data 的 `.routeledger/.gitattributes` 自动托管 JSON LF 规则。
- 新增 `pnpm measure:audit-footprint`，完成 Todo 与 Version L3 链路的首轮基线测量。
- 源码、测试和 `plugins/routeledger/runtime` 已同步；本分支不做 merge、commit 或 push。
