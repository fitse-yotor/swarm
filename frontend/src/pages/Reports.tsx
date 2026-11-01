import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Download, Edit3, FileText } from "lucide-react";
import { api, download, type Conversation, type Report, type ReportSection } from "../api";
import { useAuth } from "../auth";
import { Empty, useToast } from "../components/ui";
import { Markdown, StageLayout, StepCard, Stats, SysLog } from "../components/Stage";
import { useJob, useReports, useSims } from "../hooks";
import { ago, fmtDate } from "../vocab";
import { useCase } from "./CaseDetail";

export function useReport(repId: string) {
  return useQuery({ queryKey: ["report", repId], queryFn: () => api.get<Report>(`/reports/${repId}`),
    refetchInterval: q => (q.state.data?.status === "generating" ? 1500 : false) });
}

export const PROV: Record<ReportSection["kind"], string> = { computed: "Computed from run", generated: "Written by local LLM", evidence: "Source evidence", edited: "Edited by analyst" };

export default function Reports() {
  const { caseId = "", repId } = useParams();
  if (repId) return <ReportView caseId={caseId} repId={repId} />;
  return <ReportList caseId={caseId} />;
}

function ReportList({ caseId }: { caseId: string }) {
  const reps = useReports(caseId);
  const sims = useSims(caseId);
  const done = (sims.data ?? []).filter(s => s.status === "done");
  return <div className="page">
    <div className="page-head"><div className="grow"><h1>Reports</h1><p>Reports separate measured results (computed from the run) from model-written prose and source evidence; every section says which it is.</p></div></div>
    {reps.data && !reps.data.length && <Empty icon={<FileText />} title="No reports yet" text={done.length ? "Open a finished simulation and choose Generate Report." : "Run a simulation first."}>
      {done[0] && <Link className="btn pri" to={`/cases/${caseId}/simulations/${done[0].id}`}>Open {done[0].name}</Link>}</Empty>}
    <div className="col">{(reps.data ?? []).map(r => <Link key={r.id} className="listrow" to={`/cases/${caseId}/reports/${r.id}`}>
      <FileText size={18} color="var(--organization)" /><div className="grow"><b>{r.title}</b><div className="xs dim">{r.simulation_name} · narrative by {r.model || "…"}</div></div>
      <span className={`badge ${r.status === "approved" ? "b-ok" : r.status === "failed" ? "b-err" : "b-warn"}`}><i />{r.status}</span><span className="xs dim">{ago(r.created_at)}</span></Link>)}</div>
  </div>;
}

function ReportView({ caseId, repId }: { caseId: string; repId: string }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useCase(caseId);
  const rep = useReport(repId);
  const r = rep.data;
  const job = useJob(r?.job_id);
  const [edit, setEdit] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => { if (job.data?.status === "done" || job.data?.status === "failed") qc.invalidateQueries({ queryKey: ["report", repId] }); }, [job.data?.status, qc, repId]);
  if (rep.isError) return <div className="page muted">{(rep.error as Error).message}</div>;
  if (!r) return <div className="center-fill">Loading report…</div>;
  const j = job.data ?? r.job ?? null;
  const gen = r.status === "generating";
  const stage = j?.stage ?? 0;
  const st = (i: number) => (r.status === "failed" ? "fail" : !gen || stage > i ? "done" : stage === i ? "run" : "wait") as "done" | "run" | "wait" | "fail";
  const facts = (r.facts ?? {}) as { mean_stance?: { start: number; end: number }; agents?: number; rounds?: number; polarization?: { start: number; end: number } };
  const evidence = r.sections?.find(s => s.id === "evidence");
  const saveSection = async (id: string) => {
    try {
      await api.patch(`/reports/${r.id}`, { sections: (r.sections ?? []).map(s => (s.id === id ? { id, body: draft } : { id: s.id })) });
      setEdit(null); qc.invalidateQueries({ queryKey: ["report", repId] }); toast("Section saved", "ok");
    } catch (e) { toast((e as Error).message, "err"); }
  };
  const startChat = async () => {
    try { const cv = await api.post<Conversation>(`/cases/${caseId}/conversations`, { target: `report:${r.id}` }); qc.invalidateQueries({ queryKey: ["convs", caseId] }); nav(`/cases/${caseId}/interaction/${cv.id}`); }
    catch (e) { toast((e as Error).message, "err"); }
  };

  const left = <div className="doc">
    <div className="row mb8"><span className={`badge ${r.status === "approved" ? "b-ok" : r.status === "failed" ? "b-err" : "b-warn"}`}><i />{r.status}</span>
      <span className="xs dim">Generated {fmtDate(r.created_at)} by {r.created_by}{r.approved_by && ` · approved by ${r.approved_by}`}</span></div>
    <h1 className="doc-title">{r.title}</h1>
    <p className="small muted mt8">Simulated outcomes from <Link to={`/cases/${caseId}/simulations/${r.simulation_id}`}>{r.simulation_name}</Link>, not predictions. Section tags show what was measured, what the local model wrote, and what comes from the sources.</p>
    {gen && <div className="center-fill" style={{ height: 200 }}><div className="col" style={{ alignItems: "center" }}><span className="spinner" /><span className="small muted">{j?.stages[stage] ?? "Starting"}…</span></div></div>}
    {(r.sections ?? []).map(s => <section key={s.id} className="doc-sec" id={`sec-${s.id}`}>
      <h2>{s.title}<span className={`prov ${s.kind}`}>{s.kind === "generated" ? `LLM · ${r.model}` : PROV[s.kind]}</span>
        {r.status === "draft" && can("report.edit") && edit !== s.id && <button className="btn ghost sm" style={{ marginLeft: "auto" }} aria-label={`Edit ${s.title}`} onClick={() => { setEdit(s.id); setDraft(s.body); }}><Edit3 /></button>}</h2>
      {edit === s.id ? <div className="mt8"><textarea className="inp" rows={8} value={draft} onChange={e => setDraft(e.target.value)} style={{ fontFamily: "var(--mono)", fontSize: 12.5 }} />
        <div className="row mt8"><button className="btn pri sm" onClick={() => saveSection(s.id)}>Save</button><button className="btn sm" onClick={() => setEdit(null)}>Cancel</button></div></div>
        : <Markdown text={s.body} />}
    </section>)}
  </div>;

  const cards = <div className="st-cards">
    <StepCard n={1} title="Collect Simulation Results" state={st(0)} endpoint={`GET /api/v1/simulations/${r.simulation_id}`}>
      {facts.agents !== undefined && <Stats items={[[facts.agents, "Agents"], [facts.rounds ?? 0, "Rounds"], [`${(facts.mean_stance?.end ?? 0) >= 0 ? "+" : ""}${(facts.mean_stance?.end ?? 0).toFixed(2)}`, "Final stance"]]} />}
    </StepCard>
    <StepCard n={2} title="Compute Findings" state={st(1)} desc="Stance and polarization trajectories, coalitions, biggest movers, engagement and top posts — computed, not generated." />
    <StepCard n={3} title="Retrieve Graph Evidence" state={st(2)} endpoint="POST GraphRAG retrieval (pgvector + Neo4j)"
      desc={evidence?.sources?.length ? `${evidence.sources.length} source passages anchor the report.` : "Source passages relevant to the research question."}>
      {evidence?.sources?.length ? <div className="chips mt12">{evidence.sources.map((x, i) => <span key={i} className="chip">S{i + 1} · {x.document} p.{x.page}</span>)}</div> : null}
    </StepCard>
    <StepCard n={4} title="Write Report Sections" state={st(3)} badge={!gen && r.model ? r.model : undefined}
      desc={r.model === "template" ? "The local LLM was not running, so narrative sections were templated from computed facts." : "The local LLM writes only the summary, interpretation and watch points — from computed facts, never from raw data."} />
    <StepCard n={5} title="Review & Approve" state={r.status === "approved" ? "done" : gen ? "wait" : "run"} badge={r.status === "approved" ? "Approved" : gen ? "Waiting" : "Draft"}
      endpoint={`POST /api/v1/reports/${r.id}/approve`}>
      <div className="cs-actions">
        {r.status === "draft" && can("report.approve") && <button className="btn ok" onClick={() => api.post(`/reports/${r.id}/approve`).then(() => { qc.invalidateQueries({ queryKey: ["report", repId] }); toast("Report approved", "ok"); }).catch(e => toast(e.message, "err"))}><Check />Approve report</button>}
        <Link className="btn" to={`/cases/${caseId}/simulations/${r.simulation_id}?view=graph`}>Reaction graph · 3D</Link>
        {!gen && <button className="btn" onClick={() => download(`/reports/${r.id}/export`, `${r.title}.md`).catch(e => toast(e.message, "err"))}><Download />Export Markdown</button>}
        {!gen && r.status !== "failed" && can("chat.use") && <button className="btn pri" onClick={startChat}>Deep Interaction<ArrowRight /></button>}
      </div>
    </StepCard>
  </div>;

  const status = gen ? { label: "Generating", tone: "run" as const } : r.status === "failed" ? { label: "Failed", tone: "err" as const } : { label: r.status === "approved" ? "Approved" : "Draft", tone: "ok" as const };
  return <StageLayout step={4} caseId={caseId} status={status} leftLabel="Report" plainLeft caseStage={c.data?.stage ?? 0} left={left} right={cards} log={<SysLog job={j} />} />;
}
