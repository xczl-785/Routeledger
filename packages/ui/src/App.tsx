import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type ReactNode
} from "react";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { ClockCounterClockwise } from "@phosphor-icons/react/ClockCounterClockwise";
import { Crosshair } from "@phosphor-icons/react/Crosshair";
import { GitBranch } from "@phosphor-icons/react/GitBranch";
import { LockSimple } from "@phosphor-icons/react/LockSimple";
import { X } from "@phosphor-icons/react/X";

import {
  fetchMissionControlProjects,
  fetchMissionControlState,
  heartbeatMissionControl,
  registerMissionControlProject,
  stopMissionControl
} from "./api.js";
import type {
  MissionControlApprovalArtifact,
  MissionControlAuditEvent,
  MissionControlConstraintItem,
  MissionControlDeferredItem,
  MissionControlLegacyAudit,
  MissionControlProposal,
  MissionControlProjectSummary,
  MissionControlResponse,
  MissionControlRoadmapItem,
  MissionControlTodoItem,
  MissionControlVersionState
} from "./shared/mission-control.js";

type AppLoadState =
  | { status: "loading"; data: null; error: null; refreshing: boolean }
  | { status: "ready"; data: MissionControlResponse; error: null; refreshing: boolean }
  | { status: "failed"; data: MissionControlResponse | null; error: string; refreshing: boolean }
  | { status: "stopped"; data: null; error: null; refreshing: false };

const classNames = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(" ");

const stateLabel = (state: MissionControlVersionState | null, displayLabel?: string | null): string => {
  if (displayLabel === "SHUTDOWN") return "已终止";
  switch (state) {
    case "wait": return "等待";
    case "ready": return "准备就绪";
    case "running": return "进行中";
    case "suspend": return "已暂停";
    case "complete": return "已完成";
    case "close": return "已关闭";
    default: return "未设置";
  }
};

const stateTone = (state: MissionControlVersionState | null, displayLabel?: string | null): string =>
  displayLabel === "SHUTDOWN" ? "shutdown" : state === null ? "neutral" : state;

const formatDateTime = (value: string | null): string => {
  if (value === null || value.length === 0) return "—";
  return new Date(value).toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
};

const versionsById = (roadmap: MissionControlRoadmapItem[]): Map<string, MissionControlRoadmapItem> =>
  new Map(roadmap.map((version) => [version.id, version]));

const routeDepths = (roadmap: MissionControlRoadmapItem[]): Map<string, number> => {
  const byId = versionsById(roadmap);
  const depths = new Map<string, number>();
  const resolve = (version: MissionControlRoadmapItem, path: Set<string>): number => {
    const cached = depths.get(version.id);
    if (cached !== undefined) return cached;
    if (version.parentVersionId === null) {
      depths.set(version.id, 0);
      return 0;
    }
    if (path.has(version.id)) return 0;
    const parent = byId.get(version.parentVersionId);
    const nextPath = new Set(path).add(version.id);
    const depth = parent === undefined ? 1 : resolve(parent, nextPath) + 1;
    depths.set(version.id, depth);
    return depth;
  };
  roadmap.forEach((version) => resolve(version, new Set()));
  return depths;
};

const walkNext = (
  current: MissionControlRoadmapItem,
  roadmap: MissionControlRoadmapItem[]
): MissionControlRoadmapItem[] => {
  const byId = versionsById(roadmap);
  const result: MissionControlRoadmapItem[] = [];
  const visited = new Set<string>();
  let pointer = current.nextVersionId;
  while (pointer !== null && !visited.has(pointer)) {
    const version = byId.get(pointer);
    if (version === undefined) break;
    visited.add(pointer);
    result.push(version);
    pointer = version.nextVersionId;
  }
  return result;
};

const EmptyState = ({ title, description }: { title: string; description: string }): ReactNode => (
  <div className="empty-state">
    <strong>{title}</strong>
    <p>{description}</p>
  </div>
);

const StatusMark = ({ state, label }: { state: MissionControlVersionState | null; label?: string | null }): ReactNode => (
  <span className={classNames("status-mark", `tone-${stateTone(state, label)}`)}>
    <i />{stateLabel(state, label)}
  </span>
);

export const ProjectContext = ({ projects, selectedProjectId, projectName, onSelect, onAdd, onStop, defaultOpen = false }: {
  projects: MissionControlProjectSummary[];
  selectedProjectId: string | null;
  projectName: string;
  onSelect: (projectId: string) => void;
  onAdd?: (projectRoot: string) => Promise<void>;
  onStop: () => void;
  defaultOpen?: boolean;
}): ReactNode => {
  const [open, setOpen] = useState(defaultOpen);
  const [adding, setAdding] = useState(false);
  const [projectRoot, setProjectRoot] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selectedOption = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const close = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    window.requestAnimationFrame(() => selectedOption.current?.focus());
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      window.requestAnimationFrame(() => trigger.current?.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <div className="project-context" ref={root}>
      <button ref={trigger} className="project-trigger" onClick={() => setOpen((value) => !value)} type="button" aria-expanded={open} aria-haspopup="dialog" aria-controls="project-switcher">
        <span>{projectName}</span><CaretDown size={15} weight="bold" />
      </button>
      {open ? (
        <div id="project-switcher" className="project-popover" role="dialog" aria-label="切换 RouteLedger 项目">
          <div className="project-list">
            {projects.map((project) => (
              <button
                className={classNames("project-option", project.id === selectedProjectId && "is-selected")}
                disabled={!project.available}
                key={project.id}
                onClick={() => {
                  onSelect(project.id);
                  setOpen(false);
                  window.requestAnimationFrame(() => trigger.current?.focus());
                }}
                ref={project.id === selectedProjectId ? selectedOption : undefined}
                aria-pressed={project.id === selectedProjectId}
                type="button"
              >
                <span><strong>{project.projectName}</strong>{!project.available ? <small>项目暂不可用</small> : null}</span>
                {project.id === selectedProjectId ? <CheckCircle size={17} weight="fill" /> : null}
              </button>
            ))}
          </div>
          <div className="project-popover-footer">
            <p>这里只切换只读视图，不会改变 Codex 或 MCP 的当前绑定。</p>
            {adding ? (
              <form className="project-add-form" onSubmit={(event) => {
                event.preventDefault();
                if (projectRoot.trim().length === 0 || onAdd === undefined) return;
                setAddBusy(true);
                setAddError(null);
                void onAdd(projectRoot.trim()).then(() => {
                  setProjectRoot("");
                  setAdding(false);
                  setOpen(false);
                }).catch((error: unknown) => {
                  setAddError(error instanceof Error ? error.message : "无法添加工程。");
                }).finally(() => setAddBusy(false));
              }}>
                <label htmlFor="project-root-input">工程目录</label>
                <input id="project-root-input" value={projectRoot} onChange={(event) => setProjectRoot(event.target.value)} placeholder="输入工程的绝对路径" autoFocus />
                {addError !== null ? <small>{addError}</small> : null}
                <div><button disabled={addBusy} type="submit">{addBusy ? "添加中…" : "添加"}</button><button onClick={() => setAdding(false)} type="button">取消</button></div>
              </form>
            ) : <button className="add-project" onClick={() => setAdding(true)} type="button">添加工程</button>}
            <button className="stop-ui" onClick={onStop} type="button">退出 RouteLedger UI</button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export const RouteRail = ({ roadmap, current, selectedVersionId, onSelectVersion }: {
  roadmap: MissionControlRoadmapItem[];
  current: MissionControlRoadmapItem;
  selectedVersionId?: string;
  onSelectVersion?: (versionId: string) => void;
}): ReactNode => {
  const viewport = useRef<HTMLDivElement>(null);
  const currentNode = useRef<HTMLButtonElement>(null);
  const anchoredToCurrent = useRef(true);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [awayFromCurrent, setAwayFromCurrent] = useState(false);
  const versions = useMemo(() => [...roadmap].sort((left, right) => left.order - right.order), [roadmap]);
  const depths = useMemo(() => routeDepths(roadmap), [roadmap]);

  const scrollToCurrent = (behavior: ScrollBehavior): void => {
    const container = viewport.current;
    const marker = currentNode.current;
    if (container === null || marker === null) return;
    const top = marker.offsetTop - (container.clientHeight - marker.offsetHeight) / 2;
    container.scrollTo({ top, behavior });
  };

  const syncScrollState = (): void => {
    const container = viewport.current;
    const marker = currentNode.current;
    if (container === null || marker === null) return;
    const available = Math.max(1, container.scrollHeight - container.clientHeight);
    setScrollProgress(container.scrollTop / available);
    const containerCenter = container.getBoundingClientRect().top + container.clientHeight / 2;
    const markerRect = marker.getBoundingClientRect();
    const markerCenter = markerRect.top + markerRect.height / 2;
    const away = Math.abs(containerCenter - markerCenter) > Math.max(32, markerRect.height * 0.55);
    anchoredToCurrent.current = !away;
    setAwayFromCurrent(away);
  };

  const handleRailKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const container = viewport.current;
    if (container === null) return;
    const steps: Record<string, number> = {
      ArrowUp: -64,
      ArrowDown: 64,
      PageUp: -container.clientHeight * 0.8,
      PageDown: container.clientHeight * 0.8
    };
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      container.scrollTo({ top: event.key === "Home" ? 0 : container.scrollHeight, behavior: "smooth" });
      return;
    }
    const step = steps[event.key];
    if (step !== undefined) {
      event.preventDefault();
      container.scrollBy({ top: step, behavior: "smooth" });
    }
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      scrollToCurrent("auto");
      syncScrollState();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [current.id, versions.length]);

  useEffect(() => {
    if (selectedVersionId !== current.id) return;
    const frame = window.requestAnimationFrame(() => {
      scrollToCurrent("smooth");
      syncScrollState();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [current.id, selectedVersionId]);

  useEffect(() => {
    const container = viewport.current;
    if (container === null || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!anchoredToCurrent.current) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        scrollToCurrent("auto");
        syncScrollState();
      });
    });
    observer.observe(container);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [current.id, versions.length]);

  const railStyle = { "--route-scroll": `${scrollProgress * 100}%` } as CSSProperties;

  return (
    <section className="horizon-column route-column" aria-label="完整版本航迹" style={railStyle}>
      <div className="route-column-header">
        <div><p className="column-kicker">版本航迹</p><small>{versions.length} 个 Version</small></div>
        <button className={classNames("current-locator", awayFromCurrent && "is-visible")} onClick={() => scrollToCurrent("smooth")} type="button">
          <Crosshair size={15} />定位当前
        </button>
      </div>
      <div className="route-rail-frame">
        <div className="route-rail-viewport" ref={viewport} onScroll={syncScrollState} onKeyDown={handleRailKeyDown} tabIndex={0} aria-label="Version 路线，向上查看过去，向下查看未来">
          <div className="route-breathing-space" aria-hidden="true" />
          <div className="route-rail-track">
            {versions.map((version) => {
              const relation = version.id === current.id ? "current" : version.order < current.order ? "past" : "future";
              const depth = depths.get(version.id) ?? 0;
              const isChildRoute = depth > 0;
              const relationLabel = relation === "current" ? "当前" : relation === "past" ? "过去" : "未来";
              const nodeStyle = { "--route-depth": Math.min(depth, 4) } as CSSProperties;
              return (
                <button
                  className={classNames("route-node", `is-${relation}`, isChildRoute && "is-child-route", version.id === selectedVersionId && "is-selected")}
                  data-route-node={version.id}
                  data-route-depth={depth}
                  key={version.id}
                  ref={relation === "current" ? currentNode : undefined}
                  aria-current={relation === "current" ? "step" : undefined}
                  aria-pressed={version.id === selectedVersionId}
                  style={nodeStyle}
                  type="button"
                  onClick={() => onSelectVersion?.(version.id)}
                >
                  <span className="route-node-dot" />
                  <div className="route-node-copy">
                    <span className="route-node-eyebrow">{relationLabel} · {isChildRoute ? `子路线 L${depth} · ` : ""}{version.order}</span>
                    <strong>{version.title}</strong>
                    <small className={classNames("route-state", `tone-${stateTone(version.state, version.displayLabel)}`)}>{stateLabel(version.state, version.displayLabel)}</small>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="route-breathing-space" aria-hidden="true" />
        </div>
        <div className="route-ruler" aria-hidden="true"><span /></div>
      </div>
      <p className="route-hint">过去向上 · 未来向下</p>
    </section>
  );
};

const Metric = ({ value, label }: { value: number; label: string }): ReactNode => (
  <div className="metric">
    <strong>{value}</strong><span>{label}</span>
  </div>
);

const TodoList = ({ todos }: { todos: MissionControlTodoItem[] }): ReactNode => (
  <div className="work-list todo-list">
    {todos.length === 0 ? <p className="quiet-empty">该 Version 没有未完成 Todo。</p> : todos.map((todo) => (
      <div className="work-row" key={todo.id}>
        <span className={classNames("work-dot", todo.status === "running" && "is-running")} />
        <div><strong>{todo.title}</strong>{todo.description ? <p>{todo.description}</p> : null}</div>
      </div>
    ))}
  </div>
);

const DeferredList = ({ deferred }: { deferred: MissionControlDeferredItem[] }): ReactNode => (
  <div className="deferred-table">
    {deferred.length === 0 ? <p className="quiet-empty">该 Version 没有当前相关的 Deferred。</p> : deferred.map((item) => (
      <div className="deferred-row" key={item.id}>
        <span className={classNames("blue-dot", item.isDue && "is-due")} />
        <div><strong>{item.title}</strong>{item.reason ? <p>{item.reason}</p> : null}</div>
        <small>{item.isDue ? "本 Version 需复评" : `目标：${item.targetReviewVersionTitle}`}</small>
      </div>
    ))}
  </div>
);

const ConstraintList = ({ constraints }: { constraints: MissionControlConstraintItem[] }): ReactNode => (
  <div className="constraint-list">
    {constraints.map((constraint) => (
      <div className="constraint-row" key={constraint.id}>
        <span /><div><strong>{constraint.rule}</strong>{constraint.rationale ? <p>{constraint.rationale}</p> : null}</div>
      </div>
    ))}
  </div>
);

export const CurrentVersionColumn = ({ response, viewedVersionId, onReturnToCurrent, sectionRef }: {
  response: MissionControlResponse;
  viewedVersionId?: string | null;
  onReturnToCurrent?: () => void;
  sectionRef?: RefObject<HTMLElement | null>;
}): ReactNode => {
  const [activeSection, setActiveSection] = useState<"todo" | "deferred">("deferred");
  const [constraintsOpen, setConstraintsOpen] = useState(false);
  const [childrenOpen, setChildrenOpen] = useState(false);
  const actualCurrentId = response.identity?.currentVersionId ?? null;
  const selectedId = viewedVersionId ?? actualCurrentId;
  const current = response.versionDetails.find((version) => version.id === selectedId) ?? response.currentVersion;
  const viewedRoadmap = response.roadmap.find((version) => version.id === current?.id) ?? null;
  const isActualCurrent = current?.id === actualCurrentId;
  const actualCurrentOrder = response.identity?.currentVersionOrder ?? null;
  const relation = viewedRoadmap === null || actualCurrentOrder === null
    ? "version"
    : viewedRoadmap.order < actualCurrentOrder ? "过去版本" : "未来版本";
  const children = viewedRoadmap === null
    ? []
    : response.roadmap.filter((version) => version.parentVersionId === viewedRoadmap.id);

  useEffect(() => {
    setActiveSection("deferred");
    setConstraintsOpen(false);
    setChildrenOpen(false);
  }, [current?.id]);

  if (current === null) {
    return (
      <section className="horizon-column current-column empty-current">
        <span className="current-label">当前版本</span>
        <EmptyState title="路线尚未定义" description={response.message} />
      </section>
    );
  }

  return (
    <section ref={sectionRef} className={classNames("horizon-column current-column", !isActualCurrent && "is-inspecting")} aria-label={isActualCurrent ? "当前版本" : `正在查看${relation}`} aria-live="polite">
      <div className="version-view-label">
        <span className={classNames("current-label", !isActualCurrent && "inspection-label")}>{isActualCurrent ? "当前版本" : `查看${relation}`}</span>
        {!isActualCurrent ? <button className="return-current" onClick={onReturnToCurrent} type="button"><Crosshair size={14} />查看当前 Version</button> : null}
      </div>
      <h1>{current.title}</h1>
      <div className="current-meta">
        <StatusMark state={current.state} label={current.displayLabel} />
        <i className="meta-divider" />
        <b>{current.order} / {response.identity?.versionCount ?? response.roadmap.length}</b>
      </div>
      {current.description ? <p className="current-description">{current.description}</p> : null}
      <div className="section-rule" />

      <h2>{isActualCurrent ? "当前工作概览" : "该 Version 的当前留存记录"}</h2>
      <div className="metric-line">
        <button className={activeSection === "todo" ? "active" : ""} onClick={() => setActiveSection("todo")} type="button" aria-pressed={activeSection === "todo"}>
          <Metric value={current.todos.length} label="Todo" />
        </button>
        <button className={activeSection === "deferred" ? "active" : ""} onClick={() => setActiveSection("deferred")} type="button" aria-pressed={activeSection === "deferred"}>
          <Metric value={current.deferred.length} label="Deferred" />
        </button>
        <button onClick={() => setConstraintsOpen((value) => !value)} type="button" aria-expanded={constraintsOpen}>
          <Metric value={current.constraints.length} label="Constraints" />
        </button>
      </div>
      <div className="section-rule" />

      <div className="work-section-heading">
        <h2>{activeSection === "todo" ? "Todo" : "Deferred"}</h2>
        <small>{activeSection === "todo" ? "该 Version 当前仍未完成的工作" : "当前仍与该 Version 相关的复评事项"}</small>
      </div>
      {activeSection === "todo" ? <TodoList todos={current.todos} /> : <DeferredList deferred={current.deferred} />}

      <button className="disclosure-row" onClick={() => setConstraintsOpen((value) => !value)} type="button" aria-expanded={constraintsOpen}>
        <CaretDown className={constraintsOpen ? "rotated" : ""} size={16} />
        Constraints（{current.constraints.length}）
      </button>
      {constraintsOpen ? (
        current.constraints.length === 0
          ? <p className="disclosure-empty">该 Version 没有生效中的项目或版本 Constraint。</p>
          : <ConstraintList constraints={current.constraints} />
      ) : null}

      {children.length > 0 ? (
        <>
          <button className="disclosure-row child-disclosure" onClick={() => setChildrenOpen((value) => !value)} type="button" aria-expanded={childrenOpen}>
            <GitBranch size={16} />子路线（{children.length}）<CaretDown className={childrenOpen ? "rotated" : ""} size={16} />
          </button>
          {childrenOpen ? <div className="child-list">{children.map((child) => <div key={child.id}><span>{child.order}</span>{child.title}</div>)}</div> : null}
        </>
      ) : null}
    </section>
  );
};

const NextColumn = ({ version }: { version: MissionControlRoadmapItem | null }): ReactNode => (
  <section className="horizon-column next-column" aria-label="下一版本">
    <p className="column-kicker">下一版本</p>
    {version === null ? (
      <EmptyState title="没有下一 Version" description="当前 Version 已位于这条路线的末端。" />
    ) : (
      <>
        <h2>{version.title}</h2>
        <StatusMark state={version.state} label={version.displayLabel} />
        <p className="version-position">位置 {version.order}</p>
        <div className="section-rule" />
        {version.childCount > 0 ? <div className="child-count"><GitBranch size={16} />包含 {version.childCount} 个子 Version</div> : null}
      </>
    )}
  </section>
);

const FutureColumn = ({ versions, totalCount }: { versions: MissionControlRoadmapItem[]; totalCount: number }): ReactNode => {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? versions : versions.slice(0, 3);
  const remaining = Math.max(0, totalCount - shown.length);

  return (
    <section className="horizon-column future-column" aria-label="后续版本">
      <p className="column-kicker">后续 {totalCount} 个 Version</p>
      <div className="section-rule" />
      {versions.length === 0 ? <EmptyState title="暂无后续路线" description="当前没有可展示的下游 Version。" /> : (
        <div className="future-list">
          {shown.map((version) => (
            <article className="future-item" key={version.id}>
              <span className="rail-dot" />
              <div><strong>{version.title}</strong><p>位置 {version.order} · {stateLabel(version.state, version.displayLabel)}</p></div>
            </article>
          ))}
        </div>
      )}
      {versions.length > 3 ? (
        <button className="future-toggle" onClick={() => setExpanded((value) => !value)} type="button" aria-expanded={expanded}>
          <CaretDown className={expanded ? "rotated" : ""} size={15} />
          {expanded ? "收起后续路线" : `还有 ${remaining} 个版本`}
        </button>
      ) : null}
    </section>
  );
};

const HistorySection = ({
  approvals,
  events,
  proposals,
  legacyAudit
}: {
  approvals: MissionControlApprovalArtifact[];
  events: MissionControlAuditEvent[];
  proposals: MissionControlProposal[];
  legacyAudit: MissionControlLegacyAudit;
}): ReactNode => (
  <div className="history-stack">
    {proposals.length > 0 ? (
      <section><h3>Pending Proposal（{proposals.length}）</h3>{proposals.map((proposal) => (
        <article className="history-record" key={proposal.id}><strong>{proposal.actionType}</strong><p>{proposal.reason}</p><small>{formatDateTime(proposal.createdAt)}</small></article>
      ))}</section>
    ) : null}
    <section>
      <h3>审批记录（{approvals.length}）</h3>
      {approvals.length === 0 ? <p className="history-empty">暂无审批记录。</p> : approvals.map((approval) => (
        <article className="history-record" key={approval.id}><strong>{approval.actionType}</strong><p>{approval.approverName} · {approval.status}</p><small>{formatDateTime(approval.createdAt)}</small></article>
      ))}
    </section>
    <section>
      <h3>最近事件（{events.length}）</h3>
      {events.length === 0 ? <p className="history-empty">暂无事件记录。</p> : events.map((event) => (
        <article className="history-record" key={event.id}><strong>{event.eventType}</strong><p>{event.actorName} · {event.fromState ?? "—"} → {event.toState ?? "—"}</p><small>{formatDateTime(event.createdAt)}</small></article>
      ))}
    </section>
    {legacyAudit.records.length > 0 ? (
      <section><h3>历史兼容审计（{legacyAudit.records.length}）</h3>{legacyAudit.records.map((record) => (
        <article className="history-record" key={record.id}><strong>{record.title}</strong><p>{record.reason}</p><small>{record.status}</small></article>
      ))}</section>
    ) : null}
  </div>
);

export const VersionHorizon = ({ response, projects, selectedProjectId, refreshing, onRefresh, onSelectProject, onAddProject, onStop }: {
  response: MissionControlResponse;
  projects?: MissionControlProjectSummary[];
  selectedProjectId?: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onSelectProject?: (projectId: string) => void;
  onAddProject?: (projectRoot: string) => Promise<void>;
  onStop?: () => void;
}): ReactNode => {
  const [historyVisible, setHistoryVisible] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewedVersionId, setViewedVersionId] = useState<string | null>(response.identity?.currentVersionId ?? null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const historyCloseButton = useRef<HTMLButtonElement>(null);
  const historyWasOpen = useRef(false);
  const detailColumn = useRef<HTMLElement>(null);
  const currentRoadmap = useMemo(
    () => response.roadmap.find((version) => version.isCurrent) ?? null,
    [response.roadmap]
  );
  const viewedRoadmap = response.roadmap.find((version) => version.id === viewedVersionId) ?? currentRoadmap;
  const forward = viewedRoadmap === null ? [] : walkNext(viewedRoadmap, response.roadmap);
  const next = forward[0] ?? null;
  const later = forward.slice(1);
  const viewedVersion = response.versionDetails.find((version) => version.id === viewedVersionId) ?? response.currentVersion;
  const parentTitle = viewedVersion?.parentVersionTitle ?? null;
  const selectVersion = (versionId: string): void => {
    setViewedVersionId(versionId);
    if (!window.matchMedia("(max-width: 820px)").matches) return;
    window.requestAnimationFrame(() => detailColumn.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  useEffect(() => {
    if (viewedVersionId !== null && response.versionDetails.some((version) => version.id === viewedVersionId)) return;
    setViewedVersionId(response.identity?.currentVersionId ?? null);
  }, [response.identity?.currentVersionId, response.versionDetails, viewedVersionId]);

  useEffect(() => {
    if (!historyOpen) {
      if (historyWasOpen.current) historyButton.current?.focus();
      historyWasOpen.current = false;
      return;
    }

    historyWasOpen.current = true;
    historyCloseButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [historyOpen]);

  return (
    <main className="mission-control">
      <header className="topbar">
        <div className="brand"><GitBranch size={25} weight="fill" /><span>RouteLedger</span></div>
        <div className="project-area">
          <ProjectContext
            projects={projects ?? []}
            selectedProjectId={selectedProjectId ?? null}
            projectName={response.identity?.projectName ?? "未初始化项目"}
            onSelect={onSelectProject ?? (() => undefined)}
            onAdd={onAddProject}
            onStop={onStop ?? (() => undefined)}
          />
          <span className="readonly"><LockSimple size={15} />只读</span>
        </div>
        <button ref={historyButton} className="history-button" onClick={() => setHistoryOpen(true)} type="button" aria-expanded={historyOpen} aria-controls="history-drawer">
          <ClockCounterClockwise size={20} />历史记录
        </button>
      </header>

      <nav className="route-breadcrumb" aria-label="路线位置">
        <GitBranch size={20} weight="fill" />
        <strong>主路线</strong>
        {parentTitle !== null ? <><span>/</span><span>{parentTitle}</span></> : null}
        <span className="breadcrumb-spacer" />
        <button onClick={onRefresh} disabled={refreshing} type="button">{refreshing ? "刷新中…" : "刷新数据"}</button>
      </nav>

      {response.screen !== "ready" || response.statusRisks.some((risk) => risk.severity === "blocking") ? (
        <div className={classNames("system-notice", response.screen !== "ready" && "is-warning")}>
          <strong>{response.screen === "ready" ? "当前状态需要留意" : "RouteLedger 状态未完全就绪"}</strong>
          <p>{response.message}</p>
        </div>
      ) : null}

      <section className="horizon-content">
        <button className="history-column-toggle" onClick={() => setHistoryVisible((value) => !value)} type="button">
          <GitBranch size={17} />{historyVisible ? "隐藏版本航迹" : "显示版本航迹"}
        </button>
        <div className={classNames("horizon-grid", !historyVisible && "without-history")}>
          {historyVisible && currentRoadmap !== null ? (
            <RouteRail
              roadmap={response.roadmap}
              current={currentRoadmap}
              selectedVersionId={viewedVersionId ?? undefined}
              onSelectVersion={selectVersion}
            />
          ) : null}
          <CurrentVersionColumn
            response={response}
            viewedVersionId={viewedVersionId}
            onReturnToCurrent={() => {
              const currentId = response.identity?.currentVersionId;
              if (currentId !== null && currentId !== undefined) selectVersion(currentId);
            }}
            sectionRef={detailColumn}
          />
          <NextColumn version={next} />
          <FutureColumn versions={later} totalCount={Math.max(0, forward.length - 1)} />
        </div>
      </section>

      <div className={classNames("drawer-overlay", historyOpen && "is-open")} onClick={() => setHistoryOpen(false)} />
      <aside id="history-drawer" className={classNames("history-drawer", historyOpen && "is-open")} aria-hidden={!historyOpen} inert={!historyOpen} aria-label="历史与审批" role="dialog" aria-modal="true">
        <div className="history-header"><div><small>只读记录</small><h2>历史与审批</h2></div><button ref={historyCloseButton} onClick={() => setHistoryOpen(false)} aria-label="关闭历史记录" type="button"><X size={21} /></button></div>
        <HistorySection approvals={response.approvals} events={response.auditTrail} proposals={response.proposals} legacyAudit={response.legacyAudit} />
      </aside>
    </main>
  );
};

export const App = (): ReactNode => {
  const [loadState, setLoadState] = useState<AppLoadState>({ status: "loading", data: null, error: null, refreshing: false });
  const [projects, setProjects] = useState<MissionControlProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("project"));

  const refresh = async (projectOverride?: string | null): Promise<void> => {
    const requestedProjectId = projectOverride === undefined ? selectedProjectId : projectOverride;
    startTransition(() => setLoadState((previous) =>
      previous.status === "stopped" ? previous : { ...previous, refreshing: true }
    ));
    try {
      const projectResponse = await fetchMissionControlProjects();
      const resolvedProjectId = requestedProjectId !== null && projectResponse.projects.some((project) => project.id === requestedProjectId && project.available)
        ? requestedProjectId
        : projectResponse.projects.find((project) => project.available)?.id ?? null;
      const data = await fetchMissionControlState(resolvedProjectId);
      setProjects(projectResponse.projects);
      setSelectedProjectId(resolvedProjectId);
      const nextUrl = new URL(window.location.href);
      if (resolvedProjectId === null) nextUrl.searchParams.delete("project");
      else nextUrl.searchParams.set("project", resolvedProjectId);
      window.history.replaceState(null, "", nextUrl);
      startTransition(() => setLoadState({ status: "ready", data, error: null, refreshing: false }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取 Mission Control 状态失败。";
      startTransition(() => setLoadState((previous) => ({ status: "failed", data: previous.data, error: message, refreshing: false })));
    }
  };

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (loadState.status === "stopped") return undefined;
    const heartbeat = (): void => {
      void heartbeatMissionControl().catch(() => undefined);
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, 15_000);
    return () => window.clearInterval(timer);
  }, [loadState.status]);

  const stop = async (): Promise<void> => {
    await stopMissionControl();
    setLoadState({ status: "stopped", data: null, error: null, refreshing: false });
  };

  if (loadState.status === "stopped") {
    return <main className="mission-control centered-state"><GitBranch size={28} weight="fill" /><strong>RouteLedger UI 已退出</strong><p>项目数据和 MCP 运行不受影响。需要时可从 Codex 或命令行再次打开。</p></main>;
  }

  if (loadState.status === "loading") {
    return <main className="mission-control centered-state"><div className="loading-mark"><GitBranch size={28} weight="fill" /></div><strong>正在读取项目路线…</strong><p>RouteLedger 正在加载 canonical JSON。</p></main>;
  }

  if (loadState.data === null) {
    return <main className="mission-control centered-state"><strong>无法读取项目路线</strong><p>{loadState.error ?? "当前没有可展示的数据。"}</p><button onClick={() => void refresh()} type="button">重新读取</button></main>;
  }

  return (
    <VersionHorizon
      response={loadState.data}
      projects={projects}
      selectedProjectId={selectedProjectId}
      refreshing={loadState.refreshing}
      onRefresh={() => void refresh()}
      onSelectProject={(projectId) => void refresh(projectId)}
      onAddProject={async (projectRoot) => {
        const result = await registerMissionControlProject(projectRoot);
        await refresh(result.project.id);
      }}
      onStop={() => void stop()}
    />
  );
};
