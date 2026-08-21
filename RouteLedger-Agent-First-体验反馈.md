# RouteLedger Agent-First 使用反馈

> 测试版本：RouteLedger Plugin `0.10.3`  
> 测试方式：Codex agent 通过 RouteLedger MCP 全程操作，不打开 Mission Control UI  
> 测试日期：2026-08-21  
> 内容语言：`zh`

## 1. 测试范围与结果

本次以 agent 为 RouteLedger 的直接使用方，完成了以下无 UI 流程：

1. 检查 runtime，识别出插件进程 `cwd` 不可信；
2. 显式绑定宿主工作区；
3. 使用 `contentLocale: zh` 初始化项目；
4. 创建首个 Version 和两个 Todo；
5. 读取 current context、next action 和 start gate；
6. 将 Version 从 `wait` 准备为 `ready`；
7. dry-run 启动流程；
8. 创建并执行精确的 L3 启动提案；
9. 关闭两个 Todo；
10. 将 Version 标记为 `complete`；
11. 执行 closeout 规划和 residual audit；
12. 创建并执行精确的 L3 关闭提案；
13. 验证最终无开放 Todo、Deferred、Constraint 或 pending L3 proposal。

实际状态链：

```text
unbound → bound → wait → ready → running → complete → close
```

整个流程不依赖 UI，可以由 agent 独立完成。

## 2. 总体评价

RouteLedger 已具备 agent-native 的核心骨架：机器可判定状态、确定性的下一步、幂等普通写入、受控的高风险路线变更以及可恢复的审计链。当前主要问题不是基础能力不足，而是工具响应效率、可直接执行性和少数契约命名仍存在摩擦。

## 3. `contentLocale` 核对结论

### 3.1 正确边界

`contentLocale` 应只约束 agent 创建、并可能由用户阅读的项目内容，例如：

- Project、Version、Todo、Deferred、Constraint 的标题和描述；
- agent 写入的说明、关闭备注、审计原因等内容；
- README 或其他人类入口文档模板；
- 确实需要呈现给用户的人类审核文本。

以下内容属于 agent control plane，不需要根据 `contentLocale` 国际化：

- MCP error、diagnostic 和 blocker message；
- `nextAction.summary`、`nextAction.reason`、recommended action；
- 状态枚举和 display label；
- tool schema、参数说明和恢复指令；
- runtime、binding、storage 和 gate 的机器说明。

这些字段保持稳定英文是合理的，也更方便 agent 进行一致解析。此前将它们列为本地化缺陷属于反馈范围过宽，应撤回。

### 3.2 为什么测试 agent 会反复提出本地化问题

当前存在几处边界信号不一致，容易让测试 agent 推断为“整个工具响应都应该本地化”：

1. `routeledger-operator/SKILL.md` 明确写着：`Surface the localized Mission Control notice once per task.`
2. runtime 把 `contentLocale.effectiveScopes` 声明为：

   ```text
   project_setting
   agent_content_default
   write_integrity_gate
   ```

   其中 `agent_content_default` 很容易被理解为“所有返回给 agent 的自然语言均使用该语言”。
3. 部分 current-context / doc-drift 逻辑确实根据 `contentLocale` 对 `nextAction` 或 suggested Todo 文本做语言分支，使项目内容与 control-plane message 的边界混在一起。
4. `humanReviewText` 使用英文标签，但字段名暗示它可能直接展示给人；契约没有说明它是仅供 agent 解析、由 agent 转述，还是可以直接呈现给用户。

因此，重复反馈主要来自**契约标注不够明确，并伴有部分实现边界混杂**，不代表所有英文 MCP message 都发生了用户侧溢出。

### 3.3 实际用户侧风险

本次能确认的边界风险是 Mission Control notice：

- 技能要求 agent 将该 notice 向用户展示并取得是否打开 UI 的决定；
- runtime 返回的 notice message 是固定英文；
- 如果要求 agent 原样展示，它会成为用户可见英文；
- 如果契约要求 agent 按 `contentLocale` 转述，则固定英文完全可以保留，但技能必须明确说明“本地化由 agent 完成”。

建议采用后者，因为 RouteLedger 的直接使用方是 agent：服务端返回稳定、结构化的 notice code 和英文语义，agent 根据对话语言及 `contentLocale` 生成用户提示。

`humanReviewText` 暂列为契约待确认项，而不是已确认 bug：只有它会被产品直接展示给用户时才需要本地化；若它只作为 agent 的审核素材，则应保持稳定格式，并由 agent 负责转述。

### 3.4 建议修改

1. 在 Skill 中明确写出：

   > `contentLocale` applies to agent-authored project content intended for human consumption. It does not localize MCP control-plane messages, diagnostics, blockers, next actions, or state labels.

2. 将 Mission Control 规则改为：

   > Surface the Mission Control decision to the user once per task. Use the project's `contentLocale` when paraphrasing it; the raw MCP notice may remain in stable English.

3. 将 `agent_content_default` 重命名为更准确的名称，例如：

   ```text
   agent_authored_project_content_default
   ```

   或：

   ```text
   user_facing_content_default
   ```

4. 在 tool schema 或设计文档中标明自然语言字段的 audience：

   - `agent_control_plane`
   - `user_facing_content`
   - `human_review_material`

   不一定需要把 audience 写入每次响应；在 schema 描述中明确即可。

5. 删除对纯 control-plane 字段按 `contentLocale` 分支的实现，保留项目内容、文档模板及确定的用户可见材料的语言选择。

## 4. 已确认的有效问题

### P1：默认响应对 agent 过重

#### 现象

多个工具响应重复返回完整实体、事件、runtime context、gate snapshot 和 digest payload。高风险审计信息有价值，但作为默认响应会明显消耗 agent 上下文。

#### 影响

- 长任务中上下文成本持续累积；
- agent 更难快速定位本次真正变化的字段；
- 相同 runtime 和实体信息在连续调用中反复出现。

#### 建议

- 增加 `detail: compact | standard | audit`；
- 默认提供 `agentSummary` 和本次变更 `delta`；
- 事件默认只返回 ID、类型和时间，需要时再展开；
- digest 默认返回 value，完整 payload 放在 audit 模式；
- 保留现有完整响应作为审计或诊断选项。

### P1：推荐动作不是完全可直接执行的

#### 现象

`nextAction.toolInput` 和 proposal 的 recommended action 经常省略写入所必需的 `expectedRouteLedgerRoot`。agent 需要从较早的 runtime 结果中重新拼装参数。

#### 影响

- 增加 agent 编排复杂度；
- 容易遗漏根目录断言；
- “推荐下一步”无法真正做到复制即执行。

#### 建议

返回完整的 `executableToolInput`，至少包括：

- `operation`
- `projectId`
- `target/version/todo ID`
- `expectedRouteLedgerRoot`
- proposal 场景下的 `pendingOperationId`
- `expectedOperationDigest`

若出于安全考虑不希望把某些字段定义为普通输入，可同时返回 `requiredRuntimeBindings`，让 agent 明确知道必须从当前 runtime 合并哪些字段。

### P2：授权身份命名仍偏 user-centric

#### 现象

runtime 默认显示：

```text
approver.id = mcp-user
approver.displayName = routeledger-mcp-user
```

但 Codex 中真实的批准来源是 `host_admission`，决策凭证也显示 `Codex native tool admission`。RouteLedger 的直接使用方是 agent，并不必然存在一个操作插件的终端用户。

#### 影响

- 容易让 agent 误以为需要额外询问用户；
- 混淆“对话用户”“MCP host authority”和“审批主体”；
- 与实际 host admission 模型不一致。

#### 建议

使用更中性的概念，例如：

- `hostAuthority`
- `admissionPrincipal`
- `approvalAuthority`

仅在确实由人作出显式决定时，再把 actor type 标记为 user/human。

### P2：关闭状态命名不自然

#### 现象

Version 关闭后的状态是：

```text
state = close
displayLabel = CLOSE
```

而相关错误和说明中使用的是 `closed`。

#### 影响

- agent 容易生成 `state === "closed"` 的错误判断；
- 动作名 `close_version`、自然语言 `closed` 与状态枚举 `close` 不一致。

#### 建议

长期建议统一为 `closed`。若兼容性不允许立即修改，至少：

- 在 schema 中强调合法枚举是 `close`；
- 提供 `isClosed: true`；
- 将 display label 改为 `CLOSED`；
- 制定可识别旧值的迁移方案。

### P3：human-first 建议对 agent-only 场景形成噪声

#### 现象

初始化响应主动建议创建 README 人类入口并打开 Mission Control。拒绝 UI 不会阻塞操作，这一点是正确的，但相关建议仍占据默认响应。

#### 建议

引入或推导 interaction profile，例如：

```text
agent_only
agent_with_human_review
human_ui
```

在 `agent_only` 下：

- Mission Control 只保留一次结构化可选提示；
- README / human entry doc 建议降级为 advisory metadata；
- 不把 UI 或人工入口作为主要 recommended next action。

## 5. 已验证且建议保留的设计

以下能力表现良好，不建议因精简而削弱：

- 不信任 MCP 进程 `cwd`，要求显式宿主工作区绑定；
- 所有写操作校验 `expectedRouteLedgerRoot`；
- current context 提供 payload budget、截断状态和 Version window；
- 普通 Todo 写入使用调用方稳定的 idempotency key 和 receipt；
- start/close gate 返回结构化 blocker code 和 record IDs；
- L3 操作保存 proposal、operation digest、decision artifact 和 commit 链；
- approval artifact 单次消费，防止重放与错配；
- residual audit 必须显式声明已审核，不能用缺省空数组冒充审核；
- 拒绝打开 UI 不会阻塞路线工作；
- `next_action` 能把状态机推进建议结构化暴露给 agent。

## 6. 建议修复顺序（按改动规模由小到大）

> 此处只按预计改动面、兼容成本和验证范围排序，不代表问题优先级；P1/P2/P3 仍表示影响程度。

1. **明确 `contentLocale` 的 audience 边界（小）**  
   先修改 Skill、Mission Control notice 转述规则、`effectiveScopes` 命名和字段契约说明，再清理少量把 control-plane 文本按 locale 分支的实现。改动集中，且能先消除后续测试中的边界误判。
2. **修正 approval authority 的 user-centric 命名（小到中）**  
   优先把 Codex host 下的默认 ID、display name 和说明改为中性语义；保留现有 `approver` 数据结构，避免一开始就做全链路字段迁移。若后续确需改为 `hostAuthority` 等新字段，再单独设计兼容期。
3. **让 recommended action 可直接执行（中）**  
   抽出统一的 action builder，补齐 `expectedRouteLedgerRoot`、目标 ID、proposal ID 和 digest；同步调整相关 output schema 与各 action producer。该项涉及多个工具，但不改变持久化模型。
4. **为 agent-only 场景降低 UI 和 human-entry 噪声（中到大）**  
   增加或推导 interaction profile，并让初始化、runtime、Mission Control 和 doc-drift 的推荐逻辑一致识别该 profile。需要跨多个响应入口统一行为。
5. **提供 compact agent response（大）**  
   需要定义 `compact | standard | audit` 的稳定契约、公共裁剪/摘要机制、`delta` 语义以及各工具的最小必需字段，并补齐端到端回归，确保 compact 模式仍能完成完整状态推进。
6. **统一关闭状态为 `closed`（最大）**  
   该项会触及 core 状态机、JSON/SQLite 持久化、codec/validator、CLI、Mission Control、错误消息和大量测试；还必须设计 `close` 旧值的读兼容、迁移与写出策略，因此最后单独实施。

## 7. 验收建议

修复后建议继续使用相同的无 UI agent 流程回归，并至少断言：

1. `contentLocale: zh` 时，项目内容和文档模板使用中文；
2. blocker、diagnostic、next action 等 agent control-plane 字段允许保持稳定英文；
3. agent 能根据结构化 Mission Control notice 生成中文用户提示；
4. Skill 不再暗示所有 MCP 自然语言都必须本地化；
5. compact 模式足以完成完整状态推进，不需要读取 audit 级 payload；
6. 每个 recommended action 都可直接调用，或明确列出待合并的 runtime 字段；
7. 全程不打开 UI，也能完成初始化、Todo、Version start、complete、residual audit 和 close；
8. 最终不存在开放工作项或未消费的 L3 proposal。
