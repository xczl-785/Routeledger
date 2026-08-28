# RouteLedger

RouteLedger 是给 AI agent 项目使用的本地状态真源。它不管理代码，也不替代文档仓；它只把“当前推进到哪里、接下来做什么、哪些事暂缓、哪些规则不能破坏”记录到项目根目录的 `.routeledger/` 中。

人通过 Mission Control 只读查看状态，agent 通过 MCP 工具读写状态。

[English README](README.en.md)

## 为什么需要它

agent-first 项目很容易出现一种问题：当前状态散落在 README、AGENTS、临时任务板和对话记录里。下一次 agent 接手时，需要重新翻找、猜测和确认，尤其是在多阶段工作、暂停项、约束和收尾审计变多之后。

RouteLedger 把这部分状态从长文档里拿出来，变成机器可读、可审计、可恢复的项目台账。文档继续解释背景、证据和设计；RouteLedger 只记录可执行状态。

## 适合谁

适合：

- 主要由 Codex 或其它 AI agent 推进的项目；
- 有明确阶段、当前工作、暂缓事项和约束的工程；
- 希望 agent 接手时先读取状态真源，而不是重新整理聊天记录的维护者；
- 需要本地、可审计、可版本化项目状态的团队或个人。

不适合：

- 普通待办清单；
- Jira、Linear 之类完整项目管理平台的替代品；
- LangGraph、AutoGen 之类 agent 编排或任务执行框架；
- 希望工具自动决定路线而不是显式维护路线的工作流。

## 快速开始

当前推荐通过 Codex 插件使用 RouteLedger：

```bash
codex plugin marketplace add xczl-785/Routeledger --ref main --json
codex plugin add routeledger@routeledger-team --json
```

安装后，新开一个 Codex 任务，在目标项目里对 agent 说：

```text
请检查当前项目是否已经绑定 RouteLedger。
如果还没有绑定，请绑定到当前项目根目录。
如果项目还没有初始化，请用 zh-CN 初始化，并创建一个描述当前工作目标的第一个 Version。
然后告诉我当前 Version、Todo、Deferred 和 Constraint 的状态。
```

如果你只想先建立空台账，可以把最后一句改成：

```text
如果项目还没有初始化，请用 zh-CN 初始化，但先不要创建 Version。
```

成功后，目标项目根目录会出现 `.routeledger/`。之后你可以让 agent：

- 查看当前状态和下一步；
- 创建或完成 Todo；
- 记录 Deferred，并指定未来复评的 Version；
- 记录不能违反的 Constraint；
- 在需要时打开 Mission Control 只读看板。

## 它如何工作

RouteLedger 的状态保存在项目本地的 `.routeledger/` 目录中。JSON 文件是持久真源；SQLite 只用于查询缓存，可以从 JSON 重建。

每个 MCP server entry 固定绑定一个项目根。写入前，RouteLedger 会核对请求目标是否仍是绑定的项目，避免 agent 误写到其它工程。

核心状态很少：Project 表示被治理的项目；Version 表示路线上的当前坐标；Todo 是当前要做的工作；Deferred 是暂缓但必须复评的事项；Constraint 是不能违反的规则。

## Mission Control

Mission Control 是本地只读 Web 看板，用来给人查看 RouteLedger 状态。通过 Codex 插件使用时，可以让 agent 打开 Mission Control；源码开发时也可以运行：

```bash
pnpm build:ui
pnpm open:ui -- --workspace-root /ABS/PATH/TO/CODEX_WORKSPACE_ROOT --routeledger-root /ABS/PATH/TO/ROUTELEDGER_ROOT
```

Mission Control 只读。切换看板中的项目不会改变 MCP 绑定，也不会写入 RouteLedger 数据。

## 开发

源码开发要求 Node.js >= 20.19 和 pnpm 11。安装依赖并运行基础检查：

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

贡献流程、验证要求和插件发布检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。

RouteLedger 管理的业务项目可以按自己的协作约定把 `.routeledger/` JSON 真源纳入版本控制；这是跨机器共享和合并项目状态的主要方式。

## 当前状态

当前稳定分发方式是 Codex Git marketplace 插件；已发布稳定版为 0.10.11。npm 包仍在准备中，暂不提供 `npm install @routeledger/...` 安装方式。

`main` 是发布干线；`codex-marketplace` 是历史锚点分支，不代表当前推荐安装路径。当前发布记录见 [0.10.11 release note](docs/release/release-notes/0.10.11.md)。

## 更多文档

- [Codex plugin installation](docs/guides/codex-plugin-installation.md)：插件安装和运行边界
- [Agent-host integration](docs/guides/agent-host-integration.md)：MCP 绑定、运行时和 host 集成契约
- [Capability index](docs/capabilities/capability-index.md)：已实现能力与源码、测试证据
- [Documentation index](docs/README.md)：长期文档入口
- [Release policy](docs/release/release-policy.md)：发布流程和版本规则

## License

[Apache-2.0](LICENSE)
