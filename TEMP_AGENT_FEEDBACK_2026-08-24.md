# RouteLedger Agent 体验反馈暂存与调研

> 状态：临时文档，待后续逐项修复；本轮只整理反馈并调研第 2 项，不修改实现。
>
> 记录日期：2026-08-24
>
> 第 2 项的独立需求与实施规划见 [TEMP_AGENT_RESPONSE_FOOTPRINT_REQUIREMENT.md](TEMP_AGENT_RESPONSE_FOOTPRINT_REQUIREMENT.md)。

## 一、反馈原文整理

### 1. 控制面本地化不足

`contentLocale=zh` 只影响项目内容，不影响控制面提示；`next_action`、gate blocker 和诊断仍大量使用英文。对中文 Agent 工作流而言有些割裂。

### 2. compact 响应仍偏大且重复

即使是 `compact`，部分响应仍有 3–4 KB，且包含较多重复的项目、运行时和实体信息。连续 Agent 循环的上下文成本偏高。

### 3. 首次使用的概念负担较高

首次接触时概念较多：Version 状态、Todo/WorkItem、Deferred、Constraint、L3、残余审计、审批 artifact。建议提供一个更短的 Agent 快速路径。

### 4. 低风险场景的 L3 链路偏重

`wait -> ready` 很顺畅，但 `ready -> start` 立即进入 L3 提案与审批链。安全性很好，不过对隔离测试或低风险个人项目稍显重。

### 5. 首个 Deferred 的引导不够完整

Deferred 强制要求真实下游 Version，这在语义上正确，但首次试用只有一个 Version 时无法直接体验；错误/引导信息可以更主动地提供“创建下游 Version”的完整可执行方案。

### 6. agent_only 场景仍包含人类入口噪声

初始化返回的人类 README 入口建议，对 `agent_only` 场景价值有限，可以进一步降低其响应占比。

## 二、综合评价与测试终态

综合评价：**8/10**。

RouteLedger 更像一个“强约束、可审计的 Agent 项目状态机”，而不只是任务清单。对于长期、复杂、需要可靠恢复和审批的工程很有价值；如果进一步压缩响应、加强控制面本地化，并提供轻量模式，Agent 使用体验会明显更好。

测试项目保留终态：

- Version 为 `ready`；
- Todo 已全部关闭；
- 中文约束有效；
- 无 Deferred；
- 无待处理 L3 提案；
- 没有为了测试而擅自启动 Version。

## 三、第 2 项调研：compact 响应体积

### 3.1 结论

反馈成立，而且当前问题不只是“部分响应仍有 3–4 KB”：在小响应上，`compact` 可能与 `standard` 几乎等大，甚至更大；MCP 线缆结果还会因为兼容文本和结构化内容并存而接近再复制一份。

当前 `compact` 本质上是统一的字段投影器，不是带强制总预算的、按工具设计的最小响应契约。它比较擅长删除审计 payload 和裁剪长数组，但对 runtime、项目上下文及短小实体的重复信息压缩有限。

### 3.2 真实测试工程测量

主要测量对象：`D:\Program\文档\RouteLedger-Agent-Test`，使用当前 Codex 插件 `0.10.6` 和 JSON-only runtime。

只读核对的项目终态与反馈描述一致：

- Project：`RouteLedger Agent 试用项目`，`contentLocale=zh`；
- 当前 Version：`首次 Agent 工作流试用`，状态为 `ready`；
- Todo 为 0，Deferred 为 0；
- 中文 project constraint 为 active；
- pending L3 proposal 为 0；
- `next_action` 推荐 `start_version`，要求 L3 approval；
- 测量过程中没有执行 start，也没有创建或修改任何 RouteLedger 实体。

真实调用体积如下：

| operation | detail | `meta.payloadBytes` | structured envelope | 文本 content | 完整 CallToolResult |
| --- | --- | ---: | ---: | ---: | ---: |
| `runtime` | compact | 3,526 B | 3,982 B | 5,068 B | 9,731 B |
| `runtime` | standard | 3,265 B | 3,959 B | 5,002 B | 9,635 B |
| `get_current_context` | compact | 3,195 B | 3,930 B | 5,267 B | 9,811 B |
| `get_current_context` | standard | 2,884 B | 3,857 B | 5,160 B | 9,627 B |
| `next_action` | compact | 2,902 B | 3,358 B | 4,461 B | 8,340 B |
| `next_action` | standard | 2,599 B | 3,293 B | 4,362 B | 8,172 B |
| `list_versions` | compact | 825 B | 935 B | 1,302 B | 2,450 B |
| `list_l3_proposals` | compact | 159 B | 269 B | 380 B | 769 B |

前三个高频 Agent 循环操作中，compact 的 data、structured envelope 和完整 CallToolResult 均大于 standard。差值主要来自 compact 新增的 `agentSummary`、`delta`、`omittedSections` 与 detail meta，而原始响应没有足够大的 audit payload 可供裁掉。

补充测量：在本源码仓库“已绑定但未初始化”的 runtime 场景中，compact 完整结果为 11,756 B，standard 为 11,758 B，audit 为 11,752 B，同样几乎没有收益。这进一步说明该问题不是测试项目数据的偶发现象。

实际测试工程的 compact runtime 仍完整返回 binding 路径集合、runtime attestation、storage 路径集合、activeProject、contentLocale、Mission Control 信息等；其中多组根路径、版本身份和项目标识重复出现。

此前未初始化场景中对 compact data 做过分区测量，其主要占用如下，可用于识别优化顺序：

| 区段 | JSON 字节数 |
| --- | ---: |
| `recommendedNextActions` | 1,144 B |
| `runtimeIdentity` | 788 B |
| `binding` | 573 B |
| `storage` | 405 B |
| `missionControl` | 266 B |
| `blockedTools` | 243 B |
| `contentLocale` | 233 B |
| `agentSummary` + `delta` | 158 B |
| `meta.omittedSections` | 188 B |

### 3.3 根因定位

#### A. `payloadBytes` 统计口径小于 Agent 实际接收口径

`packages/mcp/src/response-detail.ts` 的 `payloadBytes` 只测量 `data` 或 `error`，没有计入：

- envelope 的 `ok` 和 `meta`；
- `omittedSections` 自身；
- MCP `content` 文本；
- `structuredContent`；
- stdio/JSON-RPC 外层。

因此该指标适合描述业务 payload，却不能代表宿主上下文成本。

#### B. stdio 同时返回完整文本 JSON 和 structuredContent

`packages/mcp/src/stdio-server.ts` 的 `toCallToolResult` 将同一 structured envelope：

1. 以缩进 JSON 写入 `content[0].text`；
2. 再原样写入 `structuredContent`。

这是最直接的传输级重复。对同时暴露两者给模型的宿主，实际上下文成本接近两份 envelope，并额外承担 pretty-print 空白。

#### C. compact 是通用递归投影，不是工具级最小契约

当前规则主要是：

- 数组最多保留 10 项；
- event 只保留少数字段；
- proposal / pendingOperation / approvalArtifact 使用白名单；
- 非 recommended action 中名为 `payload` 的字段被删除；
- `meta.runtimeContext` 被压缩。

但 `inspect_runtime` 的核心结果位于顶层 `data`，其中 `binding`、`runtimeIdentity`、`storage`、`missionControl` 等不会命中专门的 runtimeContext 压缩规则。于是 data 保留较完整的 runtime 信息，meta 又保留一份 runtimeContext 摘要。

#### D. compact 会无条件增加摘要字段

`buildCompactData` 为响应增加 `agentSummary` 和 `delta`。它们对复杂写入响应有价值，但对只读、小响应常常重复已有的 status、tool、operation 和实体 ID，可能抵消裁剪收益。

#### E. recommendedNextActions 被完整保留

保留可执行 `toolInput` 是正确的安全边界；但 action 中的 `description`、`fields/requiredFields`、`type` 和其他解释字段经常可以由 tool + toolInput 推导。当前一律保留，使 runtime 场景中该区段成为最大单项。

#### F. 只有 current-context 查询具备业务预算，而且最小为 8 KB

`packages/core/src/application/current-context-query.ts` 对 `get_current_context` 提供 `budgetBytes`，范围为 8–64 KB，默认 32 KB。该预算：

- 只覆盖 current-context 数据；
- 在 MCP compact 投影之前执行；
- 不覆盖 meta 与传输 envelope；
- 对反馈中的 3–4 KB 响应不会触发。

所以它不能解决全工具的连续 Agent 循环成本。

### 3.4 建议方案

#### P0：先修正测量与回归门槛

保留现有 `payloadBytes` 兼容语义，另增加能反映真实成本的指标，例如：

- `structuredEnvelopeBytes`：完整 `ok/data/error/meta`；
- `transportResultBytes`：`content + structuredContent + _meta`，在 transport 层测量；
- 测试同时断言相对收益和绝对上限，不能只断言“比构造出的超大 audit fixture 小一半”。

建议至少加入：

- 每个公共 operation 的 compact 体积快照；
- compact 不得大于同场景 standard；
- 健康只读循环的 structured envelope 目标不高于约 1.5–2 KB；
- L3 等必须携带精确标识的响应单独设置较宽预算；
- 对 `recommendedNextActions`、blocker、精确 digest/ID 做可执行性回归。

#### P0：为高频工具定义专用 compact DTO

不要继续只依赖全局递归删除规则。优先给以下高频 operation 设计白名单 DTO：

1. `inspect_runtime(runtime)`；
2. `inspect_route_progress(next_action)`；
3. `inspect_route_progress(get_current_context)`；
4. Todo/Deferred/Constraint 的普通写入回执；
5. L3 proposal/approve/commit 链。

以 `inspect_runtime(runtime)` 为例，routine compact 通常只需：

- binding status、`routeledgerRoot`；
- project ID/name；
- content locale status/value；
- 非空 blocker/diagnostic code；
- Mission Control 是否需要用户决策；
- 最小可执行 next action。

完整路径集合、runtime attestation、所有 null storage 字段、actor/approver 展示名等应按异常或 audit 需要返回。

#### P0：消除 transport 双份 JSON

在不破坏旧宿主的前提下，优先方案是：

- `structuredContent` 继续承载权威 envelope；
- 对明确选择 `detail=compact` 且支持 structured content 的宿主，`content` 只返回一句短摘要，不再复制完整 JSON；
- `standard` 暂时保持兼容；
- 若无法可靠识别宿主能力，则先使用 compact opt-in 作为兼容边界，并补旧客户端测试。

不建议直接全局删除 `content`，因为只消费文本内容的旧 MCP 客户端可能依赖它。

#### P1：压缩重复的元信息

- 成功响应的 `meta.runtimeContext` 只保留下一次写入必需的 `routeledgerRoot`、project ID 和必要绑定状态；完整 runtime identity 只在 runtime/audit 或错误诊断中返回。
- `agentSummary`、`delta` 改为按需生成：只读响应已有明确 `nextAction/status` 时可以省略，写入响应保留真正的变更摘要。
- compact 过滤 null/空数组/空对象，但必须保留有语义差异的 null。
- `omittedSections` 改为分组后的稳定 code + count，或合并重复路径模式；精确路径列表留给 standard/audit。

#### P1：精简但保留可执行动作

compact 的 action 建议稳定为：

```json
{
  "tool": "configure_project",
  "toolInput": { "operation": "initialize" },
  "requiresUserDecision": true
}
```

保留执行所需的确切参数，不重复返回可由 schema 或 toolInput 推导的字段。描述性说明只在存在歧义、风险或 blocker 时保留。

#### P2：最后再考虑跨调用引用或 delta 协议

可以研究 `runtimeRef`、project snapshot digest、since-token 等跨调用去重，但不建议作为第一步。它会引入缓存失效和宿主状态依赖；先通过专用 compact DTO、空值删除、action 精简和 transport 去重，通常就能获得大部分收益。

### 3.5 不建议的方向

- 不建议再增加 `minimal` 第四档：这会加重首次使用的概念负担，且掩盖 compact 没有兑现命名语义的问题。
- 不建议裁掉 L3 的精确 proposal/digest/artifact ID，或把可执行 toolInput 换成自然语言。
- 不建议为了绝对字节上限静默截断 blocker、风险或用户决策要求。
- 不建议用“只测 data 的 payloadBytes 下降”作为完成标准。

### 3.6 建议的实施顺序

1. 建立真实 transport 和各 operation 的体积基线测试；
2. 修正 `inspect_runtime(runtime)` 专用 compact DTO，验证小响应也确实更小；
3. 处理 `content`/`structuredContent` 双份 JSON；
4. 精简 runtimeContext、agentSummary/delta、omittedSections、recommendedNextActions；
5. 将专用 DTO 扩展到 route progress、普通写入和 L3 链；
6. 运行完整静态检查与测试，再更新 Agent host integration 契约。

## 四、后续待修复清单

- [ ] 第 1 项：控制面本地化边界与中文 Agent 展示层
- [x] 第 2 项：compact 响应体积和重复信息（已随 `0.10.7` 发布）
- [x] 第 3 项：更短的 Agent 快速路径（六组首次概念已作为 `0.10.8` 候选实现）
- [ ] 第 4 项：隔离测试/低风险个人项目的轻量授权模式
- [ ] 第 5 项：首个 Deferred 的下游 Version 可执行引导
- [ ] 第 6 项：agent_only 初始化响应降噪

## 五、其余反馈的重新评估

本节记录第 1、3、4、5、6 项的产品判断。目标不是看到反馈后立即增加模式或概念，而是先区分：真实能力缺口、展示层负担，以及合理但没有表达清楚的既有边界。

### 5.1 重要性与推荐方案复杂度

| 重要性顺序 | 问题 | 影响范围 | 推荐方案复杂度 | 当前判断 |
| --- | --- | --- | --- | --- |
| 1 | 首次使用概念过多 | 所有新 Agent 和新项目 | 中 | 优先做概念分级和快速路径，不删领域能力 |
| 2 | `ready -> start` 的 L3 体验偏重 | 每个正常启动流程 | 中高 | 保留 L3 等级，简化为外部一次操作、内部完整审计 |
| 3 | `contentLocale=zh` 与英文控制面产生割裂感 | 非英文项目和转述给用户的 Agent | 低到中 | 不做完整控制面国际化，改进边界表达和机器优先输出 |
| 4 | 首个 Deferred 的恢复引导不完整 | 只有一个 Version 的首次试用 | 低 | 在已有第一步引导上补齐跨步骤恢复计划 |
| 5 | `agent_only` 仍返回 README 建议 | 初始化响应 | 低 | 并入快速路径，默认直接省略人类入口建议 |

按投入产出比，建议先做概念分级、`agent_only` 降噪和 Deferred 恢复计划，再处理 L3 表面流程。控制面语言不单独建设一套国际化系统，而是随响应结构化和快速路径一起改进。

### 5.2 “首次使用概念太多”的根因

问题不只是概念数量多，而是三类不同层次的概念被同时展示：

1. Agent 完成当前操作必须理解的产品概念；
2. 只有进入某个场景时才需要理解的进阶概念；
3. 为恢复、审计和实现正确性服务的内部概念。

如果把 Version、Todo、WorkItem、Deferred、Constraint、L3、ApprovalArtifact、残余审计平铺为同一级，Agent 会误以为首次操作前必须掌握整个状态机。更合理的做法是按“何时必须知道”分级，而不是按代码实体或数据表分级。

### 5.3 概念分级

#### 第一级：首次必须理解的六组主概念

对抗性盲测表明，原八项内容覆盖基本完整，但并列颗粒度偏碎。第一级调整为六组：合并 Route/Current Version，并把重要变更确认纳入 Next Action Contract。每组只解释到足以安全执行下一步的程度。

| 主概念组 | 首次说明 | 首次不展开的内容 |
| --- | --- | --- |
| Bound Project Context（绑定项目上下文） | RouteLedger 一次管理一个已绑定 Project；先确认当前操作的是哪个 Project。 | workspace/data root、存储布局、revision、绑定恢复细节 |
| Route and Current Version（路线与当前阶段） | Route 是按顺序推进的 Version 计划；Current Version 是 Agent 现在应推进的阶段。 | 子 Version、插入、重排、历史尾部规则和完整 Version 树 |
| Version Lifecycle（阶段生命周期） | 正常主线是 `wait -> ready -> running -> complete -> close`。`complete` 表示实施已完成；`close` 表示 blocker、closeout 和残余工作已处理，阶段正式封存。 | `suspend`、reopen、shutdown 及异常恢复路径 |
| Work Classification（工作分类） | Todo 是现在做；Deferred 是以后指定 Version 再评审；Constraint 是必须持续成立的规则。 | WorkItem lineage、legacy Undo 和三类记录的完整状态字段 |
| Gates and Blockers（检查与阻塞） | Gate 判断状态转换是否允许；Blocker 说明为什么不允许。start gate 和 close gate 可以有不同 blocker。 | gate snapshot、风险目录和残余审计证据结构 |
| Next Action Contract（下一步动作契约） | `next_action` 返回推荐工具、确切 `toolInput`，并说明是否需要决策或 Host admission。Agent 不自行推演状态机，也不把普通聊天或项目文件当成可执行授权。 | 所有动作决策树、L3 digest、artifact、receipt 和内部 commit chain |

这里的 Work Classification 不是新增实体，而是对 Todo、Deferred、Constraint 三个用户可操作概念的分组。三者都属于核心产品语义，不能从首次介绍中完全消失；但首次只需用一句分类规则说明，不应同时展开各自生命周期。

建议首次介绍固定为下面这一小段：

> RouteLedger 一次操作一个已绑定 Project。项目的 Route 由按顺序推进的 Version 组成，Current Version 是现在要完成的阶段：Todo 表示现在做，Deferred 表示以后指定 Version 再评审，Constraint 表示必须持续成立。Gate 判断能否转换，Blocker 解释为什么不能；Agent 按 Next Action 返回的工具和参数推进，并遵守其中的决策或 Host admission 要求。

这段覆盖六组主概念，但没有提前暴露审计实现。

#### 第二级：场景触发时再解释的概念

只有当响应中实际出现对应动作或阻塞时，才补充以下概念：

| 触发场景 | 此时解释的概念 |
| --- | --- |
| 创建、插入、嵌套或重排 Version | Version 结构、父子关系、直接后继和历史边界 |
| 发生暂停、重开或强制终止 | `suspend`、reopen、shutdown 的区别和影响 |
| 创建或评审 Deferred | 目标评审 Version、activate、defer again、resolve |
| Constraint 阻止操作 | 约束作用域、状态、违反原因和 retire |
| Version 准备关闭 | close gate、残余工作、去向选择和残余审计 |
| 重要变更等待确认 | L3 proposal 是可恢复的待确认动作；优先执行返回的 admitted action |
| 文档状态或 UI 被明确请求 | doc drift、README 入口和 Mission Control；它们不是默认路线主流程 |

第二级仍然是产品概念，但遵循按需披露：没有进入 Deferred 场景，就不讲 Deferred 的三种评审结果；没有进入 closeout，就不讲残余审计。

#### 第三级：恢复、审计或开发时才解释的概念

以下内容不应进入普通首次介绍：

- WorkItem lineage；
- ApprovalArtifact、authorization receipt、operation digest、request state；
- TransitionEvent 和完整事件链；
- idempotency replay、revision、锁和冲突恢复；
- canonical JSON、SQLite read model、audit pack；
- legacy Undo 兼容规则；
- L3 内部的 propose、approve、claim、commit、finalize 分段协议。

这些概念必须继续存在，也必须能在诊断和 audit 响应中读取，但普通 Agent 只需要看到它们产生的稳定结果：动作是否等待确认、是否已执行、是否可安全重试，以及下一步工具输入。

### 5.4 首次 Agent 快速流程

首次使用应同时提供两个互补视角，避免把“工具调用顺序”和“项目生命周期”混在一起。

#### Agent 操作循环

```text
确认项目绑定
  -> 读取当前 Version、工作和 blocker
  -> 获取 Next Action
  -> 必要时请求一次确认
  -> 使用返回的 toolInput 执行
  -> 重复读取 Next Action
```

Agent 不需要自行记忆所有状态转换。`next_action` 应承担导航责任，返回的结构化 `recommendedTool` 和 `toolInput` 应比自然语言说明更权威。

已知成功结果可以直接进入下一轮；如果调用超时、冲突或结果不确定，则先重新读取当前状态和 `next_action`，不得盲目重复写入。这条行为规则覆盖首次执行安全，不需要提前解释 revision、锁或 idempotency 内部机制。

#### 正常 Version 主流程

```text
选择或创建当前 Version
  -> prepare：wait -> ready
  -> 通过 start gate 并确认 start：ready -> running
  -> 完成 Todo、处理到期 Deferred、遵守 Constraint
  -> mark complete：running -> complete
  -> 处理 close blocker 和残余工作
  -> 确认 close：complete -> close
  -> 推进到下一个 Version
```

首次只展示这条正常主线。暂停、重开、强制终止、嵌套路线和精细审批恢复在实际发生时再说明。

### 5.5 `contentLocale` 的最终边界与反馈原因

保留当前产品决定：

- `contentLocale` 只控制 Agent 生成并写入项目、供人阅读的内容；
- tool name、字段名、枚举、错误码和 MCP 控制协议保持 canonical English；
- 不增加 `controlPlaneLocale`，不维护成套的双语 message/blocker/diagnostic 模板；
- Agent 根据当前对话语言向用户转述控制面结果。

Agent 反复报告该问题，并不等于 Agent 无法理解英文。更可能的原因是：

1. `contentLocale=zh` 容易被理解成“本项目所有可见输出均为中文”，而不是较窄的“项目内容语言”；
2. `message`、`summary`、`reason` 和 blocker 文本看起来像会直接展示给用户，不像纯机器协议；
3. 中文项目内容和英文控制说明出现在同一响应中，Agent 在评估中文工作流时会主动标记这种不一致；
4. Agent 常把错误或 blocker 转述给用户，因此会把额外翻译成本也计入插件体验。

推荐修复的不是完整国际化，而是让控制面更加“机器优先”：

- compact 以稳定 code、state、blocker code、`recommendedTool` 和 `toolInput` 为主；
- 能由结构表达的内容不再重复长英文 message；
- 英文自由文本主要保留在 standard/audit 或异常诊断中；
- 文档和 standard runtime 明确标识 `contentLocale` 的作用域为 `project_content_only`；
- 测试应证明 Agent 不依赖英文句子也能完成下一步操作。

这样可以缓解割裂感，同时不引入控制面国际化的长期维护复杂度。

### 5.6 L3：保持安全等级，简化表面流程

不建议把 `start_version` 降为普通写入。启动 Version 会改变正式路线状态，保留可恢复提案、精确授权和审计链是合理的。

需要优化的是 Agent 看到的流程：

```text
Agent 发起一次重要变更
  -> Host 请求一次确认
  -> RouteLedger 内部完成 proposal、authorization、artifact 和 commit
```

默认 Next Action 应优先给出一个可执行的高风险入口，不要求普通 Agent 手工编排 propose/approve/commit。显式分段操作继续保留给恢复、诊断和特殊宿主。

隔离测试或低风险个人项目不应引入另一套“轻量安全等级”。可以复用现有 preauthorized/delegated 能力，提供明确启用且范围有限的策略，例如绑定到当前项目、指定 action/Version、短时有效并限制执行次数。未显式启用时仍走正常确认。

### 5.7 Deferred：从单步提示补成完整恢复计划

当前实现已经会在没有下游 Version 时返回 `DEFERRED_ROUTE_TARGET_UNKNOWN`、`downstream_version_required`，以及提议创建下游 Version 的第一步工具输入。反馈仍成立，因为 Agent 尚需自行推断后续步骤。

建议错误响应返回有依赖关系的三步计划：

1. 提议创建真实下游 Version，并列出仍需用户提供的标题；
2. 完成该 Version 的确认与提交，从结果取得真实 Version ID；
3. 复用原 Deferred 请求，将 `targetReviewVersionId` 替换为上一步结果后重试。

未来 ID 不能提前伪造，因此第一步可以是立即可执行动作，后两步用 `dependsOn`/结果引用表达。这样既维持 Deferred 必须绑定真实下游 Version 的语义，也让首次试用形成完整闭环。

### 5.8 `agent_only` 初始化降噪

当前 `agent_only` 会把 README 等人类入口从 recommended 降为 advisory，但相关对象仍在响应里。对于纯 Agent 流程，建议默认直接省略这类 documentation 建议：

- 初始化成功只返回项目、首个 Version、必要写入回执和 Next Action；
- README/doc drift 仅在显式文档检查、standard/audit 查询或有人类审阅配置时出现；
- Mission Control 同样保持可发现，但不能占据默认路线主动作的位置。

该项应并入快速路径实施，不需要单独增加配置模式。

### 5.9 对抗性盲测结论

三组相互隔离的 subagent 分别以新手、对抗评审和实际执行者身份，仅阅读中性概念材料：

| 角色 | 理解/接受情况 | 主要反馈 |
| --- | --- | --- |
| 新手 Agent | 理解度 8/10，快速路径操作意愿 9/10 | 能准确复述模型；混淆 `complete/close`、Gate/Blocker 和“推进” |
| 执行 Agent | 理解度 8/10，操作信心 7/10 | 常规场景可执行；Deferred 无下游、closeout 分类和确认来源需要场景提示 |
| 对抗评审 | 可理解性 6/10，可执行性 4/10 | 分级原则成立；建议合并为六组并补充动作有效性和未知结果处理 |

采纳项：

- 八项内容合并为六组，不删除核心语义；
- 明确 `complete` 与 `close`、Gate 与 Blocker；
- 将重要变更确认并入 Next Action Contract；
- 增加超时、冲突或未知结果后重新读取、不得盲目重试的规则；
- Deferred 无下游、closeout 分类和 L3 proposal 的必需信息在场景触发时随响应披露。

不采纳的过度前置项：

- 不把 ApprovalArtifact、digest、revision、锁、幂等和完整 L3 链提升为首次概念；
- 不要求每次成功写入后额外重复检查 runtime；
- 不因为对抗评审关注恢复边界，就把内部实现重新塞回首次路径。
