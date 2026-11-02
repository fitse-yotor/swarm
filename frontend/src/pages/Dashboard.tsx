import { useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, Plus, Share2, Upload } from "lucide-react";
import { api, type AuditItem, type Case } from "../api";
import { useAuth } from "../auth";
import { STAGES, ago } from "../vocab";
import { CaseTable } from "./Cases";

interface Summary {
  total_cases: number; archived: number; active_cases: number; documents_uploaded: number; documents_parsed: number;
  entities: number; relationships: number; pending_reviews: number; approved_versions: number; running_jobs: number;
}

export default function Dashboard() {
  const { user, can } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const sum = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Summary>("/dashboard") });
  const cases = useQuery({ queryKey: ["cases"], queryFn: () => api.get<Case[]>("/cases") });
  const activity = useQuery({ queryKey: ["audit"], queryFn: () => api.get<AuditItem[]>("/audit?limit=9") });
  const s = sum.data;
  const live = (cases.data ?? []).filter(c => c.status !== "Archived");
  const hr = new Date().getHours();
  const metrics: [number | undefined, string, string][] = s ? [
    [s.total_cases, "Total cases", `${s.archived} archived`], [s.active_cases, "Active cases", ""],
    [s.documents_parsed, "Documents processed", `${s.documents_uploaded} uploaded`], [s.entities, "Graph entities", "current versions"],
    [s.relationships, "Relationships", ""], [s.pending_reviews, "Pending graph reviews", s.pending_reviews ? "needs attention" : "clear"],
    [s.approved_versions, "Approved graph versions", ""], [s.running_jobs, "Running builds", ""],
  ] : [];

  return <div className="page">
    <div className="page-head"><div className="grow"><h1>{hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening"}, {user!.name.split(" ")[0]}</h1>
      <p>{s ? (s.pending_reviews ? `${s.pending_reviews} graph claims are waiting for review across your cases.` : "All graph claims are reviewed.") : "Loading workspace…"}</p></div>
      {can("case.create") && <Link className="btn pri" to="/cases/new"><Plus />Create case</Link>}</div>
    <div className="strip" role="list" style={{ "--cols": metrics.length || 8 } as CSSProperties}>
      {metrics.map(([v, l, d]) => <div role="listitem" key={l}><div className="v">{v?.toLocaleString()}</div><div className="l">{l}</div>{d && <div className="d">{d}</div>}</div>)}</div>
    <div className="dash">
      <div className="col gap16" style={{ minWidth: 0 }}>
        <section className="panel"><div className="panel-h"><h3 className="grow">Workflow progress</h3><span className="xs dim">Five stages per case</span></div>
          <div className="stages"><div className="hd">Case</div>{STAGES.map((x, i) => <div className="hd" key={x}>{i + 1}. {x}</div>)}
            {live.map(c => <div key={c.id} style={{ display: "contents" }}>
              <div className="cn"><Link to={`/cases/${c.id}`} className="trunc" style={{ color: "var(--tx)", fontWeight: 500 }}>{c.title}</Link></div>
              {STAGES.map((x, i) => <div key={x} className={`st ${i < c.stage ? "done" : i === c.stage ? "cur" : ""}`} title={`${x}: ${i < c.stage ? "complete" : i === c.stage ? "in progress" : "not started"}`}><div className="stbar"><i /></div></div>)}
            </div>)}</div></section>
        <section className="panel"><div className="panel-h"><h3 className="grow">Recent cases</h3><input className="inp" style={{ maxWidth: 220, height: 30 }} placeholder="Filter cases" value={q} onChange={e => setQ(e.target.value)} aria-label="Filter cases" /></div>
          <div style={{ overflowX: "auto" }}><CaseTable compact list={(cases.data ?? []).filter(c => !q || (c.title + c.description + c.owner_name).toLowerCase().includes(q.toLowerCase()))} /></div></section>
      </div>
      <div className="col gap16">
        <section className="panel"><div className="panel-h"><h3>Quick actions</h3></div><div className="panel-b qa">
          <button disabled={!can("case.create")} onClick={() => nav("/cases/new")}><Plus /><b className="small">Create case</b><span className="xs dim">Start from sources</span></button>
          <button onClick={() => nav(live[0] ? `/cases/${live[0].id}/documents` : "/cases")}><Upload /><b className="small">Upload sources</b><span className="xs dim">Add to a case</span></button>
          <button onClick={() => nav(live[0] ? `/cases/${live[0].id}/graph` : "/cases")}><Share2 /><b className="small">Open graph</b><span className="xs dim">Explore and review</span></button>
          <button onClick={() => nav("/cases")}><Activity /><b className="small">All cases</b><span className="xs dim">{cases.data?.length ?? 0} cases</span></button></div></section>
        <section className="panel"><div className="panel-h"><h3 className="grow">Recent activity</h3></div><div className="panel-b" style={{ paddingTop: 6 }}>
          <ul className="timeline">{(activity.data ?? []).map(a => <li key={a.id}><span className="tl-ic"><Activity /></span><div>
            <div className="small"><b style={{ fontWeight: 600 }}>{a.actor}</b> <span className="muted">{a.action.replaceAll(".", " ")}</span></div>
            <div className="small trunc">{a.target}</div><div className="xs dim">{ago(a.at)}</div></div></li>)}</ul></div></section>
      </div>
    </div>
  </div>;
}
