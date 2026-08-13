import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { ClockCounterClockwise } from "@phosphor-icons/react/ClockCounterClockwise";
import { GitBranch } from "@phosphor-icons/react/GitBranch";
import { LockSimple } from "@phosphor-icons/react/LockSimple";
import { X } from "@phosphor-icons/react/X";

import { fetchMissionControlState } from "./api.js";
import type {
  MissionControlApprovalArtifact,
  MissionControlAuditEvent,
  MissionControlConstraintItem,
  MissionControlDeferredItem,
  MissionControlLegacyAudit,
  MissionControlProposal,
  MissionControlResponse,
  MissionControlRoadmapItem,
  MissionControlTodoItem,
  MissionControlVersionState
} from "./shared/mission-control.js";

type AppLoadState =
  | { status: "loading"; data: null; error: null; refreshing: boolean }
  | { status: "ready"; data: MissionControlResponse; error: null; refreshing: boolean }
  | { status: "failed"; data: MissionControlResponse | null; error: string; refreshing: boolean };

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

const stateTone = (state: MissionControlVersionState | null): string =>
  state === null ? "neutral" : state;

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

const walkPrevious = (
  current: MissionControlRoadmapItem,
  roadmap: MissionControlRoadmapItem[],
  limit = 3
): MissionControlRoadmapItem[] => {
  const byId = versionsById(roadmap);
  const result: MissionControlRoadmapItem[] = [];
  let pointer = current.previousVersionId;
  while (pointer !== null && result.length < limit) {
    const version = byId.get(pointer);
    if (version === undefined) break;
    result.unshift(version);
    pointer = version.previousVersionId;
  }
  return result;
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
  <span className={classNames("status-mark", `tone-${stateTone(state)}`)}>
    <i />{stateLabel(state, label)}
  </span>
);

const ProjectContext = ({ projectName }: { projectName: string }): ReactNode => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);

  return (
    <div className="project-context" ref={root}>
      <button className="project-trigger" onClick={() => setOpen((value) => !value)} type="button" aria-expanded={open}>
        <span>{projectName}</span><CaretDown size={15} weight="bold" />
      </button>
      {open ? (
        <div className="project-popover">
          <div className="project-current"><span>{projectName}</span><CheckCircle size={17} weight="fill" /></div>
          <p>当前 Mission Control 实例只展示它所绑定的一个项目。</p>
        </div>
      ) : null}
    </div>
  );
};

const PastColumn = ({ versions }: { versions: MissionControlRoadmapItem[] }): ReactNode => (
  <section className="horizon-column past-column" aria-label="过去版本">
    <p className="column-kicker">过去版本</p>
    {versions.length === 0 ? (
      <EmptyState title="没有上游 Version" description="当前 Version 位于这条路线的起点。" />
    ) : (
      <div className="past-list">
        {versions.map((version) => (
          <article className="past-item" key={version.id}>
            <span className="rail-dot" />
            <div>
              <strong>{version.title}</strong>
              <p>位置 {version.order}</p>
              <small>{stateLabel(version.state, version.displayLabel)}</small>
            </div>
          </article>
        ))}
      </div>
    )}
  </section>
);

const Metric = ({ value, label }: { value: number; label: string }): ReactNode => (
  <div className="metric">
    <strong>{value}</strong><span>{label}</span>
  </div>
);

const TodoList = ({ todos }: { todos: MissionControlTodoItem[] }): ReactNode => (
  <div className="work-list todo-list">
    {todos.length === 0 ? <p className="quiet-empty">当前 Version 没有未完成 Todo。</p> : todos.map((todo) => (
      <div className="work-row" key={todo.id}>
        <span className={classNames("work-dot", todo.status === "running" && "is-running")} />
        <div><strong>{todo.title}</strong>{todo.description ? <p>{todo.description}</p> : null}</div>
      </div>
    ))}
  </div>
);

const DeferredList = ({ deferred }: { deferred: MissionControlDeferredItem[] }): ReactNode => (
  <div className="deferred-table">
    {deferred.length === 0 ? <p className="quiet-empty">当前 Version 没有相关 Deferred。</p> : deferred.map((item) => (
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

export const CurrentVersionColumn = ({ response }: { response: MissionControlResponse }): ReactNode => {
  const [activeSection, setActiveSection] = useState<"todo" | "deferred">("deferred");
  const [constraintsOpen, setConstraintsOpen] = useState(false);
  const [childrenOpen, setChildrenOpen] = useState(false);
  const current = response.currentVersion;
  const currentRoadmap = response.roadmap.find((version) => version.isCurrent) ?? null;
  const children = currentRoadmap === null
    ? []
    : response.roadmap.filter((version) => version.parentVersionId === currentRoadmap.id);

  if (current === null) {
    return (
      <section className="horizon-column current-column empty-current">
        <span className="current-label">当前版本</span>
        <EmptyState title="路线尚未定义" description={response.message} />
      </section>
    );
  }

  return (
    <section className="horizon-column current-column" aria-label="当前版本">
      <span className="current-label">当前版本</span>
      <h1>{current.title}</h1>
      <div className="current-meta">
        <StatusMark state={current.state} label={current.displayLabel} />
        <i className="meta-divider" />
        <b>{current.order} / {response.identity?.versionCount ?? response.roadmap.length}</b>
      </div>
      {current.description ? <p className="current-description">{current.description}</p> : null}
      <div className="section-rule" />

      <h2>当前工作概览</h2>
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
        <small>{activeSection === "todo" ? "当前 Version 的未完成工作" : "与当前 Version 相关的复评事项"}</small>
      </div>
      {activeSection === "todo" ? <TodoList todos={current.todos} /> : <DeferredList deferred={current.deferred} />}

      <button className="disclosure-row" onClick={() => setConstraintsOpen((value) => !value)} type="button" aria-expanded={constraintsOpen}>
        <CaretDown className={constraintsOpen ? "rotated" : ""} size={16} />
        Constraints（{current.constraints.length}）
      </button>
      {constraintsOpen ? (
        current.constraints.length === 0
          ? <p className="disclosure-empty">当前项目与 Version 没有生效中的 Constraint。</p>
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

export const VersionHorizon = ({ response, refreshing, onRefresh }: {
  response: MissionControlResponse;
  refreshing: boolean;
  onRefresh: () => void;
}): ReactNode => {
  const [historyVisible, setHistoryVisible] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const historyCloseButton = useRef<HTMLButtonElement>(null);
  const historyWasOpen = useRef(false);
  const currentRoadmap = useMemo(
    () => response.roadmap.find((version) => version.isCurrent) ?? null,
    [response.roadmap]
  );
  const past = currentRoadmap === null ? [] : walkPrevious(currentRoadmap, response.roadmap, 3);
  const forward = currentRoadmap === null ? [] : walkNext(currentRoadmap, response.roadmap);
  const next = forward[0] ?? null;
  const later = forward.slice(1);
  const parentTitle = response.currentVersion?.parentVersionTitle ?? null;

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
          <ProjectContext projectName={response.identity?.projectName ?? "未初始化项目"} />
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
          <ClockCounterClockwise size={17} />{historyVisible ? "隐藏历史版本" : "显示历史版本"}
        </button>
        <div className={classNames("horizon-grid", !historyVisible && "without-history")}>
          {historyVisible ? <PastColumn versions={past} /> : null}
          <CurrentVersionColumn response={response} />
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

  const refresh = async (): Promise<void> => {
    startTransition(() => setLoadState((previous) => ({ ...previous, refreshing: true })));
    try {
      const data = await fetchMissionControlState();
      startTransition(() => setLoadState({ status: "ready", data, error: null, refreshing: false }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取 Mission Control 状态失败。";
      startTransition(() => setLoadState((previous) => ({ status: "failed", data: previous.data, error: message, refreshing: false })));
    }
  };

  useEffect(() => { void refresh(); }, []);

  if (loadState.status === "loading") {
    return <main className="mission-control centered-state"><div className="loading-mark"><GitBranch size={28} weight="fill" /></div><strong>正在读取项目路线…</strong><p>RouteLedger 正在加载 canonical JSON。</p></main>;
  }

  if (loadState.data === null) {
    return <main className="mission-control centered-state"><strong>无法读取项目路线</strong><p>{loadState.error ?? "当前没有可展示的数据。"}</p><button onClick={() => void refresh()} type="button">重新读取</button></main>;
  }

  return <VersionHorizon response={loadState.data} refreshing={loadState.refreshing} onRefresh={() => void refresh()} />;
};
