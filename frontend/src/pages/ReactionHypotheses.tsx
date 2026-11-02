import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CircleSlash, Eye, FlaskConical, Network, Pencil, RefreshCw, Sparkles, Undo2 } from "lucide-react";
import { api, type Reaction, type ReactionCategory, type ReactionDetail, type ReactionPage, type ReactionRun, type ReactionStatus, type Version } from "../api";
import { useAuth } from "../auth";
import { ConfBar, Drawer, Empty, EtypeTag, Modal, Spinner, useToast } from "../components/ui";
import { ago } from "../vocab";

const LABEL = "AI-generated hypothesis — not a verified statement or actual response";
const CAT: Record<ReactionCategory, string> = { support: "Support", opposition: "Opposition", concern: "Concern", neutrality: "Neutrality", negotiation: "Negotiation",
  public_communication: "Public communication", policy_response: "Policy response", operational_response: "Operational response" };
const STATUS_LABEL: Record<ReactionStatus, string> = { generated: "Generated · unreviewed", reviewed: "Reviewed", selected: "Selected for simulation", excluded: "Excluded" };
const STATUS_CLS: Record<ReactionStatus, string> = { generated: "b-warn", reviewed: "b-acc", selected: "b-ok", excluded: "b-err" };
const BASIS: Record<string, string> = { evidence_supported: "Supported by source evidence", model_inferred: "Inferred (not stated in the sources)", synthetic: "Synthetic content" };
const PAGE = 24;

type Filters = { actor_type: string; category: string; status: string; min: string; q: string };
const NONE: Filters = { actor_type: "", category: "", status: "", min: "", q: "" };

export default function ReactionHypotheses() {
  const { caseId = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Filters>(NONE);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<string | null>(sp.get("reaction"));
  const [editing, setEditing] = useState<Reaction | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const editable = can("graph.review");

  useEffect(() => { const t = setTimeout(() => setF(x => ({ ...x, q: q.trim() })), 250); return () => clearTimeout(t); }, [q]);

  const runs = useQuery({ queryKey: ["rx-runs", caseId], queryFn: () => api.get<ReactionRun[]>(`/cases/${caseId}/reaction-runs`),
    refetchInterval: q2 => ((q2.state.data ?? []).some(r => r.status === "generating") ? 1500 : false) });
  const versions = useQuery({ queryKey: ["versions", caseId], queryFn: () => api.get<Version[]>(`/cases/${caseId}/graph/versions`) });
  const approved = (versions.data ?? []).filter(v => v.status === "approved");
  const noApproved = versions.isSuccess && approved.length === 0;  // reactions are generated only from an approved graph
  const run = (runs.data ?? []).find(r => r.id === runId) ?? (runs.data ?? []).find(r => r.status === "ready") ?? runs.data?.[0];
  const generating = (runs.data ?? []).find(r => r.status === "generating");

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (run?.status === "ready") p.set("run_id", run.id);
    for (const [k, v] of Object.entries(f)) if (v) p.set(k === "min" ? "min_confidence" : k, v);
    return p.toString();
  }, [f, run]);
  const list = useInfiniteQuery({
    queryKey: ["rx", caseId, params], enabled: !!run && run.status === "ready",
    queryFn: ({ pageParam }) => api.get<ReactionPage>(`/cases/${caseId}/reactions?${params}&limit=${PAGE}&offset=${pageParam}`),
    initialPageParam: 0, getNextPageParam: (last, all) => (all.length * PAGE < last.total ? all.length * PAGE : undefined),
  });
  const items = list.data?.pages.flatMap(p => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; type: string; items: Reaction[] }>();
    for (const r of items) (m.get(r.actor_id) ?? m.set(r.actor_id, { name: r.actor_name, type: r.actor_type, items: [] }).get(r.actor_id)!).items.push(r);
    return [...m.entries()];
  }, [items]);

  const refresh = () => { qc.invalidateQueries({ queryKey: ["rx", caseId] }); qc.invalidateQueries({ queryKey: ["rx-runs", caseId] }); qc.invalidateQueries({ queryKey: ["rx-detail"] }); };
  const generate = useMutation({
    mutationFn: () => api.post<ReactionRun>(`/cases/${caseId}/reaction-runs`, {}),
    onSuccess: r => { setRunId(null); refresh(); toast(`Generating reaction run ${r.number}…`, "ok"); },
    onError: e => toast((e as Error).message, "err"),
  });
  const setStatus = useMutation({
    mutationFn: ({ ids, status }: { ids: string[]; status: "reviewed" | "selected" | "excluded" | "generated" }) =>
      ids.length === 1 ? api.patch(`/reactions/${ids[0]}`, { status }) : api.post(`/cases/${caseId}/reactions/bulk`, { ids, status }),
    onSuccess: () => { setPicked(new Set()); refresh(); },
    onError: e => toast((e as Error).message, "err"),
  });
  const toggle = (id: string) => setPicked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const pickedIds = [...picked];
  const filtered = Object.values(f).some(Boolean);

  const head = <div className="page-head"><div className="grow"><h1>Reactions</h1>
    <p>Possible ways relevant actors might respond, generated from the approved research graph. They are hypotheses to test, never verified statements or real events.</p></div>
    {editable && <button className="btn pri" disabled={!!generating || generate.isPending || noApproved} title={noApproved ? "Approve the graph first" : undefined} onClick={() => generate.mutate()}>{generate.isPending ? <Spinner /> : <RefreshCw />}{runs.data?.length ? "Generate again" : "Generate reactions"}</button>}</div>;

  if (runs.isLoading) return <div className="page">{head}<p className="muted">Loading…</p></div>;
  if (runs.isError) return <div className="page">{head}<Empty icon={<AlertTriangle />} title="Could not load reactions" text={(runs.error as Error).message}><button className="btn" onClick={() => runs.refetch()}>Try again</button></Empty></div>;

  return <div className="page">
    {head}
    {noApproved && <div className="banner err" role="alert"><AlertTriangle /><span className="grow"><b>This case has no approved graph yet.</b> Reactions are generated only from entities and relationships a person has approved.
      Open the <b>Review queue</b>, approve what you trust, then press <b>Approve</b> on the graph. Reactions are then generated automatically.</span>
      <Link className="btn sm" to={`/cases/${caseId}/review`}>Open the Review queue</Link><Link className="btn sm" to={`/cases/${caseId}/graph`}>Open the graph</Link></div>}
    <div className="banner warn" role="note"><FlaskConical /><span><b>{LABEL}.</b> Each card shows which graph relationships and source passages it relied on, and what is inferred or synthetic.</span></div>

    {generating && <div className="panel panel-b mb12" role="status"><div className="row"><Spinner /><b className="small">Generating run {generating.number}…</b>
      <span className="xs dim">{generating.job ? `${generating.job.progress}%` : ""}</span></div>
      <div className="prog mt8"><i style={{ width: `${generating.job?.progress ?? 5}%` }} /></div></div>}
    {run?.status === "failed" && <div className="banner err"><AlertTriangle /><span>Run {run.number} failed{run.job?.error ? `: ${run.job.error}` : ""}. {editable ? "Fix the cause and generate again." : ""}</span></div>}

    {!runs.data?.length && !generating ? <Empty icon={<Sparkles />} title="No reactions yet" text={noApproved ? "Approve the graph first (see above). Reactions are generated automatically once a version is approved." : "Reactions are generated automatically when a graph version is approved. You can also generate them from the latest approved version."}>
      {editable && !noApproved && <button className="btn pri" onClick={() => generate.mutate()}><RefreshCw />Generate reactions</button>}
      <Link className="btn" to={`/cases/${caseId}/graph`}><Network />Open the graph</Link></Empty> : run && <>
      <div className="panel panel-b mb12"><div className="row wrap" style={{ gap: 14 }}>
        <label className="row small" style={{ gap: 6 }}>Run <select className="sel" style={{ width: "auto" }} aria-label="Reaction run" value={run.id} onChange={e => setRunId(e.target.value)}>
          {(runs.data ?? []).map(r => <option key={r.id} value={r.id}>#{r.number} · {r.mode === "llm" ? "language model" : "demo rules"} · {ago(r.created_at)}{r.status !== "ready" ? ` · ${r.status}` : ""}</option>)}</select></label>
        <span className={`badge ${run.demo ? "b-warn" : "b-acc"}`}><i />{run.demo ? "Demo mode · rule-based, not AI analysis" : `Generated by ${run.provider}`}</span>
        <span className="xs dim">template {run.template_version} · {run.stats.actors ?? 0} actors · {run.stats.reactions ?? 0} hypotheses{run.stats.rejected ? ` · ${run.stats.rejected} rejected by validation` : ""}{run.stats.failed_actors ? ` · ${run.stats.failed_actors} actor(s) failed` : ""}</span></div>
        {run.demo && <p className="xs dim mt8">No language model is configured, so the text comes from a rule set that reads relationship types in the approved graph. Configure a model to get actor-specific analysis. Earlier runs are kept.</p>}
        {run.stats.actor_selection && <details className="mt8"><summary className="xs dim" style={{ cursor: "pointer" }}>Why these actors were chosen</summary>
          <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>{run.stats.actor_selection.map(a => <li key={a.id}><b>{a.name}</b> <span className="dim">· {a.why}</span></li>)}</ul></details>}
      </div>

      <div className="toolbar mb12">
        <select className="sel tb-sel" aria-label="Actor type" value={f.actor_type} onChange={e => setF({ ...f, actor_type: e.target.value })}><option value="">All actor types</option>
          {["person", "organization", "country"].map(t => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}</select>
        <select className="sel tb-sel" aria-label="Category" value={f.category} onChange={e => setF({ ...f, category: e.target.value })}><option value="">All categories</option>
          {Object.entries(CAT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select className="sel tb-sel" aria-label="Review status" value={f.status} onChange={e => setF({ ...f, status: e.target.value })}><option value="">Any review status</option>
          {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select className="sel tb-sel" aria-label="Minimum confidence" value={f.min} onChange={e => setF({ ...f, min: e.target.value })}><option value="">Any confidence</option>
          <option value="0.3">Confidence ≥ 30%</option><option value="0.5">Confidence ≥ 50%</option><option value="0.7">Confidence ≥ 70%</option></select>
        <input className="inp tb-search" placeholder="Search actor or text" aria-label="Search reactions" value={q} onChange={e => setQ(e.target.value)} />
        {filtered && <button className="btn ghost sm" onClick={() => { setF(NONE); setQ(""); }}>Clear filters</button>}</div>

      {editable && pickedIds.length > 0 && <div className="bulkbar" role="toolbar" aria-label="Bulk actions"><b>{pickedIds.length} selected</b>
        <button className="btn sm" onClick={() => setStatus.mutate({ ids: pickedIds, status: "selected" })}><Check />Select for simulation</button>
        <button className="btn sm" onClick={() => setStatus.mutate({ ids: pickedIds, status: "reviewed" })}><Eye />Mark reviewed</button>
        <button className="btn sm danger" onClick={() => setStatus.mutate({ ids: pickedIds, status: "excluded" })}><CircleSlash />Exclude</button>
        <button className="btn ghost sm" onClick={() => setPicked(new Set())}>Clear</button></div>}

      {list.isLoading ? <p className="muted">Loading reactions…</p> : list.isError ? <Empty icon={<AlertTriangle />} title="Could not load reactions" text={(list.error as Error).message}><button className="btn" onClick={() => list.refetch()}>Try again</button></Empty>
        : !items.length ? <Empty icon={<Sparkles />} title={filtered ? "No reactions match these filters" : "This run produced no reactions"} text={filtered ? "Clear a filter to see more." : "No actor in the approved graph had enough relationships to the case issue. Approve more of the graph, then generate again."}>
          {filtered && <button className="btn" onClick={() => { setF(NONE); setQ(""); }}>Clear filters</button>}</Empty>
        : <div className="col" style={{ gap: 18 }}>{groups.map(([actorId, g]) => <section key={actorId} aria-label={`Reactions for ${g.name}`}>
          <div className="row mb8"><EtypeTag type={g.type as never} /><h2 style={{ fontSize: 16 }}>{g.name}</h2>
            <Link className="btn ghost sm" to={`/cases/${caseId}/dynamic?focus=${actorId}`} title="Show this actor in the graph"><Network />In graph</Link>
            {g.type === "person" && <span className="badge b-warn" title="Real person: scenario hypotheses only, not their actual views"><i />real person · synthetic scenario</span>}</div>
          <div className="rx-grid">{g.items.map(r => <article key={r.id} className={`rx ${r.status}`} aria-label={r.title}>
            <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
              {editable && <input type="checkbox" aria-label={`Select ${r.title}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} style={{ marginTop: 4 }} />}
              <div className="grow" style={{ minWidth: 0 }}><h3 style={{ fontSize: 14.5 }}>{r.title}</h3>
                <div className="row wrap mt8" style={{ gap: 6 }}><span className="badge b-warn" title={LABEL}><FlaskConical size={11} />Hypothesis</span>
                  <span className="badge">{CAT[r.category]}</span><span className={`badge ${STATUS_CLS[r.status]}`}><i />{STATUS_LABEL[r.status]}</span>{r.edited && <span className="badge b-acc">edited</span>}</div></div></div>
            <p className="small mt8" style={{ lineHeight: 1.5 }}>{r.description}</p>
            <div className="mt8"><div className="xs dim">Uncertainty: <b>{r.uncertainty}</b> · confidence</div><ConfBar value={r.confidence} /></div>
            <ul className="rx-warn">{r.warnings.slice(0, 3).map(w => <li key={w}><AlertTriangle size={12} />{w}</li>)}</ul>
            <div className="row wrap mt8" style={{ gap: 4 }}>{r.related.slice(0, 4).map(x => <span key={x.id} className="chip" title={x.relation}>{x.name}</span>)}
              <span className="xs dim">{r.evidence_ids.length ? `${r.evidence_ids.length} source passage${r.evidence_ids.length > 1 ? "s" : ""}` : "no linked passage"}</span></div>
            <div className="row wrap mt8" style={{ gap: 4 }}>
              <button className="btn sm" onClick={() => setDetail(r.id)}><Eye />Evidence &amp; reasoning</button>
              {editable && <>{r.status === "selected" ? <button className="btn sm" onClick={() => setStatus.mutate({ ids: [r.id], status: "reviewed" })}><Undo2 />Unselect</button>
                : <button className="btn sm ok" onClick={() => setStatus.mutate({ ids: [r.id], status: "selected" })}><Check />Select</button>}
                {r.status === "excluded" ? <button className="btn sm" onClick={() => setStatus.mutate({ ids: [r.id], status: "reviewed" })}><Undo2 />Restore</button>
                  : <button className="btn sm danger" onClick={() => setStatus.mutate({ ids: [r.id], status: "excluded" })}><CircleSlash />Exclude</button>}
                <button className="btn ghost sm icon" aria-label={`Edit ${r.title}`} title="Edit" onClick={() => setEditing(r)}><Pencil /></button></>}</div>
          </article>)}</div></section>)}
          <div className="row" style={{ justifyContent: "center" }}><span className="xs dim">Showing {items.length} of {total}</span>
            {list.hasNextPage && <button className="btn" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>{list.isFetchingNextPage && <Spinner />}Load more</button>}</div></div>}
    </>}

    {detail && <DetailDrawer id={detail} caseId={caseId} editable={editable} onClose={() => { setDetail(null); if (sp.get("reaction")) { sp.delete("reaction"); setSp(sp, { replace: true }); } }}
      onStatus={(id, status) => setStatus.mutate({ ids: [id], status })} />}
    {editing && <EditModal r={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); toast("Reaction updated", "ok"); }} />}
  </div>;
}

function DetailDrawer({ id, caseId, editable, onClose, onStatus }: { id: string; caseId: string; editable: boolean; onClose: () => void; onStatus: (id: string, s: "reviewed" | "selected" | "excluded") => void }) {
  const d = useQuery({ queryKey: ["rx-detail", id], queryFn: () => api.get<ReactionDetail>(`/reactions/${id}`) });
  const r = d.data?.reaction;
  return <Drawer title={r?.title ?? "Reaction"} sub={r ? `${r.actor_name} · ${CAT[r.category]}` : undefined} onClose={onClose}>
    {d.isLoading && <p className="muted">Loading…</p>}
    {d.isError && <p className="small" style={{ color: "var(--err)" }}>{(d.error as Error).message}</p>}
    {r && d.data && <div className="col" style={{ gap: 14 }}>
      <div className="banner warn" role="note"><FlaskConical /><span><b>{LABEL}.</b></span></div>
      <section><div className="sec-t">Hypothesis</div><p className="small" style={{ lineHeight: 1.55 }}>{r.description}</p>
        <p className="xs dim mt8">Triggering issue: {r.trigger}</p></section>
      <section><div className="sec-t">Reasoning from the graph</div><p className="small" style={{ lineHeight: 1.55 }}>{r.reasoning}</p>
        <div className="row wrap mt8" style={{ gap: 4 }}>{r.related.map(x => <span key={x.id} className="chip">{x.relation.toLowerCase().replace(/_/g, " ")} · {x.name}</span>)}</div></section>
      <section><div className="sec-t">What it rests on</div>
        {(["evidence_supported", "model_inferred", "synthetic"] as const).map(k => <div key={k} className="mb8"><div className="xs" style={{ fontWeight: 600 }}>{BASIS[k]}</div>
          {d.data!.basis[k].length ? <ul className="small" style={{ margin: "2px 0 0", paddingLeft: 18 }}>{d.data!.basis[k].map(a => <li key={a.text}>{a.text}</li>)}</ul> : <div className="xs dim">None</div>}</div>)}
        {r.warnings.map(w => <div key={w} className="rx-warn-line"><AlertTriangle size={13} />{w}</div>)}</section>
      <section><div className="sec-t">Source evidence</div>
        {d.data.evidence.length ? d.data.evidence.map(e => <blockquote key={e.id} className="quote"><p>“{e.quote}”</p><div className="xs dim">{e.document} · p.{e.page}{e.section ? ` · ${e.section}` : ""}</div></blockquote>)
          : <p className="small dim">No source passage is linked to this hypothesis. It rests on the graph relationships above and on the assumptions listed.</p>}</section>
      <section><div className="sec-t">Provenance</div><dl className="kv" style={{ gridTemplateColumns: "120px 1fr" }}>
        <dt>Provenance</dt><dd>{r.provenance.replace(/_/g, " ")}</dd><dt>Generator</dt><dd>{r.generator.provider} {r.generator.mode === "demo-rules" && <span className="badge b-warn">demo</span>}</dd>
        <dt>Template</dt><dd className="mono small">{r.generator.template_version}</dd><dt>Run</dt><dd>#{d.data.run?.number} · {ago(r.created_at)}</dd><dt>Status</dt><dd>{STATUS_LABEL[r.status]}{r.edited ? " · edited by an analyst" : ""}</dd></dl></section>
      <div className="row wrap" style={{ gap: 6 }}><Link className="btn" to={`/cases/${caseId}/dynamic?focus=${r.actor_id}`}><Network />Show in graph</Link>
        {editable && <><button className="btn ok" onClick={() => onStatus(r.id, "selected")}><Check />Select for simulation</button><button className="btn danger" onClick={() => onStatus(r.id, "excluded")}><CircleSlash />Exclude</button></>}</div>
    </div>}
  </Drawer>;
}

function EditModal({ r, onClose, onSaved }: { r: Reaction; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [d, setD] = useState({ title: r.title, description: r.description, category: r.category });
  const save = useMutation({ mutationFn: () => api.patch(`/reactions/${r.id}`, d), onSuccess: onSaved, onError: e => toast((e as Error).message, "err") });
  const valid = d.title.trim().length >= 5 && d.description.trim().length >= 20;
  return <Modal title="Edit hypothesis" sub="Your edit is recorded and the reaction stays labelled as a generated hypothesis." onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={!valid || save.isPending} onClick={() => save.mutate()}>{save.isPending && <Spinner />}Save changes</button></>}>
    <div className="col gap12">
      <div className="field"><label htmlFor="rx-t">Title</label><input id="rx-t" className="inp" value={d.title} maxLength={160} onChange={e => setD({ ...d, title: e.target.value })} /></div>
      <div className="field"><label htmlFor="rx-c">Category</label><select id="rx-c" className="sel" value={d.category} onChange={e => setD({ ...d, category: e.target.value as ReactionCategory })}>
        {Object.entries(CAT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <div className="field"><label htmlFor="rx-d">Description</label><textarea id="rx-d" className="inp" rows={5} maxLength={1200} value={d.description} onChange={e => setD({ ...d, description: e.target.value })} />
        <span className="hint">Do not add quotations or confirmed positions: only text from a source passage may be quoted.</span></div>
    </div>
  </Modal>;
}
