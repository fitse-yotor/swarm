import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Lock, Play, Share2 } from "lucide-react";
import { api, type AuditItem, type Case, type Doc, type Job, type Version } from "../api";
import { useAuth } from "../auth";
import { CaseStatusBadge, Empty, useToast } from "../components/ui";
import { STAGES, ago, fmtDate } from "../vocab";
import { DocTable } from "./Documents";

export function useCase(caseId: string) {
  return useQuery({ queryKey: ["case", caseId], queryFn: () => api.get<Case>(`/cases/${caseId}`) });
}

export function useStartBuild(caseId: string) {
  const nav = useNavigate();
  const toast = useToast();
  return useMutation({
    mutationFn: (reextract: boolean = false) => api.post<Job>(`/cases/${caseId}/graph/build`, { reextract }),
    onSuccess: j => nav(`/cases/${caseId}/build/${j.id}`),
    onError: e => toast((e as Error).message, "err"),
  });
}

export default function CaseDetail() {
  const { caseId = "" } = useParams();
  const { can } = useAuth();
  const [tab, setTab] = useState("overview");
  const c = useCase(caseId);
  const docs = useQuery({ queryKey: ["docs", caseId], queryFn: () => api.get<Doc[]>(`/cases/${caseId}/documents`) });
  const vers = useQuery({ queryKey: ["versions", caseId], queryFn: () => api.get<Version[]>(`/cases/${caseId}/graph/versions`) });
  const jobs = useQuery({ queryKey: ["jobs", caseId], queryFn: () => api.get<Job[]>(`/cases/${caseId}/jobs`), enabled: tab === "builds" });
  const audit = useQuery({ queryKey: ["audit", caseId], queryFn: () => api.get<AuditItem[]>(`/audit?case_id=${caseId}&limit=100`), enabled: tab === "audit" });
  const build = useStartBuild(caseId);
  if (!c.data) return <div className="page muted">{c.isError ? (c.error as Error).message : "Loading…"}</div>;
  const k = c.data;
  const pendingDocs = (docs.data ?? []).filter(d => !d.extracted_at && d.status !== "failed").length;

  return <div className="page">
    <div className="page-head"><div className="grow"><div className="row mb8"><CaseStatusBadge status={k.status} /><span className="xs dim">Case · created {ago(k.created_at)}{k.scope_type && ` · ${k.scope_type} scope`}</span></div>
      <h1>{k.title}</h1><p>{k.description}</p></div>
      {can("doc.upload") && <button className="btn" disabled={build.isPending} onClick={() => build.mutate(false)}><Play />{pendingDocs ? `Build graph (${pendingDocs} new source${pendingDocs > 1 ? "s" : ""})` : "Rebuild graph"}</button>}
      <Link className="btn pri" to={`/cases/${caseId}/graph`}><Share2 />Open graph</Link></div>
    <div className="tabs" role="tablist">{[["overview", "Overview"], ["sources", `Sources ${docs.data?.length ?? ""}`], ["graph", `Graph versions ${vers.data?.length ?? ""}`], ["builds", "Builds"], ["audit", "Audit"]].map(([id, l]) =>
      <button key={id} role="tab" className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{l}</button>)}</div>

    {tab === "overview" && <div className="grid2">
      <section className="panel"><div className="panel-h"><h3>Brief</h3></div><div className="panel-b"><dl className="kv">
        <dt>Research question</dt><dd>{k.research_question || "Not set"}</dd><dt>Objective</dt><dd>{k.objective || "Not set"}</dd>
        <dt>Owner</dt><dd>{k.owner_name}</dd><dt>Visibility</dt><dd>{k.visibility}</dd><dt>Created</dt><dd>{fmtDate(k.created_at)}</dd>
        <dt>Tags</dt><dd className="row wrap gap4">{k.tags.length ? k.tags.map(t => <span key={t} className="tag">{t}</span>) : "—"}</dd></dl></div></section>
      <section className="panel"><div className="panel-h"><h3>Stage</h3></div><div className="panel-b col">{STAGES.map((s, i) =>
        <div className="row" key={s}><span className="sdot" style={i < k.stage ? { background: "var(--ok)", borderColor: "var(--ok)", color: "#fff" } : i === k.stage ? { borderColor: "var(--acc)" } : {}}>{i < k.stage && <Check />}</span>
          <span className={i > Math.max(k.stage, 0) ? "dim" : ""}>{i + 1}. {s}</span><span className="grow" />
          <Link className="btn sm ghost" to={`/cases/${caseId}/${["graph", "environments", "simulations", "reports", "interaction"][i]}`}>Open</Link></div>)}</div></section></div>}

    {tab === "sources" && (docs.data?.length ? <div className="panel" style={{ overflowX: "auto" }}><DocTable docs={docs.data} caseId={caseId} /></div>
      : <Empty icon={<Share2 />} title="No sources yet" text="Upload PDF, Markdown or TXT files to build this case's graph."><Link className="btn pri" to={`/cases/${caseId}/documents`}>Upload sources</Link></Empty>)}

    {tab === "graph" && (vers.data?.length ? <div className="panel"><table className="tbl"><thead><tr><th>Version</th><th>Status</th><th>Entities</th><th>Relationships</th><th>Created</th><th>Note</th><th /></tr></thead>
      <tbody>{vers.data.map(v => <tr key={v.id}><td>{v.label}</td><td>{v.status === "approved" ? <span className="badge b-ok" title={`sha256 ${v.content_hash}`}><Lock size={10} />Approved</span> : <span className="badge">Draft</span>}</td>
        <td>{v.node_count}</td><td>{v.edge_count}</td><td className="small muted">{fmtDate(v.created_at)} · {v.created_by}</td><td className="small muted">{v.note}</td>
        <td><Link className="btn sm" to={`/cases/${caseId}/graph?v=${v.id}`}>Open</Link></td></tr>)}</tbody></table></div>
      : <Empty icon={<Share2 />} title="No graph yet" text="Build a knowledge graph from this case's sources." />)}

    {tab === "builds" && <div className="panel"><table className="tbl"><tbody>{(jobs.data ?? []).map(j => <tr key={j.id}>
      <td><span className={`badge ${j.status === "done" ? "b-ok" : j.status === "failed" ? "b-err" : j.status === "running" ? "b-acc" : ""}`}><i />{j.status}</span></td>
      <td className="small">{String(j.stats.extractor ?? "—")}</td><td className="small muted">{j.created_by} · {ago(j.created_at)}</td>
      <td style={{ textAlign: "right" }}><Link className="btn sm" to={`/cases/${caseId}/build/${j.id}`}>Open</Link></td></tr>)}</tbody></table>
      {jobs.data?.length === 0 && <p className="panel-b muted small">No builds yet.</p>}</div>}

    {tab === "audit" && <div className="panel"><table className="tbl"><tbody>{(audit.data ?? []).map(a => <tr key={a.id}>
      <td className="small">{a.action}</td><td className="small trunc" style={{ maxWidth: 480 }}>{a.target}</td><td className="small muted">{a.actor}</td><td className="small muted">{ago(a.at)}</td></tr>)}</tbody></table></div>}
  </div>;
}
