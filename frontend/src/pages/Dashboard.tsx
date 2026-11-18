import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight, Cpu, Folder, GitBranch, Inbox, Layers, Plus, Share2 } from "lucide-react";
import { api, type AuditItem, type Case } from "../api";
import { useAuth } from "../auth";
import { Donut, TONE, buildSteps, pct, sumTone, useSimInsight, type Tone } from "../components/Charts";
import { useSystem } from "../hooks";
import { STAGES, ago } from "../vocab";

interface Summary {
  total_cases: number; archived: number; active_cases: number; documents_uploaded: number; documents_parsed: number;
  entities: number; relationships: number; pending_reviews: number; approved_versions: number; running_jobs: number;
}

export const StageDots = ({ stage }: { stage: number }) => (
  <div className="dots5" title={`${Math.min(stage, 5)} of 5 stages complete`}>{STAGES.map((s, i) => <i key={s} className={i < stage ? "d" : i === stage ? "c" : ""} />)}</div>
);

function SentimentMini({ cases }: { cases: Case[] }) {
  const pick = [...cases].filter(c => c.stage >= 3 && c.status !== "Archived").sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  const ins = useSimInsight(pick?.id ?? null);
  const steps = ins.sim ? buildSteps(ins.sim, ins.events, "round") : [];
  const c = sumTone(steps);
  return <section className="panel"><div className="panel-h"><h3 className="grow">Reaction sentiment</h3>{pick && <span className="xs dim trunc" style={{ maxWidth: 160 }}>{pick.title}</span>}</div>
    {!pick || !ins.sim ? <p className="panel-b small muted">{ins.loading && pick ? "Loading…" : "Appears once a case has a finished simulation."}</p> :
    <div className="panel-b row" style={{ gap: 16, alignItems: "center" }}><Donut c={c} size={118} />
      <div className="col grow" style={{ gap: 8 }}>{(["pos", "neu", "neg"] as Tone[]).map(k => <div key={k}>
        <div className="row xs" style={{ justifyContent: "space-between" }}><span className="row" style={{ gap: 6 }}><i className="ldot" style={{ background: TONE[k][1] }} />{TONE[k][0]}</span><b className="mono">{pct(c, k)}%</b></div>
        <div className="v2-bar"><i style={{ width: `${pct(c, k)}%`, background: TONE[k][1] }} /></div></div>)}
        <Link className="btn sm ghost" style={{ alignSelf: "flex-start", paddingLeft: 0 }} to={`/cases/${pick.id}`}>Open case <ArrowRight /></Link></div></div>}
  </section>;
}

export default function Dashboard() {
  const { user, can } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const sum = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Summary>("/dashboard") });
  const cases = useQuery({ queryKey: ["cases"], queryFn: () => api.get<Case[]>("/cases") });
  const activity = useQuery({ queryKey: ["audit"], queryFn: () => api.get<AuditItem[]>("/audit?limit=8") });
  const sys = useSystem();
  const s = sum.data;
  const all = cases.data ?? [];
  const live = all.filter(c => c.status !== "Archived").filter(c => !q || (c.title + c.description + c.owner_name).toLowerCase().includes(q.toLowerCase()));
  const hr = new Date().getHours();
  const kpis: [typeof Folder, string, number | undefined, string][] = [
    [Folder, "Active cases", s?.active_cases, s ? `${s.total_cases} total · ${s.archived} archived` : ""],
    [Share2, "Graph entities", s?.entities, s ? `${s.relationships.toLocaleString()} relationships` : ""],
    [GitBranch, "Approved versions", s?.approved_versions, ""],
    [Inbox, "Pending reviews", s?.pending_reviews, s?.pending_reviews ? "needs attention" : "all clear"],
    [Activity, "Running jobs", s?.running_jobs, s ? `${s.documents_parsed}/${s.documents_uploaded} sources parsed` : ""],
  ];
  const svc = sys.data?.services;

  return <div className="page">
    <div className="page-head"><div className="grow"><div className="v2-eyebrow">Case intelligence workspace</div>
      <h1>{hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening"}, {user!.name.split(" ")[0]}</h1>
      <p>Every model runs on this machine; nothing is sent to a hosted AI service.</p></div>
      <Link className="btn" to="/cases"><Folder />All cases</Link>
      {can("case.create") && <Link className="btn pri" to="/cases/new"><Plus />New case</Link>}</div>

    <div className="kstrip">{kpis.map(([Icon, l, v, d]) => <div className="kseg" key={l}><span className="kic"><Icon /></span>
      <div><small>{l}</small><b>{v?.toLocaleString() ?? "—"}</b>{d && <span className="dl">{d}</span>}</div></div>)}</div>

    <div className="v2-grid">
      <div className="col gap16" style={{ minWidth: 0 }}>
        {can("case.create") && all.length < 3 && <section className="panel v2-cta"><div className="panel-b">
          <div className="v2-eyebrow">Try the full pipeline</div><h3>Start a case from seed documents</h3>
          <p>Drop sources, write the simulation question and watch it go from graph to personas, simulation, report and conversation.</p>
          <button className="btn pri" onClick={() => nav("/cases/new")}><Plus />Create case</button></div></section>}
        <section className="panel"><div className="panel-h"><h3 className="grow">Recent cases</h3>
          <input className="inp" style={{ maxWidth: 220, height: 30 }} placeholder="Filter cases" value={q} onChange={e => setQ(e.target.value)} aria-label="Filter cases" /></div>
          {live.length ? live.slice(0, 8).map(c => <Link key={c.id} to={`/cases/${c.id}`} className="list-i"><span className="kic sm"><Layers /></span>
            <div className="grow" style={{ minWidth: 0 }}><b className="trunc">{c.title}</b><small>{c.owner_name} · {c.document_count} sources · updated {ago(c.updated_at)}</small></div>
            <StageDots stage={c.stage} /><span className="v2-pill">{c.stage >= 5 ? "Complete" : STAGES[c.stage] ?? c.status}</span></Link>)
            : <p className="panel-b small muted">{cases.isLoading ? "Loading…" : "No cases yet."}</p>}
        </section>
      </div>
      <div className="col gap16">
        <SentimentMini cases={all} />
        <section className="panel"><div className="panel-h"><h3 className="grow"><Cpu size={15} /> Local engine</h3>
          {sys.data && <span className={`badge ${sys.data.llm.available ? "b-ok" : "b-warn"}`}><i />{sys.data.llm.available ? "Healthy" : "LLM offline"}</span>}</div>
          <div className="panel-b col" style={{ gap: 10 }}>
            {sys.data ? <>
              <div className="row small" style={{ justifyContent: "space-between" }}><span>LLM</span><span className="mono">{sys.data.llm.provider} · {sys.data.llm.model}</span></div>
              <div className="row small" style={{ justifyContent: "space-between" }}><span>Extraction</span><span className="mono">{sys.data.extractor}</span></div>
              <div className="row small" style={{ justifyContent: "space-between" }}><span>Embeddings</span><span className="mono">{sys.data.embedder}</span></div>
              <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>{svc && Object.entries(svc).map(([k, v]) => <span key={k} className={`badge ${v.ok ? "b-ok" : "b-err"}`}><i />{k}</span>)}</div>
              {can("admin.access") && <Link className="btn sm ghost" style={{ alignSelf: "flex-start", paddingLeft: 0 }} to="/settings">Change models in Settings <ArrowRight /></Link>}
            </> : <span className="small muted">Checking services…</span>}</div></section>
        <section className="panel"><div className="panel-h"><h3 className="grow">Activity</h3></div><div className="panel-b" style={{ paddingTop: 6 }}>
          <ul className="timeline">{(activity.data ?? []).map(a => <li key={a.id}><span className="tl-ic"><Activity /></span><div>
            <div className="small"><b style={{ fontWeight: 600 }}>{a.actor}</b> <span className="muted">{a.action.replaceAll(".", " ")}</span></div>
            <div className="small trunc">{a.target}</div><div className="xs dim">{ago(a.at)}</div></div></li>)}</ul></div></section>
      </div>
    </div>
  </div>;
}
