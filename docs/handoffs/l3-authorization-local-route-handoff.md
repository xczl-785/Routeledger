# L3 决策协议与宿主适配路线交接

- `role`: 在新 Codex 线程中恢复并继续完整的 L3 决策协议改造任务
- `state`: 产品定义与实施评估已接受并推送；代码尚未开始；canonical 新版本链已完成预检，但因宿主授权返回 `HOST_DECLINED` 未写入
- `updated`: 2026-08-11；源码基线 `559ee57`，本文件所在提交为更新后的分支 tip
- `truth-sources`: 用户已确认的产品定义、两份 L3 设计文档、当前源码、RouteLedger MCP live context
- `current-entry`: 先恢复可用的 L3 宿主决策通道，再提交 `L3-D1～D6` 版本链；随后从 L3-D1 以测试驱动方式开始接口与状态投影

这是本任务唯一的 task-level handoff。它替代本文件此前以“物理点击证明”为中心的交接内容，
但不抹除 0.5.0～0.6.0 已发布实现的历史事实。另一次 handoff 只在用户再次明确要求转接时进行。

## 1. 整体任务与最终结果

RouteLedger 需要同时适配 Codex 插件和通用 MCP，并提供分级的 L3 交互体验。最终结果不是
让高权限绕过 L3，而是让权限模式控制“决策如何得到”，同时每次路线转换仍完整执行：

```text
exact proposal
  -> decision resolution
  -> exact decision artifact
  -> commit-time live validation
  -> atomic commit
  -> receipt and audit
```

用户期望的三级行为是：

1. 请求批准：没有匹配授权时等待宿主中的用户决定；
2. 替我审批：确定性规则自动解决匹配 proposal；
3. 完全访问：在有限项目/会话/时间 capability 内自动解决。

高权限减少的是用户与工具之间的往返，不是内部状态、数据或审计。Codex 和通用 MCP 是同一
核心协议的平级 adapter，任何一方都不能定义 core。

## 2. 当前权限、边界和非目标

### 已获授权

- 整理 RouteLedger canonical 版本链；
- 更新任务级 handoff 和相关索引；
- 保守盘点、清理已被完全吸收的中间文档；
- 提交并推送本轮源码文档和 RouteLedger 数据变更；
- 后续按已确认路线推进接口、状态机和 adapter。

### 当前不在范围内

- 远程、多用户、组织、OAuth、跨设备权限；
- 把 Mission Control 变成 canonical 写入或主审批面；
- 在第一阶段迁移 canonical JSON schema；
- 用自然语言、`confirm`、`decisionRef` 或 Agent 自报身份代替 L3 决策；
- 为了降低摩擦而删除 digest、live validation、receipt、idempotency 或 audit。

### 仍需单独授权的外部效果

- 合并受保护的 `main`；
- tag、GitHub Release、npm/package 或 plugin 正式发布；
- 删除仍有独有信息或兼容消费者的历史资产；
- 扩展到远程或多用户权限模型。

## 3. 当前真实状态

### 3.1 已完成并接受

- 插件 `0.6.0` 已实现本地单用户授权内核：finite grant、profile、policy、receipt、replay、
  revoke、commit claim/finalize 和 host-owned registry。
- 新产品定义已写入
  [`L3 route-transition decision protocol`](../guides/l3-route-transition-decision-protocol.md)。
- 当前代码差异、接口方向、状态机、adapter 分工和 20～34 人日估算已写入
  [`L3 decision protocol implementation assessment`](../guides/l3-decision-protocol-implementation-assessment.md)。
- 源码分支 `docs/v3-codex-authorization-handoff` 已推送到 `origin`；定义提交为
  `ec65b09`，实施评估提交为 `559ee57`。

### 3.2 尚未开始

- 没有生产代码改动；
- 没有新的 decision interface、state projection 或 adapter；
- 没有一调用 `proposal -> decision -> commit` 编排；
- 没有 Codex live mode provider；
- 没有 MCP 2026 `InputRequiredResult` adapter。

曾短暂创建三份 TDD 测试草稿，但在用户要求“先落地情况、不要急着改代码”后已全部撤销，
未进入任何提交。

### 3.3 Canonical RouteLedger 状态

- workspace root：`D:\Program\plugins`
- RouteLedger root：`D:\Program\plugins\Routeledger-Internal`
- project：`RouteLedger Plugin Closeout Tracking`
- project id：`6a63dcd2-a1b4-4301-b314-de0e2436d86c`
- content locale：`zh-CN`
- runtime：plugin `0.6.0`，JSON-only，payload digest
  `30a4fea0b4643458cd1bea2087c13c72660af9c81e3efac8e7849937925724c8`
- current：已关闭的 `V2.16 Agent-Neutral Workspace Binding 契约重塑`
- 当前直接后继：WAIT 的 `V2.2 UI Mission Control 只读看板完整形态`

2026-08-11 已对 `L3-D1～D6` 做成功 batch preflight。第一次尝试把它们插在 V2.16 与
V2.2 之间，被 append-only 规则正确拒绝；第二个计划改为先追加到 V2.2 之后，再把 V2.2
重排到 L3-D6 之后，preflight 通过。

随后创建 proposal `739f37c8-8e2e-427c-a4b4-98aa775764e9`，digest
`6781bf231e333051b83aff50c51465cd1ccd23620a324cd27d520410378b5dbf`。调用
`approve_l3_operation` 时宿主返回 `AUTHORIZATION_GRANT_REJECTED/HOST_DECLINED`。不得用聊天
授权绕过，因此该 proposal 已明确 reject。**没有 Version 或 Todo 被创建，也没有路线重排。**

下一线程必须把这视为“版本链设计 ready，canonical commit 被当前宿主决策通道阻断”，而
不是“版本链已落地”或“实现进行中”。

## 4. 已接受的版本链

目标前向顺序：

```text
V2.16 (closed current)
  -> L3-D1 决策接口与状态投影
  -> L3-D2 现有授权路径 Adapter 化
  -> L3-D3 一调用执行编排与兼容工具
  -> L3-D4 Codex 权限 Adapter 与三级交互
  -> L3-D5 通用 MCP Adapter 与协议兼容
  -> L3-D6 迁移清理、全量回归与发布候选
  -> V2.2 UI Mission Control 只读看板完整形态
```

由于 V2.16 已关闭且已经有直接后继，合法操作顺序是：

1. 在当前顶层尾节点 V2.2 后 batch-create `L3-D1～D6`；
2. 授权并提交 batch proposal；
3. 对 V2.2 创建 reorder proposal，把它移动到 L3-D6 之后；
4. 授权并提交 reorder proposal；
5. 确认 V2.16 的直接后继为 L3-D1；
6. 准备并 advance 到 L3-D1。

下面的规划是 portable truth。另一台机器即使不读取本机 rejected proposal，也能重建完整
版本链；若需要复现原始输入和 digest，再从 `Routeledger-Internal` 读取该 proposal。

### 4.1 L3-D1 决策接口与状态投影

**目标**

建立宿主无关的 L3 decision request/result 契约，并基于现有 `PendingOperation`、
`ApprovalArtifact`、grant receipt 和 commit 数据提供兼容状态投影。

**Todo**

1. 定义 `ExactProposalDecisionRequest`、`DecisionResolution` 与 `L3DecisionAdapter` 公共契约；
2. 实现 `proposed`、`decision_required`、`decision_resolved`、`committing`、`committed`、
   `rejected`、`stale`、`failed` 的逻辑投影和非法跳转保护；
3. 覆盖 interactive、delegated、preauthorized、stale、replay、rejected 和 failed；
4. 增加 focused behavior test 和 public-contract test；
5. 证明 canonical schema 和现有外部行为不变。

**Undo / Boundary**

- 不把 Codex 专属字段放进 core；
- 不绕过 proposal、digest、live validation、receipt 或 audit；
- 本阶段不迁移 canonical JSON；
- 不实现一调用外部编排和用户模式切换。

**Acceptance**

所有现有 L3 结果能用统一状态语言表达，非法的 `proposed -> committing` shortcut 被拒绝，
现有 L3 测试保持兼容，存储格式没有迁移。

初始 Todo 标题：

- `定义 ExactProposalDecisionRequest、DecisionResolution 与 L3DecisionAdapter 公共契约`
- `实现基于现有数据的 L3 logical phase 投影与非法跳转保护`
- `补充接口、状态投影和兼容性测试，确认 canonical schema 不变`

### 4.2 L3-D2 现有授权路径 Adapter 化

**目标**

把 decision source 选择从 `approve_l3_operation` 的超长 handler 抽离为 host-neutral
resolver/adapters，同时严格保持 0.6.0 行为。

**Todo**

1. 包装 consumed replay；
2. 包装 matching finite grant / preauthorized 路径；
3. 包装 delegated authority 和一次性 grant 校验；
4. 包装 structured interaction 和 interaction grant；
5. 保留 profile/broker/registry 兼容路径；
6. 将 `approve_l3_operation` 收敛为兼容编排入口；
7. 运行现有授权、receipt、profile、elicitation 和 negative matrices。

**Undo / Boundary**

- 不删除现有低层工具；
- 不减弱 finite capability、exact binding、budget 或 receipt 校验；
- preauthorization miss 不得静默降级；
- 本阶段保持外部交互次数不变，一调用执行属于 L3-D3。

**Acceptance**

interactive、delegated、preauthorized 和 replay 全部经过统一 adapter 边界，既有成功和失败
结果等价，canonical 数据不迁移。

初始 Todo 标题：

- `抽取 replay、preauthorized、delegated、interactive 决策 resolver`
- `将 approve_l3_operation 收敛为调用统一 adapter 的兼容入口`
- `运行现有 L3 授权、receipt、profile 与 MCP interaction 回归矩阵`

### 4.3 L3-D3 一调用执行编排与兼容工具

**目标**

允许宿主用一次外部调用请求 L3 操作，并得到最终 committed result 或可恢复的
`input_required`，内部完整协议不减少。

**Todo**

1. 定义高层 execute L3 application API 与 MCP tool contract；
2. 实现 `propose -> resolve -> decision artifact -> live validation -> atomic commit`；
3. 自动模式在一次请求中完成 proposal-to-commit；
4. 交互模式返回并恢复 request state；
5. 设计 idempotency、duplicate delivery 和 retry；
6. 保留 propose/approve/commit 作为兼容和诊断工具。

**Undo / Boundary**

- 不折叠或删除内部状态转换；
- adapter 不得直接写 canonical 数据；
- retry 不得重复消费 grant 或重复 commit；
- 宿主 mode discovery 留给 L3-D4/D5。

**Acceptance**

匹配 delegated policy 和 finite capability 的操作一调用完成；interactive 可以安全恢复；
重复请求不会 double-consume 或 double-commit；低层工具继续可用。

初始 Todo 标题：

- `定义高层 execute L3 application API 与 MCP tool 契约`
- `实现自动模式的一调用 proposal-to-commit 编排`
- `实现 input_required 恢复、幂等重试与低层工具兼容测试`

### 4.4 L3-D4 Codex 权限 Adapter 与三级交互

**目标**

把 Codex 实现为第一个 host adapter，同时明确 Codex 不是 core permission model。

**Todo**

1. 实测当前 Codex 是否暴露 effective conversation permission context；
2. 能读取时映射为 interactive/delegated/preauthorized；
3. 不能读取时提供明确的 plugin-config fallback，不猜测当前模式；
4. 请求批准模式使用 Codex 原生 tool approval/interaction；
5. 替我审批模式调用确定性 RouteLedger policy；
6. 完全访问模式消费当前项目、会话或时间窗的 finite capability；
7. 展示 effective mode 和剩余额度，普通界面隐藏 profile 内部字段；
8. 完成真实 Codex Desktop 验收。

**Undo / Boundary**

- 不猜 conversation mode；
- 不把 physical-click attestation 当成通用硬门槛；
- 不把 Codex 配置或事件类型放进 core；
- 本阶段不定义 generic MCP 行为。

**Acceptance**

真实 Codex session 中可以证明三种用户行为；三种行为产生相同的 canonical mutation 和 audit
语义；模式不可用时结果明确且不静默放宽。

初始 Todo 标题：

- `实测 Codex 当前对话权限上下文与原生 tool approval 能力`
- `实现 Codex mode provider、映射与不可用时的显式 fallback`
- `完成三级交互、状态展示和真实 Codex Desktop 验收`

### 4.5 L3-D5 通用 MCP Adapter 与协议兼容

**目标**

提供独立于 Codex 的 host-neutral MCP decision adapter 和 conformance contract。

**Todo**

1. 将 MCP 2025 structured elicitation 接到统一 adapter；
2. 实现 MCP 2026 `InputRequiredResult`、`inputResponses`、`requestState` 和协议协商；
3. 定义无 UI 宿主的显式 configuration/capability injection；
4. 建立至少一个非 Codex stdio conformance harness；
5. 覆盖 tampered request state、duplicate、disconnect、timeout、retry 和 crash recovery。

**Undo / Boundary**

- generic MCP 不得假装知道 Codex mode；
- natural-language claims 和 project files 不能成为 authority；
- 不创建第二套 core decision model；
- 只覆盖本地单用户宿主，不扩展远程、组织、OAuth、多用户或跨设备。

**Acceptance**

MCP 2025、MCP 2026 和至少一个非 Codex stdio harness 对相同 proposal 产生等价结果；无 UI
fallback 有显式配置；异常和重试不导致授权或提交重复消费。

初始 Todo 标题：

- `接入 MCP 2025 elicitation 到统一 decision adapter`
- `实现 MCP 2026 requestState/inputResponses 协议适配与协商`
- `建立非 Codex stdio conformance、无 UI fallback 和异常重试矩阵`

### 4.6 L3-D6 迁移清理、全量回归与发布候选

**目标**

只有在新 adapters 和 orchestrator 证明兼容后，才移除过时产品仪式并形成 release candidate。

**Todo**

1. 默认产品面隐藏 profileId/profileDigest/modeEpoch；
2. 新 API 把 `ApprovalArtifact` 投影为 `DecisionArtifact`；
3. 审核 `trustedDecision`、physical-click proof、profile adoption 和重复 ceremony；
4. 保留并验证旧数据 reader、旧工具和升级/降级路径；
5. 覆盖 restart、concurrency、clock、crash、expiry、revoke、replay 和 receipt recovery；
6. 运行 full tests、typecheck、lint、package/plugin/marketplace/MCP/host smokes；
7. 形成 release-candidate audit 和 portable handoff。

**Undo / Boundary**

- 没有 migration proof 不删除 raw evidence 或 legacy reader；
- 不在本 Version 自动 merge、tag、publish 或 release；
- 正式发布仍需用户另行授权。

**Acceptance**

清理清单全部 resolved 或显式 deferred；兼容和异常矩阵通过；完整回归为 green；release
candidate 没有隐藏的 machine-local 依赖。

初始 Todo 标题：

- `盘点 Profile、trustedDecision、旧命名与重复 ceremony 的清理候选`
- `完成旧数据/旧工具兼容、升级降级与异常恢复矩阵`
- `运行全量测试、typecheck、lint、package/plugin/host smokes 并形成发布候选审计`

### 4.7 Canonical 重建参数

- 所有六个 Version 都是 top-level sibling，`parentVersionId = null`；
- batch 顺序和 `clientKey` 固定为 `l3-d1`、`l3-d2`、`l3-d3`、`l3-d4`、`l3-d5`、
  `l3-d6`；
- `partialAllowed = false`；
- 第一步 anchor：`afterVersionId = 31ca96d7-675f-42e0-8c4f-f5a9d2c20a06`
  （旧 V2.2 UI），`beforeVersionId = null`；
- `setCurrentTo = null`；
- `previousCurrentPolicy = leave_as_is`；
- batch commit 后，reorder `31ca96d7-675f-42e0-8c4f-f5a9d2c20a06` 到 L3-D6 的新 ID
  之后；
- 最终结构必须由 `get_version_structure` 验证为
  `V2.16 -> L3-D1 -> ... -> L3-D6 -> V2.2`；
- 不复用 rejected proposal 做 commit；读取它仅用于恢复输入，必须重新 preflight/propose 并
  使用新的 exact artifact。

## 5. 工作地图

| 工作区 | 状态 | 稳定结果或剩余工作 |
| --- | --- | --- |
| 产品定义 | accepted | L3 是路线转换决策协议；权限控制决策自动化 |
| 当前实现评估 | complete | 现有内核保留，MCP handler/宿主决策边界需要拆分 |
| Canonical 版本链 | ready / blocked | 精确 batch 已预检；需要可用宿主 L3 决策后重新 propose/approve/commit |
| L3-D1 接口与状态投影 | ready | 第一段代码工作，5～8 人日切片的一部分 |
| L3-D2 兼容 adapter | pending | 抽离 replay/preauthorized/delegated/interactive 分支 |
| L3-D3 一调用编排 | pending | 自动模式一调用完成，交互模式可恢复 |
| L3-D4 Codex adapter | pending | live capability probe、动态映射或配置 fallback、Desktop 验收 |
| L3-D5 通用 MCP adapter | pending | MCP 2025/2026、stdio conformance、无 UI fallback |
| L3-D6 清理和 RC | pending | 内部概念降噪、兼容迁移、全量异常矩阵和发布候选审计 |
| 正式发布 | not authorized | merge/tag/release/publish 必须另行明确授权 |

## 6. 已接受决策与证据边界

### 必须保持的决策

- L3 在所有权限模式下都完整运行；
- permission mode 只改变 decision source 和交互次数；
- trusted Agent host 可以作为决策来源，RouteLedger 不复制每个平台的完整 sandbox；
- 物理点击证明不是通用产品硬门槛，可由特定 adapter/部署按需要求；
- Profile 是兼容期内部 capability 记录，不是用户必须理解的产品中心；
- core 中不得出现 Codex 专属配置；
- generic MCP 不得假装知道 Codex 当前会话模式；
- 新 API 优先使用 `decisionArtifact` 语义，存储和兼容 API 暂留 `ApprovalArtifact`。

### 被否定或取代的方向

- “拿不到可验证的用户点击就整个产品 fail closed”已被取代；
- 把 Codex 插件形态和 RouteLedger L3 内核视为同一层已被否定；
- 直接依赖外部 Agent 平台保证全部路线正确性已被否定：平台负责调用决策，RouteLedger
  仍负责 exact binding、live validation、atomic commit 和 audit；
- 直接删掉 L3 或在完全访问下跳过内部操作已被否定。

### 未知和证据限制

- 当前 Codex 是否公开当前对话权限模式的稳定运行时字段仍未知；必须 live probe；
- 本次 `HOST_DECLINED` 只证明当前加载的 MCP interaction 没有给出 accept，不证明所有 Codex
  版本永久不能提供该能力；
- MCP 2026 adapter 尚未实现，也未在目标客户端实测；
- 工作量估算为 20～34 人日，最大变量是宿主能力和协议兼容矩阵。

## 7. 资产分类与待清理清单

### 7.1 当前真源：保留

1. `docs/guides/l3-route-transition-decision-protocol.md`：产品和架构定义；
2. `docs/guides/l3-decision-protocol-implementation-assessment.md`：当前代码差异和实施顺序；
3. 本 handoff：唯一继续入口；
4. canonical RouteLedger MCP live state：版本和 Todo 的操作真源。

### 7.2 稳定历史结果：保留

- `docs/release/release-notes/0.5.0.md`、`0.5.1.md`、`0.6.0.md`；
- `docs/guides/l3-authorization-v3-host-broker.md`；
- `packages/core/src/application/l3-authorization*.ts`；
- `packages/mcp/src/local-l3-authority-*.ts` 和 `local-l3-authorization.ts`；
- 现有 broker/profile/grant/receipt/interaction 测试和 smoke。

这些材料描述已发布行为或仍被代码消费。即使新产品定义不同，也不能作为“过时文档”直接删除。

### 7.3 代码清理候选：到 L3-D6 前不得提前删除

| 候选 | 位置 | 处理原则 |
| --- | --- | --- |
| 超长决策 handler | `packages/mcp/src/index.ts` 的 `approve_l3_operation` | L3-D2 抽成 resolver/adapters，先保持行为等价 |
| 物理点击通用门槛 | `trustedDecision` 和 V3 interactive 校验 | Codex/generic adapter 就位并有负面测试后再收窄 |
| Profile 用户可见字段 | status/recommendation projection 中的 id/digest/epoch | 内部保留，普通用户表面隐藏 |
| approval 命名 | `ApprovalArtifact`、approve/commit 兼容 API | 新 API 投影为 decision；旧数据和工具保留兼容 |
| Codex 静态 tool approval 分类 | `packages/codex/src/index.ts` | 与 live mode provider/fallback 一起重评，不先删除 |
| 旧 profile/adoption ceremony | broker/registry migration 路径 | 有真实旧数据升级测试后才能删除 |
| 旧 smoke 假设 | Codex app-server、normal-turn、elicitation scripts | adapter 验收矩阵建立后分类为保留/重写/删除 |

### 7.4 RouteLedger 旧 Version 清理候选

- `Initial Version`：无业务内容的初始化占位，优先 shutdown 候选；
- `V2.15 Workspace Config 定位契约重塑`：父节点仍 WAIT，但 A/B 已完成且 V2.16 已关闭，
  状态失真；
- `V2.15C 数据目录迁移与跳转执行层`：V2.16 明确否定原路径，需 shutdown 或重新定义，
  不得原样推进；
- `V3 Package 发布准备与跨平台验证`：0.6.0 plugin 已发布，但 npm/package/cross-platform
  仍可能有效，需拆分已完成与剩余；
- `V4`、`V5`：长期 backlog，保留但不阻塞 L3；
- `V6`：混合杂项容器，需把独有 Todo 分流后才能 shutdown；
- `V7`：SUSPEND，部分模块拆分与 L3-D1/D2 重叠，需吸收重叠项并保留非 L3 工程债；
- `V2.2 UI`：需求仍有效，只需后移，不应 shutdown。

本轮没有对这些 Version 执行 shutdown，因为新的 batch 变更已在授权处失败；继续发起更多必然
失败的 L3 proposal 只会制造审计噪音。

### 7.5 已清理的中间资产

- 本文件此前的 V1/V2/V3-R1/R2/R3 路线叙述已被新定义和实施评估完整吸收，因此在原路径
  重写；旧字节仍可从 Git 历史 `a5b02e5` 恢复；
- 未提交的三份 decision 测试草稿已经删除；没有独有结论，行为要求已进入实施评估和目标
  L3-D1 Todo。

没有删除 raw evidence、release evidence、用户文件或机器私有授权状态。

## 8. 最短阅读顺序

1. 仓库 `Agents.md` 和当前用户指令；
2. [`L3 route-transition decision protocol`](../guides/l3-route-transition-decision-protocol.md)；
3. [`L3 decision protocol implementation assessment`](../guides/l3-decision-protocol-implementation-assessment.md)；
4. 本 handoff 的 canonical 状态、版本链和下一步；
5. `packages/mcp/src/index.ts` 中 `approve_l3_operation`；
6. `packages/core/src/application/routeledger-service.ts` 中 `authorizeL3Operation` 和
   `commitL3Operation`；
7. `packages/core/src/application/l3-authorization*.ts`；
8. `packages/codex/src/index.ts` 的 tool approval config；
9. 仅在查历史行为时阅读 0.5.0～0.6.0 release notes 和旧 broker guide。

不要先重放旧对话，也不要先从历史 V3-R1“物理点击 admission”重新开始。

## 9. 工作区与恢复

### 源码仓库

- 路径：`D:\Program\plugins\Routeledger`
- remote：`https://github.com/xczl-785/Routeledger.git`
- branch：`docs/v3-codex-authorization-handoff`
- 本 handoff 更新前 HEAD：`559ee57`
- 受保护保留分支：`codex-marketplace`，不得删除、重命名、合并、rebase 或 force-push

### Canonical 数据仓库

- 路径：`D:\Program\plugins\Routeledger-Internal`
- remote：`https://github.com/xczl-785/Routeledger-Internal.git`
- branch：`main`
- 本轮开始时本地已比 `origin/main` ahead 1：`524e5e4`
- 本轮新增的是一个 rejected proposal 及两条 audit event；没有 Version/Todo 变更

canonical 文件只能由 RouteLedger MCP 工具写入。Git 可以提交 MCP 产生的数据文件，但不得
手工编辑它们来伪造版本链或授权结果。

### 机器本地依赖

- 本次使用的 plugin cache runtime 位于当前 Windows 用户 Codex cache；该路径不应成为代码
  或文档的运行依赖；
- detached release attestation 可从 0.6.0 GitHub Release 恢复；
- 当前宿主 interaction 返回 `HOST_DECLINED`，这一运行时状态不可通过 Git 转移。

## 10. 精确下一步

1. 新线程先调用 `get_runtime_context`，核对 workspace、RouteLedger root、project、locale 和
   runtime identity；
2. 调用 `get_current_context`，确认没有 pending L3 proposal，且 rejected proposal 已保留为
   audit；
3. 确定一个能让 `approve_l3_operation` 得到有效决策的宿主路径：真实 structured
   interaction、已配置 delegated authority，或严格匹配的 finite preauthorization；
4. 读取 rejected proposal `739f37c8-8e2e-427c-a4b4-98aa775764e9`，复用其中完整
   `batchItems` 重新执行 preflight/propose；
5. approve 并 commit batch；然后 reorder V2.2 到 L3-D6 后并提交；
6. 复核结构后 prepare/advance 到 L3-D1；
7. 进入代码时使用 TDD：先写 decision result/state transition 的失败测试，再实现最小公共
   接口和兼容状态投影；
8. 不要在 L3-D1 顺手实现一调用编排、Codex adapter 或数据迁移。

如果宿主仍返回 `HOST_DECLINED`，不要重复制造 proposal；记录 live evidence，并先修复/配置
宿主决策通道。聊天文本不能作为替代授权。

## 11. 验证标准

交接恢复后，新 Agent 应能在不读旧对话的情况下说明：

- L3 的新定义和三级权限真正控制什么；
- 哪些 0.6.0 内核必须保留；
- 为什么 Codex 与 generic MCP 是 adapter；
- 当前没有代码实现，也没有 canonical 新版本；
- 版本链为何要先 append 再 reorder；
- 哪个 proposal 被拒绝、为什么被拒绝；
- 第一段代码只做到接口、状态投影和兼容测试；
- merge/tag/release 仍未获授权。
