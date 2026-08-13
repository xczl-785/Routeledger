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

当前推荐通过 Codex 插件使用 RouteLedger。已发布稳定版为 0.8.0，由不可变标签 `routeledger-plugin-v0.8.0` 固定；它把 L3 授权收敛为与单个 proposal 精确绑定、一次消费的授权，并将旧的宽范围授权记录隔离为只读审计历史。`main` 是唯一发布干线，`codex-marketplace` 只保留为 0.3.3 的历史锚点分支：

```bash
codex plugin marketplace add xczl-785/Routeledger --ref main --json
codex plugin add routeledger@routeledger-team --json
```

安装后新开一个 Codex 任务，然后：

1. 让 agent 先调用 `get_runtime_context` 确认当前绑定；
2. 若未绑定到目标项目，调用 `activate_routeledger_binding` 绑定到当前项目根；
3. `get_runtime_context` 会根据当前交流语言提议 `content_locale`；agent 必须先让用户确认具体 BCP 47 locale（如 `zh-CN` 或 `en`）；
4. 用明确的 `contentLocale` 调用 `init_project`。默认只建立 Project 逻辑根，不创建真实 Version；如用户已经确认首个交付节点，可同时传入 `firstVersion`（标题、描述、初始 Todo）。`auto` 不被接受。

`content_locale` 控制 agent 后续生成并写入该项目内容时采用的语言，持久化在项目设置中。旧项目缺少此字段时会读作 `null`：仍可检查，但写入前必须通过 `set_project_content_locale` 补齐。`responseLocale` 只控制单次 MCP 返回中的人类可读说明，不会改变稳定的英文工具名、字段名、枚举或错误码。

插件内置 JSON-only runtime，不依赖 SQLite。更多安装与运行细节见 [Codex plugin installation](docs/guides/codex-plugin-installation.md)。

> npm 安装方式正在支持中（coming soon），目前不提供 `npm install @routeledger/...`。

## CLI

仓库还提供 CLI（`@routeledger/cli`，当前为源码形态），覆盖常用工作语义：

- Deferred：`deferred create`、`deferred from-todo`、`deferred activate`、`deferred defer-again`、`deferred resolve`
- Constraint：`constraint record`、`constraint retire`
- JSON：`json import`、`json export`、`json merge-check`、`json review-summary`
- 上下文：`context`
- 项目语言：初始化时使用 `init_project --content-locale <BCP47>`；旧项目使用 `set_project_content_locale --content-locale <BCP47>` 补齐
- 路线起点：`init_project` 默认建立空路线；可用 `--first-version <JSON>` 明确初始化首个节点
- 连续推进：`version advance` 将“切换到已准备好的直接后继 Version + 启动”合并为一次 L3 审批提交

## Mission Control（只读看板）

Mission Control 是仓库自带的本地 Web 看板，展示总览、路线树和当前版本面板。当前为只读，写操作请走 Codex 插件 / MCP / CLI。

```bash
pnpm build:ui
pnpm launch:ui -- --workspace-root /ABS/PATH/TO/CODEX_WORKSPACE_ROOT --routeledger-root /ABS/PATH/TO/ROUTELEDGER_ROOT
```

启动后终端会打印访问地址（`http://127.0.0.1:<动态端口>`），用浏览器打开即可。该方式需要本地克隆仓库，适合开发者预览。

## 开发与验证

环境要求：Node.js ≥ 20.19（建议 22 LTS）、pnpm 11（仓库锁定 `pnpm@11.7.0`，建议 `corepack enable` 后使用）。

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
- 安装：当前只通过 Codex 插件（Git marketplace）分发；已发布稳定版为 0.8.0；
- npm：`@routeledger/mcp` 等包正在支持中（coming soon），暂不提供 npm 安装；
- 数据：JSON-first，SQLite 仅为查询缓存；
- 并发：同一项目同一时刻只有一个 current version；当前是单写者模型，多读者可在无活跃写入时使用；
- UI：Mission Control 当前只读。

## 文档导航

- [docs/README.md](docs/README.md) — 文档仓入口与边界
- [Capability index](docs/capabilities/capability-index.md) — 已实现能力与源码 / 测试对应关系
- [Agent-host integration](docs/guides/agent-host-integration.md) — MCP 单绑定运行时契约
- [Codex plugin installation](docs/guides/codex-plugin-installation.md) — 插件安装与运行边界
- [Release policy](docs/release/release-policy.md) 与 [0.8.0 release note](docs/release/release-notes/0.8.0.md) — 当前已发布基线与发布流程
- [Distribution and tag conventions](docs/release/distribution-and-tags.md) — 插件与 MCP / npm 的版本与标签约定

## License

[Apache-2.0](LICENSE)
