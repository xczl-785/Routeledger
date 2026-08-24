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
- [ ] 第 2 项：compact 响应体积和重复信息
- [ ] 第 3 项：更短的 Agent 快速路径
- [ ] 第 4 项：隔离测试/低风险个人项目的轻量授权模式
- [ ] 第 5 项：首个 Deferred 的下游 Version 可执行引导
- [ ] 第 6 项：agent_only 初始化响应降噪
