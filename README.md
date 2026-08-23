# RouteLedger

RouteLedger 是一个轻量的**项目状态台账**，专为以 AI agent（如 Codex）为主要开发者的项目设计。它不管理代码，只管理“项目现在推进到哪个版本、接下来该做什么、什么暂缓了、哪些约束不能违反”，把散落在文档和对话里的状态收拢到项目根目录 `.routeledger/` 下一份可读、可写、可审计的权威数据（single source of truth，下称“真源”）里：用户通过只读看板查看，agent 通过 MCP 读写。

## 它解决什么问题

agent-first 项目通常有一个文档仓，其中 `进行中 / 路线图 / 任务与进展 / 遗留问题 / 当前边界` 会快速膨胀：

- 当前状态散落在多份文档和对话记录里，agent 每次都要重新翻找；
- “当前版本 / 当前阶段”缺少一个机器可读、可校验的坐标；
- 暂停、否决、推迟的事项缺少生命周期和复评点；
- 状态变更缺少审计，收尾时无法确认是否真的收干净了。

它的目标是让“项目当前状态”像代码一样有版本、有坐标、可查询，而不是靠翻文档和猜。RouteLedger 不承载文档、证据和方法论，只负责状态本身：

> 工具负责：版本路线、当前位置、Todo / Deferred / Constraint、状态流转和审计
> 文档负责：长说明、证据、方法论、参考资料和历史材料

## 它不是什么

- 不是 Jira 之类的完整项目管理 / 问题追踪平台；
- 不是 LangGraph / AutoGen 之类的 agent 编排或任务执行框架——它只管理项目状态，不替你执行任务；
- 不会替项目自动推导路线——版本和路线由用户或 agent 显式维护；
- 不替代你的文档仓。

## 核心概念

| 概念 | 含义 |
| --- | --- |
| Project | 被 RouteLedger 治理的一个项目容器 |
| Version | 路线上的推进坐标，当前版本决定“现在该做什么” |
| Todo | 当前版本应做、但尚未完成的工作 |
| Deferred | 当前主动不做、已指定目标版本、届时必须复评的事项 |
| Constraint | 项目或版本范围内不得违反的规则 |
| TransitionEvent | 状态变化的审计记录 |

## 数据如何存放

每个被治理的项目根下有一个 `.routeledger/` 目录：

```text
your-project/
└── .routeledger/
    ├── config.json        # 工作区配置（声明数据目录）
    ├── project.json       # 项目聚合
    ├── refs/current.json  # 当前版本指针
    ├── versions/          # 版本对象
    ├── todos/             # 当前工作项
    ├── deferred_items/    # 暂缓项
    └── constraints/       # 约束
```

三点关键规则：

- canonical JSON 文档集是**真源**，MCP 每次写入先更新 JSON；
- SQLite（`.routeledger/db/routeledger.sqlite3`）只是查询缓存副本，删除或损坏都可以从 JSON 完整重建；
- 一条 MCP server entry 固定绑定一个项目根；写入前，服务会先核对请求指向的就是它绑定的那个根（root 断言），防止误改别的项目。

## 快速开始（安装 Codex 插件）

当前推荐通过 Codex 插件使用 RouteLedger。当前发布版为 0.10.6，由不可变标签 `routeledger-plugin-v0.10.6` 固定；它修复了真实 Agent 试用发现的错误输出、父子路线导航、残留承接、关闭审计和文档漂移结论问题。`main` 是唯一发布干线，`codex-marketplace` 只保留为 0.3.3 的历史锚点分支：

```bash
codex plugin marketplace add xczl-785/Routeledger --ref main --json
codex plugin add routeledger@routeledger-team --json
```

安装后新开一个 Codex 任务，然后：

1. 让 agent 先调用 `get_runtime_context` 确认当前绑定；
2. 若未绑定到目标项目，调用 `activate_routeledger_binding` 绑定到当前项目根；
3. `get_runtime_context` 会报告 `content_locale` 是否尚未确认；agent 必须让用户明确选择具体 BCP 47 locale（如 `zh-CN` 或 `en`）；
4. 用明确的 `contentLocale` 调用 `configure_project(operation="initialize")`。默认只建立 Project 逻辑根，不创建真实 Version；如用户已经确认首个交付节点，可同时传入 `firstVersion`（标题、描述、初始 Todo）。`auto` 不被接受。初始化结果还会只读检查 README、AGENTS、CONTRIBUTING 等人类入口是否指向 `.routeledger/project.json`；缺失时返回本地化建议，不会自动改写文档。

`content_locale` 控制 agent 后续生成并写入该项目内容时采用的语言，持久化在项目设置中，并供用户界面消费。旧项目缺少此字段时会读作 `null`：仍可检查，但写入前必须通过 `configure_project(operation="set_content_locale")` 补齐。面向 agent 的 MCP 工具名、字段名、枚举、错误码和系统说明统一使用英文。

插件内置 JSON-only runtime，不依赖 SQLite。新初始化的 JSON-only 项目默认把同一 operation 的 Event 与 ordinary-write receipt 写入带摘要的 operation envelope；已有 loose-audit 项目保持原布局，只有显式执行 `json compact-audit` 才迁移。更多安装与运行细节见 [Codex plugin installation](docs/guides/codex-plugin-installation.md)。

> npm 安装方式正在支持中（coming soon），目前不提供 `npm install @routeledger/...`。

## CLI

仓库还提供 CLI（`@routeledger/cli`，当前为源码形态），覆盖常用工作语义：

- Deferred：`deferred create`、`deferred from-todo`、`deferred activate`、`deferred defer-again`、`deferred resolve`
- Constraint：`constraint record`、`constraint retire`
- JSON：`json import`、`json export`、`json merge-check`、`json review-summary`、`json audit-summary`、`json compact-audit`
- 上下文：`context`
- 项目语言：初始化时使用 `init_project --content-locale <BCP47>`；旧项目使用 `set_project_content_locale --content-locale <BCP47>` 补齐
- 路线起点：`init_project` 默认建立空路线；可用 `--first-version <JSON>` 明确初始化首个节点
- 连续推进：`version advance` 将“切换到已准备好的直接后继 Version + 启动”合并为一次 L3 审批提交

## Mission Control（只读看板）

Mission Control 是仓库自带的本地只读 Web 看板。每台机器只运行一个 UI Hub；多个已明确登记的工程共享这个进程，但页面一次只展示一个工程。切换工程只改变看板读取目标，不会改变 MCP 绑定，也不会写入 RouteLedger 数据。

CI 用真实的无浏览器 UI 子进程测试认证、关闭和注册表清理，并以全局及 UI Hub 服务端覆盖率下限防止这些边界在重构中悄然失守。

```bash
pnpm build:ui
pnpm open:ui -- --workspace-root /ABS/PATH/TO/CODEX_WORKSPACE_ROOT --routeledger-root /ABS/PATH/TO/ROUTELEDGER_ROOT
```

重复执行 `open:ui` 会复用现有 Hub，并把新工程加入顶部工程切换器。Hub 只监听 `127.0.0.1`；页面关闭且连续 30 分钟没有活动时自动退出，也可以执行 `pnpm stop:ui` 主动关闭。`pnpm status:ui` 查看状态，`pnpm add:ui-project` 只登记工程、不打开新进程。Codex 插件内的 `open_mission_control` 提供同一套 Hub，无需本地克隆源码。

## 开发与验证

开发与构建本仓库要求 Node.js ≥ 20.19（建议 22 LTS）、pnpm 11（仓库锁定 `pnpm@11.7.0`，建议 `corepack enable` 后使用）。这不是已生成插件 runtime 的最低运行版本；runtime 的独立要求记录在其 `package.json` 与 README 中。

`packages/mcp` 与生成后的 runtime 使用 `0.0.0-package-prep` 作为尚未发布到 npm 的内部包身份；这不是 Codex 插件版本。插件版本与不可变发布标签分别以 `plugins/routeledger/.codex-plugin/plugin.json` 和 `plugins/routeledger/release.json` 为准。当前生成 runtime 的最低运行要求是 Node.js 18，而构建整个源码仓仍按上面的 Node.js 20.19 要求执行。

```bash
git clone https://github.com/xczl-785/Routeledger.git
cd Routeledger
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

插件构建与发布校验：

```bash
pnpm build:codex-plugin
pnpm smoke:codex-plugin
pnpm check:codex-plugin-release
pnpm smoke:codex-git-marketplace
```

源码方式接入 MCP 的配置示例见 `examples/config/`，运行时契约见 [Agent-host integration](docs/guides/agent-host-integration.md)。

## 仓库结构

| 目录 | 作用 |
| --- | --- |
| `packages/core` | 领域模型与状态机：Project / Version / Todo / Deferred / Constraint |
| `packages/json` | canonical JSON 编解码、校验、导入导出、merge-check |
| `packages/sqlite` | SQLite 查询缓存适配（非真源） |
| `packages/mcp` | MCP stdio server、binding、root 断言、Mission Control 工具 |
| `packages/codex` | Codex 项目级配置生成器 |
| `packages/cli` | 命令行入口 |
| `packages/ui` | Mission Control 只读看板 |
| `plugins/routeledger` | 已生成的 Codex 插件分发（JSON-only runtime） |
| `docs/` | 能力文档、接入指南、发布策略与发布记录 |
| `examples/` | Codex 配置示例 |

## 当前状态与边界

- 发布干线：`main` 是唯一发布干线，`codex-marketplace` 保留为 0.3.3 历史锚点；Codex 插件与未来的 MCP / npm 包各自使用独立版本号和标签；
- 安装：当前只通过 Codex 插件（Git marketplace）分发；已发布稳定版为 0.10.6；
- npm：`@routeledger/mcp` 等包正在支持中（coming soon），暂不提供 npm 安装；
- 数据：JSON-first，SQLite 仅为查询缓存；
- 并发：同一项目同一时刻只有一个 current version；当前是单写者模型，多读者可在无活跃写入时使用；
- UI：Mission Control 当前只读。

## 文档导航

- [docs/README.md](docs/README.md) — 文档仓入口与边界
- [Capability index](docs/capabilities/capability-index.md) — 已实现能力与源码 / 测试对应关系
- [Agent-host integration](docs/guides/agent-host-integration.md) — MCP 单绑定运行时契约
- [Codex plugin installation](docs/guides/codex-plugin-installation.md) — 插件安装与运行边界
- [Release policy](docs/release/release-policy.md) 与 [0.10.6 release note](docs/release/release-notes/0.10.6.md) — 当前候选基线与发布流程
- [Distribution and tag conventions](docs/release/distribution-and-tags.md) — 插件与 MCP / npm 的版本与标签约定

## License

[Apache-2.0](LICENSE)
