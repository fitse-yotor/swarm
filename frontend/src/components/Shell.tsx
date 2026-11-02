import { useEffect, useState, type FocusEvent, type MouseEvent } from "react";
import { NavLink, Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, FileText, Folder, Inbox, Layers, LayoutDashboard, LogOut, MessageSquare, Moon, Play, Share2, Shield,
  Sun } from "lucide-react";
import { api, type Case } from "../api";
import { useAuth } from "../auth";
import { applyTheme, useTheme, useWorkspace } from "../hooks";
import { load, store } from "../prefs";
import { Avatar } from "./ui";

export const Logo = () => (
  <svg className="brand-mark" viewBox="0 0 28 28" aria-hidden="true"><rect width="28" height="28" rx="6" fill="var(--acc)" />
    <g stroke="#fff" strokeWidth="1.6" fill="none"><path d="M8 19 14 8l6 11z" opacity=".55" /><path d="M8 19h12" /></g>
    <circle cx="14" cy="8" r="2.3" fill="#fff" /><circle cx="8" cy="19" r="2.3" fill="#fff" /><circle cx="20" cy="19" r="2.3" fill="#fff" /></svg>
);

export const useLastCase = () => {
  const m = useMatch("/cases/:caseId/*");
  const id = m?.params.caseId && m.params.caseId !== "new" ? m.params.caseId : null;
  useEffect(() => { if (id) store("case", id); }, [id]);
  return id ?? load<string | null>("case", null);
};

const TITLES: [RegExp, string][] = [[/\/graph$/, "Graph explorer"], [/\/review$/, "Review queue"], [/\/documents$/, "Documents"],
  [/\/build\//, "Graph build"], [/\/environments/, "Environments"], [/\/simulations/, "Simulations"], [/\/reports/, "Reports"],
  [/\/interaction/, "Conversations"], [/^\/cases\/new/, "Create case"], [/^\/cases\/[^/]+$/, "Case"], [/^\/cases$/, "Cases"], [/^\/$/, "Dashboard"], [/^\/admin/, "Administration"], [/^\/account/, "My account"]];

type Tip = { label: string; desc: string; top: number } | null;

export default function Shell() {
  const { user, can, logout } = useAuth();
  const theme = useTheme();
  const [tip, setTip] = useState<Tip>(null);
  const loc = useLocation();
  const nav = useNavigate();
  useLastCase();  // remembers the last case for deep links
  const routeCase = useMatch("/cases/:caseId/*");
  const caseId = routeCase?.params.caseId && routeCase.params.caseId !== "new" && routeCase.params.caseId !== "wizard" ? routeCase.params.caseId : null;
  const cases = useQuery({ queryKey: ["cases"], queryFn: () => api.get<Case[]>("/cases") });
  const ws = useWorkspace();
  const wsName = ws.data?.name ?? "Workspace";
  const current = cases.data?.find(c => c.id === caseId);
  const scoped = /^\/cases\/(?!new)[^/]+/.test(loc.pathname);

  useEffect(() => setTip(null), [loc.pathname]);

  const caseLink = (sub: string) => (caseId ? `/cases/${caseId}/${sub}` : "/cases");
  const title = TITLES.find(([re]) => re.test(loc.pathname))?.[1] ?? "";
  // Icon rail: the name and a one-line description appear in a hover / focus card beside the icon.
  const tipFor = (label: string, desc: string) => {
    const show = (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ label, desc, top: r.top + r.height / 2 });
    };
    // Focus shows the card only for keyboard focus; a mouse click focuses the button too and would bring a stale card back.
    return { "aria-label": label, onMouseEnter: show, onFocus: (e: FocusEvent<HTMLElement>) => { if (e.currentTarget.matches(":focus-visible")) show(e); }, onMouseLeave: () => setTip(null), onBlur: () => setTip(null),
      onMouseDown: () => setTip(null) };
  };
  const needCase = caseId ? "" : " Open a case first.";
  if (!user) return null;

  return (
    <div className="shell collapsed">
      <aside className="side rail" aria-label="Primary">
        <div className="brand" {...tipFor("Lattice", `Case intelligence · ${wsName}`)} tabIndex={0}><Logo /></div>
        <nav className="nav">
          <NavLink to="/" end {...tipFor("Dashboard", "Workspace overview: metrics, workflow progress and recent activity")}><LayoutDashboard /></NavLink>
          <NavLink to="/cases" end {...tipFor("Cases", "All cases: search, filter, archive and restore")}><Folder /></NavLink>
          {caseId && <>
          <hr />
          <NavLink to={caseLink("graph")} {...tipFor("Graph explorer", `Stage 1 · Explore the knowledge graph, inspect evidence and ask the graph.${needCase}`)}><Share2 /></NavLink>
          <NavLink to={caseLink("review")} {...tipFor("Review queue", `Stage 1 · Approve, reject, edit and merge extracted claims.${needCase}`)}><Inbox /></NavLink>
          <NavLink to={caseLink("documents")} {...tipFor("Documents", `Stage 1 · Upload sources and read them with highlighted evidence.${needCase}`)}><BookOpen /></NavLink>
          <hr />
          <NavLink to={caseLink("environments")} {...tipFor("Environments", `Stage 2 · Turn graph actors into agents and edit their network.${needCase}`)}><Layers /></NavLink>
          <NavLink to={caseLink("simulations")} {...tipFor("Simulations", `Stage 3 · Run the two-platform simulation and watch opinions shift.${needCase}`)}><Play /></NavLink>
          <NavLink to={caseLink("reports")} {...tipFor("Reports", `Stage 4 · Findings from a run with source evidence; edit, approve, export.${needCase}`)}><FileText /></NavLink>
          <NavLink to={caseLink("interaction")} {...tipFor("Conversations", `Stage 5 · Chat with the report agent, a simulated agent or the graph.${needCase}`)}><MessageSquare /></NavLink></>}
          {can("admin.access") && <><hr /><NavLink to="/admin" {...tipFor("Administration", "Users, roles and workspace settings")}><Shield /></NavLink></>}
        </nav>
        <div className="side-foot">
          <button className="btn ghost icon sm" onClick={() => applyTheme(theme === "dark" ? "light" : "dark")} {...tipFor("Theme", `Switch to ${theme === "dark" ? "light" : "dark"} mode`)}>{theme === "dark" ? <Sun /> : <Moon />}</button>
          <button className="btn ghost icon sm" onClick={logout} {...tipFor("Sign out", `Signed in as ${user.name}`)}><LogOut /></button>
          <NavLink to="/account" className="me" {...tipFor(user.name, `${user.role} · ${user.email} · My account`)}><Avatar name={user.name} /></NavLink>
        </div>
      </aside>
      {tip && <div className="rail-tip" role="tooltip" style={{ top: tip.top }}><b>{tip.label}</b><span>{tip.desc}</span></div>}
      <div className="main">
        <header className="top">
          <NavLink to="/" className="top-brand" aria-label="Dashboard"><Logo /></NavLink>
          <div className="crumbs"><NavLink to="/" className="muted">{wsName}</NavLink>
            {scoped && current && <><span className="sep">/</span>
              <select className="sel" aria-label="Current case" value={current.id}
                style={{ height: 28, width: "auto", maxWidth: 260, borderColor: "transparent", background: "transparent", fontWeight: 600, paddingLeft: 4 }}
                onChange={e => nav(loc.pathname.replace(`/cases/${current.id}`, `/cases/${e.target.value}`).replace(/\/build\/.*/, "")
                  .replace(/\/(environments|simulations|reports|interaction)\/.*/, "/$1"))}>
                {cases.data!.filter(c => c.status !== "Archived" || c.id === current.id).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select></>}
            <span className="sep">/</span><b>{title}</b></div>
          <span className="grow" />
          <NavLink to="/account" className="top-me" aria-label={`My account · ${user.name}`}><Avatar name={user.name} size={30} /></NavLink>
        </header>
        <main className="view" id="view" tabIndex={-1}><Outlet /></main>
      </div>
    </div>
  );
}
