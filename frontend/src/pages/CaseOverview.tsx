import { Link } from "react-router-dom";
import { FileText, Layers, MessageSquare, Play, Share2, Zap } from "lucide-react";
import type { Case } from "../api";
import { BucketSeg, Donut, GrowthChart, GrowthTitle, TONE, ToneBars, ToneTitle, buildSteps, pct, sumTone, useBucket, useSimInsight, type Tone } from "../components/Charts";
import { STAGE_ROUTES } from "../components/Shell";
import { STAGES, fmtDate } from "../vocab";

const STAGE_INFO: [typeof Share2, string][] = [[Share2, "Upload → extract → resolve → verify → approve"], [Layers, "Graph actors and synthetic personas"],
  [Play, "Agents post, reply and shift stance"], [FileText, "Findings computed from the run"], [MessageSquare, "Chat with the report agent or a persona"]];

export default function CaseOverview({ caseId, k }: { caseId: string; k: Case }) {
  const ins = useSimInsight(caseId);
  const [bucket, setBucket] = useBucket();
  const steps = ins.sim ? buildSteps(ins.sim, ins.events, bucket) : [];
  const c = sumTone(steps);
  const totals = steps.reduce((a, s) => a + s.posts + s.replies + s.reactions + s.trig, 0);
  const trig = steps.reduce((a, s) => a + s.trig, 0);
  const last = steps[steps.length - 1];
  const agents = ins.sim?.agent_count ?? 0;
  const ps = [...(ins.sim?.agents ?? [])].filter(a => a.speaks !== false).sort((a, b) => b.stance - a.stance);

  return <div className="col gap16">
    <div className="v2-stages">{STAGES.map((s, i) => { const [Icon, d] = STAGE_INFO[i]; const st = i < k.stage ? "done" : i === k.stage ? "cur" : "";
      return <Link key={s} to={`/cases/${caseId}/${STAGE_ROUTES[i]}`} className={`v2-stage ${st}`}>
        <div className="row" style={{ justifyContent: "space-between" }}><span className="n">{st === "done" ? "✓" : i + 1}</span>
          {st === "done" ? <span className="badge b-ok"><i />Done</span> : st === "cur" ? <span className="badge b-acc"><i />Next</span> : <Icon className="dim" size={16} />}</div>
        <h4>{s}</h4><p>{d}</p></Link>; })}</div>

    {ins.sims.length > 0 && <div className="row" style={{ gap: 10 }}>
      <span className="small muted">Simulation</span>
      <select className="sel" style={{ width: "auto", maxWidth: 360 }} value={ins.simId ?? ""} onChange={e => ins.setPick(e.target.value)} aria-label="Simulation run">
        {ins.sims.map(s => <option key={s.id} value={s.id}>{s.name} · {s.environment_name} · {fmtDate(s.created_at)}</option>)}</select>
      {ins.sim && <span className="xs dim">{ins.sim.rounds_total} rounds × {ins.sim.config?.minutes_per_round ?? 60} min · {agents} agents{ins.truncated ? " · tone and engagement use the latest 1000 events" : ""}</span>}
      <span className="grow" /><BucketSeg value={bucket} onChange={setBucket} /></div>}

    {!ins.sim ? <section className="panel"><div className="panel-b empty-in">
      <h3>{ins.loading ? "Loading the latest run…" : "No finished simulation yet"}</h3>
      <p className="small muted">Reaction growth and positive / neutral / negative sentiment appear here once a simulation in this case has finished. Triggered comments and reactions are counted separately.</p>
      {!ins.loading && <Link className="btn pri" to={`/cases/${caseId}/${k.stage >= 2 ? "simulations" : STAGE_ROUTES[Math.max(0, Math.min(k.stage, 4))]}`}><Play />{k.stage >= 2 ? "Open simulations" : "Continue to the next stage"}</Link>}</div></section> : <>
      <section className="panel"><div className="panel-h"><h3 className="grow"><GrowthTitle /></h3><span className="xs dim">bars = actions per {bucket} · line = personas engaged</span></div>
        <div className="panel-b v2-chartrow">
          <div className="col" style={{ gap: 10 }}>
            <div className="metric"><small>Total actions</small><b>{totals.toLocaleString()}</b></div>
            <div className="metric"><small>Personas engaged</small><b>{last?.engaged ?? 0} <span className="muted" style={{ fontSize: 14 }}>/ {agents}</span></b></div>
            <div className="metric"><small>Analyst-triggered</small><b>{trig}</b>{trig === 0 && <Link className="xs" to={`/cases/${caseId}/simulations/${ins.simId}`}><Zap size={11} /> Trigger a reaction</Link>}</div>
          </div>
          <GrowthChart steps={steps} agents={agents} bucket={bucket} /></div>
        <div className="v2-legend"><span><i style={{ background: "var(--acc)" }} />Posts</span><span><i style={{ background: "var(--steel)" }} />Replies</span>
          <span><i style={{ background: "var(--agent)" }} />Likes, reposts, follows</span><span><i style={{ background: "var(--hi)" }} />Analyst-triggered</span><span><i className="ld" style={{ background: "var(--sup)" }} />Personas engaged</span>
          <span className="grow" /><span className="dim">Dates: run start 08:00 + {ins.sim.config?.minutes_per_round ?? 60} min per round</span></div></section>

      <section className="panel"><div className="panel-h"><h3 className="grow"><ToneTitle /></h3><span className="xs dim">tone toward the focus issue · positive &gt; +0.25 · negative &lt; −0.25</span></div>
        <div className="panel-b v2-tonerow"><Donut c={c} />
          <div className="col" style={{ gap: 10 }}>{(["pos", "neu", "neg"] as Tone[]).map(t => <div key={t}>
            <div className="row small" style={{ justifyContent: "space-between" }}><span className="row" style={{ gap: 7 }}><i className="ldot" style={{ background: TONE[t][1] }} />{TONE[t][0]}</span><b className="mono">{c[t]} · {pct(c, t)}%</b></div>
            <div className="v2-bar"><i style={{ width: `${pct(c, t)}%`, background: TONE[t][1] }} /></div></div>)}</div>
          <ToneBars steps={steps} bucket={bucket} /></div>
        {ps.length > 0 && <div className="v2-legend"><span>Most positive: <b>{ps[0].name}</b> <span className="mono" style={{ color: "var(--sup)" }}>{ps[0].stance > 0 ? "+" : ""}{ps[0].stance.toFixed(2)}</span></span>
          <span>Most negative: <b>{ps[ps.length - 1].name}</b> <span className="mono" style={{ color: "var(--opp)" }}>{ps[ps.length - 1].stance.toFixed(2)}</span></span></div>}</section></>}

    <section className="panel"><div className="panel-h"><h3>Brief</h3></div><div className="panel-b"><dl className="kv">
      <dt>Research question</dt><dd>{k.research_question || "Not set"}</dd><dt>Objective</dt><dd>{k.objective || "Not set"}</dd>
      <dt>Owner</dt><dd>{k.owner_name}</dd><dt>Visibility</dt><dd>{k.visibility}</dd><dt>Created</dt><dd>{fmtDate(k.created_at)}</dd>
      <dt>Tags</dt><dd className="row wrap gap4">{k.tags.length ? k.tags.map(t => <span key={t} className="tag">{t}</span>) : "—"}</dd></dl></div></section>
  </div>;
}
