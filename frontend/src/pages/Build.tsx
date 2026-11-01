import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Inbox, Maximize, Minimize, RefreshCw, Share2, Square, Tag } from "lucide-react";
import { api, type Doc, type Graph, type Job } from "../api";
import { useToast } from "../components/ui";
import { StageLayout, StepCard, Stats, SysLog } from "../components/Stage";
import Graph3D, { type G3Link, type G3Node } from "../graph/Graph3D";
import { ETYPES, typeColor } from "../vocab";
import { useTheme } from "../hooks";
import { useCase } from "./CaseDetail";

type Preview = { nodes: [string, string, string | null][]; edges: [string, string, string][] };

/** Graph build as a live process view: the knowledge graph assembles in 3D while the job runs. */
export default function Build() {
  const { caseId = "", jobId = "" } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const c = useCase(caseId);
  const job = useQuery({
    queryKey: ["job", jobId], queryFn: () => api.get<Job>(`/jobs/${jobId}`),
    refetchInterval: q => (q.state.data && ["done", "failed", "cancelled"].includes(q.state.data.status) ? false : 800),
  });
  const docs = useQuery({ queryKey: ["docs", caseId], queryFn: () => api.get<Doc[]>(`/cases/${caseId}/documents`), refetchInterval: 4000 });
  const j = job.data;
  const done = j?.status === "done";
  const versionId = j?.stats.version_id as string | undefined;
  const final = useQuery({ queryKey: ["graph", caseId, versionId], enabled: done && !!versionId,
    queryFn: () => api.get<Graph>(`/cases/${caseId}/graph?version_id=${versionId}`) });
  const [labels, setLabels] = useState(true);
  const [full, setFull] = useState(false);
  const theme = useTheme();

  useEffect(() => {
    if (done) ["cases", "docs", "versions", "case", "dashboard", "jobs"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));
  }, [done, qc]);

  const control = useMutation({
    mutationFn: (op: "cancel" | "retry") => api.post<Job>(`/jobs/${jobId}/${op}`),
    onSuccess: r => { qc.setQueryData(["job", jobId], r); qc.invalidateQueries({ queryKey: ["job", jobId] }); },
    onError: e => toast((e as Error).message, "err"),
  });

  // Node ids are names in both the live preview and the final graph, so the build hands over without a jump.
  const { nodes, links } = useMemo(() => {
    if (final.data) {
      const name = Object.fromEntries(final.data.nodes.map(n => [n.id, n.name]));
      return { nodes: final.data.nodes.filter(n => n.status !== "rejected").map(n => ({ id: n.name, name: n.name, type: n.type })) as G3Node[],
        links: final.data.edges.filter(e => name[e.s] && name[e.o]).map(e => ({ source: name[e.s], target: name[e.o], type: e.type })) as G3Link[] };
    }
    const p = (j?.stats.preview ?? { nodes: [], edges: [] }) as Preview;
    const docLinks = p.nodes.filter(n => n[2]).map(n => ({ source: n[2]!, target: n[0], type: "MENTIONED_IN" }));
    return { nodes: p.nodes.map(([n, t]) => ({ id: n, name: n, type: t })),
      links: [...p.edges.map(([s, o, t]) => ({ source: s, target: o, type: t })), ...docLinks] };
  }, [j?.stats.preview, final.data]);

  if (!j) return <div className="page muted">{job.isError ? (job.error as Error).message : "Loading build…"}</div>;
  const running = j.status === "running" || j.status === "queued";
  const extractor = String(j.stats.extractor ?? "local extractor");
  const entityNodes = nodes.filter(n => n.type !== "document");
  const types = [...new Set(entityNodes.map(n => n.type))];
  const rels = [...new Set(links.map(l => l.type).filter(t => t !== "MENTIONED_IN"))];
  const stageState = (from: number, to: number) => (j.status === "failed" && j.stage >= from && j.stage <= to ? "fail" as const
    : done || j.stage > to ? "done" as const : j.stage >= from ? (running ? "run" as const : "warn" as const) : "wait" as const);
  const status = running ? { label: `${j.stages[j.stage] ?? "Starting"} · ${j.progress}%`, tone: "run" as const }
    : done ? { label: "Graph ready for review", tone: "ok" as const } : { label: j.status === "failed" ? "Build failed" : "Cancelled", tone: "err" as const };

  const left = <div className={`st-left ${full ? "full" : ""}`} style={{ position: full ? "fixed" : "absolute", inset: 0 }}>
    <Graph3D nodes={nodes} links={links} live={running} theme={theme} labels={labels}
      nodeHref={done ? n => `/cases/${caseId}/graph?focus=${encodeURIComponent(n.name)}` : undefined} />
    <div className="st-left-h">
      <h3>Graph Relationship Visualization{running && <span className="small muted" style={{ fontWeight: 400 }}> · building live</span>}</h3>
      <button className="pbtn" aria-pressed={labels} onClick={() => setLabels(!labels)}><Tag />{labels ? "Hide labels" : "Show labels"}</button>
      <button className="pbtn icon" onClick={() => setFull(!full)} aria-label="Fullscreen">{full ? <Minimize /> : <Maximize />}</button>
    </div>
    <div className="legend-card"><h5>Entity Types</h5><div className="lg-grid">
      {["document", ...types].map(t => <span key={t} className="lg"><i style={{ background: typeColor(t) }} />{ETYPES[t as keyof typeof ETYPES]?.label ?? t}
        <span className="dim">{nodes.filter(n => n.type === t).length}</span></span>)}</div>
      <div className="xs dim mt8">Hover for details · click a node to pin it · drag to orbit · scroll to zoom</div></div>
  </div>;

  const cards = <div className="st-cards">
    <StepCard n={1} title="Ontology Generation" state={stageState(0, 4)} endpoint={`POST /api/v1/cases/${caseId}/graph/build`}
      desc={<>Sources are validated, parsed and split into passages; <b className="mono">{extractor}</b> reads each passage locally and proposes entities and relationships, each pinned to its source sentence.</>}>
      <div className="cs-label">Generated entity types</div>
      <div className="chips">{types.length ? types.map(t => <span key={t} className="chip"><i style={{ background: typeColor(t) }} />{ETYPES[t as keyof typeof ETYPES]?.label ?? t}</span>)
        : <span className="xs dim">Waiting for extraction…</span>}</div>
      <div className="cs-label">Generated relation types</div>
      <div className="chips">{rels.slice(0, 16).map(r => <span key={r} className="chip">{r}</span>)}{rels.length > 16 && <span className="chip">+{rels.length - 16}</span>}
        {!rels.length && <span className="xs dim">Waiting for extraction…</span>}</div>
    </StepCard>
    <StepCard n={2} title="GraphRAG Build" state={stageState(5, 8)} endpoint={`GET /api/v1/cases/${caseId}/graph`}
      desc="Entities are resolved across documents, every quote is verified against the source text, passages are embedded into pgvector and the version is written to Neo4j.">
      <Stats items={[[entityNodes.length, "Entity nodes"], [links.filter(l => l.type !== "MENTIONED_IN").length, "Relation edges"], [types.length, "Schema types"]]} />
      <div className="cs-label">Sources</div>
      {(docs.data ?? []).map(d => { const p = j.per_doc[d.id] ?? 0;
        return <div key={d.id} className="mb8"><div className="row small"><span className="grow trunc">{d.filename}</span><span className="dim">{d.status === "failed" ? "failed" : `${p}%`}</span></div>
          <div className={`prog mt8 ${d.status === "failed" ? "err" : p >= 100 ? "ok" : ""}`}><i style={{ width: `${d.status === "failed" ? 100 : p}%` }} /></div></div>; })}
    </StepCard>
    <StepCard n={3} title="Build Complete" state={done ? "done" : j.status === "failed" ? "fail" : "wait"} badge={done ? "Complete" : running ? "Waiting" : undefined}
      endpoint={`POST /api/v1/cases/${caseId}/environments`}
      desc={done ? "The graph is ready. Review the extracted claims, then set up a simulation environment." : j.error ?? "Graph build in progress."}>
      <div className="cs-actions">
        {done && <><Link className="btn" to={`/cases/${caseId}/graph`}><Share2 />Graph explorer</Link>
          <Link className="btn" to={`/cases/${caseId}/review`}><Inbox />Review queue</Link>
          <button className="btn pri" onClick={() => nav(`/cases/${caseId}/environments?new=1`)}>Go to Environment Setup<ArrowRight /></button></>}
        {running && <button className="btn" onClick={() => control.mutate("cancel")}><Square />Cancel build</button>}
        {(j.status === "failed" || j.status === "cancelled") && <button className="btn pri" onClick={() => control.mutate("retry")}><RefreshCw />Retry</button>}
      </div>
    </StepCard>
  </div>;

  return <StageLayout step={1} caseId={caseId} status={status} leftLabel="Graph" caseStage={c.data?.stage ?? 0} left={left} right={cards}
    log={<SysLog job={j} />} actions={<span className="small trunc"><b>{c.data?.title}</b></span>} />;
}
