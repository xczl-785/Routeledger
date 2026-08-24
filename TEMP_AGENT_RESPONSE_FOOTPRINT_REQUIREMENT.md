# RouteLedger Agent 响应体积治理需求与实施规划

> 状态：实施中；高收益批次（基线、高频读取、Todo 回执、L3 预算、MRTR transport）已完成
>
> 范围：MCP 公共工具的 `compact | standard | audit` 响应、stdio transport 与体积回归测试
>
> 本稿保留为实施追踪，正式能力文档和发布记录完成后删除。
>
> 来源：[TEMP_AGENT_FEEDBACK_2026-08-24.md](TEMP_AGENT_FEEDBACK_2026-08-24.md) 第 2 项反馈与真实测试工程测量。

## 0. 当前实施结果

隔离 ready 项目的 minified structured envelope 已从以下基线降至：

| operation | compact 实施前 | compact 当前 | standard 当前 | compact/standard |
| --- | ---: | ---: | ---: | ---: |
| `runtime` | 3,982 B | 1,464 B | 3,728 B | 39.3% |
| `get_current_context` | 3,930 B | 1,461 B | 3,462 B | 42.2% |
| `next_action` | 3,358 B | 1,353 B | 2,911 B | 46.5% |
| `list_versions` | 935 B | 591 B | 592 B | 99.8% |
| 空 `list_l3_proposals` | 269 B | 110 B | 111 B | 99.1% |

已完成的代表流程：

- runtime、next action、current context 的 operation-aware compact profile；
- Version/L3 空列表不再添加重复 summary/delta；
- Todo create/close 回执不重复完整 WorkItem；
- L3 propose/read/commit compact-only 链均不超过 4 KiB；
- MCP 2026/MRTR 显式 compact 使用不超过 256 B 的 terse text；
- legacy/standard 继续完整 JSON 文本镜像；
- 隔离 footprint 脚本、预算集成测试和正式能力文档已加入。

## 1. 需求摘要

RouteLedger 需要把 Agent tool response 从“提供 compact 选项”提升为“具备可验证的响应体积契约”。

本需求解决以下问题：

1. compact 在常见小响应上可能比 standard 更大；
2. runtime、项目、实体和操作信息在 data、meta、summary 中重复；
3. `payloadBytes` 只统计 data/error，不能代表 structured envelope、transport 或模型上下文成本；
4. stdio 同时返回完整文本 JSON 和 `structuredContent`，存在兼容性驱动的重复；
5. current-context 的 8–64 KiB 业务预算不覆盖其他工具，也不覆盖 MCP envelope；
6. 现有测试只证明大型 audit fixture 能被裁剪，不能证明真实 Agent 循环足够小。

完成后，RouteLedger 应在不牺牲 blocker、用户决策、精确 ID/digest 和可执行下一步的前提下，使普通 compact 调用主要落在 1 KiB 内，并对复杂上下文及 L3 响应设置明确硬上限。

## 2. 现场评估

### 2.1 实际测试环境

- 插件：RouteLedger Codex plugin `0.10.6`；
- runtime：JSON-only；
- 测试项目：一个 ready Version、零 Todo、零 Deferred、一条中文 project constraint、零 pending L3 proposal；
- 测试方式：只读调用，没有启动 Version 或修改任何 canonical 实体。

### 2.2 当前基线

以下字节数均按 UTF-8 JSON 序列化测量：

| operation | detail | data/error 指标 | structured envelope | 文本 content | 完整 CallToolResult |
| --- | --- | ---: | ---: | ---: | ---: |
| `runtime` | compact | 3,526 B | 3,982 B | 5,068 B | 9,731 B |
| `runtime` | standard | 3,265 B | 3,959 B | 5,002 B | 9,635 B |
| `get_current_context` | compact | 3,195 B | 3,930 B | 5,267 B | 9,811 B |
| `get_current_context` | standard | 2,884 B | 3,857 B | 5,160 B | 9,627 B |
| `next_action` | compact | 2,902 B | 3,358 B | 4,461 B | 8,340 B |
| `next_action` | standard | 2,599 B | 3,293 B | 4,362 B | 8,172 B |
| `list_versions` | compact | 825 B | 935 B | 1,302 B | 2,450 B |
| `list_l3_proposals` | compact | 159 B | 269 B | 380 B | 769 B |

结论：三个最高频 Agent 循环读取中，compact 在所有测量层级都大于 standard。当前实现没有兑现 compact 的相对体积语义。

### 2.3 代码边界

当前管线为：

```text
Core/application result
  -> tool handler / composite normalization
  -> public reference projection
  -> applyAgentResponseDetail
  -> ToolResponse envelope
  -> toCallToolResult
  -> content(text JSON) + structuredContent
  -> JSON-RPC / host context
```

主要所有权：

- `packages/core/src/application/current-context-query.ts`
  - 仅 current-context 的业务窗口和 8–64 KiB data budget；
- `packages/mcp/src/response-detail.ts`
  - 当前三态投影、`agentSummary`、`delta`、`omittedSections` 和 `payloadBytes`；
- `packages/mcp/src/index.ts`
  - 公共工具组合、normalization、runtime meta 和 detail 调用位置；
- `packages/mcp/src/stdio-server.ts`
  - MCP CallToolResult、文本镜像、structuredContent 与协议兼容；
- `packages/mcp/src/testing/*`
  - registry、stdio、MRTR、L3 和当前 response-detail 契约测试。

### 2.4 根因

1. 通用投影器只识别少数键名和 route record，无法表达每个 operation 的最小充分语义；
2. runtime 的主要信息在 `data` 顶层，未命中 `meta.runtimeContext` 的专用压缩；
3. compact 无条件增加 summary/delta，短响应反而变大；
4. recommended actions 保留了大量可由 schema 或 toolInput 推导的说明字段；
5. null、空数组、重复路径和重复身份信息缺少按语义清理；
6. 体积测试只测 data 或构造型 fixture，没有覆盖完整 envelope 和 transport；
7. 文本镜像是 MCP 兼容策略，当前没有根据宿主能力分流。

## 3. 目标和非目标

### 3.1 目标

- 建立统一、可自动测试的字节统计口径；
- 为所有公共 operation 指定响应复杂度等级与三态预算；
- 保证 compact 永不大于同场景 standard；
- 为高频 Agent loop operation 提供专用 compact profile；
- 保证 compact 可独立完成普通写入和完整 L3 状态推进；
- 保持 standard 默认兼容响应；
- audit 不丢失完整诊断和授权证据；
- 对超限列表和审计材料使用窗口、分页、cursor 或 artifact/reference；
- 分离业务响应治理和 transport 兼容，允许独立回滚。

### 3.2 非目标

- 不改变 Core 领域状态机、gate 规则或 L3 安全模型；
- 不修改 canonical JSON schema 或迁移现有项目数据；
- 不增加第四种 `minimal` detail；
- 不以静默截断 blocker、风险、用户决策或精确授权标识换取体积；
- 不在第一阶段引入跨调用缓存一致性协议；
- 不承诺图片、二进制 artifact 或显式大文档读取遵守普通 JSON 响应上限。

## 4. 统一测量口径

### 4.1 单位

- `B`：UTF-8 字节；
- `KiB`：1,024 B；
- 所有预算使用 minified `JSON.stringify` 等价结果，不把 pretty-print 空白算入 structured 业务预算；
- transport 指标按实际 CallToolResult 序列化结果测量，包含文本镜像产生的空白。

### 4.2 四层指标

| 指标 | 计算范围 | 所有者 | 是否作为硬门禁 |
| --- | --- | --- | --- |
| `businessBytes` | `data ?? error` | response profile 测试 | 否，诊断用 |
| `structuredEnvelopeBytes` | `ok + data/error + meta` | MCP registry 测试 | 是 |
| `transportResultBytes` | `content + structuredContent + isError + _meta` | stdio/MRTR 测试 | 是 |
| `modelVisibleBytes` | 宿主实际注入模型的内容 | host 集成/实测 | 发布前观测门禁 |

现有 `meta.payloadBytes` 在兼容期保留原语义。新的完整体积指标主要由测试与诊断脚本外部计算，不默认写入每次 compact 响应，以免指标本身增加上下文成本。

### 4.3 不设置字节最小值

响应没有强制字节下限。最小要求是语义完整：

- 状态；
- 当前调用涉及的精确实体 ID；
- blocker、风险和用户决策；
- 下一步 tool 与完整 `toolInput`；
- L3 所需 proposal、digest、authorization、artifact 与 replay 标识。

空列表、ACK 或无变化结果允许只有几十至几百字节。

## 5. 响应复杂度和预算

### 5.1 复杂度等级

| 等级 | 典型响应 |
| --- | --- |
| R0 | ACK、布尔/状态、空列表、无变化回执 |
| R1 | 单实体摘要、单个 next action、普通 Todo/Constraint 写入回执 |
| R2 | current context、小型实体列表、gate、Version structure/window |
| R3 | L3 proposal/approval/commit、复杂错误恢复、完整诊断和授权材料 |

### 5.2 structured envelope 预算

| 等级 | compact 目标 | compact 硬上限 | standard 目标 | standard 硬上限 | audit 硬上限 |
| --- | ---: | ---: | ---: | ---: | ---: |
| R0 | <= 400 B | 768 B | <= 1 KiB | 2 KiB | 8 KiB |
| R1 | <= 1 KiB | 1.5 KiB | <= 3 KiB | 4 KiB | 16 KiB |
| R2 | <= 1.5 KiB | 2 KiB | <= 6 KiB | 8 KiB | 32 KiB |
| R3 | <= 3 KiB | 4 KiB | <= 12 KiB | 16 KiB | 64 KiB |

硬上限是 circuit breaker，不是鼓励填满。超限必须显式选择以下措施之一：

- 缩小字段集合；
- 列表窗口化或分页；
- 返回 cursor；
- 返回 artifact/resource reference；
- 将 operation 重新评定为更高等级，并说明不可裁剪证据。

### 5.3 相对要求

- 所有场景：`compactStructuredBytes <= standardStructuredBytes`；
- standard 至少 1 KiB 且确有可省略区段时：`compact / standard <= 0.60`；
- standard 没有额外细节时，standard 与 audit 可以相等；
- 不要求通过填充字段制造三态大小差异；
- compact 超过目标但未超过硬上限时，测试记录 warning；超过硬上限时失败。

### 5.4 transport 和 Agent 循环要求

- legacy 文本镜像存在时，transport 单独记账，不用 structured 预算掩盖；
- 支持 structured-only/terse-text 的宿主，compact 的文本 content 目标不超过 256 B；
- 健康项目一次典型循环：`runtime + next_action + ordinary write receipt`：
  - model-visible 目标 <= 4 KiB；
  - 硬上限 <= 6 KiB；
- `get_current_context` 不应成为每次循环的强制调用；next action 足够时避免重复全上下文。

## 6. operation 初始分级

| 公共工具 / operation | compact 等级 | 必须保留 |
| --- | --- | --- |
| `inspect_runtime(runtime)` | R1；异常绑定可升 R2 | binding status/root、project identity、locale decision、非空诊断、Mission Control 决策、next action |
| `inspect_runtime(discover_roots/plan_binding)` | R2 | candidate identity/root、风险、用户决策、可执行 binding input |
| `inspect_runtime(mission_control_status)` | R1 | status、URL、用户决策、最小 action |
| `inspect_route_progress(next_action)` | R1 | action type、target、blocker/risk、L3 要求、完整 toolInput |
| `inspect_route_progress(get_current_context)` | R2 | project/current/next、当前 Todo、到期 Deferred、有效 Constraint、gate、pending L3、next action、截断信息 |
| closeout / doc drift | R2 | blocker、残余项、文档位置、可执行 action |
| Version list/window/gate/structure/guide | R1–R2 | 窗口、关系、gate、legal operation、target ID |
| L3 proposal list 空结果 | R0 | 空 items、hasMore/cursor（如有） |
| L3 proposal/detail/status | R2–R3 | exact IDs、digest、gate、authorization state、replay state |
| Todo/Deferred/Constraint 普通写入 | R1 | changed entity summary、idempotency/replay、next action |
| Version prepare/complete | R1–R2 | version state、gate/blocker、next action |
| proposal/approval/commit | R3 | proposal/digest/artifact/authorization/commit chain 的精确标识 |
| 输入/绑定/业务错误 | R1–R3 | canonical code、恢复状态、是否可重试、是否已写入、精确修复 input |

最终分级由自动基线矩阵校准，但任何 operation 升级等级都必须记录理由，不能仅因为当前实现过大。

## 7. 方案比较

### 方案 A：继续强化通用递归投影器

做法：扩展 `response-detail.ts` 的键名白名单、null 清理和数组裁剪。

优点：改动小、交付快。

缺点：

- 仍依赖偶然字段名；
- 无法可靠判断同名字段在不同 operation 中是否必要；
- 推荐动作、错误恢复和 L3 容易被错误裁剪；
- 后续新增 operation 会再次膨胀而不易察觉。

结论：可作为短期止血，不适合作为完整需求方案。

### 方案 B：operation-aware compact profile + 统一预算检查（推荐）

做法：

- 每类 operation 定义有类型、有语义的 compact profile；
- 共用 route record、action、error recovery、runtime binding 等投影构件；
- detail orchestrator 选择 profile；
- 最终统一执行空值规范、omission 记录和预算检查；
- standard 默认兼容，audit 完整保真。

优点：

- 最小字段集合可评审、可测试；
- 失败时能定位具体 operation/profile；
- 安全字段不会依赖通用递归猜测；
- 便于逐批迁移和回滚。

缺点：

- 初期需要为 operation 建立响应分类和 fixture；
- profile 与业务响应演进需要共同维护。

结论：作为主方案。

### 方案 C：全新 delta/reference 响应协议

做法：引入 snapshot digest、runtimeRef、since-token 和跨调用引用。

优点：长期压缩潜力最大。

缺点：

- 引入宿主状态、缓存失效和重放复杂度；
- 降低单次响应自足性；
- 与 RouteLedger 的恢复可靠性目标存在张力；
- 迁移和兼容成本高。

结论：本需求不采用；完成方案 B 后再根据数据决定是否立项。

## 8. 推荐架构

### 8.1 边界

```text
Core domain/application
  produces complete semantic result
        |
        v
MCP response profile layer
  selects operation-aware compact shape
  preserves standard/audit contracts
        |
        v
MCP response budget layer
  measures minified structured envelope
  reports test/diagnostic violation
        |
        v
Transport adapter
  chooses legacy mirrored text or capable-host terse text
  measures actual CallToolResult
```

- Core 不感知 `compact | standard | audit`；
- profile 层拥有 Agent 最小充分响应语义；
- budget 层只校验，不擅自删除安全字段；
- transport 层拥有 `content` 与 `structuredContent` 的兼容策略；
- host 集成测试拥有 model-visible 指标。

### 8.2 建议模块

在 `packages/mcp/src` 下建立明确的 response profile 边界，避免扩张为笼统 helpers：

```text
agent-response-profiles/
  runtime-response-profile.ts
  route-progress-response-profile.ts
  version-response-profile.ts
  work-response-profile.ts
  l3-response-profile.ts
  error-recovery-response-profile.ts
  response-profile-contract.ts
response-footprint.ts
response-detail.ts
```

`response-detail.ts` 缩减为 detail 选择和 orchestrator；`response-footprint.ts` 提供一致的 UTF-8 minified 测量函数和预算分类，不包含业务投影规则。

### 8.3 compact 公共形状原则

- 优先复用原始公开字段名，避免再套一层重复 DTO；
- 对 ACK/空列表不强制添加 `agentSummary` 和 `delta`；
- write receipt 只有在 delta 比原实体更短、更明确时才生成；
- runtime identity 只在 runtime audit、来源异常或校验失败时完整返回；
- meta runtimeContext 在成功响应中只保留下一次安全写入所需 root/project identity；
- action 必须保留确切 tool、toolInput、requiresUserDecision；
- description/requiredFields 仅在不能由 schema/toolInput 推导时保留；
- omission 按父区段合并，例如 `data.runtimeIdentity`，不枚举每个子字段；
- 空数组表示“已查询且为空”时保留；未知/未查询不能被错误转换为空数组；
- 有语义的 null 与字段缺失必须区分。

### 8.4 transport 兼容策略

MCP 的 structured content 兼容建议意味着不能立即全局删除文本镜像。分两步处理：

1. 第一阶段先缩小 structured envelope；即使镜像仍存在，总量也同步下降；
2. 第二阶段根据协议/宿主能力选择：
   - legacy 或未知客户端：保留完整 JSON 文本镜像；
   - 已验证消费 structuredContent 的 Codex/MRTR host：content 只放 <=256 B 的人类摘要；
   - standard/audit 默认保持旧行为，除非明确协商能力。

不能只以 `detail=compact` 推断客户端支持 structuredContent；能力必须来自协议协商、host profile 或明确 capability flag。

## 9. 现场基线与测试设计

### 9.1 新增自动测量入口

建议新增类似现有 audit footprint 脚本的临时工作区基准：

```text
scripts/testing/measure-agent-response-footprint.ts
```

脚本使用 `mkdtemp` 创建隔离 JSON-only 项目，完成后清理；不使用真实测试项目执行写入。

输出至少包含：

- scenario、tool、operation、detail、complexityClass；
- business、structured envelope、text、transport 字节数；
- compact/standard/audit 比率；
- omitted section 数量；
- 是否超过 target/hard limit；
- 是否仍具备下一次调用必需字段。

### 9.2 场景矩阵

| 场景 | 目的 |
| --- | --- |
| S0 unbound | 绑定错误和恢复动作 |
| S1 bound/uninitialized | 初始化与 locale 引导 |
| S2 initialized/no Version | 空路线和首个 Version 提案 |
| S3 ready Version | 高频 runtime/context/next action |
| S4 running with work | Todo/Deferred/Constraint 与 gate |
| S5 long route/many records | 窗口、分页、omission、预算边界 |
| S6 blocked gate/error | blocker 和可执行恢复输入 |
| S7 L3 proposal/approval/commit | 精确安全标识和审计差异 |
| S8 idempotency replay | replay receipt 与刷新建议 |
| S9 agent_only | Mission Control 与文档建议降噪 |

### 9.3 覆盖层级

- profile 单元测试：字段保留/删除和语义空值；
- registry 集成测试：三态 structured envelope 和预算；
- stdio 2025-11-25：legacy mirror 行为；
- MRTR 2026-07-28：capable-host 行为和 result metadata；
- Codex plugin smoke：生成 runtime 与源代码一致；
- 真实测试工程：仅只读回归 runtime/context/next action；
- L3：从 propose 到 commit 的 compact-only 完整推进测试。

### 9.4 必需断言

```text
compactStructuredBytes <= compactHardLimit
standardStructuredBytes <= standardHardLimit
auditStructuredBytes <= auditHardLimit
compactStructuredBytes <= standardStructuredBytes

if standardStructuredBytes >= 1024 and compactHasOmissions:
    compactStructuredBytes / standardStructuredBytes <= 0.60

compactPreservesExecutableNextAction == true
compactPreservesAllBlockersAndUserDecisions == true
compactL3RoundTripCompletesWithoutAuditRead == true
```

## 10. 分阶段实施计划

### 阶段 0：基线设施

改动：

- 提取统一 UTF-8 minified 测量函数；
- 新增 response footprint benchmark；
- 固化当前 15 个公共工具及各 operation 的基线；
- 将真实测试工程数据作为人工对照，不作为可写 fixture。

完成标准：能够稳定复现 compact >= standard 的当前问题，并输出分层字节数。

### 阶段 1：契约与高频只读 profile

优先 operation：

- `inspect_runtime(runtime)`；
- `inspect_route_progress(next_action)`；
- `inspect_route_progress(get_current_context)`；
- `inspect_versions(list_versions/window)`；
- `inspect_l3_route_operations(list_l3_proposals)`。

改动：

- 建立 response profile contract；
- 删除只读小响应的强制 summary/delta；
- 精简 runtime/meta/action/omission；
- 加入 R0–R2 budget gate。

完成标准：真实测试工程三个高频 compact structured envelope 分别达到对应目标或至少低于硬上限，并全部小于 standard。

### 阶段 2：普通写入与错误恢复 profile

覆盖：

- Todo、Deferred、Constraint；
- Version prepare/complete；
- 初始化、locale、binding；
- idempotency replay；
- 输入、状态、root mismatch、write lock 等错误。

完成标准：普通 compact 写入回执达到 R1，错误响应仍能一次构造正确重试调用。

### 阶段 3：L3 与 lifecycle profile

覆盖 proposal、authorize/approve、artifact、commit、reject、resume、closeout、structure change。

完成标准：Agent 只使用 compact 即可完成完整 L3 链；所有精确摘要与安全标识不丢失；R3 <= 4 KiB。

### 阶段 4：transport 去重

改动：

- 明确协议/host capability；
- capable host 使用 terse text + structuredContent；
- legacy 继续完整文本镜像；
- 增加 transportResultBytes 和 model-visible 实测。

完成标准：兼容测试通过；capable-host compact content <=256 B；典型 Agent loop model-visible <=4 KiB。

### 阶段 5：文档、插件生成与发布验证

更新：

- Agent-host integration；
- MCP route operation capability；
- capability index；
- tool contract/description hash（仅确有变化时）；
- release note；
- 生成的 plugin runtime 与 attestation。

验证：

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build:codex-plugin
pnpm smoke:codex-plugin
pnpm check:codex-plugin-release
```

本工程不是 C++/Cytometry；实施时按 TypeScript 工程验证，不涉及 C++ 编译。

## 11. 兼容、迁移和回滚

### 11.1 兼容承诺

- 省略 detail 的 standard 响应默认保持兼容；
- audit 保留完整数据；
- compact 允许减少非必需字段，但保留已承诺的可执行和 L3 标识；
- `payloadBytes` 在本需求内不直接改义；
- persisted state、idempotency fingerprint 和 digest 不受 detail 影响。

### 11.2 风险

| 风险 | 控制措施 |
| --- | --- |
| compact 误删执行字段 | operation fixture + 下一调用构造测试 |
| L3 digest/ID 不完整 | compact-only 端到端推进测试 |
| 旧客户端只读 content | transport 分期、capability gating、legacy fallback |
| 预算诱导静默截断安全信息 | budget validator 只报错，不自动删 blocker |
| profile 与业务响应漂移 | tool 新增/修改 checklist 强制更新 profile 和 budget fixture |
| 体积测试脆弱 | target warning + hard failure；对动态 ID/时间只测字节区间和语义字段 |

### 11.3 回滚单元

- profile 改动可按 operation 单独回退到旧投影；
- transport terse-text 由 capability flag 独立关闭；
- standard/audit 不依赖 compact profile；
- 不存在数据迁移回滚。

## 12. 完成定义

需求完成必须同时满足：

1. 全部公共 operation 有复杂度等级、target 和 hard limit；
2. compact 永不大于同场景 standard；
3. 真实 ready 测试项目：runtime、next action、current context 均满足各自 hard limit；
4. 普通健康 compact 主要分布在 1 KiB 内；
5. compact-only 可完成普通写入和 L3 全链路；
6. blocker、风险、用户决策和精确安全标识无丢失；
7. standard 默认兼容、audit 完整；
8. legacy 与 capable host transport 都有自动测试；
9. 典型 Agent loop 的 model-visible 总量 <=6 KiB，目标 <=4 KiB；
10. 全量测试、类型检查、lint、插件 smoke 和发布检查通过；
11. 临时需求与反馈文档在正式 capability/architecture 文档落地后删除或归档到变更记录。

## 13. 实施前决策点

建议批准以下四项后开始阶段 0：

1. 采用方案 B：operation-aware compact profile + 统一预算检查；
2. 接受 R0–R3 的初始预算，后续只能用测量证据调整；
3. standard 默认兼容和 audit 完整为硬边界；
4. transport 去重放在阶段 4，必须 capability-gated，不与第一批 profile 改动捆绑发布。
