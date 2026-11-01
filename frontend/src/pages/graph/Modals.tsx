import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Image, Send, X } from "lucide-react";
import { api, download, type Chunk, type Diff, type EntityType, type GEdge, type GNode, type RagAnswer, type Version } from "../../api";
import { Modal, ShapeIcon, Spinner } from "../../components/ui";
import { ETYPES, TYPE_KEYS } from "../../vocab";
import type { GraphCtx } from "../GraphExplorer";

const vurl = (ctx: GraphCtx) => `/cases/${ctx.caseId}/graph/versions/${ctx.g.version.id}`;
const Foot = ({ onClose, ok, disabled, onOk, cls = "pri" }: { onClose: () => void; ok: string; disabled?: boolean; onOk: () => void; cls?: string }) =>
  <><button className="btn" onClick={onClose}>Cancel</button><button className={`btn ${cls}`} disabled={disabled} onClick={onOk}>{ok}</button></>;
const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) =>
  <div className="field"><label>{label}</label>{children}{hint && <span className="hint">{hint}</span>}</div>;

function usePassages(caseId: string) {
  return useQuery({ queryKey: ["chunks-case", caseId], queryFn: () => api.get<Chunk[]>(`/cases/${caseId}/chunks`) });
}
function PassagePicker({ ctx, value, onChange, none }: { ctx: GraphCtx; value: string; onChange: (v: string) => void; none: string }) {
  const p = usePassages(ctx.caseId);
  return <select className="sel" value={value} onChange={e => onChange(e.target.value)}><option value="">{none}</option>
    {(p.data ?? []).map(c => <option key={c.id} value={c.id}>p.{c.page} {c.section}: {c.text.slice(0, 80)}{c.text.length > 80 ? "…" : ""}</option>)}</select>;
}

export function EditNodeModal({ ctx, node, onClose }: { ctx: GraphCtx; node: GNode; onClose: () => void }) {
  const [f, setF] = useState({ name: node.name, type: node.type, description: node.description ?? "", aliases: node.aliases.join(", ") });
  const save = () => ctx.run(() => api.patch(`${vurl(ctx)}/nodes/${node.id}`, { ...f, aliases: f.aliases.split(",").map(a => a.trim()).filter(Boolean) }), `Edited ${f.name}`).then(onClose);
  return <Modal title="Edit entity" onClose={onClose} footer={<Foot onClose={onClose} ok="Save changes" disabled={f.name.trim().length < 2} onOk={save} />}>
    <div className="col gap12"><Field label="Name"><input className="inp" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Type"><select className="sel" value={f.type} onChange={e => setF({ ...f, type: e.target.value as EntityType })}>{TYPE_KEYS.map(k => <option key={k} value={k}>{ETYPES[k].label}</option>)}</select></Field>
      <Field label="Description"><textarea className="inp" rows={3} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Aliases" hint="Comma separated"><input className="inp" value={f.aliases} onChange={e => setF({ ...f, aliases: e.target.value })} /></Field></div>
  </Modal>;
}

export function MergeNodeModal({ ctx, node, onClose }: { ctx: GraphCtx; node: GNode; onClose: () => void }) {
  const opts = ctx.g.nodes.filter(n => n.id !== node.id).sort((a, b) => Number(b.type === node.type) - Number(a.type === node.type) || a.name.localeCompare(b.name));
  const [into, setInto] = useState(node.dup_of ?? opts[0]?.id ?? "");
  const target = opts.find(o => o.id === into);
  return <Modal title="Merge duplicate entity" sub={<>“{node.name}” will be merged into the entity you choose. Its relationships, evidence and name move there; the name becomes an alias. Merges are recorded and can be reviewed in the version history.</>}
    onClose={onClose} footer={<Foot onClose={onClose} ok="Merge" disabled={!into} onOk={() => ctx.run(() => api.post(`${vurl(ctx)}/merge`, { keep_id: into, drop_ids: [node.id] }), `Merged into ${target?.name}`).then(() => { ctx.select(into); onClose(); })} />}>
    <Field label="Merge into"><select className="sel" value={into} onChange={e => setInto(e.target.value)}>{opts.map(o => <option key={o.id} value={o.id}>{o.name} · {ETYPES[o.type].label}</option>)}</select></Field>
  </Modal>;
}

export function MergeSelectionModal({ ctx, ids, onClose, onDone }: { ctx: GraphCtx; ids: string[]; onClose: () => void; onDone: (keep: string) => void }) {
  const [keep, setKeep] = useState(ids[0]);
  return <Modal title={`Merge ${ids.length} entities`} onClose={onClose} footer={<Foot onClose={onClose} ok="Merge" onOk={() => ctx.run(() => api.post(`${vurl(ctx)}/merge`, { keep_id: keep, drop_ids: ids.filter(i => i !== keep) }), "Entities merged").then(() => { onDone(keep); onClose(); })} />}>
    <p className="small muted mb12">Choose the entity to keep. The others become its aliases.</p>
    {ids.map(id => { const n = ctx.g.nodes.find(x => x.id === id)!; return <label key={id} className="fl-item"><input type="radio" name="keep" checked={keep === id} onChange={() => setKeep(id)} /><ShapeIcon type={n.type} />{n.name}</label>; })}
  </Modal>;
}

export function CorrectEdgeModal({ ctx, edge, onClose }: { ctx: GraphCtx; edge: GEdge; onClose: () => void }) {
  const types = [...new Set(ctx.g.edges.map(e => e.type))].sort();
  const nm = (id: string) => ctx.g.nodes.find(n => n.id === id)?.name;
  const [f, setF] = useState({ type: edge.type, confidence: Math.round(edge.confidence * 100), swap: false, directed: edge.directed,
    valid_from: edge.valid_from ?? "", valid_to: edge.valid_to ?? "", add_chunk_id: "", quote: "", verify: true });
  const save = () => {
    const willHaveEv = edge.evidence_ids.length > 0 || !!f.add_chunk_id;
    return ctx.run(() => api.patch(`${vurl(ctx)}/edges/${edge.id}`, { type: f.type, confidence: f.confidence / 100, swap: f.swap, directed: f.directed,
      valid_from: f.valid_from, valid_to: f.valid_to, add_chunk_id: f.add_chunk_id || null, quote: f.quote.trim() || null,
      status: f.verify && willHaveEv ? "approved" : undefined }), f.verify && !willHaveEv ? "Corrected — not verified: add a citation first" : `Corrected ${f.type}`).then(onClose);
  };
  return <Modal wide title="Correct relationship" sub={`${nm(edge.s)} → ${nm(edge.o)}`} onClose={onClose} footer={<Foot onClose={onClose} ok="Save correction" onOk={save} />}>
    <div className="grid2"><Field label="Relationship type" hint="UPPER_SNAKE_CASE"><input className="inp" list="rtypes" value={f.type} onChange={e => setF({ ...f, type: e.target.value })} /><datalist id="rtypes">{types.map(t => <option key={t}>{t}</option>)}</datalist></Field>
      <Field label={`Confidence ${f.confidence}%`}><input type="range" min={0} max={100} value={f.confidence} onChange={e => setF({ ...f, confidence: +e.target.value })} /></Field>
      <label className="chk"><input type="checkbox" checked={f.swap} onChange={e => setF({ ...f, swap: e.target.checked })} />Swap direction (object becomes subject)</label>
      <label className="chk"><input type="checkbox" checked={f.directed} onChange={e => setF({ ...f, directed: e.target.checked })} />Directed relationship</label>
      <Field label="Valid from"><input className="inp" value={f.valid_from} placeholder="e.g. 2025-03 or ‘before dry season’" onChange={e => setF({ ...f, valid_from: e.target.value })} /></Field>
      <Field label="Valid to"><input className="inp" value={f.valid_to} onChange={e => setF({ ...f, valid_to: e.target.value })} /></Field>
      <div style={{ gridColumn: "1/-1" }} className="col gap12"><Field label="Add citation"><PassagePicker ctx={ctx} value={f.add_chunk_id} onChange={v => setF({ ...f, add_chunk_id: v })} none="No new citation" /></Field>
        {f.add_chunk_id && <Field label="Quote (optional)" hint="Exact text from the passage; leave blank to cite the whole passage."><input className="inp" value={f.quote} onChange={e => setF({ ...f, quote: e.target.value })} /></Field>}</div>
      <label className="chk" style={{ gridColumn: "1/-1" }}><input type="checkbox" checked={f.verify} onChange={e => setF({ ...f, verify: e.target.checked })} />Mark as verified after correction</label></div>
  </Modal>;
}

export function AddNodeModal({ ctx, onClose }: { ctx: GraphCtx; onClose: () => void }) {
  const [f, setF] = useState({ name: "", type: "organization" as EntityType, description: "", chunk_id: "" });
  return <Modal title="Add verified entity" sub="Analyst-added entities are labelled as such in the graph and reports." onClose={onClose}
    footer={<Foot onClose={onClose} ok="Add entity" disabled={f.name.trim().length < 2} onOk={() => ctx.run(() => api.post<GNode>(`${vurl(ctx)}/nodes`, { ...f, chunk_id: f.chunk_id || null }), `Added ${f.name}`).then(n => { if (n) { ctx.select(n.id); setTimeout(() => ctx.canvas.current?.focus(n.id), 150); } onClose(); })} />}>
    <div className="col gap12"><Field label="Name"><input className="inp" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Type"><select className="sel" value={f.type} onChange={e => setF({ ...f, type: e.target.value as EntityType })}>{TYPE_KEYS.map(k => <option key={k} value={k}>{ETYPES[k].label}</option>)}</select></Field>
      <Field label="Description"><textarea className="inp" rows={2} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Source passage (recommended)"><PassagePicker ctx={ctx} value={f.chunk_id} onChange={v => setF({ ...f, chunk_id: v })} none="No source passage" /></Field></div>
  </Modal>;
}

export function AddEdgeModal({ ctx, subject, onClose }: { ctx: GraphCtx; subject: string | null; onClose: () => void }) {
  const opts = [...ctx.g.nodes].sort((a, b) => a.name.localeCompare(b.name));
  const types = [...new Set(ctx.g.edges.map(e => e.type))].sort();
  const [f, setF] = useState({ s: subject ?? opts[0]?.id ?? "", o: opts.find(n => n.id !== subject)?.id ?? "", type: "", chunk_id: "", quote: "" });
  return <Modal wide title="Add verified relationship" onClose={onClose}
    footer={<Foot onClose={onClose} ok="Add relationship" disabled={!f.type.trim() || f.s === f.o} onOk={() => ctx.run(() => api.post<GEdge>(`${vurl(ctx)}/edges`, { ...f, chunk_id: f.chunk_id || null, quote: f.quote.trim() || null }), "Relationship added").then(e => { if (e) ctx.selectEdge(e.id); onClose(); })} />}>
    <div className="grid3"><Field label="Subject"><select className="sel" value={f.s} onChange={e => setF({ ...f, s: e.target.value })}>{opts.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field>
      <Field label="Relationship"><input className="inp" list="rtypes2" value={f.type} placeholder="e.g. SUPPORTS" onChange={e => setF({ ...f, type: e.target.value })} /><datalist id="rtypes2">{types.map(t => <option key={t}>{t}</option>)}</datalist></Field>
      <Field label="Object"><select className="sel" value={f.o} onChange={e => setF({ ...f, o: e.target.value })}>{opts.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field></div>
    <div className="col gap12 mt12"><Field label="Supporting passage"><PassagePicker ctx={ctx} value={f.chunk_id} onChange={v => setF({ ...f, chunk_id: v })} none="None — will be flagged unsupported" /></Field>
      {f.chunk_id && <Field label="Quote (optional)" hint="Exact text from the passage; leave blank to cite the whole passage."><input className="inp" value={f.quote} onChange={e => setF({ ...f, quote: e.target.value })} /></Field>}</div>
  </Modal>;
}

export function CompareModal({ ctx, onClose }: { ctx: GraphCtx; onClose: () => void }) {
  const vs: Version[] = ctx.g.versions;
  const [a, setA] = useState(vs.at(-2)?.id ?? vs[0].id);
  const [b, setB] = useState(ctx.g.version.id);
  const d = useQuery({ queryKey: ["diff", ctx.caseId, a, b], queryFn: () => api.get<Diff>(`/cases/${ctx.caseId}/graph/compare?a=${a}&b=${b}`), enabled: a !== b });
  const opt = vs.map(v => <option key={v.id} value={v.id}>{v.label} · {v.status}</option>);
  const D = d.data;
  return <Modal wide title="Compare graph versions" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
    <div className="row mb12"><select className="sel" value={a} onChange={e => setA(e.target.value)}>{opt}</select><span className="dim">→</span><select className="sel" value={b} onChange={e => setB(e.target.value)}>{opt}</select></div>
    {a === b ? <p className="small muted">Pick two different versions.</p> : !D ? <Spinner /> : <>
      <div className="strip" style={{ gridTemplateColumns: "repeat(5,1fr)" }}>{([[D.added_nodes.length, "Entities added"], [D.removed_nodes.length, "Entities removed"], [D.changed_nodes.length, "Entities changed"], [D.added_edges.length, "Relationships added"], [D.removed_edges.length, "Relationships removed"]] as const).map(([v, l]) => <div key={l}><div className="v">{v}</div><div className="l">{l}</div></div>)}</div>
      <div className="grid2 mt16"><div><div className="sec-t">Entities</div>
        {D.added_nodes.slice(0, 25).map((n, i) => <div key={"a" + i} className="row small"><span style={{ color: "var(--ok)" }}>+</span><ShapeIcon type={n.type} />{n.name}</div>)}
        {D.removed_nodes.slice(0, 25).map((n, i) => <div key={"r" + i} className="row small"><span style={{ color: "var(--err)" }}>−</span><ShapeIcon type={n.type} />{n.name}</div>)}
        {D.changed_nodes.slice(0, 25).map((n, i) => <div key={"c" + i} className="row small"><span style={{ color: "var(--warn)" }}>~</span><ShapeIcon type={n.type} />{n.name}<span className="dim">→ {n.status}</span></div>)}</div>
        <div><div className="sec-t">Relationships</div>
          {D.added_edges.slice(0, 25).map((e, i) => <div key={"a" + i} className="small"><span style={{ color: "var(--ok)" }}>+</span> {e.s} <span className="dim">{e.type}</span> {e.o}</div>)}
          {D.removed_edges.slice(0, 25).map((e, i) => <div key={"r" + i} className="small"><span style={{ color: "var(--err)" }}>−</span> {e.s} <span className="dim">{e.type}</span> {e.o}</div>)}</div></div></>}
  </Modal>;
}

export function ApproveModal({ ctx, onClose, onDone }: { ctx: GraphCtx; onClose: () => void; onDone: (draftId: string | null) => void }) {
  const p = useQuery({ queryKey: ["approval", ctx.g.version.id], queryFn: () => api.get<{ entities: number; relationships: number; pending: number; rejected: number }>(`${vurl(ctx)}/approval-preview`) });
  const v = ctx.g.version;
  return <Modal title={`Approve graph ${v.label}?`} onClose={onClose} footer={<Foot onClose={onClose} ok={`Approve ${v.label}`} cls="ok" disabled={!p.data?.entities}
    onOk={() => ctx.run(() => api.post<{ approved: Version; draft: Version | null }>(`${vurl(ctx)}/approve`), `${v.label} approved`).then(r => { if (r) onDone(r.draft?.id ?? r.approved.id); onClose(); })} />}>
    <p className="small">The approved version becomes immutable, receives a content hash and is the only graph that environments (stage 2) can use.</p>
    {p.data ? <dl className="kv mt16"><dt>Included</dt><dd>{p.data.entities} entities · {p.data.relationships} relationships (verified or analyst-added with a source)</dd>
      <dt>Carried forward</dt><dd>{p.data.pending} pending or conflicting claims move to a new draft</dd><dt>Excluded</dt><dd>{p.data.rejected} rejected claims</dd></dl> : <Spinner />}
    {p.data && !p.data.entities && <p className="small mt12" style={{ color: "var(--warn)" }}>Approve at least one entity first.</p>}
  </Modal>;
}

export function ExportModal({ ctx, caseTitle, onClose }: { ctx: GraphCtx; caseTitle: string; onClose: () => void }) {
  const base = `${caseTitle.toLowerCase().replace(/\W+/g, "-")}-${ctx.g.version.label}`;
  return <Modal title="Export graph" sub={`Graph ${ctx.g.version.label} of ${caseTitle}`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
    <div className="col gap8">
      <button className="btn" onClick={() => { ctx.canvas.current?.exportPng(base); onClose(); }}><Image />PNG image of the current view</button>
      <button className="btn" onClick={() => download(`${vurl(ctx)}/export?format=json`, `${base}.json`).then(onClose)}><Download />JSON — entities, relationships and evidence</button>
      <button className="btn" onClick={() => download(`${vurl(ctx)}/export?format=csv`, `${base}-relationships.csv`).then(onClose)}><Download />CSV — relationships with citations</button></div>
  </Modal>;
}

export function AskPanel({ ctx, onClose }: { ctx: GraphCtx; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [a, setA] = useState<RagAnswer | null>(null);
  const [err, setErr] = useState("");
  const ask = async () => {
    if (q.trim().length < 3) return;
    setBusy(true); setErr("");
    try { setA(await api.post<RagAnswer>(`/cases/${ctx.caseId}/graphrag/query`, { question: q, version_id: ctx.g.version.id })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const cited = (id: string) => a?.cited_sources.includes(id) || a?.cited_relationships.includes(id);
  return <div className="ask" role="dialog" aria-label="Ask the graph">
    <div className="panel-h"><h3 className="grow">Ask the graph</h3><span className="b-syn badge">GraphRAG · {ctx.g.version.label}</span><button className="btn ghost icon sm" aria-label="Close" onClick={onClose}><X /></button></div>
    <div className="ask-b">
      <div className="row"><input className="inp" value={q} placeholder="e.g. Who opposes Dam Filling Phase II, and why?" onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === "Enter" && ask()} />
        <button className="btn pri icon" aria-label="Ask" disabled={busy} onClick={ask}>{busy ? <Spinner /> : <Send />}</button></div>
      {err && <p className="small" style={{ color: "var(--err)" }}>{err}</p>}
      {a && <>
        <div className={`prov ${a.model ? "interp" : "fact"}`}><div className="prov-tag">{a.model ? `${a.label} · ${a.support}` : "Retrieval only"}</div><div className="ask-ans">{a.answer}</div>
          {a.caveats && <div className="xs muted mt8">{a.caveats}</div>}</div>
        <div className="sec-t">Sources</div>
        {a.chunks.map((c, i) => <div key={c.chunk_id} className="ask-src" style={cited(`S${i + 1}`) ? { borderColor: "var(--acc)" } : undefined}>
          <div className="xs dim mb8"><b>[S{i + 1}]</b> <FileText size={11} /> {c.document} · p. {c.page} · {c.section} · similarity {c.score}</div>{c.text}</div>)}
        {a.relationships.length > 0 && <><div className="sec-t">Graph relationships</div>
          {a.relationships.map((r, i) => <button key={r.edge_id} className="rel" style={cited(`R${i + 1}`) ? { borderColor: "var(--acc)" } : undefined} onClick={() => ctx.selectEdge(r.edge_id)}>
            <b className="xs">[R{i + 1}]</b><span className="trunc">{r.subject}</span><span className="rt">{r.type}</span><span className="trunc grow">{r.object}</span><span className="xs dim">{r.status}</span></button>)}</>}
      </>}
      {!a && !busy && <p className="xs dim">Answers are grounded in passages retrieved by vector search (pgvector) plus a one-hop neighborhood of matching entities in Neo4j, and cite them as [S#] and [R#].</p>}
    </div>
  </div>;
}
