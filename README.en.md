# RouteLedger

RouteLedger is a local source of truth for project state in AI-agent-driven
software work. It does not manage code and does not replace your documentation.
It records where the project is, what should happen next, what has been
deferred, and what constraints must be preserved.

Humans inspect the state through the read-only Mission Control dashboard.
Agents read and write it through MCP tools.

[中文 README](README.md)

## Why It Exists

Agent-first projects tend to accumulate state across README files, AGENTS
instructions, temporary task boards, and chat history. When a new agent session
takes over, it has to rediscover what is current, what is postponed, what is
blocked, and what must not change.

RouteLedger moves that operational state out of long-form documents and into a
machine-readable, auditable, recoverable ledger. Documents still explain context,
evidence, and design. RouteLedger tracks executable state.

## Good Fit

Use RouteLedger when:

- Codex or another AI agent is a primary project operator;
- the project has explicit phases, current work, deferred work, and constraints;
- you want each agent handoff to start from a state source of truth, not chat archaeology;
- you need local, inspectable, versionable project-state records.

Do not use it as:

- a general todo list;
- a replacement for Jira, Linear, or a full project management system;
- an agent orchestration framework like LangGraph or AutoGen;
- a tool that decides the route for you. Routes are maintained explicitly.

## Quick Start

The recommended distribution today is the Codex plugin:

```bash
codex plugin marketplace add xczl-785/Routeledger --ref main --json
codex plugin add routeledger@routeledger-team --json
```

After installation, start a new Codex task in your target project and tell the
agent:

```text
Check whether this project is already bound to RouteLedger.
If it is not bound, bind RouteLedger to the current project root.
If it is not initialized, initialize it with content locale en and create a first Version that describes the current delivery goal.
Then tell me the current Version, Todo, Deferred, and Constraint state.
```

If you only want an empty ledger first, replace the initialization sentence with:

```text
If it is not initialized, initialize it with content locale en, but do not create a Version yet.
```

When initialization succeeds, the project root will contain `.routeledger/`.
From then on, you can ask the agent to:

- inspect the current state and next action;
- create or complete Todo items;
- record Deferred items and the Version where they must be revisited;
- record Constraints that must not be violated;
- open the read-only Mission Control dashboard when useful.

## How It Works

RouteLedger stores state locally under `.routeledger/`. JSON files are the
durable source of truth. SQLite is only a rebuildable query cache.

Each MCP server entry is bound to one project root. Before writing, RouteLedger
checks that the request still targets that bound root, which helps prevent an
agent from mutating the wrong project.

The state model is small: a Project is the governed workspace; a Version is the
current point on the route; Todo is active work; Deferred is postponed work that
must be revisited; Constraint is a rule that must remain true.

## Mission Control

Mission Control is a local read-only web dashboard for human inspection. When
using the Codex plugin, ask the agent to open Mission Control. For source
development, run:

```bash
pnpm build:ui
pnpm open:ui -- --workspace-root /ABS/PATH/TO/CODEX_WORKSPACE_ROOT --routeledger-root /ABS/PATH/TO/ROUTELEDGER_ROOT
```

Mission Control is read-only. Switching projects in the dashboard does not
change the MCP binding and does not write RouteLedger data.

## Development

Source development requires Node.js >= 20.19 and pnpm 11. Install dependencies
and run the standard checks:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

Contribution flow, validation expectations, and plugin release checks are in
[CONTRIBUTING.md](CONTRIBUTING.md).

Projects managed by RouteLedger can choose to version their `.routeledger/` JSON
source of truth according to their own collaboration rules; that is the main way
to share and merge project state across machines.

## Current Status

The current stable distribution is the Codex Git marketplace plugin. npm
packages are still being prepared; `npm install @routeledger/...` is not
available yet.

`main` is the release trunk. `codex-marketplace` is a historical anchor branch,
not the recommended installation path. Current release history starts at the
[0.10.10 release note](docs/release/release-notes/0.10.10.md).

## Documentation

- [Codex plugin installation](docs/guides/codex-plugin-installation.md): plugin installation and runtime boundaries
- [Agent-host integration](docs/guides/agent-host-integration.md): MCP binding, runtime, and host integration contracts
- [Capability index](docs/capabilities/capability-index.md): implemented capabilities with source and test evidence
- [Documentation index](docs/README.md): durable documentation entry point
- [Release policy](docs/release/release-policy.md): release flow and version rules

## License

[Apache-2.0](LICENSE)
