# Undo 退役：数据迁移分类报告

> 本文是迁移前的过程输入，不是迁移已完成证明。当前禁止执行真实数据改写。

## Process Contract

| 字段 | 当前值 |
| --- | --- |
| role | 盘点 legacy Undo 数据面、分类目的地、执行门槛、验证和回滚要求。 |
| state | `blocked` |
| truth-source | 当前代码与测试、`cap-route-work-semantics.md`、每个项目绑定后的 canonical JSON。 |
| downstream-target | feature 开发完成后的独立数据迁移阶段。 |
| exit-condition | 所有已授权项目完成 dry-run、迁移、验证和回滚演练，并由用户确认验收。 |
| post-exit-disposition | 作为迁移证据保留；稳定规则继续由 capability docs 承载。 |
| blocker | feature 尚未结束，其他使用 RouteLedger 的项目尚未由用户显式宣布停机。 |
| unblock-condition | 用户显式宣布 feature 开发结束且其他项目全部停下，并授权进入迁移。 |

## 当前结论

- 当前代码已经支持 Todo / Deferred / Constraint，并保留 legacy Undo 读取、Gate 和 direct invoke 兼容。
- canonical JSON 和 SQLite 已同时支持 `deferred_items` 与 `constraints`，但 `.routeledger/undos/`、SQLite `undos`、历史 events 和 pending payload 仍存在。
- 本阶段只做分类与迁移设计，不扫描或改写任何真实项目 `.routeledger`。
- 不允许把所有 Undo 机械地一比一改名为 Deferred。存量记录必须按真实含义分类。

## 数据面盘点

| 数据面 | 当前角色 | 迁移原则 |
| --- | --- | --- |
| `.routeledger/undos/<prefix>/<id>.json` | legacy canonical object | 按记录分类；原始快照必须保留。 |
| `.routeledger/deferred_items/` | 当前 Deferred canonical object | 接收“已承诺未来复评”的迁移结果。 |
| `.routeledger/constraints/` | 当前 Constraint canonical object | 接收稳定 guardrail/rule。 |
| `.routeledger/todos/` | 当前 Todo canonical object | 接收当前或明确 owning Version 应做的工作。 |
| `.routeledger/work_items/` | 跨 Todo/Undo/Deferred 的工作身份与 active record 关系 | 迁移时保持 lineage，禁止制造同一 work item 的多个 active record。 |
| `.routeledger/events/` | 历史审计证据 | 不重写既有事件；新增迁移事件应可追溯到原 legacy id。 |
| `.routeledger/pending_operations/` | L3 proposal 与 digest 载体 | 不直接改写 digest；先清空或裁决 legacy pending proposal。 |
| `.routeledger/approval_artifacts/` | 审批证据 | 不重写、删除或复用。 |
| SQLite `undos/deferred_items/constraints/...` | 可重建 read model | canonical JSON 迁移完成后重建；不得从 SQLite 反向覆盖 canonical 真源。 |
| `.routeledger_bak`、WAL/SHM | 备份或输入证据 | 只读保留，不原地恢复成当前 runtime 真源。 |

## 迁移分类

每条 open legacy Undo 必须落入且只能落入下列一类。无法确定时进入 `AMBIGUOUS`，不得自动迁移。

| 分类 | 判断问题 | 目标状态 | 必要证据 |
| --- | --- | --- | --- |
| `TODO_NOW` | 是否已经属于当前/明确 owning Version 应完成的工作？ | Todo | target Version、title、迁移理由。 |
| `DEFERRED_REVIEW` | 是否明确承诺未来复评，而当前主动不做？ | Deferred | origin Version、target review Version、reason；可选 trigger。 |
| `CONSTRAINT_RULE` | 是否是任何实现不得违反的规则，而不是一项工作？ | Constraint | project/version scope、rule、rationale。 |
| `OUT_OF_SCOPE` | 是否仅判断当前范围不承诺，未来重新进入需新决策？ | 关闭 legacy active record；保留独立范围决策证据 | reason、decision ref。 |
| `REJECTED` | 是否已经评审并明确不采用？ | 关闭 legacy active record；保留拒绝决策证据 | reason、decision ref。 |
| `SUPERSEDED` | 是否已被另一个正式记录或实现替代？ | 关闭 legacy active record | replacement id / evidence。 |
| `HISTORICAL_CLOSED` | legacy record 是否早已关闭且不再参与 Gate？ | 原样保留历史证据，不生成新 active item | close reason/note 与审计链。 |
| `AMBIGUOUS` | 文本、owner、target 或决策证据是否不足？ | 阻塞该条迁移，人工裁决 | 缺失字段和推荐选项。 |

### 禁止的机械映射

- `Undo -> Deferred` 全量改名；
- 没有目标复评 Version 的 Deferred；
- 把 guardrail 创建成 Todo；
- 把 Out of Scope 与 Rejected 合并成同一个“关闭”语义；
- 为了迁移而先创建 Deferred、再立即 resolve；
- 重写历史 event、approval artifact 或已生成 proposal digest；
- 只改 SQLite、不改 canonical JSON。

## 执行前硬门槛

以下条件必须全部满足：

1. feature 开发已经结束，相关代码、schema、CLI/UI/文档和 package 验收已经关闭。
2. 用户显式宣布所有使用 RouteLedger 的其他项目均已停下，并明确授权迁移。
3. 对每个项目重新验证 `workspaceRoot`、`routeledgerRoot`、`dataRoot`、project id 和 current Version；禁止沿用旧聊天记录里的路径。
4. 所有 MCP/CLI/UI writer 已停止，且不存在 active write lock、运行中的 proposal commit 或后台同步。
5. 每个 canonical root 已做只读、字节级备份，并记录 Git/head revision、文件清单和校验值。
6. legacy pending proposal 已完成 commit/reject，或经人工批准作为不可改历史保留；不得在迁移中修改其 digest。
7. dry-run 分类报告不存在 `AMBIGUOUS`，且每条记录都有唯一目的地与证据。
8. 迁移工具、验证器和回滚脚本已在复制到临时目录的数据上演练通过。

任一条件失败，迁移必须 fail closed。

## 建议执行顺序

1. 冻结全部 RouteLedger writer，并重新检查 binding。
2. 复制 canonical roots 到独立只读备份和临时 staging。
3. 只在 staging 运行 inventory 与分类 dry-run，输出逐记录映射：
   - source legacy id
   - classification
   - target type/id/version
   - lineage strategy
   - decision evidence
   - expected Gate change
4. 人工审阅分类报告，消除所有 `AMBIGUOUS`。
5. 在 staging 生成 canonical replacement，运行 validate、decode/encode round-trip 和 Gate 对比。
6. 经显式批准后，对单个低风险项目做首批迁移。
7. 重启 JSON-first runtime，从 canonical JSON 恢复并重建 SQLite。
8. 完成验收后再逐项目推进；一个项目失败不得继续批量扩散。

## 验证清单

- 迁移前后 project/version/todo/deferred/constraint/work-item/event/pending/approval 数量均有可解释对账。
- 每条 active legacy Undo 都有唯一分类；closed legacy 证据仍可追溯。
- 每个 work item 最多一个 active Todo/Deferred/legacy record。
- Deferred 全部指向存在且顺序合法的 target review Version。
- Constraint scope 指向存在的 project 或 Version。
- Out of Scope 与 Rejected 的 reason 和 decision ref 可区分。
- `json validate`、canonical round-trip、merge-check 和全仓测试通过。
- 删除或重建 SQLite 后，runtime 能仅从 canonical JSON 恢复相同状态。
- 默认 current context 只展示 Todo / Deferred / Constraint；必要时 legacy audit 仍可读取保留证据。
- start/close Gate 的每一处变化都与批准的映射报告一致，没有静默放宽 blocker。

## 回滚方案

1. 发现任何分类、引用、Gate 或 digest 异常时立即停止 writer。
2. 保留失败后的 canonical set 作为诊断证据，不在原地反复修补。
3. 从迁移前字节级备份恢复整个 canonical managed set，而不是只恢复 `undos/`。
4. 删除并重建 SQLite read model；不得用失败后的 SQLite 覆盖恢复后的 canonical JSON。
5. 重新运行 validate、round-trip、runtime restart 和 Gate 对比。
6. 记录失败分类与修正条件；只有新的 dry-run 全部通过并再次获得授权后才可重试。

## 当前不执行

本报告的存在不构成迁移授权。当前保持：

- 真实 `.routeledger` 不变；
- legacy schema compatibility 不变；
- historical evidence 不删除；
- 数据迁移 disposition 为 `deferred-with-condition`。
