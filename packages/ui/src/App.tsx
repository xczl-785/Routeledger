import { startTransition, useEffect, useState, type MouseEvent, type ReactNode } from "react";

import { fetchMissionControlState } from "./api.js";
import type {
  MissionControlApprovalArtifact,
  MissionControlAuditEvent,
  MissionControlCurrentVersion,
  MissionControlLegacyAudit,
  MissionControlOverview,
  MissionControlProposal,
  MissionControlResponse,
  MissionControlTreeNode
} from "./shared/mission-control.js";

type ViewId = "overview" | "roadmap" | "current" | "tree";
type ThemeName = "dark" | "light";
type DrawerKind = "proposal" | "audit" | null;

type AppLoadState =
  | {
      status: "loading";
      data: null;
      error: null;
      refreshing: boolean;
    }
  | {
      status: "ready";
      data: MissionControlResponse;
      error: null;
      refreshing: boolean;
    }
  | {
      status: "failed";
      data: MissionControlResponse | null;
      error: string;
      refreshing: boolean;
    };

const navItems: Array<{ id: ViewId; icon: string; label: string }> = [
  { id: "overview", icon: "◱", label: "总览" },
  { id: "roadmap", icon: "⚲", label: "宏观路线图" },
  { id: "current", icon: "◎", label: "当前 Version" },
  { id: "tree", icon: "⎇", label: "Version 树" }
];

const themeStorageKey = "routeledger-mission-control-theme";

const classNames = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(" ");

const readInitialTheme = (): ThemeName => {
  if (typeof window === "undefined") {
    return "dark";
  }

  const savedTheme = window.localStorage.getItem(themeStorageKey);
  return savedTheme === "light" ? "light" : "dark";
};

const formatDateTime = (value: string | null): string => {
  if (value === null || value.length === 0) {
    return "N/A";
  }

  return new Date(value).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
};

const toneClassByVersionState = (state: string | null): string => {
  switch (state) {
    case "running":
      return "is-running";
    case "ready":
      return "is-ready";
    case "complete":
    case "close":
      return "is-complete";
    case "suspend":
      return "is-suspend";
    case "wait":
      return "is-wait";
    default:
      return "is-neutral";
  }
};

const toneLabel = (state: string | null): string => {
  if (state === null) {
    return "Unavailable";
  }

  return state.toUpperCase();
};

const currentStatusLabel = (response: MissionControlResponse | null): string => {
  if (response === null) {
    return "Unavailable";
  }

  return response.identity?.currentVersionDisplayLabel ?? toneLabel(response.identity?.currentVersionState ?? null);
};

const itemStatusClass = (status: string): string => {
  switch (status) {
    case "running":
      return "active";
    case "closed":
    case "complete":
      return "done";
    default:
      return status;
  }
};

const screenTitle = (response: MissionControlResponse | null): string => {
  if (response === null) {
    return "RouteLedger";
  }

  return response.identity?.projectName ?? "RouteLedger";
};

const screenVersionTitle = (response: MissionControlResponse | null): string => {
  if (response === null) {
    return "Waiting for canonical JSON";
  }

  return response.identity?.currentVersionTitle ?? "No current version";
};

const screenMessageTone = (screen: MissionControlResponse["screen"]): "warning" | "error" | "info" => {
  switch (screen) {
    case "binding_error":
    case "json_error":
      return "error";
    case "current_closed":
      return "warning";
    default:
      return "info";
  }
};

const SpotlightCard = (props: {
  className?: string;
  children: ReactNode;
}): ReactNode => {
  const handleMouseMove = (event: MouseEvent<HTMLDivElement>): void => {
    const currentTarget = event.currentTarget;
    const rect = currentTarget.getBoundingClientRect();
    currentTarget.style.setProperty("--mouse-x", `${event.clientX - rect.left}px`);
    currentTarget.style.setProperty("--mouse-y", `${event.clientY - rect.top}px`);
  };

  return (
    <div className={classNames("spotlight-card", props.className)} onMouseMove={handleMouseMove}>
      {props.children}
    </div>
  );
};

const EmptyState = (props: {
  title: string;
  description: string;
}): ReactNode => (
  <div className="empty-card">
    <div className="empty-title">{props.title}</div>
    <div className="empty-description">{props.description}</div>
  </div>
);

const TreeCard = (props: {
  node: MissionControlTreeNode | null;
}): ReactNode => {
  if (props.node === null) {
    return (
      <div className="tree-card tree-card-empty">
        <div className="tree-card-title">无节点</div>
        <div className="tree-card-desc">当前列没有可展示的 Version。</div>
      </div>
    );
  }

  return (
    <div className={classNames("tree-card", props.node.isCurrent && "is-current")}>
      <div className="tree-card-title">{props.node.title}</div>
      <div className="tree-card-desc">{props.node.description || "当前 Version 暂无补充描述。"}</div>
      <div className="tree-badges">
        <span className="tree-badge">Order {props.node.order}</span>
        <span className="tree-badge">{props.node.displayLabel}</span>
      </div>
    </div>
  );
};

const ProposalDrawer = (props: {
  proposals: MissionControlProposal[];
}): ReactNode => {
  if (props.proposals.length === 0) {
    return (
      <EmptyState
        title="暂无 Pending Proposal"
        description="当前 canonical JSON 中没有待审批的 L3 proposal。Mission Control 保持只读，不会替你创建任何 proposal。"
      />
    );
  }

  return (
    <>
      {props.proposals.map((proposal, index) => (
        <div
          key={proposal.id}
          className="prop-card animated-list-item"
          style={{ animationDelay: `${index * 0.06}s` }}
        >
          <div className="prop-row">
            <div className="prop-label">Action</div>
            <div className="prop-val font-mono">{proposal.actionType}</div>
          </div>
          <div className="prop-row">
            <div className="prop-label">Target</div>
            <div className="prop-val font-mono">{proposal.targetId}</div>
          </div>
          <div className="prop-row">
            <div className="prop-label">Reason</div>
            <div className="prop-val">{proposal.reason}</div>
          </div>
          <div className="prop-row">
            <div className="prop-label">Gate</div>
            <div className="prop-val">
              {proposal.gateKind} / {proposal.gateAllowed ? "allowed" : "blocked"} / blockers {proposal.blockerCount}
            </div>
          </div>
          <div className="prop-row">
            <div className="prop-label">Created</div>
            <div className="prop-val">{formatDateTime(proposal.createdAt)}</div>
          </div>
        </div>
      ))}
    </>
  );
};

export const AuditDrawer = (props: {
  approvals: MissionControlApprovalArtifact[];
  events: MissionControlAuditEvent[];
  legacyAudit: MissionControlLegacyAudit;
}): ReactNode => (
  <div className="drawer-stack">
    <section className="drawer-section legacy-audit-section">
      <div className="drawer-section-title">Legacy Undo Audit（历史兼容审计）</div>
      <div className="legacy-audit-summary">
        当前 Version 审计阻塞 {props.legacyAudit.currentVersionBlockerCount} · 项目 open 记录{" "}
        {props.legacyAudit.openRecordCount}
      </div>
      {props.legacyAudit.records.length === 0 ? (
        <EmptyState
          title="无 Legacy Undo 记录"
          description="默认产品语义仅使用 Todo、Deferred 与 Constraint。"
        />
      ) : (
        props.legacyAudit.records.map((record, index) => (
          <div
            key={record.id}
            className="prop-card legacy-audit-card animated-list-item"
            style={{ animationDelay: `${index * 0.04}s` }}
          >
            <div className="prop-row">
              <div className="prop-label">Legacy record</div>
              <div className="prop-val">{record.title}</div>
            </div>
            <div className="prop-row">
              <div className="prop-label">Reason</div>
              <div className="prop-val">{record.reason}</div>
            </div>
            <div className="prop-row">
              <div className="prop-label">Status</div>
              <div className="prop-val">{record.status}</div>
            </div>
            <div className="prop-row">
              <div className="prop-label">Updated</div>
              <div className="prop-val">{formatDateTime(record.updatedAt)}</div>
            </div>
          </div>
        ))
      )}
    </section>

    <section className="drawer-section">
      <div className="drawer-section-title">审批记录</div>
      {props.approvals.length === 0 ? (
        <EmptyState
          title="暂无审批记录"
          description="当前项目没有可展示的 approval artifact；这不影响只读看板浏览。"
        />
      ) : (
        props.approvals.map((approval, index) => (
          <div
            key={approval.id}
            className="prop-card animated-list-item"
            style={{ animationDelay: `${index * 0.04}s` }}
          >
            <div className="prop-row">
              <div className="prop-label">Action</div>
              <div className="prop-val font-mono">{approval.actionType}</div>
            </div>
            <div className="prop-row">
              <div className="prop-label">Approver</div>
              <div className="prop-val">{approval.approverName}</div>
            </div>
            <div className="prop-row">
              <div className="prop-label">Decision Ref</div>
              <div className="prop-val font-mono">{approval.decisionRef}</div>
            </div>
            <div className="prop-row">
              <div className="prop-label">Created</div>
              <div className="prop-val">{formatDateTime(approval.createdAt)}</div>
            </div>
          </div>
        ))
      )}
    </section>

    <section className="drawer-section">
      <div className="drawer-section-title">事件时间线</div>
      {props.events.length === 0 ? (
        <EmptyState
          title="暂无事件"
          description="当前项目没有最近事件可展示。"
        />
      ) : (
        props.events.map((event, index) => (
          <div
            key={event.id}
            className="record-item animated-list-item"
            style={{ animationDelay: `${index * 0.04}s` }}
          >
            <div className="record-time">{formatDateTime(event.createdAt)}</div>
            <div className="record-event">
              {event.eventType} · {event.targetType}
            </div>
            <div className="record-detail">
              {event.actorName} · {event.targetId}
              {event.fromState !== null || event.toState !== null
                ? ` · ${event.fromState ?? "null"} → ${event.toState ?? "null"}`
                : ""}
            </div>
          </div>
        ))
      )}
    </section>
  </div>
);

export const renderCurrentVersionPanel = (
  currentVersion: MissionControlCurrentVersion | null
): ReactNode => {
  if (currentVersion === null) {
    return (
      <EmptyState
        title="路线尚未定义"
        description="Project 逻辑根已经建立；创建首个真实 Version 后即可开始推进。"
      />
    );
  }

  return (
    <div className="current-grid blur-text-delayed">
      <div className="right-col">
        <SpotlightCard>
          <div className="panel-title">
            <span>Todo 列表</span>
            <span className="panel-count">{currentVersion.todos.length}</span>
          </div>
          <div className="panel-list">
            {currentVersion.todos.length === 0 ? (
              <EmptyState title="暂无 Todo" description="当前 Version 没有 open todo。" />
            ) : (
              currentVersion.todos.map((todo) => (
                <div key={todo.id} className="list-item">
                  <div className={classNames("item-status", itemStatusClass(todo.status))}></div>
                  <div className="item-content">
                    <div className={classNames("item-text", itemStatusClass(todo.status))}>{todo.title}</div>
                    <div className="item-meta">{todo.description || "无补充描述"}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </SpotlightCard>

        <SpotlightCard>
          <div className="panel-title">
            <span>Deferred · 待评审</span>
            <span className="panel-count">{currentVersion.deferred.length}</span>
          </div>
          <div className="panel-list">
            {currentVersion.deferred.length === 0 ? (
              <EmptyState
                title="暂无相关 Deferred"
                description="当前 Version 没有发起或需要评审的 Deferred。"
              />
            ) : (
              currentVersion.deferred.map((deferred) => (
                <div key={deferred.id} className={classNames("list-item", deferred.isDue && "is-due")}>
                  <div className={classNames("item-status", deferred.isDue ? "due" : "wait")}></div>
                  <div className="item-content">
                    <div className="item-text">
                      {deferred.title}
                      {deferred.isDue ? <span className="item-badge">DUE</span> : null}
                    </div>
                    <div className="item-meta">
                      评审 Version：{deferred.targetReviewVersionTitle}
                      {deferred.reviewTrigger ? ` · ${deferred.reviewTrigger}` : ""}
                    </div>
                    <div className="item-meta">{deferred.reason}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </SpotlightCard>
      </div>

      <div className="right-col">
        <SpotlightCard>
          <div className="panel-title">
            <span>Active Constraints</span>
            <span className="panel-count">{currentVersion.constraints.length}</span>
          </div>
          <div className="panel-list">
            {currentVersion.constraints.length === 0 ? (
              <EmptyState
                title="暂无 Active Constraint"
                description="当前项目与 Version 没有生效中的约束。"
              />
            ) : (
              currentVersion.constraints.map((constraint) => (
                <div key={constraint.id} className="list-item constraint-item">
                  <div className="item-status active"></div>
                  <div className="item-content">
                    <div className="item-text">{constraint.rule}</div>
                    <div className="item-meta">
                      {constraint.scope === "project" ? "项目范围" : "当前 Version"}
                      {constraint.rationale ? ` · ${constraint.rationale}` : ""}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </SpotlightCard>

        <SpotlightCard>
          <div className="panel-title">
            <span>版本元数据</span>
            <span className="panel-count">live</span>
          </div>
          <div className="meta-grid">
            <div className="meta-row">
              <div className="meta-label">State</div>
              <div className="meta-value">
                {currentVersion.displayLabel}
                {currentVersion.stateReason !== null ? ` · ${currentVersion.stateReason}` : ""}
              </div>
            </div>
            <div className="meta-row">
              <div className="meta-label">Order</div>
              <div className="meta-value">{currentVersion.order}</div>
            </div>
            <div className="meta-row">
              <div className="meta-label">Parent</div>
              <div className="meta-value">{currentVersion.parentVersionTitle ?? "None"}</div>
            </div>
            <div className="meta-row">
              <div className="meta-label">Previous</div>
              <div className="meta-value">{currentVersion.previousVersionTitle ?? "None"}</div>
            </div>
            <div className="meta-row">
              <div className="meta-label">Next</div>
              <div className="meta-value">{currentVersion.nextVersionTitle ?? "None"}</div>
            </div>
            <div className="meta-row">
              <div className="meta-label">Updated</div>
              <div className="meta-value">{formatDateTime(currentVersion.updatedAt)}</div>
            </div>
          </div>
        </SpotlightCard>
      </div>
    </div>
  );
};

export const OverviewStats = (props: {
  overview: MissionControlOverview;
}): ReactNode => (
  <div className="overview-grid blur-text-delayed">
    <SpotlightCard className="stat-card">
      <h3>Open Todo</h3>
      <div className="stat-value">{props.overview.openTodoCount}</div>
      <div className="stat-desc">项目范围内 wait/running todo 数量</div>
    </SpotlightCard>
    <SpotlightCard className="stat-card">
      <h3>Pending Deferred</h3>
      <div className="stat-value">{props.overview.pendingDeferredCount}</div>
      <div className="stat-desc">待后续 Version 评审的 Deferred 数量</div>
    </SpotlightCard>
    <SpotlightCard className="stat-card">
      <h3>Due for Review</h3>
      <div className="stat-value is-warn">{props.overview.dueDeferredCount}</div>
      <div className="stat-desc">当前 Gate 已到期、需要评审的 Deferred 数量</div>
    </SpotlightCard>
    <SpotlightCard className="stat-card">
      <h3>Active Constraints</h3>
      <div className="stat-value">{props.overview.activeConstraintCount}</div>
      <div className="stat-desc">项目与 Version 范围内生效约束数量</div>
    </SpotlightCard>
  </div>
);

export const App = (): ReactNode => {
  const [view, setView] = useState<ViewId>("overview");
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [theme, setTheme] = useState<ThemeName>(readInitialTheme);
  const [loadState, setLoadState] = useState<AppLoadState>({
    status: "loading",
    data: null,
    error: null,
    refreshing: false
  });

  const refresh = async (): Promise<void> => {
    startTransition(() => {
      setLoadState((previous) => ({
        ...previous,
        refreshing: true
      }));
    });

    try {
      const nextState = await fetchMissionControlState();
      startTransition(() => {
        setLoadState({
          status: "ready",
          data: nextState,
          error: null,
          refreshing: false
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取 Mission Control 状态失败。";
      startTransition(() => {
        setLoadState((previous) => ({
          status: "failed",
          data: previous.data,
          error: message,
          refreshing: false
        }));
      });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  const response = loadState.data;
  const alertTone = response === null ? "info" : screenMessageTone(response.screen);

  const renderView = (): ReactNode => {
    if (loadState.status === "loading") {
      return (
        <div className="view-state">
          <div className="loading-copy">正在读取 canonical JSON…</div>
        </div>
      );
    }

    if (response === null) {
      return (
        <div className="view-state">
          <EmptyState
            title="状态不可用"
            description={loadState.status === "failed" ? loadState.error : "尚未获取到 Mission Control 数据。"}
          />
        </div>
      );
    }

    switch (view) {
      case "overview":
        return (
          <>
            <div className="view-header blur-text">
              <h1 className="view-title">总览 (Overview)</h1>
              <p className="view-subtitle">用 canonical JSON 直接理解当前项目身份、路线压力和诊断信息。</p>
            </div>

            {response.overview === null ? (
              <EmptyState title="暂无总览" description={response.message} />
            ) : (
              <>
                <OverviewStats overview={response.overview} />

                <div className="summary-grid">
                  <SpotlightCard className="summary-card blur-text-delayed">
                    <h3>项目身份</h3>
                    <div className="summary-item">
                      <span className="summary-label">Project</span>
                      <span className="summary-val">{response.identity?.projectName ?? "Unavailable"}</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-label">Project ID</span>
                      <span className="summary-val path-text">{response.identity?.projectId ?? "N/A"}</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-label">workspaceRoot</span>
                      <span className="summary-val path-text">{response.binding.workspaceRoot}</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-label">routeledgerRoot</span>
                      <span className="summary-val path-text">{response.binding.routeledgerRoot}</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-label">Source Mode</span>
                      <span className="summary-val">{response.storage.mode}</span>
                    </div>
                  </SpotlightCard>

                  <SpotlightCard className="summary-card blur-text-delayed">
                    <h3>诊断与下一步</h3>
                    <div className="summary-item">
                      <span className="summary-label">Binding</span>
                      <span className="summary-val">{response.binding.status}</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-label">SQLite</span>
                      <span className="summary-val">{response.storage.sqlite.status}</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-label">Canonical JSON</span>
                      <span className="summary-val">{response.storage.canonicalJson.status}</span>
                    </div>
                    <div className="summary-item summary-block">
                      <span className="summary-label">Next Action</span>
                      <span className="summary-val multiline">
                        {response.nextAction?.summary ?? "当前没有系统建议动作"}
                      </span>
                    </div>
                    <div className="summary-item summary-block">
                      <span className="summary-label">Status Risks</span>
                      <span className="summary-val multiline">
                        {response.statusRisks.length === 0
                          ? "暂无显式风险"
                          : response.statusRisks.map((risk) => `${risk.severity}: ${risk.summary}`).join("\n")}
                      </span>
                    </div>
                  </SpotlightCard>
                </div>
              </>
            )}
          </>
        );
      case "roadmap":
        return (
          <>
            <div className="view-header blur-text">
              <h1 className="view-title">宏观路线图 (Roadmap)</h1>
              <p className="view-subtitle">按真实 Version 顺序展示主推进链，不引入 mock branch/type 字段。</p>
            </div>
            <div className="roadmap-rail blur-text-delayed">
              {response.roadmap.length === 0 ? (
                <EmptyState title="暂无路线图" description={response.message} />
              ) : (
                response.roadmap.map((item, index) => (
                  <div
                    key={item.id}
                    className={classNames("roadmap-node", toneClassByVersionState(item.state))}
                    style={{ animationDelay: `${index * 0.06}s` }}
                  >
                    <div className="node-header">
                      <span className="node-title">{item.title}</span>
                      <span className="node-tag">{item.displayLabel}</span>
                      {item.isCurrent ? <span className="node-tag node-tag-current">CURRENT</span> : null}
                      {item.isDiagnostic ? <span className="node-tag">DIAGNOSTIC</span> : null}
                    </div>
                    <div className="node-summary">
                      order {item.order} · child {item.childCount} · todo {item.openTodoCount} · deferred{" "}
                      {item.pendingDeferredCount} · constraints {item.activeConstraintCount}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        );
      case "current":
        return (
          <>
            <div className="view-header blur-text">
              <h1 className="view-title">当前 Version</h1>
              <p className="view-subtitle">{response.currentVersion?.description ?? response.message}</p>
            </div>
            {renderCurrentVersionPanel(response.currentVersion)}
          </>
        );
      case "tree":
        return (
          <>
            <div className="view-header blur-text">
              <h1 className="view-title">Version 树 (Tree)</h1>
              <p className="view-subtitle">展示父级、同级与子级 Version 关系，并保持真实 RouteLedger 语义。</p>
            </div>
            {response.tree === null ? (
              <EmptyState title="暂无 Version 树" description={response.message} />
            ) : (
              <div className="tree-container blur-text-delayed">
                <div className="tree-col">
                  <div className="tree-col-title">父节点</div>
                  <TreeCard node={response.tree.parent} />
                </div>
                <div className="tree-col">
                  <div className="tree-col-title current-title">当前焦点</div>
                  <TreeCard node={response.tree.focus} />
                </div>
                <div className="tree-col">
                  <div className="tree-col-title">同级 Version</div>
                  {response.tree.siblings.length === 0 ? (
                    <TreeCard node={null} />
                  ) : (
                    response.tree.siblings.map((node) => <TreeCard key={node.id} node={node} />)
                  )}
                </div>
                <div className="tree-col">
                  <div className="tree-col-title">子分支</div>
                  {response.tree.children.length === 0 ? (
                    <TreeCard node={null} />
                  ) : (
                    response.tree.children.map((node) => <TreeCard key={node.id} node={node} />)
                  )}
                </div>
              </div>
            )}
          </>
        );
    }
  };

  return (
    <>
      <div className="dot-grid-bg"></div>

      <main className="app-shell">
        <aside className="sidebar">
          <div className="brand-area">
            <div className="brand-logo">RL</div>
            <div className="brand-text">
              <div className="brand-name">RouteLedger</div>
              <div className="brand-subtitle">Mission Control</div>
            </div>
          </div>

          <nav className="nav-menu">
            {navItems.map((item) => (
              <button
                key={item.id}
                className={classNames("nav-item", view === item.id && "active")}
                onClick={() => setView(item.id)}
                type="button"
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>

          <div className="sidebar-footer">
            <button
              className="theme-toggle"
              onClick={() => setTheme((previous) => (previous === "dark" ? "light" : "dark"))}
              title="切换主题"
              type="button"
            >
              <span className="icon-dark">🌙</span>
              <span className="icon-light">☀️</span>
            </button>
          </div>
        </aside>

        <section className="workspace">
          <header className="context-bar">
            <div className="context-info">
              <span className="project-name">Project: {screenTitle(response)}</span>
              <span className="divider">/</span>
              <span className="current-version-label">{screenVersionTitle(response)}</span>
              <span className={classNames("status-indicator", toneClassByVersionState(response?.identity?.currentVersionState ?? null))}>
                {currentStatusLabel(response)}
              </span>
            </div>

            <div className="context-actions">
              <span className="data-source">Source: {response?.storage.mode ?? "loading"}</span>
              <button className="action-pill" onClick={() => void refresh()} type="button">
                刷新 {loadState.refreshing ? "…" : ""}
              </button>
              <button className="action-pill" onClick={() => setDrawer("proposal")} type="button">
                <span className={classNames("pill-dot", response?.proposals.length ? "is-warning" : "is-idle")}></span>
                提案
                <span className="pill-count">{response?.proposals.length ?? 0}</span>
              </button>
              <button className="action-pill" onClick={() => setDrawer("audit")} type="button">
                审计记录
              </button>
            </div>
          </header>

          <div className="view-container">
            <div className={classNames("banner-card", `tone-${alertTone}`)}>
              <div className="banner-title">
                {response?.screen === "ready" ? "Read-only Canonical View" : "Attention"}
              </div>
              <div className="banner-copy">
                {response?.message ??
                  (loadState.status === "failed"
                    ? loadState.error
                    : "Mission Control 正在读取 routeledgerRoot 下的 canonical JSON。")}
              </div>
            </div>

            {loadState.status === "failed" && loadState.error !== null ? (
              <div className="error-inline">{loadState.error}</div>
            ) : null}

            {renderView()}
          </div>
        </section>
      </main>

      <div className={classNames("drawer-overlay", drawer !== null && "is-active")} onClick={() => setDrawer(null)}></div>
      <aside className={classNames("drawer", drawer !== null && "is-open")}>
        <div className="drawer-header">
          <div className="drawer-title">
            <span className="drawer-kicker">{drawer === "proposal" ? "L3 Proposal" : "History & Audit"}</span>
            <h2>{drawer === "proposal" ? "只读 Proposal 视图" : "审计与审批轨迹"}</h2>
          </div>
          <button className="drawer-close" onClick={() => setDrawer(null)} type="button">
            ✕
          </button>
        </div>
        <div className="drawer-content">
          {drawer === "proposal" ? (
            <ProposalDrawer proposals={response?.proposals ?? []} />
          ) : drawer === "audit" ? (
            <AuditDrawer
              approvals={response?.approvals ?? []}
              events={response?.auditTrail ?? []}
              legacyAudit={
                response?.legacyAudit ?? {
                  openRecordCount: 0,
                  currentVersionBlockerCount: 0,
                  records: []
                }
              }
            />
          ) : null}
        </div>
      </aside>
    </>
  );
};
