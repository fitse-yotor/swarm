import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, CircleDot, Crosshair, Edit3, FileText, Link2, Lock, Merge, Pin, PlusCircle, X } from "lucide-react";
import { api, type Evidence, type GEdge, type GNode, type HistoryItem } from "../../api";
import { useAuth } from "../../auth";
import { ConfBar, EtypeTag, ShapeIcon, StatusBadge } from "../../components/ui";
import { COMM_COL, ago } from "../../vocab";
import type { GraphCtx } from "../GraphExplorer";
import { SourceDrawer, type Highlight } from "../Documents";
import { CorrectEdgeModal, EditNodeModal, MergeNodeModal } from "./Modals";

export function useEvidence(caseId: string, ids: string[]) {
  return useQuery({ queryKey: ["evidence", caseId, ids.join(",")], enabled: ids.length > 0,
    queryFn: () => api.get<Evidence[]>(`/cases/${caseId}/evidence?${ids.map(i => `ids=${encodeURIComponent(i)}`).join("&")}`) });
}

export function EvidenceCard({ ev, tag, onOpen }: { ev: Evidence; tag?: string; onOpen: (h: Highlight & { doc: string }) => void }) {
  const counter = ev.support_type === "contradicts";
  return <button className="ev" style={counter ? { borderColor: "var(--warn)" } : undefined} onClick={() => onOpen({ doc: ev.document_id, chunk_id: ev.chunk_id, char_start: ev.char_start, char_end: ev.char_end })}>
    <div className="quote">“{ev.quote}”</div>
    <div className="ev-src"><FileText size={12} /><span className="trunc">{ev.document}</span><span>p. {ev.page}{ev.section && ` · ${ev.section}`}</span><span className="grow" />
      {counter ? <span style={{ color: "var(--warn)" }}>counter-evidence</span> : tag && <span className="rt" style={{ fontSize: 10 }}>{tag}</span>}</div>
    <div className="xs dim mt8">{ev.extractor.startsWith("analyst") ? `Cited by ${ev.extractor.slice(8)}` : `Extracted by ${ev.extractor}`} · chars {ev.char_start}–{ev.char_end}</div>
  </button>;
}

function History({ ctx, objectId }: { ctx: GraphCtx; objectId: string }) {
  const h = useQuery({ queryKey: ["history", ctx.caseId, ctx.g.version.id, objectId],
    queryFn: () => api.get<HistoryItem[]>(`/cases/${ctx.caseId}/graph/versions/${ctx.g.version.id}/history?object_id=${objectId}`) });
  return <div className="sec"><div className="sec-t">Review history</div><div className="hist">
    {(h.data ?? []).map(x => <div key={x.id}><b style={{ fontWeight: 500 }}>{x.action}</b><div className="xs dim">{x.actor} · {ago(x.at)}</div></div>)}
    {h.data?.length === 0 && <div className="xs dim">Extracted — no review decisions yet.</div>}</div></div>;
}

export function Inspector({ ctx, sel, selEdge, caseTitle, onExpand, onModal }: {
  ctx: GraphCtx; sel: string | null; selEdge: string | null; caseTitle: string; onExpand: (id: string) => void; onModal: (m: string) => void;
}) {
  const { can } = useAuth();
  const { g, caseId, run, select, selectEdge, canvas } = ctx;
  const [local, setLocal] = useState<string | null>(null);
  const [reading, setReading] = useState<(Highlight & { doc: string }) | null>(null);
  const [, force] = useState(0);
  const ed = g.editable, locked = g.version.status === "approved";
  const vurl = `/cases/${caseId}/graph/versions/${g.version.id}`;
  const node = sel ? g.nodes.find(n => n.id === sel) : undefined;
  const edge = selEdge ? g.edges.find(e => e.id === selEdge) : undefined;
  const rels = node ? g.edges.filter(e => e.s === node.id || e.o === node.id) : [];
  const evIds = node ? [...new Set([...node.evidence_ids, ...rels.flatMap(e => e.evidence_ids)])].slice(0, 12) : edge ? edge.evidence_ids : [];
  const ev = useEvidence(caseId, evIds);
  const byId = (id: string) => g.nodes.find(n => n.id === id);

  const setNode = (n: GNode, status: string) => run(() => api.patch(`${vurl}/nodes/${n.id}`, { status }), `${status === "approved" ? "Approved" : "Rejected"} ${n.name}`);
  const setEdge = (e: GEdge, status: string) => run(() => api.patch(`${vurl}/edges/${e.id}`, { status }), `${status === "approved" ? "Approved" : "Rejected"}: ${byId(e.s)?.name} ${e.type} ${byId(e.o)?.name}`);
  const lockNote = locked ? <div className="sec"><div className="row small" style={{ color: "var(--ok)" }}><Lock size={14} />Approved version — read only. Start a new draft to make changes.</div></div>
    : !can("graph.review") ? <div className="sec xs dim">Your role can view but not review claims.</div> : null;
  const reader = reading && <SourceDrawer docId={reading.doc} highlight={reading} onClose={() => setReading(null)} />;

  if (node) {
    const conflicts = rels.filter(e => e.status === "conflict");
    const dup = node.dup_of ? byId(node.dup_of) : undefined;
    const comm = g.communities.find(c => c.id === node.community);
    return <>
      <div className="insp-head"><div className="row mb8"><EtypeTag type={node.type} /><span className="grow" /><StatusBadge status={node.status} /></div>
        <div className="insp-title">{node.name}</div>{node.description && <p className="small muted mt8">{node.description}</p>}
        <div className="row wrap mt12" style={{ gap: 6 }}>
          {ed && <><button className="btn sm ok" disabled={node.status === "approved"} onClick={() => setNode(node, "approved")}><Check />Approve</button>
            <button className="btn sm danger" disabled={node.status === "rejected"} onClick={() => setNode(node, "rejected")}><X />Reject</button>
            <button className="btn sm" onClick={() => setLocal("edit")}><Edit3 />Edit</button><button className="btn sm" onClick={() => setLocal("merge")}><Merge />Merge</button>
            <button className="btn sm" onClick={() => onModal("addEdge")}><Link2 />Relate</button></>}
          <button className="btn sm" title="Show this entity and its neighbors" onClick={() => onExpand(node.id)}><PlusCircle />Expand</button>
          <button className="btn sm" onClick={() => { canvas.current?.togglePin(node.id); force(x => x + 1); }}><Pin />{canvas.current?.isPinned(node.id) ? "Unpin" : "Pin"}</button>
          <button className="btn sm icon" title="Center" aria-label="Center on entity" onClick={() => canvas.current?.focus(node.id)}><Crosshair /></button>
          {node.community && <button className="btn sm icon" title="Isolate community" aria-label="Isolate community" onClick={() => ctx.isolateCommunity(node.community!)}><CircleDot /></button>}</div></div>
      {lockNote}
      {dup && <div className="sec"><div className="demo-flag" style={{ borderStyle: "solid" }}><Merge /><span>Possible duplicate of <b>{dup.name}</b>.{" "}
        {ed && <><button className="btn sm" onClick={() => run(() => api.post(`${vurl}/merge`, { keep_id: dup.id, drop_ids: [node.id] }), `Merged into ${dup.name}`).then(() => select(dup.id))}>Merge</button>{" "}
          <button className="btn sm ghost" onClick={() => run(() => api.post(`${vurl}/nodes/${node.id}/not-duplicate`), "Marked distinct")}>Not a duplicate</button></>}</span></div></div>}
      {conflicts.length > 0 && <div className="sec"><div className="sec-t" style={{ color: "var(--warn)" }}><AlertTriangle size={13} />Conflicting evidence</div>
        {conflicts.map(e => <button key={e.id} className="rel" onClick={() => selectEdge(e.id)}><span className="rt">{e.type}</span><span className="trunc">{byId(e.s === node.id ? e.o : e.s)?.name}</span></button>)}</div>}
      <div className="sec"><div className="sec-t">Confidence</div><ConfBar value={node.confidence} /></div>
      <div className="sec"><dl className="kv">{node.aliases.length > 0 && <><dt>Aliases</dt><dd>{node.aliases.join(", ")}</dd></>}
        {Object.entries(node.attrs).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
        <dt>Community</dt><dd>{comm?.name ?? "—"}</dd><dt>Connections</dt><dd>{node.degree}</dd></dl></div>
      <div className="sec"><div className="sec-t">Relationships ({rels.length})</div>{rels.map(e => { const out = e.s === node.id, o = byId(out ? e.o : e.s);
        return <button key={e.id} className="rel" onClick={() => selectEdge(e.id)} title={e.status}><span style={{ color: "var(--tx3)" }}>{out ? "→" : "←"}</span>
          <span className="rt" style={e.status === "conflict" ? { color: "var(--warn)" } : e.status === "rejected" ? { color: "var(--err)", textDecoration: "line-through" } : undefined}>{e.type}</span>
          {o && <ShapeIcon type={o.type} size={10} />}<span className="trunc grow">{o?.name}</span><span className="xs dim">{Math.round(e.confidence * 100)}%</span></button>; })}
        {!rels.length && <p className="xs dim">No relationships.</p>}</div>
      <div className="sec"><div className="sec-t">Evidence excerpts</div>{ev.isLoading && <p className="xs dim">Loading…</p>}
        {(ev.data ?? []).map(x => <EvidenceCard key={x.id} ev={x} tag={rels.find(e => e.evidence_ids.includes(x.id))?.type ?? "mention"} onOpen={setReading} />)}
        {!evIds.length && <p className="xs dim">No source evidence. This entity is unsupported until linked to a source.</p>}</div>
      <div className="sec"><div className="sec-t">Source documents</div>{node.doc_ids.map(d => <div key={d} className="ent-row"><FileText size={13} /><span className="trunc">{g.documents[d] ?? d}</span></div>)}
        {!node.doc_ids.length && <p className="xs dim">None</p>}</div>
      <History ctx={ctx} objectId={node.id} />
      {local === "edit" && <EditNodeModal ctx={ctx} node={node} onClose={() => setLocal(null)} />}
      {local === "merge" && <MergeNodeModal ctx={ctx} node={node} onClose={() => setLocal(null)} />}
      {reader}
    </>;
  }

  if (edge) {
    const a = byId(edge.s), b = byId(edge.o);
    const unsupported = edge.flag === "unsupported" || !edge.evidence_ids.length;
    return <>
      <div className="insp-head"><div className="row mb8"><span className="xs dim">Relationship · {edge.epistemic_status ?? "reported"}</span><span className="grow" /><StatusBadge status={edge.status} /></div>
        <div className="col" style={{ gap: 6 }}>
          {a && <button className="ent-row" onClick={() => { select(a.id); canvas.current?.focus(a.id); }}><ShapeIcon type={a.type} /><b className="trunc">{a.name}</b><span className="xs dim" style={{ marginLeft: "auto" }}>subject</span></button>}
          <div className="row" style={{ paddingLeft: 10 }}><span style={{ color: "var(--tx3)" }}>{edge.directed ? "↓" : "↕"}</span><span className="rt" style={{ fontSize: 12, padding: "2px 7px", border: "1px solid var(--bd)", borderRadius: 4, fontWeight: 600 }}>{edge.type}</span></div>
          {b && <button className="ent-row" onClick={() => { select(b.id); canvas.current?.focus(b.id); }}><ShapeIcon type={b.type} /><b className="trunc">{b.name}</b><span className="xs dim" style={{ marginLeft: "auto" }}>object</span></button>}</div>
        {ed && <div className="row wrap mt12" style={{ gap: 6 }}><button className="btn sm ok" disabled={edge.status === "approved" || unsupported} title={unsupported ? "Add a citation first" : ""} onClick={() => setEdge(edge, "approved")}><Check />Approve</button>
          <button className="btn sm danger" disabled={edge.status === "rejected"} onClick={() => setEdge(edge, "rejected")}><X />Reject</button>
          <button className="btn sm" onClick={() => setLocal("correct")}><Edit3 />Correct</button></div>}</div>
      {lockNote}
      {edge.status === "conflict" && <div className="sec"><div className="demo-flag" style={{ borderStyle: "solid" }}><AlertTriangle /><span>Sources disagree on this claim. Compare the excerpts below before approving or rejecting.</span></div></div>}
      {unsupported && <div className="sec"><div className="demo-flag" style={{ borderStyle: "solid", color: "var(--err)", borderColor: "var(--err)", background: "var(--err-s)" }}><AlertTriangle /><span>Unsupported claim — no verified source span backs it. Reject it or add a citation.</span></div></div>}
      <div className="sec"><dl className="kv"><dt>Direction</dt><dd>{edge.directed ? "Subject → object" : "Undirected"}</dd><dt>Confidence</dt><dd><ConfBar value={edge.confidence} /></dd>
        {edge.statement && <><dt>Statement</dt><dd>{edge.statement}</dd></>}<dt>Valid from</dt><dd>{edge.valid_from || "Not stated in sources"}</dd><dt>Valid to</dt><dd>{edge.valid_to || "Not stated"}</dd></dl></div>
      <div className="sec"><div className="sec-t">Supporting evidence ({edge.evidence_ids.length})</div>{(ev.data ?? []).map(x => <EvidenceCard key={x.id} ev={x} onOpen={setReading} />)}
        {!edge.evidence_ids.length && <p className="xs dim">None</p>}</div>
      <History ctx={ctx} objectId={edge.id} />
      {local === "correct" && <CorrectEdgeModal ctx={ctx} edge={edge} onClose={() => setLocal(null)} />}
      {reader}
    </>;
  }

  const top = [...g.nodes].sort((x, y) => y.degree - x.degree).slice(0, 7);
  const open = (s: string) => s === "pending" || s === "conflict";
  const tot = g.nodes.length + g.edges.length, done = tot - g.nodes.filter(n => open(n.status)).length - g.edges.filter(e => open(e.status)).length;
  const v = g.version;
  return <>
    <div className="insp-head"><div className="xs dim mb8">Graph {v.label} · {v.status === "approved" ? `approved by ${v.approved_by} ${ago(v.approved_at!)}` : `draft · ${v.note}`}</div>
      <div className="insp-title">{caseTitle}</div><p className="small muted mt8">Select an entity or relationship to inspect its evidence. Shift-click to select several. Double-click to expand neighbors.</p>
      {v.extractor && <p className="xs dim mt8">Extractor: {v.extractor}{v.content_hash && <> · sha256 <span className="mono">{v.content_hash.slice(0, 12)}…</span></>}</p>}</div>
    {lockNote}
    <div className="sec"><div className="sec-t">Review progress</div><div className={`prog ${done === tot ? "ok" : ""}`}><i style={{ width: `${tot ? (done / tot) * 100 : 0}%` }} /></div>
      <div className="row small mt8"><span className="grow muted">{done} of {tot} claims reviewed</span>{done < tot && <Link to={`/cases/${caseId}/review`} className="small">Open queue</Link>}</div></div>
    <div className="sec"><div className="sec-t">Most connected</div>{top.map(n => <button key={n.id} className="ent-row" onClick={() => { select(n.id); canvas.current?.focus(n.id); }}><ShapeIcon type={n.type} /><span className="grow trunc">{n.name}</span><span className="xs dim">{n.degree}</span></button>)}</div>
    <div className="sec"><div className="sec-t">Communities</div>{g.communities.slice(0, 8).map((cm, i) => <button key={cm.id} className="ent-row" onClick={() => ctx.isolateCommunity(cm.id)}>
      <span style={{ width: 9, height: 9, borderRadius: "50%", background: COMM_COL[i % COMM_COL.length] }} /><span className="grow trunc">{cm.name}</span><span className="xs dim">{cm.size}</span></button>)}</div>
  </>;
}
