// v2 shell: top bar across the app, icon rail (case menus appear only when a case is open),
// case bar with the five-stage stepper, status footer and the assistant on every page.
import { useEffect, useState, type FocusEvent, type FormEvent, type MouseEvent } from "react";
import { NavLink, Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, FileText, Folder, GitBranch, Inbox, Layers, LayoutDashboard, Lightbulb, LogOut, MessageSquare, Moon, Play, Search, Settings,
  Share2, Shield, Sun, X } from "lucide-react";
import { api, type Case, type ServiceCheck, type ServiceName } from "../api";
import { useAuth } from "../auth";
import { applyTheme, useSystem, useTheme, useWorkspace } from "../hooks";
import { load, store } from "../prefs";
import { STAGES } from "../vocab";
import Assistant from "./Assistant";
import { Avatar } from "./ui";

export const Logo = ({ size = 30 }: { size?: number }) => (
  <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#1E3A5F" />
    <g stroke="#D4A574" strokeWidth="1.5" fill="none"><path d="M9 11 16 7l7 4v10l-7 4-7-4z" /><path d="M9 11l7 4 7-4M16 15v10" /></g>
    <circle cx="16" cy="15" r="2.3" fill="#D4A574" /></svg>
);

export const useLastCase = () => {
  const m = useMatch("/cases/:caseId/*");
  const id = m?.params.caseId && m.params.caseId !== "new" ? m.params.caseId : null;
  useEffect(() => { if (id) store("case", id); }, [id]);
  return id ?? load<string | null>("case", null);
};

export const STAGE_ROUTES = ["graph", "environments", "simulations", "reports", "interaction"];
const STAGE_OF: [RegExp, number][] = [[/\/(graph|dynamic|reactions|review|documents|build)/, 0], [/\/environments/, 1], [/\/simulations/, 2], [/\/reports/, 3], [/\/interaction/, 4]];

type Tip = { label: string; desc: string; top: number } | null;

export default function Shell() {
  const { user, can, logout } = useAuth();
  const theme = useTheme();
  const sys = useSystem();
  const [tip, setTip] = useState<Tip>(null);
  const [q, setQ] = useState("");
  const loc = useLocation();
  const nav = useNavigate();
  useLastCase();
  const routeCase = useMatch("/cases/:caseId/*");
  const caseId = routeCase?.params.caseId && routeCase.params.caseId !== "new" && routeCase.params.caseId !== "wizard" ? routeCase.params.caseId : null;
  const cases = useQuery({ queryKey: ["cases"], queryFn: () => api.get<Case[]>("/cases") });
  const ws = useWorkspace();
  const wsName = ws.data?.name ?? "Workspace";
  const current = cases.data?.find(c => c.id === caseId);
  const activeStage = STAGE_OF.find(([re]) => re.test(loc.pathname))?.[1] ?? -1;

  useEffect(() => setTip(null), [loc.pathname]);

  const caseLink = (sub: string) => (caseId ? `/cases/${caseId}/${sub}` : "/cases");
  const tipFor = (label: string, desc: string) => {
    const show = (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ label, desc, top: r.top + r.height / 2 });
    };
    return { "aria-label": label, onMouseEnter: show, onFocus: (e: FocusEvent<HTMLElement>) => { if (e.currentTarget.matches(":focus-visible")) show(e); },
      onMouseLeave: () => setTip(null), onBlur: () => setTip(null), onMouseDown: () => setTip(null) };
  };
  const stageDot = (i: number) => current && (i < current.stage ? <span className="st done" /> : i === current.stage ? <span className="st cur" /> : null);
  const initials = (c: Case) => c.title.split(/\s+/).filter(w => /^[A-Za-z]/.test(w)).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "C";
  const search = (e: FormEvent) => {
    e.preventDefault();
    const hit = (cases.data ?? []).find(c => (c.title + " " + c.description).toLowerCase().includes(q.trim().toLowerCase()));
    if (hit && q.trim()) { nav(`/cases/${hit.id}`); setQ(""); } else nav("/cases");
  };
  if (!user) return null;
  const llm = sys.data?.llm;
  const services: Partial<Record<ServiceName, ServiceCheck>> = sys.data?.services ?? {};

  return (
    <div className="v2">
      <header className="v2-top">
        <NavLink to="/" className="v2-brand" aria-label="Dashboard"><Logo /><span><b>M2 Swarm</b><small>Lattice</small></span></NavLink>
        <form className="v2-search" onSubmit={search} role="search">
          <Search /><input list="v2-cases" value={q} onChange={e => setQ(e.target.value)} placeholder={`Search cases in ${wsName}…`} aria-label="Search cases" />
          <datalist id="v2-cases">{(cases.data ?? []).map(c => <option key={c.id} value={c.title} />)}</datalist>
        </form>
        <div className="v2-top-r">
          {llm && <span className="v2-engine" title={llm.url}><i className={llm.available ? "ok" : "bad"} />{llm.provider === "none" ? "No LLM (templates)" : `${llm.provider} · ${llm.model}`}{llm.available ? " · local" : " · offline"}</span>}
          <button className="v2-ibtn" onClick={() => applyTheme(theme === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>{theme === "dark" ? <Sun /> : <Moon />}</button>
          <NavLink to="/account" className="v2-me" aria-label={`My account · ${user.name}`}><Avatar name={user.name} size={32} /></NavLink>
          <button className="v2-ibtn" onClick={logout} aria-label="Sign out" title="Sign out"><LogOut /></button>
        </div>
      </header>

      <nav className="v2-rail" aria-label="Primary">
        <div className="rl-g">
          <NavLink to="/" end className="rl-i" {...tipFor("Dashboard", "Workspace overview: metrics, recent cases, sentiment and activity")}><LayoutDashboard /></NavLink>
          <NavLink to="/cases" end className="rl-i" {...tipFor("Cases", "All cases. Open one to unlock its stage menus.")}><Folder /></NavLink>
        </div>
        {caseId && <div className="rl-g">
          <NavLink to={`/cases/${caseId}`} end className="rl-case" {...tipFor(current?.title ?? "Case", "Case overview: stages, reaction growth and sentiment")}>{current ? initials(current) : "…"}</NavLink>
          <NavLink to={caseLink("documents")} className="rl-i" {...tipFor("Documents", "Stage 1 · Upload sources and read them with highlighted evidence")}><BookOpen /></NavLink>
          <NavLink to={caseLink("graph")} className="rl-i" {...tipFor("Graph explorer", "Stage 1 · Explore the knowledge graph and ask the graph")}><Share2 />{stageDot(0)}</NavLink>
          <NavLink to={caseLink("review")} className="rl-i" {...tipFor("Review queue", "Stage 1 · Approve, reject, edit and merge extracted claims")}><Inbox /></NavLink>
          <NavLink to={caseLink("reactions")} className="rl-i" {...tipFor("Reactions", "Hypotheses about how actors might respond, for review")}><Lightbulb /></NavLink>
          <NavLink to={caseLink("dynamic")} className="rl-i" {...tipFor("Dynamic graph", "Research, reaction and simulation layers with snapshots and a timeline")}><GitBranch /></NavLink>
          <NavLink to={caseLink("environments")} className="rl-i" {...tipFor("Environment · personas", "Stage 2 · Graph actors and synthetic personas, behaviour and network")}><Layers />{stageDot(1)}</NavLink>
          <NavLink to={caseLink("simulations")} className="rl-i" {...tipFor("Simulations", "Stage 3 · Run the simulation, comment and trigger reactions")}><Play />{stageDot(2)}</NavLink>
          <NavLink to={caseLink("reports")} className="rl-i" {...tipFor("Reports", "Stage 4 · Findings with source evidence; edit, approve, export")}><FileText />{stageDot(3)}</NavLink>
          <NavLink to={caseLink("interaction")} className="rl-i" {...tipFor("Interaction", "Stage 5 · Chat with the report agent, a persona or the graph")}><MessageSquare />{stageDot(4)}</NavLink>
          <button className="rl-i" onClick={() => { store("case", null); nav("/cases"); }} {...tipFor("Close case", "Back to all cases")}><X /></button>
        </div>}
        <div className="rl-foot">
          {can("admin.access") && <NavLink to="/admin" className="rl-i" {...tipFor("Administration", "Users, roles, workspace and audit")}><Shield /></NavLink>}
          <NavLink to="/settings" className="rl-i" {...tipFor("Settings", can("admin.access") ? "Appearance and environment files (.env)" : "Appearance")}><Settings /></NavLink>
        </div>
      </nav>
      {tip && <div className="rail-tip" role="tooltip" style={{ top: tip.top }}><b>{tip.label}</b><span>{tip.desc}</span></div>}

      {caseId && <div className="v2-casebar">
        <div className="cb-title"><div className="cb-crumb"><NavLink to="/cases">Cases</NavLink><span>/</span><span className="cid">{caseId.slice(0, 8)}</span></div>
          <div className="cb-name"><span className="trunc">{current?.title ?? "Loading…"}</span>{current && <span className="v2-pill">{current.status}</span>}</div></div>
        <div className="mini-step">{STAGES.map((s, i) => {
          const st = current ? (i < current.stage ? "done" : i === current.stage ? "cur" : "") : "";
          return <span key={s} className="row" style={{ gap: 4 }}>{i > 0 && <span className="ms-line" />}
            <NavLink to={caseLink(STAGE_ROUTES[i])} className={`ms ${st} ${activeStage === i ? "on" : ""}`}><b>{st === "done" ? "✓" : i + 1}</b>{s}</NavLink></span>;
        })}</div>
      </div>}

      <main className="view v2-main" id="view" tabIndex={-1}><Outlet /></main>

      <footer className="v2-foot">
        {(["database", "graph", "jobs", "embeddings", "llm"] as const).map(k => services[k] && <span key={k}><i className={services[k]!.ok ? "ok" : "bad"} />{k === "graph" ? "Neo4j" : k === "database" ? "Postgres" : k === "jobs" ? "Jobs" : k === "embeddings" ? "Embeddings" : "LLM"}</span>)}
        {sys.data && <span>Extractor: {sys.data.extractor} · Embedder: {sys.data.embedder}</span>}
        <span className="grow" /><span>All models run locally · simulated outcomes are not forecasts</span>
      </footer>
      <Assistant caseId={caseId} caseTitle={current?.title} versionId={current?.current_version_id ?? null} />
    </div>
  );
}
