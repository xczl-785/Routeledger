import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  CaretDown,
  CaretRight,
  CheckCircle,
  ClockCounterClockwise,
  DotsThree,
  GitBranch,
  LockSimple,
  SquaresFour,
} from "@phosphor-icons/react";

const projects = ["ProjectBP 正式路线", "Fund Claw", "CustomGameEngine", "FTest", "OpenFlow"];

function ProjectSwitcher({ value, onChange, align = "left" }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);

  useEffect(() => {
    const close = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);

  return (
    <div className={`project-switcher ${align}`} ref={root}>
      <button className="project-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{value}</span><CaretDown size={15} weight="bold" />
      </button>
      {open && (
        <div className="project-menu">
          {projects.map((project) => (
            <button key={project} className={project === value ? "selected" : ""} onClick={() => { onChange(project); setOpen(false); }}>
              <span>{project}</span>{project === value && <CheckCircle size={17} weight="fill" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const focusData = {
  "ProjectBP 正式路线": {
    position: 44, total: 68,
    title: "Godot-E8 Core 自动 Docking 与连接语义迁移",
    state: "进行中", todo: 1, deferred: 1, constraints: 1,
    todoTitle: "完善自动 Docking 的端口匹配与命名规则",
    deferredTitle: "批量迁移的性能与并发策略优化",
    constraintTitle: "现有项目结构与资源引用不可破坏",
    next: "Godot-F 稳定性、体验与资产归宿审计",
    later: ["Godot-P｜Package detached 与 Boundary", "Godot-P｜Reuse Package 与蓝图复用", "Godot-W｜Legacy Web 与 Delete-Group 物理收尾"],
  },
  "Fund Claw": {
    position: 47, total: 58, title: "Claw-PF1 Multi-fund Portfolio Foundation", state: "已关闭",
    todo: 0, deferred: 3, constraints: 9, todoTitle: "当前 Version 没有未完成 Todo",
    deferredTitle: "组合层策略表现边界复评", constraintTitle: "真实基金与虚拟资金边界不可混用",
    next: "Claw-SV1 Single-strategy Portfolio Validation And Stabilization",
    later: ["Claw-N3｜Multi-strategy Isolation", "Claw-N4｜Long-term Review And Memory", "Claw-S1｜Governed Social Sentiment"],
  },
};

const routeNodes = [
  [41, "Godot-E7", "输入门与会话"], [42, "Godot-E8 Pre", "Docking 语义梳理"],
  [43, "Godot-E8 Pre", "连接语义迁移准备"], [44, "Godot-E8 Core", "自动 Docking 与连接语义迁移"],
  [45, "Godot-F", "稳定性与校验完善"], [46, "Godot-P", "边界与回归收敛"],
];

function FocusPage() {
  const [project, setProject] = useState("ProjectBP 正式路线");
  const [childrenOpen, setChildrenOpen] = useState(false);
  const [constraintsOpen, setConstraintsOpen] = useState(true);
  const data = focusData[project] ?? focusData["ProjectBP 正式路线"];

  return (
    <main className="focus-page">
      <header className="focus-header">
        <div className="brand-group"><SquaresFour size={25} weight="fill" /><ProjectSwitcher value={project} onChange={setProject} /></div>
        <div className="header-actions"><span><LockSimple size={18} />只读模式</span><i /><a href="/horizon" title="查看另一个原型"><ClockCounterClockwise size={20} />历史</a></div>
      </header>

      <section className="route-strip">
        <div className="route-line" />
        {routeNodes.map(([number, label, detail]) => (
          <div className={`route-node ${number === 44 ? "current" : ""}`} key={number}>
            <span className="node-number">{number}</span><strong>{label}</strong><small>{detail}</small>
            {number === 44 && <em>进行中</em>}
          </div>
        ))}
        <div className="route-node route-more"><span className="node-number"><DotsThree size={23} /></span><small>至 {data.total}</small></div>
      </section>
      <button className="children-toggle" onClick={() => setChildrenOpen((value) => !value)}><CaretDown className={childrenOpen ? "rotated" : ""} size={15} />子路线 2</button>
      {childrenOpen && <div className="children-preview"><span>Godot-E8.1 兼容路径</span><span>Godot-E8.2 迁移验证</span></div>}

      <div className="focus-grid">
        <section className="current-panel">
          <p className="eyebrow">当前版本 <span>（{data.position} / {data.total}）</span></p>
          <h1>{data.title}</h1>
          <div className="state-line"><span className="state-dot" />{data.state}</div>
          <div className="rule" />
          <h2>当前版本工作概况</h2>
          <div className="counts">
            <div><span className="ring todo-ring" />{data.todo} Todo</div>
            <div><span className="ring deferred-ring" />{data.deferred} Deferred</div>
            <button onClick={() => setConstraintsOpen((value) => !value)}><span className="ring constraint-ring">!</span>{data.constraints} Constraint</button>
          </div>
          <WorkRow heading={`Todo（${data.todo}）`} title={data.todoTitle} tag={data.todo ? "研究中" : "已清空"} priority="优先级：中" />
          <WorkRow heading={`Deferred（${data.deferred}）`} title={data.deferredTitle} tag="待后续" priority="优先级：低" dotted />
          {constraintsOpen && <WorkRow heading={`Constraint（${data.constraints}）`} title={data.constraintTitle} warning />}
        </section>

        <aside className="trajectory-panel">
          <p className="eyebrow">下一版本 <span>（{data.position + 1} / {data.total}）</span></p>
          <div className="next-state"><span />等待</div>
          <h2>{data.next}</h2>
          <div className="rule" />
          <h3>后续方向</h3>
          <div className="later-list">
            {data.later.map((item, index) => {
              const [prefix, title] = item.split("｜");
              return <div className="later-item" key={item}><span>{data.position + 2 + index}</span><div><strong>{prefix}</strong><p>{title}</p></div></div>;
            })}
          </div>
        </aside>
      </div>
    </main>
  );
}

function WorkRow({ heading, title, tag, priority, dotted, warning }) {
  return (
    <section className="work-section">
      <h3>{heading}</h3>
      <div className="work-row">
        <span className={`work-mark ${dotted ? "dotted" : ""} ${warning ? "warning" : ""}`}>{warning ? "!" : ""}</span>
        <p>{title}</p>{tag && <span className="tag">{tag}</span>}{priority && <small className="priority">{priority}</small>}
      </div>
    </section>
  );
}

const deferredItems = [
  ["Strategy performance edge validation", "Claw-SV1"],
  ["Risk model hardening", "Claw-SV1"],
  ["Operational runbooks & automation", "Claw-SV1"],
];

function HorizonPage() {
  const [project, setProject] = useState("Fund Claw");
  const [historyVisible, setHistoryVisible] = useState(true);
  const [constraintsOpen, setConstraintsOpen] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);

  return (
    <main className="horizon-page">
      <header className="horizon-header">
        <a href="/focus" className="horizon-brand"><GitBranch size={25} weight="fill" />Version Horizon</a>
        <div className="horizon-project"><ProjectSwitcher value={project} onChange={setProject} align="center" /><span className="readonly-dot" />只读</div>
        <button className="history-link"><ClockCounterClockwise size={20} />历史视图</button>
      </header>
      <nav className="route-breadcrumb"><GitBranch size={20} weight="fill" /><strong>主路线</strong><span>/</span><span>Portfolio 路线</span></nav>
      <section className="horizon-content">
        <button className="history-toggle" onClick={() => setHistoryVisible((value) => !value)}><AppWindow size={17} />{historyVisible ? "隐藏历史版本" : "显示历史版本"}</button>
        <div className={`horizon-columns ${historyVisible ? "" : "without-history"}`}>
          {historyVisible && <PastColumn />}
          <section className="current-column">
            <span className="current-label">当前版本</span>
            <h1>Claw-PF1 Multi-fund Portfolio Foundation</h1>
            <div className="current-meta"><strong>已关闭</strong><i /><b>47 / 58</b></div>
            <div className="rule" />
            <h2>当前工作概览</h2>
            <div className="metric-line"><Metric value="0" label="Todo" /><Metric value="3" label="Deferred" /><Metric value="9" label="Constraints" /></div>
            <div className="rule" />
            <h2>Deferred <small>（下阶段推进的事项）</small></h2>
            <div className="deferred-table">
              {deferredItems.map(([title, target]) => <div key={title}><span className="blue-bullet" /><p>{title}</p><small>目标版本：{target}</small></div>)}
            </div>
            <button className="constraint-disclosure" onClick={() => setConstraintsOpen((value) => !value)}><CaretDown className={constraintsOpen ? "rotated" : ""} />Constraints（9）</button>
            {constraintsOpen && <div className="constraint-body">项目资金边界、策略隔离和可回放证据等 9 条约束仍然有效。</div>}
          </section>
          <section className="next-column">
            <p className="column-label">下一版本</p>
            <h2>Claw-SV1 Single-strategy Portfolio Validation And Stabilization</h2>
            <span className="closed-tag">已关闭</span>
            <div className="rule" />
          </section>
          <section className="future-column">
            <p className="column-label">后续 10 个 Version</p>
            <div className="rule" />
            {["Claw-GA1|Growth & Allocation Expansion", "Claw-INT1|Integrations & APIs", "Claw-RB1|Risk & Rebalancing Engine"].map((item) => {
              const [title, detail] = item.split("|");
              return <div className="future-item" key={title}><span /><div><strong>{title}</strong><p>{detail}</p></div></div>;
            })}
            <button className="more-future" onClick={() => setLaterOpen((value) => !value)}><CaretDown className={laterOpen ? "rotated" : ""} />还有 7 个版本</button>
            {laterOpen && <div className="future-extra">Claw-N3<br />Claw-N4<br />Claw-S1<br />Claw-UV1</div>}
          </section>
        </div>
      </section>
    </main>
  );
}

function PastColumn() {
  return <section className="past-column"><p className="column-label">过去版本</p>{[["Claw-ALPHA", "Alpha Foundation"], ["Claw-BETA", "Beta Validation"], ["Claw-MVP", "MVP Release"]].map(([title, detail]) => <div className="past-item" key={title}><span /><div><strong>{title}</strong><p>{detail}</p><small>已关闭</small></div></div>)}</section>;
}

function Metric({ value, label }) { return <div className="metric"><strong>{value}</strong><span>{label}</span></div>; }

export function App() {
  const page = useMemo(() => window.location.pathname.toLowerCase(), []);
  return page.startsWith("/horizon") ? <HorizonPage /> : <FocusPage />;
}
