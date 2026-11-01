import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Heart, MessageCircle, Network, Play, Repeat2, Square, Trash2, Zap } from "lucide-react";
import { api, type Report, type SimEvent, type Simulation } from "../api";
import { useAuth } from "../auth";
import { Empty, useToast } from "../components/ui";
import { LineChart, StageLayout, StepCard, Stats, SysLog, stanceColor } from "../components/Stage";
import { useEnvs, useJob, useSims } from "../hooks";
import { ago } from "../vocab";
import { useCase } from "./CaseDetail";
import { ReactionPane, TriggerCard, type Scope } from "./sim/Reactions";

const PLATFORM: Record<string, string> = { microblog: "Microblog", forum: "Forum" };

export function useSim(simId: string) {
  return useQuery({ queryKey: ["sim", simId], enabled: !!simId, queryFn: () => api.get<Simulation>(`/simulations/${simId}`),
    refetchInterval: q => (q.state.data && ["running", "queued"].includes(q.state.data.status) ? 2000 : false) });
}

export default function Simulations() {
  const { caseId = "", simId } = useParams();
  if (simId) return <SimulationView caseId={caseId} simId={simId} />;
  return <SimulationList caseId={caseId} />;
}

function SimulationList({ caseId }: { caseId: string }) {
  const sims = useSims(caseId);
  const envs = useEnvs(caseId);
  const ready = (envs.data ?? []).filter(e => e.status === "ready" || e.status === "approved");
  return <div className="page">
    <div className="page-head"><div className="grow"><h1>Simulation runs</h1>
      <p>Each run plays an environment forward round by round on two simulated platforms. Runs are seeded, so the same environment and settings reproduce exactly.</p></div></div>
    {sims.data && !sims.data.length && <Empty icon={<Play />} title="No runs yet" text={ready.length ? "Open a ready environment and start a simulation from its Approve & Launch card." : "Create an environment first."}>
      <Link className="btn pri" to={ready.length ? `/cases/${caseId}/environments/${ready[0].id}` : `/cases/${caseId}/environments?new=1`}>{ready.length ? "Open environment" : "New environment"}</Link></Empty>}
    <div className="col">{(sims.data ?? []).map(s => <Link key={s.id} className="listrow" to={`/cases/${caseId}/simulations/${s.id}`}>
      <Play size={18} color="var(--ok)" /><div className="grow"><b>{s.name}</b><div className="xs dim">{s.environment_name} · {s.agent_count} agents · {s.platforms.join(" + ")}</div></div>
      <span className="xs dim">round {s.rounds_done ? s.rounds_done - 1 : 0}/{s.rounds_total} · {s.report_count} report(s)</span>
      <span className={`badge ${s.status === "done" ? "b-ok" : s.status === "failed" ? "b-err" : s.status === "cancelled" ? "" : "b-warn"}`}><i />{s.status}</span>
      <span className="xs dim">{ago(s.created_at)}</span></Link>)}</div>
  </div>;
}

function SimulationView({ caseId, simId }: { caseId: string; simId: string }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const c = useCase(caseId);
  const sim = useSim(simId);
  const s = sim.data;
  const job = useJob(s?.job_id);
  const running = !!s && ["running", "queued"].includes(s.status);
  const events = useQuery({ queryKey: ["simEvents", simId], enabled: !!s, queryFn: () => api.get<SimEvent[]>(`/simulations/${simId}/events?originals=true&limit=400`),
    refetchInterval: running ? 2500 : false });
  const reports = useQuery({ queryKey: ["reports", caseId], queryFn: () => api.get<Report[]>(`/cases/${caseId}/reports`) });
  const [platformOnly, setPlatformOnly] = useState<string | null>(null);
  const [leftView, setLeftView] = useState<"feed" | "graph">(() => (new URLSearchParams(window.location.search).get("view") === "graph" ? "graph" : "feed"));
  const [scope, setScope] = useState<Scope>({ kind: "agents" });
  const [preset, setPreset] = useState<{ target?: string; tick: number }>({ tick: 0 });
  useEffect(() => { if (job.data?.status === "done") { qc.invalidateQueries({ queryKey: ["sim", simId] }); qc.invalidateQueries({ queryKey: ["simEvents", simId] }); } }, [job.data?.status, qc, simId]);

  const byId = useMemo(() => Object.fromEntries((events.data ?? []).map(e => [e.id, e])), [events.data]);
  const agents = useMemo(() => Object.fromEntries((s?.agents ?? []).map(a => [a.id, a])), [s?.agents]);
  if (sim.isError) return <div className="page muted">{(sim.error as Error).message}</div>;
  if (!s) return <div className="center-fill">Loading simulation…</div>;
  const rounds = s.rounds ?? [];
  const last = rounds[rounds.length - 1];
  const st = s.stats && "engine" in s.stats ? s.stats : undefined;  // empty until the run finishes
  const j = job.data ?? s.job ?? null;
  const myReports = (reports.data ?? []).filter(r => r.simulation_id === s.id);
  const status = running ? { label: `Round ${Math.max(rounds.length - 1, 0)}/${s.rounds_total}`, tone: "run" as const }
    : s.status === "done" ? { label: "Completed", tone: "ok" as const } : { label: s.status === "cancelled" ? "Cancelled" : "Failed", tone: "err" as const };
  const sum = (k: string) => rounds.reduce((n, r) => n + (r.actions[k] ?? 0), 0);

  const feed = (platform: string) => (events.data ?? []).filter(e => e.platform === platform);
  const feedView = <div className="feed" style={platformOnly ? { gridTemplateColumns: "1fr" } : undefined}>
    {s.platforms.filter(p => !platformOnly || p === platformOnly).map(p => <div key={p} className="feed-col">
      <div className="feed-h"><span style={{ color: p === "microblog" ? "var(--person)" : "var(--organization)" }}>●</span>{PLATFORM[p] ?? p}
        <button className="btn ghost sm" onClick={() => setPlatformOnly(platformOnly ? null : p)}>{platformOnly ? "Show both" : "Only this"}</button>
        <span className="n">{feed(p).length} posts</span></div>
      <div className="feed-b">{feed(p).map(e => { const a = agents[e.agent_id]; const tgt = e.target_id ? byId[e.target_id] : null;
        return <article key={e.id} className="post" style={{ borderLeftColor: e.agent_id === "src" ? "var(--warn)" : stanceColor(e.stance) }}>
          <div className="ph"><b>{e.agent_name}</b>{a?.synthetic && <span className="syn-badge" title="Fictional persona — not a real person">SYNTHETIC</span>}{a && <span className="h">{a.handle}</span>}
            {e.action === "REPOST" && <span className="xs dim"><Repeat2 size={11} /> reposted</span>}{e.action === "CREATE_COMMENT" && <span className="xs dim">replied</span>}
            <span className="r">R{e.round}</span></div>
          {tgt && e.action === "CREATE_COMMENT" && <div className="reply-to">↳ {tgt.agent_name}: {tgt.content}</div>}
          <div className="pc">{e.content}</div>
          <div className="pa"><span><Heart />{e.likes}</span><span><Repeat2 />{e.reposts}</span><span><MessageCircle />{e.replies}</span>
            <span style={{ marginLeft: "auto" }} className={`gen ${e.generated_by.startsWith("ollama") ? "llm" : ""}`}>{e.generated_by}</span></div>
          <div className="pa" style={{ marginTop: 6 }}>
            <button className="btn ghost sm" title="Show the reactions to this post as a 3D graph" onClick={() => { setScope({ kind: "post", id: e.id }); setLeftView("graph"); }}><Network />Reactions</button>
            {s.status === "done" && can("sim.run") && <button className="btn ghost sm" title="Make a persona react to this post" onClick={() => { setPreset(x => ({ target: e.id, tick: x.tick + 1 })); document.getElementById("trigger")?.scrollIntoView({ behavior: "smooth", block: "center" }); }}><Zap />React…</button>}</div>
        </article>; })}
        {!feed(p).length && <p className="small muted" style={{ padding: 12 }}>{running ? "Waiting for the first posts…" : "No posts on this platform."}</p>}</div>
    </div>)}
  </div>;

  const left = <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
    <div className="react-bar"><div className="viewseg" role="group" aria-label="Left pane">
      <button className={leftView === "feed" ? "on" : ""} aria-pressed={leftView === "feed"} onClick={() => setLeftView("feed")}>Feed</button>
      <button className={leftView === "graph" ? "on" : ""} aria-pressed={leftView === "graph"} onClick={() => setLeftView("graph")}>Reaction graph · 3D</button></div>
      <span className="xs dim">{leftView === "feed" ? "Posts, comments and reposts as they happened" : "Who reacted to whom"}</span></div>
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}>{leftView === "feed" ? feedView
      : <ReactionPane simId={s.id} scope={scope} setScope={setScope} agents={s.agents ?? []} posts={events.data ?? []} />}</div></div>;

  const cards = <div className="st-cards">
    <StepCard n={1} title="Initialize Agents" state="done" endpoint={`POST /api/v1/environments/${s.environment_id}/simulations`}
      desc={<>Engine <b className="mono">{s.engine || "lattice-abm/1"}</b> · {s.agent_count} agents from <Link to={`/cases/${caseId}/environments/${s.environment_id}`}>{s.environment_name}</Link> · seed {s.config?.seed}</>}>
      {s.scenario && <><div className="cs-label">Scenario</div><p className="small">{s.scenario} <span className="dim">(injected at round {s.config?.inject_round})</span></p></>}
    </StepCard>
    <StepCard n={2} title="Run Simulation Rounds" state={running ? "run" : s.status === "done" ? "done" : "fail"} badge={running ? `${j?.progress ?? 0}%` : undefined}
      endpoint={`GET /api/v1/simulations/${s.id}/events`} desc={`Round = ${s.config?.minutes_per_round ?? 60} simulated minutes. Agents read their feed, act, and update their stance.`}>
      <div className="prog mt12"><i style={{ width: `${((rounds.length) / (s.rounds_total + 1)) * 100}%` }} /></div>
      <Stats items={[[sum("CREATE_POST"), "Posts"], [sum("CREATE_COMMENT"), "Comments"], [sum("LIKE_POST") + sum("REPOST"), "Likes + reposts"], [st?.llm_posts ?? "…", "LLM-written"]]} />
      {running && can("sim.run") && j && <div className="cs-actions"><button className="btn sm" onClick={() => api.post(`/jobs/${j.id}/cancel`).then(() => qc.invalidateQueries()).catch(e => toast(e.message, "err"))}><Square />Stop run</button></div>}
    </StepCard>
    <StepCard n={3} title="Opinion Dynamics" state={rounds.length ? (running ? "run" : "done") : "wait"} badge={last ? `mean ${last.mean_stance >= 0 ? "+" : ""}${last.mean_stance.toFixed(2)}` : undefined}
      desc={<>Stance toward <b>{st?.focus ?? s.config?.focus_name ?? "the focus issue"}</b>, from −1 (opposes) to +1 (supports).</>}>
      {rounds.length > 1 ? <>
        <div className="cs-label">Share of agents supporting vs opposing</div>
        <LineChart ariaLabel="Share of agents supporting and opposing per round" min={0} max={1} ticks={[0, 0.5, 1]}
          series={[{ label: "Support", color: "var(--sup)", values: rounds.map(r => r.support), fmt: v => `${Math.round(v * 100)}%` },
            { label: "Oppose", color: "var(--opp)", values: rounds.map(r => r.oppose), fmt: v => `${Math.round(v * 100)}%` }]} />
        <div className="cs-label">Mean stance</div>
        <LineChart ariaLabel="Mean stance per round" min={-1} max={1} ticks={[-1, 0, 1]} height={120}
          series={[{ label: "Mean stance", color: "var(--acc)", values: rounds.map(r => r.mean_stance), fmt: v => (v >= 0 ? "+" : "") + v.toFixed(2) }]} />
        <details className="mt8"><summary className="xs dim" style={{ cursor: "pointer" }}>Table view</summary>
          <table className="tbl mt8"><thead><tr><th>Round</th><th>Active</th><th>Mean</th><th>Polarization</th><th>Support</th><th>Oppose</th></tr></thead>
            <tbody>{rounds.map(r => <tr key={r.round}><td>{r.round}</td><td>{r.active}</td><td>{r.mean_stance.toFixed(2)}</td><td>{r.polarization.toFixed(2)}</td><td>{Math.round(r.support * 100)}%</td><td>{Math.round(r.oppose * 100)}%</td></tr>)}</tbody></table></details>
      </> : <p className="xs dim mt8">Charts appear after the first rounds.</p>}
    </StepCard>
    {st && <StepCard n={4} title="Coalitions & Movers" state="done" desc={`Polarization ${st.polarization_start.toFixed(2)} → ${st.polarization_end.toFixed(2)}.`}>
      {(["support", "neutral", "oppose"] as const).map(k => <div key={k}><div className="cs-label">{({ support: "Supporting", neutral: "Neutral", oppose: "Opposing" })[k]} ({st.coalitions[k].length})</div>
        <div className="chips">{st.coalitions[k].map(m => <span key={m.id} className="chip"><i style={{ background: stanceColor(m.stance) }} />{m.name} {m.stance >= 0 ? "+" : ""}{m.stance.toFixed(2)}</span>)}</div></div>)}
      <div className="cs-label">Largest shifts</div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{st.movers.slice(0, 5).map(m => <li key={m.id}>{m.name}: {m.from.toFixed(2)} → {m.to.toFixed(2)}</li>)}</ul>
    </StepCard>}
    {s.status === "done" && can("sim.run") && <TriggerCard n={5} simId={s.id} agents={s.agents ?? []} posts={events.data ?? []} preset={preset}
      onDone={r => { const e = r.events[0]; if (["CREATE_POST", "CREATE_COMMENT", "REPOST"].includes(e.action)) { setScope({ kind: "post", id: e.id }); setLeftView("graph"); } else if (e.target_id) { setScope({ kind: "post", id: e.target_id }); setLeftView("graph"); } }} />}
    <StepCard n={s.status === "done" && can("sim.run") ? 6 : 5} title="Simulation Complete" state={s.status === "done" ? "done" : "wait"} endpoint={`POST /api/v1/simulations/${s.id}/reports`}
      desc="Generate a report: findings are computed from the run; the local LLM writes the narrative sections.">
      <div className="cs-actions">
        {myReports.map(r => <Link key={r.id} className="btn sm" to={`/cases/${caseId}/reports/${r.id}`}>{r.title.replace(/^Report — /, "Open report: ")}</Link>)}
        {s.status === "done" && can("report.edit") && <button className="btn pri" onClick={() => api.post<Report>(`/simulations/${s.id}/reports`).then(r => { qc.invalidateQueries({ queryKey: ["reports", caseId] }); nav(`/cases/${caseId}/reports/${r.id}`); }).catch(e => toast(e.message, "err"))}>Generate Report<ArrowRight /></button>}
        {!running && can("sim.run") && <button className="btn danger sm" onClick={() => { if (confirm(`Delete ${s.name}?`)) api.del(`/simulations/${s.id}`).then(() => { qc.invalidateQueries({ queryKey: ["sims", caseId] }); nav(`/cases/${caseId}/simulations`); }).catch(e => toast(e.message, "err")); }}><Trash2 />Delete run</button>}
      </div>
    </StepCard>
  </div>;

  return <StageLayout step={3} caseId={caseId} status={status} leftLabel="Feed" caseStage={c.data?.stage ?? 0} left={left} plainLeft right={cards} log={<SysLog job={j} />}
    actions={<span className="small trunc"><b>{s.name}</b></span>} />;
}
