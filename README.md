# RouteLedger

RouteLedger 当前已经有可运行的 core / JSON / SQLite / CLI / MCP 实现，不再是“仅产品定义、尚未开始工程实现”的状态。

本项目以 [Apache License 2.0](LICENSE) 授权；第三方依赖各自适用其声明的许可证。

## Current docs

- 当前工作语义：[Route work semantics](docs/capabilities/cap-route-work-semantics.md)
- 代码当前真相入口：[Capability index](docs/capabilities/capability-index.md)
- 代码仓内 current-truth 文档目录：[Capabilities](docs/capabilities/README.md)
- Undo 退役数据迁移分类报告：[Data migration classification](docs/undo-retirement-data-migration-classification.md)
- Codex marketplace 与插件入口：`xczl-785/Routeledger`、selector `routeledger@routeledger-team`、`.agents/plugins/marketplace.json`、`plugins/routeledger/`。
- 公开接入与发布边界：[Guides](docs/README.md)、[Release policy](docs/release-policy.md)

## Current work semantics

RouteLedger 的默认 Agent 语义已经固定为：

| 术语 | 含义 |
| --- | --- |
| `TODO` | 当前 Version 应做、但尚未完成。 |
| `DEFERRED` | 当前主动不做，已指定目标 Version，届时必须复评。 |
| `CONSTRAINT` | project 或 Version 范围内不得违反的规则。 |
| `OUT OF SCOPE` | 当前范围不承诺实现；未来重新进入需要新决策。 |
| `REJECTED` | 已评审并明确不采用。 |
| `UNDO` | 只保留撤销/回滚的通常含义；现有同名 entity 是历史兼容术语。 |

Agent 默认使用 `create_todo` / `close_todo`、`defer_work` / `review_deferred`、`record_constraint` / `retire_constraint`。五个历史 Undo 写 handler 不再进入 MCP 默认 discovery；只有遗留 blocker 需要审计时，才显式调用 `get_current_context(includeLegacyUndo=true)`。

历史兼容并不等于数据已经迁移：canonical JSON/SQLite 仍保留 legacy Undo schema、事件和旧 pending payload 的读取/round-trip 能力。真实迁移只有在 feature 开发结束、用户显式宣布其他项目全部停下并授权后才能进行。

## Runtime terms

| 术语 | 当前含义 |
| --- | --- |
| `workspaceRoot` | host 当前线程/工作区对应的工程根目录。MCP CLI/runtime 接收它作为 binding 的外层边界。 |
| `routeledgerRoot` | 当前这条 MCP server entry 实际管理的项目根目录。必须位于 `workspaceRoot` 内。 |
| `workspace config` | 项目根下的 `.routeledger/config.json`。它是 workspace entrypoint，只负责声明 `dataDir`。 |
| `dataRoot` | `config.json.dataDir` 解析后的 RouteLedger output root。默认是 `routeledgerRoot/.`，也允许指向外部目录。 |
| `routeledgerDir` | 真实 canonical 数据目录，固定为 `<dataRoot>/.routeledger`。 |
| `MCP server entry` | host 配置里的一条 server 配置。当前契约是一条 entry 对应一个固定 binding：`workspaceRoot + routeledgerRoot`。 |
| `tools` | 这条 entry 通过 MCP 暴露给 host 的工具集合。普通工作区或 thread 默认只应看到当前工作区对应的那条 entry 的 tools。 |

## Runtime truth

- 项目根的 `.routeledger/config.json` 是 runtime entrypoint。首次 MCP 接入时若该文件不存在，会自动创建默认配置：`{ "version": 1, "dataDir": "." }`。
- `dataRoot` 是 `config.json.dataDir` 解析后的物理 output root。若是相对路径，则以 `routeledgerRoot` 为基准解析；它允许位于工作区外。
- `routeledgerDir` 固定为 `<dataRoot>/.routeledger`。
- Canonical JSON 文档集位于 `<dataRoot>/.routeledger/`，是当前 MCP runtime 的真源。
- SQLite 位于 `<dataRoot>/.routeledger/db/routeledger.sqlite3`，现在只承担可重建的 read model / cache 角色。
- MCP runtime 入口已经是 JSON-first：
  - 若 `<dataRoot>/.routeledger/project.json` 存在，MCP 先从 canonical JSON load/validate aggregate。
  - 若 SQLite 缺失、为空或损坏，MCP 仍可从 JSON 启动，并在后续重建 SQLite read model。
  - 若配置存在但只有 SQLite，MCP 仍可走 SQLite-only fallback；但旧的 no-config 项目不会在本轮自动迁移。
- 若 canonical JSON 与非空 SQLite 指向不同 project，或同 project 但 canonical 内容冲突，MCP 会返回明确 conflict，不会静默覆盖。

## Control-plane boundary

- RouteLedger 是 per-project control plane，不是 workspace 级自动感知助手。
- 每个 MCP stdio server 实例永远只绑定一个 `workspaceRoot + routeledgerRoot`。`workspaceRoot === routeledgerRoot` 是合法单根特例，不是 runtime 默认回退。
- `cwd` 只是 MCP 进程的运行位置：源码方式通常指 RouteLedger 仓根，已安装 package 方式通常指安装目录。被管理项目身份始终由 binding 决定，而不是由 `cwd` 决定。
- `routeledgerRoot` 仍然是项目根，不是 data root。host config 继续只绑定项目根，不把外部 `dataDir` 写进 Codex 配置。
- 多工作区并行的当前模型是：A entry 绑定 `workspaceRoot=/path/to/A`、`routeledgerRoot=/path/to/A/subA`；B entry 绑定 `workspaceRoot=/path/to/B`、`routeledgerRoot=/path/to/B/subB`。两条 entry 可以共用同一份源码仓或已安装工件，但各自是独立进程、独立 binding、独立 `config.json` entrypoint、独立 write lock、独立 SQLite 和 runtime data。
- same-root lock 只负责同一个 `dataRoot` 下的串行写入；cross-root 不共享锁、不共享 SQLite、也不共享 runtime state。
- MCP 提供只读 `get_runtime_context` 诊断工具，用于回显当前 server 的 binding 摘要、`workspaceConfigPath`、`dataRoot`、`routeledgerDir`、`jsonProjectPath`、SQLite 路径、storage mode、active project 摘要和 host identity。它不要求 `projectId`，也不切换 root。
- MCP 还提供第一批 binding assist 工具：`discover_routeledger_roots` 只读扫描 `workspaceRoot` 内 `.routeledger/config.json` 候选，`plan_routeledger_binding` 生成绑定计划，`render_host_binding_config` 生成 Codex source-mode 配置片段或写入计划。它们都不做 runtime root switch，也不自动落盘用户配置。

## Safety boundary

- `get_runtime_context` 是看板，不是保险丝。它负责把当前 server 实际绑到哪里回显出来，但不替代 host 隔离，也不替代写路径断言。
- P0 / P1 阶段的强防误写依赖两层：第一层是 host 隔离，普通工作区或 thread 默认只暴露本工作区对应的那条 server entry；第二层是写工具自身的 root assertion。
- 如果同一个 host / thread 需要同时暴露多条 RouteLedger entry，entry 名称必须带项目名，例如 `routeledger-project-a`、`routeledger-project-b`，避免 agent 把 tools 用错对象。
- 非 read-only MCP 工具现在要求 `expectedRouteLedgerRoot` 写断言。调用方传入时，server 会先校验 `expectedRouteLedgerRoot === routeledgerRoot`；不匹配、空值或相对路径会直接拒绝，不进入写路径。它是 root assertion，不是 per-call root switch。
- MCP runtime 还会在工具执行前做 binding preflight。若当前 binding 为 `unbound`、`uninitialized` 或 `invalid`，相关工具返回结构化 blocked 信息与 next actions，不再沿用旧 `projectRoot` 语义硬跑。
- `unbound` / `invalid` 时，推荐动作优先指向 `discover_routeledger_roots -> plan_routeledger_binding -> render_host_binding_config`。`uninitialized` 时，推荐动作会先 discover/plan，再让 agent 决定是否调用 `init_project`。

## Multi-project FAQ

- 从 A 切到 B 后，B entry 查不到 A 的 RouteLedger data root。这是当前设计目标，不是缺陷。
- B entry 可以正常初始化或创建自己的工程，前提是 B entry 绑定的确实是 B，且 B 目录可写。
- 如果 B 下已经存在 canonical JSON / SQLite 冲突，仍按现有 `JSON_SQLITE_CONFLICT` 规则报错，不会因为它是“另一个 entry”而放宽。
- 当前不支持 `workspaceRoot=A` 但 `routeledgerRoot=/outside/of/A`。`routeledgerRoot` 必须位于 `workspaceRoot` 内。
- 当前支持 `workspaceRoot=A` 且 `routeledgerRoot=A/sub`。如果把 `routeledgerRoot` 直接设成 `A/sub`，RouteLedger 只管理这棵子树及其 `.routeledger/config.json` entrypoint 与对应 data root。

## Write path

- MCP 写路径先更新 canonical JSON，再同步 SQLite read model。
- SQLite 同步失败不会破坏已经写成功的 canonical JSON；下次启动仍会以 JSON 为真源恢复。
- 这意味着“JSON 已成功、SQLite 仍 degraded”是允许的中间状态。当前实现会保留 JSON 并在后续启动时尝试恢复 SQLite。

## Canonical replacement safety

- Canonical JSON 替换不是逐文件直接覆盖。
- 新文档集会先写入 `.routeledger/.canonical-replace/next/` staging 区并完成读取/校验。
- 只有 staging 文档集准备完成后，才会进入 canonical replace 阶段。
- 若上次替换中断并留下 `.routeledger/.canonical-replace/`：
  - read / replace 前会先做 recovery；
  - `staged` 残留只有在 backup 尚未生成时才会被丢弃；如果 backup 已经存在，会恢复旧 canonical set；
  - `backup_created` 残留会恢复旧 canonical set；
  - 若当前 canonical set 已经完整有效，即使 replacement cleanup 残留了 partial backup，也会优先保留当前真源并只清理 replacement 目录；
  - 不会把混合 canonical set 无声当作真源继续读取。
- `.routeledger/db/`、`.routeledger/views/`、`.routeledger/runtime/` 等非真源目录不会在 canonical replace 中被覆盖或删除。

## Testing boundaries

- 根级 `.routeledger_bak/db/routeledger.sqlite3`、`-wal`、`-shm` 只能作为测试输入、备份证据或回滚证据。
- 不要把 `.routeledger_bak/db` 原地恢复成运行时真源。
- 做真实 smoke 时，先复制到 `/tmp/...` 再操作，避免污染用户数据。

## CLI boundary

- CLI 已提供当前工作语义命令：
  - `deferred create`
  - `deferred from-todo`
  - `deferred activate`
  - `deferred defer-again`
  - `deferred resolve`
  - `constraint record`
  - `constraint retire`
- 新建 Deferred 使用 `--current-version-id` 与 `--target-review-version-id`；CLI 响应不暴露内部 work-item/origin 编排字段。
- `context` 默认隐藏 legacy Undo；只有显式传入 `--include-legacy-undo` 才返回审计明细。
- 旧 `undo create/reassign/close` 命令只为兼容既有脚本和数据操作保留，不是新工作默认入口。
- CLI 仍以 SQLite / JSON import/export 为主要 runtime/storage 入口。
- `json import` / `json export` / `json merge-check` 仍是 CLI 侧的显式操作面。
- `json review-summary --base-ref <ref> --head-ref <ref>` 会从两个 Git ref 临时 materialize `.routeledger/`，输出聚合后的 review summary；当前一等字段是 `todos` / `deferred` / `constraints`，历史 Undo 统计位于 `legacyCompatibility.undos`。它不改 canonical schema，不替代 `git diff`，也暂不支持 working tree / directory 对比。
- `json import` 成功响应不再输出一等 `undos` count，改为 `legacyUndoRecords`；canonical `.routeledger/undos/` 与 decoder 仍保持兼容。
- 上述两个 CLI JSON 输出字段调整可能破坏旧外部解析器。消费者升级时应把 review-summary response 的 `data.undos` 改读 `data.legacyCompatibility.undos`，把 import response 的 `data.undos` 改读 `data.legacyUndoRecords`，并在切换 package/CLI 版本前更新 contract fixtures。滚动升级可暂时双读新旧字段，但新代码不得继续把 legacy Undo 当一等产品语义。
- 当前 package 仍未发布；未来发布说明必须显式列出这项 parser-facing 变更。若替换已经被外部消费的 artifact，应按输出 contract breaking change 管理，而不能仅以 canonical storage 仍兼容为由当作无影响补丁。
- CLI 的 JSON 读取路径在 `json validate` / `json import` / `json merge-check` 前也会先做 recovery，因此不是完全无副作用的裸读目录扫描。
- MCP runtime 已经是 JSON-first，但 CLI 并没有整体切换成与 MCP 完全相同的入口语义；这是当前边界，不要混用表述。

## Agent host docs

Codex marketplace 与插件定义位于仓库根 `.agents/plugins/marketplace.json` 和 `plugins/routeledger/`。`routeledger@routeledger-team` 已作为 Git marketplace plugin 发布，使用仓库内的 JSON-only runtime；这不等于 `@routeledger/mcp` 已发布到 npm registry，也不代表提供 global CLI。

## Mission Control source launch

当前 Mission Control 自动启动只覆盖源码态，不覆盖安装包集成、MCP package build 流程或发布产物验收。

- 先执行 `pnpm build:ui` 生成 `packages/ui/dist/`。
- 当前 MCP 新增只读源码态工具：
  - `open_mission_control`
    - 默认复用当前 MCP runtime binding 的 `workspaceRoot + routeledgerRoot`。
    - 也允许显式传入 `workspaceRoot` / `routeledgerRoot` JSON 字段。
    - 返回 `url`、`projectId`、`pid`、`port`、`reused`、`registryPath`、`workspaceRoot`、`routeledgerRoot`。
  - `get_mission_control_status`
    - 只检查用户级 registry 与 `/api/health`，不会启动 UI。
    - 返回当前 roots、matching healthy instance、healthy instances 与 stale entry 摘要。
- CLI 源码入口仍是 `pnpm launch:ui -- --workspace-root <abs> --routeledger-root <abs>`。
- Mission Control launcher 继续使用 `127.0.0.1 + listen(0)` 动态端口；实例 registry 继续写入用户级状态目录，不写项目内 `.routeledger/views`。
- 默认总览、路线树和 current Version 面板使用 Todo / Deferred / Constraint：Deferred 显示目标评审 Version、trigger 与 DUE 状态，Constraint 显示 project/current Version 生效范围。
- legacy Undo 不进入默认统计或 current work 列表，只在明确标注的历史兼容审计区域展示，并保留 legacy blocker 数量提示。
- 当前 UI 仍然是只读看板，不接 create/close/approve/commit/transition 等写接口。

## MCP package-prep artifact

仓库现在提供一个本地 package-readiness 补丁，用于把 `@routeledger/mcp` 做到可构建、可本地 tarball smoke，但仍不宣称已发布：

- `pnpm build:mcp-package`
  - 生成 `packages/mcp/dist/`。
  - 产出 dist 专用 `package.json`，runtime 工件里不再保留 `workspace:*` 依赖。
- `pnpm smoke:mcp-package`
  - 对 `packages/mcp/dist/` 执行 `npm pack`。
  - 把 tarball 安装到临时目录。
  - 用已安装的 `bin.js` 跑 `initialize -> tools/list` smoke，并验证 stdout/stderr 边界。

当前 dist 工件会把 `@routeledger/core` / `@routeledger/json` / `@routeledger/sqlite` 编译进包内，只保留 `better-sqlite3` 为外部 runtime 依赖。

这仍然不是 npm registry 发布完成态：

- 还没有对外发布 `@routeledger/mcp`。
- 还不能把文档写成“现在可直接 `npx @routeledger/mcp`”。
- `routeledger@routeledger-team` 0.3.1 已作为 Git marketplace plugin 发布；不可变 `routeledger-plugin-v0.3.1` tag 与 canonical remote 的 `codex-marketplace` 分支固定发布提交。发布点的 `main` 与其对齐；其后 `main` 可经受保护 PR 承载非分发变更而前进，只要 `plugins/**` 相对 tag 零差异，仍对应同一 0.3.1 baseline。任何分发字节变化都必须使用新 SemVer 和 tag。它与 npm registry package 是两条独立发布路径，不能据此宣称 `@routeledger/mcp` 已发布。
- `better-sqlite3` 仍只在当前开发机做过本地安装 smoke，干净 macOS / Windows / Linux 验证仍待完成。
