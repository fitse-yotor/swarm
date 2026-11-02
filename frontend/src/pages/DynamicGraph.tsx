import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bookmark, Clock, FlaskConical, GitCompare, History, Maximize2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Search, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { api, type DiffSide, type DynEdge, type DynGraph, type DynNode, type EntityContext, type Evidence, type GraphEvent, type Layer, type Reaction, type ReactionDetail,
  type Simulation, type Snapshot, type SnapshotDiff, type Timeline } from "../api";
import { useAuth } from "../auth";
import { ConfBar, Empty, Modal, ShapeIcon, Spinner, StatusBadge, useToast } from "../components/ui";
import SigmaCanvas, { type CanvasEdge, type CanvasHandle, type CanvasNode } from "../graph/SigmaCanvas";
import { useTheme } from "../hooks";
import { ETYPES, fmtDate, typeColor } from "../vocab";
import { useCase } from "./CaseDetail";

type View = { kind: "live" } | { kind: "snapshot"; id: string } | { kind: "seq"; seq: number; step: number };
type Sel = { kind: "node" | "edge" | "event"; id: string } | null;

const LAYER_META: Record<Layer, { label: string; badge: string; cls: string; note: string }> = {
  research: { label: "Research graph", badge: "Sourced", cls: "b-ok", note: "Approved entities and relationships grounded in uploaded sources." },
  reaction: { label: "Reactions", badge: "AI-generated hypothesis", cls: "b-warn", note: "Hypotheses about how actors might respond. Not verified." },
  simulation: { label: "Simulation", badge: "Simulation-generated", cls: "b-syn", note: "Synthetic agents and their simulated interactions." },
};
const EVENT_LABEL: Record<string, string> = { STATEMENT_PUBLISHED: "Statement", RESPONDED_TO: "Response", REACTED_TO_EVENT: "Reaction to event", POSITION_CHANGED: "Position change",
  RELATIONSHIP_FORMED: "New relationship", RELATIONSHIP_STRENGTHENED: "Relationship stronger", RELATIONSHIP_WEAKENED: "Relationship weaker", ALLIANCE_FORMED: "Alliance" };
const REASON_LABEL: Record<string, string> = { research_approved: "Research graph approved", reactions_generated: "Reactions generated", simulation_start: "Simulation start", checkpoint: "Checkpoint",
  simulation_complete: "Simulation complete", manual: "Analyst checkpoint" };
const FIELD_LABEL: Record<string, string> = { label: "name", type: "type", status: "status", confidence: "confidence", stance: "position", strength: "strength" };
const canvasStatus = (x: DynNode | DynEdge) => (x.layer === "research" ? (x.status === "manual" ? "manual" : "approved") : x.layer === "reaction"
  ? (x.status === "selected" ? "selected" : x.status === "excluded" ? "excluded" : "hypothesis") : "simulated") as CanvasNode["status"];
const rawAgent = (id: string) => id.replace(/^sim:/, "");

export default function DynamicGraph() {
  const { caseId = "" } = useParams();
  const [sp] = useSearchParams();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const theme = useTheme();
  const canvas = useRef<CanvasHandle>(null);
  const c = useCase(caseId);

  const [view, setView] = useState<View>({ kind: "live" });
  const [sel, setSel] = useState<Sel>(null);
  const [layers, setLayers] = useState<Set<Layer>>(new Set(["research", "reaction", "simulation"]));
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [statements, setStatements] = useState(false);
  const [simId, setSimId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [left, setLeft] = useState(true);
  const [right, setRight] = useState(true);
  const [agentF, setAgentF] = useState("");
  const [typeF, setTypeF] = useState("");
  const [modal, setModal] = useState<"compare" | "checkpoint" | null>(null);
  const [hi, setHi] = useState<Set<string> | null>(null);

  const sims = useQuery({ queryKey: ["sims", caseId], queryFn: () => api.get<Simulation[]>(`/cases/${caseId}/simulations`) });
  const simQ = simId ? `&simulation_id=${simId}` : "";
  const gUrl = `/cases/${caseId}/dynamic-graph?statements=${statements}${simQ}${view.kind === "snapshot" ? `&snapshot_id=${view.id}` : view.kind === "seq" ? `&upto_seq=${view.seq}` : ""}`;
  const graph = useQuery({ queryKey: ["dyn", caseId, gUrl], queryFn: () => api.get<DynGraph>(gUrl), placeholderData: keepPreviousData });
  const tl = useQuery({ queryKey: ["dyn-tl", caseId, simId], queryFn: () => api.get<Timeline>(`/cases/${caseId}/timeline?limit=1000${simQ}`) });
  const g = graph.data;
  const T = tl.data;
  const historical = view.kind !== "live";

  // positions are keyed by case, so the same nodes stay where they are as you move through time
  const { nodes, edges, degree } = useMemo(() => {
    const deg = new Map<string, number>();
    for (const e of g?.edges ?? []) { deg.set(e.s, (deg.get(e.s) ?? 0) + 1); deg.set(e.o, (deg.get(e.o) ?? 0) + 1); }
    const n: CanvasNode[] = (g?.nodes ?? []).map(x => ({ id: x.id, label: x.label, type: x.type, status: canvasStatus(x), fill: typeColor(x.type), community: null,
      size: x.layer === "research" ? 11 + Math.min(10, deg.get(x.id) ?? 0) : x.type === "statement" ? 7 : x.type === "agent" ? 10 + Math.abs(x.stance ?? 0) * 6 : 10 }));
    const e: CanvasEdge[] = (g?.edges ?? []).map(x => ({ id: x.id, s: x.s, o: x.o, status: canvasStatus(x), directed: x.directed, label: x.type }));
    return { nodes: n, edges: e, degree: deg };
  }, [g]);
  const byId = useMemo(() => new Map((g?.nodes ?? []).map(n => [n.id, n])), [g]);
  const hidden = useMemo(() => new Set((g?.nodes ?? []).filter(n => !layers.has(n.layer) || hiddenTypes.has(n.type)).map(n => n.id)), [g, layers, hiddenTypes]);
  const matches = useMemo(() => (q.trim() ? (g?.nodes ?? []).filter(n => !hidden.has(n.id) && n.label.toLowerCase().includes(q.trim().toLowerCase())) : []), [g, q, hidden]);
  const highlight = useMemo(() => (hi ? hi : matches.length ? new Set(matches.map(m => m.id)) : null), [hi, matches]);
  const presentTypes = useMemo(() => [...new Set((g?.nodes ?? []).map(n => n.type))], [g]);
  const state = useMemo(() => ({ hidden, selected: new Set(sel?.kind === "node" ? [sel.id] : []), selEdge: sel?.kind === "edge" ? sel.id : null, highlight, labels: "auto" as const }), [hidden, sel, highlight]);

  // on a phone the inspector sits below the graph, so bring it into view when something is selected
  const reveal = () => { if (window.innerWidth <= 820) setTimeout(() => document.querySelector(".dyn-inspector")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80); };
  const select = (id: string) => { setSel({ kind: "node", id }); setRight(true); canvas.current?.focus(id); reveal(); };
  const focusParam = sp.get("focus");
  useEffect(() => { if (focusParam && g && byId.has(focusParam)) { const t = setTimeout(() => select(focusParam), 400); return () => clearTimeout(t); } }, [focusParam, g?.meta.research.version_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- timeline derived data (events filtered on the client so the slider always knows every step)
  const events = useMemo(() => (T?.items ?? []).filter((i): i is Extract<typeof i, { kind: "event" }> => i.kind === "event"), [T]);
  const snaps = useMemo(() => (T?.items ?? []).filter((i): i is Extract<typeof i, { kind: "snapshot" }> => i.kind === "snapshot").map(i => i.snapshot), [T]);
  const shown = useMemo(() => events.filter(e => (!agentF || e.event.actor_ids.includes(agentF)) && (!typeF || e.event.event_type === typeF)), [events, agentF, typeF]);
  const lastSeqAt = (step: number) => events.filter(e => e.event.step <= step).reduce((m, e) => Math.max(m, e.event.seq), 0);
  const steps = T?.steps ?? [];
  const sliderIdx = view.kind === "seq" ? Math.max(0, steps.findIndex(s => s.step >= view.step)) : steps.length - 1;

  const refreshAll = () => { qc.invalidateQueries({ queryKey: ["dyn", caseId] }); qc.invalidateQueries({ queryKey: ["dyn-tl", caseId] }); qc.invalidateQueries({ queryKey: ["dyn-snaps", caseId] }); };
  const live = () => { setView({ kind: "live" }); setHi(null); };

  const sidebar = <aside className="dyn-side" aria-label="Layers and filters">
    <div className="sec"><div className="sec-t">Layers</div>
      {(Object.keys(LAYER_META) as Layer[]).map(l => <label key={l} className="dyn-layer"><input type="checkbox" checked={layers.has(l)} onChange={() => setLayers(s => { const n = new Set(s); n.has(l) ? n.delete(l) : n.add(l); return n; })} />
        <span className="grow"><b className="small">{LAYER_META[l].label}</b><span className="xs dim" style={{ display: "block" }}>{LAYER_META[l].note}</span>
          <span className={`badge ${LAYER_META[l].cls}`} style={{ marginTop: 4 }}><i />{LAYER_META[l].badge}</span></span>
        <span className="xs dim">{g?.counts[l].nodes ?? 0}</span></label>)}
      <label className="chk mt8"><input type="checkbox" checked={statements} onChange={e => setStatements(e.target.checked)} />Show simulated statements</label></div>
    <div className="sec"><div className="sec-t">Simulation run</div>
      <select className="sel" aria-label="Simulation run" value={simId ?? ""} onChange={e => { setSimId(e.target.value || null); live(); }}>
        <option value="">Latest run{T?.simulation ? ` · ${T.simulation.name}` : ""}</option>{(sims.data ?? []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
    <div className="sec"><div className="sec-t">Search</div>
      <div className="row"><Search size={14} className="dim" /><input className="inp" placeholder="Find an entity, reaction or agent" aria-label="Search the graph" value={q} onChange={e => setQ(e.target.value)} /></div>
      {q.trim() && <div className="mt8">{matches.length ? matches.slice(0, 12).map(m => <button key={m.id} className="ent-row" onClick={() => select(m.id)}><ShapeIcon type={m.type} /><span className="grow trunc">{m.label}</span><span className="xs dim">{ETYPES[m.type].label}</span></button>)
        : <p className="xs dim">Nothing matches.</p>}</div>}</div>
    <div className="sec"><div className="sec-t">Node types</div>
      {presentTypes.map(t => <label key={t} className="fl-item"><input type="checkbox" checked={!hiddenTypes.has(t)} onChange={() => setHiddenTypes(s => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; })} />
        <ShapeIcon type={t} /><span className="grow">{ETYPES[t].label}</span><span className="xs dim">{(g?.nodes ?? []).filter(n => n.type === t).length}</span></label>)}
      <p className="xs dim mt8">Shape shows the type, and the ring shows status: solid = approved, dashed = hypothesis, dotted = simulated.</p></div>
  </aside>;

  const banner = historical && g && <div className="dyn-banner" role="status"><History />
    <span className="grow">{view.kind === "snapshot" && g.view.snapshot ? <>Viewing <b>snapshot #{g.view.snapshot.number}</b> · {REASON_LABEL[g.view.snapshot.reason] ?? g.view.snapshot.reason} · {fmtDate(g.view.snapshot.created_at)}
      {g.view.snapshot.integrity === "verified" && <span className="badge b-ok" style={{ marginLeft: 6 }}><i />unchanged since saved</span>}</>
      : view.kind === "seq" ? <>Viewing the graph <b>as of step {view.step}</b> (event #{view.seq})</> : null} — <b>this is not the current graph.</b></span>
    <button className="btn sm" onClick={live}><Undo2 />Return to current graph</button></div>;

  const toolbar = <div className="dyn-bar">
    <div className="row wrap" style={{ gap: 8 }}>
      <b className="trunc" style={{ maxWidth: 260 }}>{c.data?.title ?? "Case"}</b>
      {g && <><span className="badge b-ok" title="Approved research graph version"><i />Research {g.meta.research.version_label ?? "—"}</span>
        {g.meta.reactions.run_id && <span className="badge b-warn" title="Reaction run"><i />Reactions #{g.meta.reactions.run_number}{g.meta.reactions.mode === "demo-rules" ? " · demo" : ""}</span>}
        {g.meta.simulation && <span className="badge b-syn" title="Simulation graph version"><i />{g.meta.simulation.run_name} · step {g.meta.simulation.step} · v{g.meta.simulation.graph_version}</span>}
        <span className={`badge ${historical ? "b-warn" : "b-ok"}`}><i />{historical ? "Historical view" : "Live"}</span></>}
      {graph.isFetching && <Spinner />}</div>
    <span className="grow" />
    <div className="tb" role="toolbar" aria-label="View"><button aria-label="Zoom in" title="Zoom in" onClick={() => canvas.current?.zoom(1.25)}><ZoomIn /></button>
      <button aria-label="Zoom out" title="Zoom out" onClick={() => canvas.current?.zoom(0.8)}><ZoomOut /></button>
      <button aria-label="Fit graph" title="Fit to view" onClick={() => canvas.current?.fit()}><Maximize2 /></button>
      <button aria-label="Reset layout" title="Reset layout" onClick={() => canvas.current?.relayout("force", true)}><Undo2 /></button></div>
    <button className="btn sm" onClick={() => setModal("compare")}><GitCompare />Compare</button>
    {can("graph.review") && <button className="btn sm" onClick={() => setModal("checkpoint")}><Bookmark />Save checkpoint</button>}
    <button className="btn ghost sm icon" aria-label={left ? "Hide filters" : "Show filters"} onClick={() => setLeft(!left)}>{left ? <PanelLeftClose /> : <PanelLeftOpen />}</button>
    <button className="btn ghost sm icon" aria-label={right ? "Hide inspector" : "Show inspector"} onClick={() => setRight(!right)}>{right ? <PanelRightClose /> : <PanelRightOpen />}</button>
  </div>;

  let canvasArea: ReactNode;
  if (graph.isError) canvasArea = <Empty icon={<AlertTriangle />} title="Could not load the graph" text={(graph.error as Error).message}><button className="btn" onClick={() => graph.refetch()}>Try again</button></Empty>;
  else if (!g) canvasArea = <div className="center-fill"><Spinner /></div>;
  else if (g.meta.research.unavailable && !g.nodes.length) canvasArea = <Empty icon={<AlertTriangle />} title="The research graph could not be read" text="The graph database is not reachable, so the research layer cannot be drawn. Reactions and simulation history are still stored."><button className="btn" onClick={() => graph.refetch()}>Try again</button></Empty>;
  else if (!g.meta.research.version_id) canvasArea = <Empty icon={<Clock />} title="No approved graph yet" text="The case graph appears here once a research graph version is approved. Reactions and simulations build on it."><Link className="btn pri" to={`/cases/${caseId}/graph`}>Open the research graph</Link></Empty>;
  else canvasArea = <SigmaCanvas ref={canvas} nodes={nodes} edges={edges} state={state} layout="force" positionsKey={`dyn-${caseId}`} theme={theme}
    ariaLabel={`Case graph: ${g.nodes.length} nodes in ${layers.size} layer${layers.size === 1 ? "" : "s"}. Use the search box in the filter panel for a keyboard-accessible list.`}
    onNode={id => select(id)} onEdge={id => { setSel({ kind: "edge", id }); setRight(true); reveal(); }} onBlank={() => setSel(null)} onDouble={id => canvas.current?.focus(id)} onHover={() => undefined} />;

  return <div className={`dyn ${historical ? "is-past" : ""} ${left ? "" : "no-left"} ${right ? "" : "no-right"}`}>
    {toolbar}
    {banner}
    {left && sidebar}
    <section className="dyn-canvas" aria-label="Graph canvas">{canvasArea}
      {g && <div className="legend-card" style={{ left: 12, bottom: 12 }}><h5>Provenance</h5>
        <div className="lg-grid" style={{ gridTemplateColumns: "1fr" }}>{(Object.keys(LAYER_META) as Layer[]).filter(l => layers.has(l)).map(l => <span key={l} className="lg"><span className={`badge ${LAYER_META[l].cls}`}><i />{LAYER_META[l].badge}</span></span>)}</div></div>}
    </section>
    {right && <aside className="dyn-inspector" aria-label="Inspector"><Inspector caseId={caseId} sel={sel} g={g} byId={byId} degree={degree} simId={simId ?? T?.simulation?.id ?? null} events={events.map(e => e.event)}
      onSelect={select} onEvent={e => { setSel({ kind: "event", id: e.id }); setView({ kind: "seq", seq: e.seq, step: e.step }); }} /></aside>}
    <TimelinePanel T={T} loading={tl.isLoading} error={tl.isError ? (tl.error as Error).message : null} retry={() => tl.refetch()} shown={shown} snaps={snaps} view={view} sliderIdx={sliderIdx} steps={steps}
      agentF={agentF} typeF={typeF} setAgentF={setAgentF} setTypeF={setTypeF} sel={sel} historical={historical} live={live}
      onSnap={s => { setView({ kind: "snapshot", id: s.id }); setHi(null); }} onScrub={i => (i >= steps.length - 1 ? live() : setView({ kind: "seq", seq: lastSeqAt(steps[i].step), step: steps[i].step }))}
      onEvent={e => { setSel({ kind: "event", id: e.id }); setRight(true); setView({ kind: "seq", seq: e.seq, step: e.step }); }} />
    {modal === "compare" && <CompareModal caseId={caseId} simId={simId} onClose={() => setModal(null)} onShow={(ref, ids) => { setView(ref === "live" ? { kind: "live" } : { kind: "snapshot", id: ref }); setHi(ids); setModal(null); }} />}
    {modal === "checkpoint" && <CheckpointModal caseId={caseId} simId={simId} onClose={() => setModal(null)} onSaved={s => { setModal(null); refreshAll(); toast(`Checkpoint #${s.number} saved. Snapshots cannot be edited.`, "ok"); }} />}
  </div>;
}

// ---------------------------------------------------------------- inspector
function Section({ title, children }: { title: string; children: ReactNode }) { return <div className="sec"><div className="sec-t">{title}</div>{children}</div>; }

function Inspector({ caseId, sel, g, byId, degree, simId, events, onSelect, onEvent }: {
  caseId: string; sel: Sel; g: DynGraph | undefined; byId: Map<string, DynNode>; degree: Map<string, number>; simId: string | null; events: GraphEvent[];
  onSelect: (id: string) => void; onEvent: (e: GraphEvent) => void;
}) {
  if (!sel || !g) return <div className="sec"><h3>Inspector</h3><p className="small muted mt8">Select a node, a relationship or a timeline event to see what it is, where it came from and what supports it.</p>
    <ul className="small muted" style={{ paddingLeft: 18 }}><li><b>Sourced</b> items link to the passages that support them.</li><li><b>Hypotheses</b> are generated and unverified.</li><li><b>Simulated</b> items are synthetic agent behaviour.</li></ul></div>;
  if (sel.kind === "event") return <EventView id={sel.id} events={events} onEvent={onEvent} />;
  if (sel.kind === "edge") { const e = g.edges.find(x => x.id === sel.id); return e ? <EdgeView caseId={caseId} e={e} byId={byId} onSelect={onSelect} /> : <p className="sec small muted">That relationship is not in this view.</p>; }
  const n = byId.get(sel.id);
  if (!n) return <p className="sec small muted">That item is not in this view of the graph.</p>;
  return <NodeView caseId={caseId} n={n} g={g} byId={byId} degree={degree.get(n.id) ?? 0} simId={simId} events={events} onSelect={onSelect} onEvent={onEvent} />;
}

function Provenance({ layer }: { layer: Layer }) { return <span className={`badge ${LAYER_META[layer].cls}`}><i />{LAYER_META[layer].badge}</span>; }

function EvidenceList({ caseId, ids }: { caseId: string; ids: string[] }) {
  const ev = useQuery({ queryKey: ["dyn-ev", caseId, ids.join(",")], enabled: ids.length > 0, queryFn: () => api.get<Evidence[]>(`/cases/${caseId}/evidence?${ids.map(i => `ids=${i}`).join("&")}`) });
  if (!ids.length) return <p className="xs dim">No source passage is linked.</p>;
  if (ev.isLoading) return <p className="xs dim">Loading evidence…</p>;
  if (ev.isError) return <p className="xs" style={{ color: "var(--err)" }}>{(ev.error as Error).message}</p>;
  return <>{(ev.data ?? []).map(e => <blockquote key={e.id} className="quote"><p>“{e.quote}”</p><div className="xs dim">{e.document} · p.{e.page}{e.support_type === "contradicts" ? " · contradicts" : ""}</div></blockquote>)}</>;
}

function NodeView({ caseId, n, g, byId, degree, simId, events, onSelect, onEvent }: { caseId: string; n: DynNode; g: DynGraph; byId: Map<string, DynNode>; degree: number; simId: string | null;
  events: GraphEvent[]; onSelect: (id: string) => void; onEvent: (e: GraphEvent) => void }) {
  const rels = g.edges.filter(e => e.s === n.id || e.o === n.id);
  const ctx = useQuery({ queryKey: ["dyn-ctx", caseId, n.id, simId], enabled: n.layer === "research", queryFn: () => api.get<EntityContext>(`/cases/${caseId}/graph-entity/${n.id}${simId ? `?simulation_id=${simId}` : ""}`) });
  const rx = useQuery({ queryKey: ["rx-detail", n.id], enabled: n.layer === "reaction", queryFn: () => api.get<ReactionDetail>(`/reactions/${n.id}`) });
  const mine = n.layer === "simulation" && n.type === "agent" ? events.filter(e => e.actor_ids.includes(rawAgent(n.id))).slice(-12).reverse() : [];
  const relList = <Section title={`Connections (${rels.length})`}>{rels.length ? rels.slice(0, 40).map(e => { const other = byId.get(e.s === n.id ? e.o : e.s);
    return <button key={e.id} className="ent-row" onClick={() => other && onSelect(other.id)}><span className="dim">{e.s === n.id ? "→" : "←"}</span><span className="xs">{e.type.replace(/_/g, " ").toLowerCase()}</span><span className="grow trunc">{other?.label ?? "?"}</span><Provenance layer={e.layer} /></button>; })
    : <p className="xs dim">No connections in the visible layers.</p>}</Section>;
  return <div>
    <div className="sec"><div className="row"><ShapeIcon type={n.type} /><h3 className="grow" style={{ wordBreak: "break-word" }}>{n.label}</h3></div>
      <div className="row wrap mt8" style={{ gap: 6 }}><span className="badge">{ETYPES[n.type].label}</span><Provenance layer={n.layer} />{n.layer === "research" && <StatusBadge status={n.status} />}
        {n.layer === "reaction" && <StatusBadge status={n.status === "generated" || n.status === "reviewed" ? "hypothesis" : n.status} />}</div></div>
    {n.layer === "research" && <>
      {n.description && <Section title="Description"><p className="small">{n.description}</p></Section>}
      <Section title="Confidence"><ConfBar value={n.confidence ?? 0} /></Section>
      <Section title="Source evidence"><EvidenceList caseId={caseId} ids={n.evidence_ids ?? []} /></Section>
      {relList}
      <Section title="Generated reactions">{ctx.isLoading ? <p className="xs dim">Loading…</p> : ctx.data?.reactions.length ? <>
        <p className="xs dim">AI-generated hypotheses, not verified.</p>{ctx.data.reactions.map((r: Reaction) => <button key={r.id} className="ent-row" onClick={() => onSelect(r.id)}><ShapeIcon type="reaction" /><span className="grow trunc">{r.title}</span><span className="xs dim">{r.status}</span></button>)}
        <Link className="btn sm mt8" to={`/cases/${caseId}/reactions`}>Review in Reactions</Link></> : <p className="xs dim">None for this entity.</p>}</Section>
      <Section title="Simulation events">{ctx.data?.events.length ? ctx.data.events.slice(0, 8).map(e => <button key={e.id} className="ent-row" onClick={() => onEvent(e)}><span className="pill">{EVENT_LABEL[e.event_type] ?? e.event_type}</span><span className="grow trunc xs">{e.description}</span></button>)
        : <p className="xs dim">No simulated agent represents this entity, or it has not acted.</p>}</Section></>}
    {n.layer === "reaction" && <>
      <div className="banner warn" style={{ margin: 12 }} role="note"><FlaskConical /><span><b>AI-generated hypothesis — not a verified statement or actual response.</b></span></div>
      {rx.isLoading && <p className="sec xs dim">Loading…</p>}
      {rx.data && <><Section title="Hypothesis"><p className="small" style={{ lineHeight: 1.5 }}>{rx.data.reaction.description}</p><p className="xs dim mt8">Category: {rx.data.reaction.category.replace(/_/g, " ")} · uncertainty {rx.data.reaction.uncertainty}</p><ConfBar value={rx.data.reaction.confidence} /></Section>
        <Section title="Reasoning">{<p className="small" style={{ lineHeight: 1.5 }}>{rx.data.reaction.reasoning}</p>}</Section>
        <Section title="Relies on">{rx.data.reaction.warnings.map(w => <div key={w} className="rx-warn-line"><AlertTriangle size={13} />{w}</div>)}
          {rx.data.reaction.assumptions.map(a => <div key={a.text} className="xs mt8"><b>{a.basis.replace(/_/g, " ")}:</b> {a.text}</div>)}</Section>
        <Section title="Source evidence"><EvidenceList caseId={caseId} ids={rx.data.reaction.evidence_ids} /></Section></>}
      <Section title="About"><button className="ent-row" onClick={() => n.actor_id && onSelect(n.actor_id)}><ShapeIcon type="organization" /><span className="grow">Show the actor</span></button>
        <Link className="btn sm mt8" to={`/cases/${caseId}/reactions?reaction=${n.id}`}>Open in Reactions</Link></Section></>}
    {n.layer === "simulation" && n.type === "agent" && <>
      <div className="banner" style={{ margin: 12 }} role="note"><span>Synthetic agent. Its behaviour is simulated, not a real person's actions.</span></div>
      <Section title="Position on the issue"><div className="xs dim">At start {fmt(n.stance0 ?? 0)} → now <b>{fmt(n.stance ?? 0)}</b></div><div className="stance-bar mt8"><i style={{ left: `${((n.stance ?? 0) + 1) * 50}%` }} /></div></Section>
      {relList}
      <Section title="Recent graph changes">{mine.length ? mine.map(e => <button key={e.id} className="ent-row" onClick={() => onEvent(e)}><span className="pill">{EVENT_LABEL[e.event_type] ?? e.event_type}</span><span className="grow trunc xs">{e.description}</span><span className="xs dim">s{e.step}</span></button>)
        : <p className="xs dim">No recorded changes.</p>}</Section></>}
    {n.layer === "simulation" && n.type === "statement" && <Section title="Simulated statement"><p className="small">{n.description}</p><p className="xs dim mt8">Round {n.step} · synthetic text, not reported speech.</p></Section>}
    <div className="sec xs dim">{degree} connection{degree === 1 ? "" : "s"} in this view</div>
  </div>;
}
const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;

function EdgeView({ caseId, e, byId, onSelect }: { caseId: string; e: DynEdge; byId: Map<string, DynNode>; onSelect: (id: string) => void }) {
  const s = byId.get(e.s), o = byId.get(e.o);
  return <div>
    <div className="sec"><h3>{e.type.replace(/_/g, " ").toLowerCase()}</h3><div className="row wrap mt8" style={{ gap: 6 }}><Provenance layer={e.layer} />{e.layer === "research" && <StatusBadge status={e.status} />}</div></div>
    <Section title="Between"><button className="ent-row" onClick={() => s && onSelect(s.id)}><ShapeIcon type={s?.type ?? "topic"} /><span className="grow trunc">{s?.label}</span></button>
      <div className="xs dim" style={{ padding: "2px 8px" }}>{e.directed ? "↓ directed" : "↔ undirected"}</div>
      <button className="ent-row" onClick={() => o && onSelect(o.id)}><ShapeIcon type={o?.type ?? "topic"} /><span className="grow trunc">{o?.label}</span></button></Section>
    {e.description && <Section title="Context"><p className="small">{e.description}</p></Section>}
    {e.confidence != null && <Section title="Confidence"><ConfBar value={e.confidence} /></Section>}
    {e.strength != null && <Section title="Strength"><p className="small">{e.strength} simulated interaction{e.strength === 1 ? "" : "s"} ({e.polarity})</p></Section>}
    {e.layer === "research" && <Section title="Source evidence"><EvidenceList caseId={caseId} ids={e.evidence_ids ?? []} /></Section>}
    {e.layer !== "research" && <div className="sec xs dim">{e.layer === "reaction" ? "Links a hypothesis to the actor it is about." : "Created by simulated agent behaviour; it never alters research relationships."}</div>}
  </div>;
}

function EventView({ id, events, onEvent }: { id: string; events: GraphEvent[]; onEvent: (e: GraphEvent) => void }) {
  const d = useQuery({ queryKey: ["dyn-event", id], queryFn: () => api.get<{ event: GraphEvent; label: string; trigger: { agent: string; action: string; round: number; platform: string; content: string; generated_by: string } | null; related_events: GraphEvent[] }>(`/graph-events/${id}`) });
  if (d.isLoading) return <p className="sec muted">Loading…</p>;
  if (d.isError) return <p className="sec small" style={{ color: "var(--err)" }}>{(d.error as Error).message}</p>;
  const e = d.data!.event;
  const before = JSON.stringify(e.before), after = JSON.stringify(e.after, null, 1);
  return <div>
    <div className="sec"><div className="row"><span className="pill">{EVENT_LABEL[e.event_type] ?? e.event_type}</span><span className="xs dim">step {e.step} · event #{e.seq} · graph v{e.graph_version}</span></div>
      <h3 className="mt8" style={{ fontSize: 14 }}>{e.description}</h3><div className="mt8"><span className="badge b-syn"><i />Simulation-generated</span></div>
      <p className="xs dim mt8">{d.data!.label}</p></div>
    {d.data!.trigger && <Section title="Triggered by"><p className="small"><b>{d.data!.trigger.agent}</b> {d.data!.trigger.action.replace(/_/g, " ").toLowerCase()} on the {d.data!.trigger.platform} in round {d.data!.trigger.round}</p>
      {d.data!.trigger.content && <blockquote className="quote"><p>{d.data!.trigger.content}</p><div className="xs dim">{d.data!.trigger.generated_by}</div></blockquote>}</Section>}
    <Section title="What changed"><div className="xs dim">Before</div><pre className="logbox" style={{ margin: "2px 0 8px" }}>{before === "{}" ? "—" : before}</pre><div className="xs dim">After</div><pre className="logbox" style={{ margin: "2px 0 0", maxHeight: 160, overflow: "auto" }}>{after}</pre></Section>
    {d.data!.related_events.length > 0 && <Section title="Other changes from the same action">{d.data!.related_events.map(r => <button key={r.id} className="ent-row" onClick={() => onEvent(events.find(x => x.id === r.id) ?? r)}><span className="pill">{EVENT_LABEL[r.event_type] ?? r.event_type}</span><span className="grow trunc xs">{r.description}</span></button>)}</Section>}
  </div>;
}

// ---------------------------------------------------------------- timeline
function TimelinePanel({ T, loading, error, retry, shown, snaps, view, sliderIdx, steps, agentF, typeF, setAgentF, setTypeF, sel, historical, live, onSnap, onScrub, onEvent }: {
  T: Timeline | undefined; loading: boolean; error: string | null; retry: () => void; shown: { event: GraphEvent }[]; snaps: Snapshot[]; view: View; sliderIdx: number; steps: Timeline["steps"];
  agentF: string; typeF: string; setAgentF: (v: string) => void; setTypeF: (v: string) => void; sel: Sel; historical: boolean; live: () => void; onSnap: (s: Snapshot) => void;
  onScrub: (i: number) => void; onEvent: (e: GraphEvent) => void;
}) {
  const max = Math.max(1, ...steps.map(s => s.events));
  return <section className="dyn-timeline" aria-label="Timeline">
    <div className="row wrap" style={{ gap: 8, padding: "6px 12px" }}><Clock size={14} /><b className="small">Timeline</b>
      {T?.simulation && <span className="xs dim">{T.simulation.name}{T.simulation.attempt > 1 ? ` · attempt ${T.simulation.attempt}` : ""}</span>}
      <span className="grow" />
      <select className="sel" style={{ width: "auto", height: 28 }} aria-label="Filter by agent" value={agentF} onChange={e => setAgentF(e.target.value)}><option value="">All agents</option>{(T?.agents ?? []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      <select className="sel" style={{ width: "auto", height: 28 }} aria-label="Filter by event type" value={typeF} onChange={e => setTypeF(e.target.value)}><option value="">All event types</option>{(T?.event_types ?? []).map(t => <option key={t} value={t}>{EVENT_LABEL[t] ?? t}</option>)}</select>
      <button className="btn sm" disabled={!historical} onClick={live}><Undo2 />Current graph</button></div>
    {loading ? <p className="xs dim" style={{ padding: 12 }}>Loading timeline…</p> : error ? <div className="row" style={{ padding: 12 }}><span className="xs" style={{ color: "var(--err)" }}>{error}</span><button className="btn sm" onClick={retry}>Try again</button></div>
      : !T?.items.length ? <p className="xs dim" style={{ padding: "4px 12px 12px" }}>Nothing on the timeline yet. Snapshots appear when a graph is approved, and graph events appear when a simulation runs.</p> : <div className="dyn-tl-body">
        <div className="dyn-track" role="group" aria-label="Simulation steps">
          {steps.length > 1 && <input type="range" min={0} max={steps.length - 1} value={sliderIdx} aria-label="Move through simulation steps" onChange={e => onScrub(+e.target.value)} />}
          <div className="dyn-bars">{steps.map(s => <div key={s.step} className={`dyn-step ${view.kind === "seq" && view.step === s.step ? "on" : ""}`} title={`Step ${s.step}: ${s.events} change${s.events === 1 ? "" : "s"}`}>
            <i style={{ height: `${8 + (s.events / max) * 30}px` }} />
            {s.snapshot_ids.map(id => { const sn = snaps.find(x => x.id === id); return sn ? <button key={id} className={`dyn-snap ${view.kind === "snapshot" && view.id === id ? "on" : ""}`} aria-label={`Snapshot ${sn.number}: ${REASON_LABEL[sn.reason]}`} title={`#${sn.number} ${REASON_LABEL[sn.reason]}`} onClick={() => onSnap(sn)} /> : null; })}
            <span className="xs dim">{s.step}</span></div>)}</div></div>
        <div className="dyn-list"><div className="dyn-snaps" role="list" aria-label="Snapshots">{snaps.map(s => <button key={s.id} role="listitem" className={`btn sm ${view.kind === "snapshot" && view.id === s.id ? "pri" : ""}`} onClick={() => onSnap(s)}
          title={`${fmtDate(s.created_at)} · ${s.note}`}><Bookmark size={12} />#{s.number} {REASON_LABEL[s.reason] ?? s.reason}{s.step != null ? ` · s${s.step}` : ""}</button>)}</div>
          <ul className="dyn-events" aria-label="Graph events">{shown.slice(-80).reverse().map(({ event: e }) => <li key={e.id}><button className={sel?.kind === "event" && sel.id === e.id ? "on" : ""} onClick={() => onEvent(e)}>
            <span className="pill">{EVENT_LABEL[e.event_type] ?? e.event_type}</span><span className="grow trunc">{e.description}</span><span className="xs dim">s{e.step}</span></button></li>)}
            {!shown.length && <li className="xs dim" style={{ padding: 8 }}>No events match these filters.</li>}</ul></div></div>}
  </section>;
}

// ---------------------------------------------------------------- compare and checkpoint
function CompareModal({ caseId, simId, onClose, onShow }: { caseId: string; simId: string | null; onClose: () => void; onShow: (b: string, ids: Set<string>) => void }) {
  const snaps = useQuery({ queryKey: ["dyn-snaps", caseId], queryFn: () => api.get<{ items: Snapshot[] }>(`/cases/${caseId}/snapshots?limit=500`) });
  const list = snaps.data?.items ?? [];
  const [a, setA] = useState("");
  const [b, setB] = useState("live");
  useEffect(() => { if (!a && list.length) setA(list[Math.max(0, list.length - 2)].id); }, [list, a]);
  const diff = useQuery({ queryKey: ["dyn-diff", caseId, a, b, simId], enabled: !!a, queryFn: () => api.get<SnapshotDiff>(`/cases/${caseId}/snapshots/compare?a=${a}&b=${b}${simId ? `&simulation_id=${simId}` : ""}`) });
  const opts = <>{list.map(s => <option key={s.id} value={s.id}>#{s.number} · {REASON_LABEL[s.reason] ?? s.reason}{s.step != null ? ` · step ${s.step}` : ""}</option>)}</>;
  const d = diff.data;
  const ids = useMemo(() => { const out = new Set<string>(); if (d) for (const l of Object.values(d.layers)) for (const side of [l.nodes, l.edges] as DiffSide[]) { side.added.forEach(x => out.add(x.id)); side.changed.forEach(x => out.add(x.id)); } return out; }, [d]);
  const Row = ({ layer }: { layer: Layer }) => { const s = d!.summary[layer], l = d!.layers[layer]; const items = [...l.nodes.added.map(x => ["added", x.label] as const), ...l.nodes.removed.map(x => ["removed", x.label] as const),
    ...l.nodes.changed.map(x => ["changed", `${x.label} (${Object.keys(x.fields).map(f => FIELD_LABEL[f] ?? f).join(", ")})`] as const)];
    return <div className="mb8"><div className="row"><b className="small grow">{LAYER_META[layer].label}</b><span className="badge b-ok">+{s.added}</span><span className="badge b-err">−{s.removed}</span><span className="badge b-warn">~{s.changed}</span></div>
      {!d!.comparable.research && layer === "research" && <p className="xs dim">The research layer could not be read on one side, so it is not compared.</p>}
      <ul className="xs" style={{ margin: "4px 0 0", paddingLeft: 18, maxHeight: 110, overflow: "auto" }}>{items.slice(0, 40).map(([k, t], i) => <li key={i}><span className={k === "added" ? "diff-add" : k === "removed" ? "diff-del" : "diff-chg"}>{k}</span> {t}</li>)}
        {l.edges.added.length + l.edges.removed.length + l.edges.changed.length > 0 && <li className="dim">{l.edges.added.length} relationships added, {l.edges.removed.length} removed, {l.edges.changed.length} changed</li>}</ul></div>; };
  return <Modal wide title="Compare snapshots" sub="See what was added, removed or changed between two points in time, per layer. Snapshots are never modified." onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn pri" disabled={!d || !ids.size} onClick={() => onShow(b, ids)}>Show {b === "live" ? "current graph" : "snapshot"} with changes highlighted</button></>}>
    {snaps.isLoading ? <p className="muted">Loading…</p> : snaps.isError ? <p className="small" style={{ color: "var(--err)" }}>{(snaps.error as Error).message}</p> : list.length < 1 ? <p className="small muted">There are no snapshots yet. They are created when a graph is approved and as a simulation runs.</p> : <div className="col gap12">
      <div className="form-grid"><div className="field"><label htmlFor="cmp-a">From (earlier)</label><select id="cmp-a" className="sel" value={a} onChange={e => setA(e.target.value)}>{opts}</select></div>
        <div className="field"><label htmlFor="cmp-b">To</label><select id="cmp-b" className="sel" value={b} onChange={e => setB(e.target.value)}><option value="live">Current graph</option>{opts}</select></div></div>
      {diff.isFetching ? <Spinner /> : diff.isError ? <p className="small" style={{ color: "var(--err)" }}>{(diff.error as Error).message}</p> : d && <>
        <p className="xs dim">{d.a.label} → {d.b.label}</p>{(["research", "reaction", "simulation"] as Layer[]).map(l => <Row key={l} layer={l} />)}</>}</div>}
  </Modal>;
}

function CheckpointModal({ caseId, simId, onClose, onSaved }: { caseId: string; simId: string | null; onClose: () => void; onSaved: (s: Snapshot) => void }) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const save = useMutation({ mutationFn: () => api.post<Snapshot>(`/cases/${caseId}/snapshots`, { note, simulation_id: simId }), onSuccess: onSaved, onError: e => toast((e as Error).message, "err") });
  return <Modal title="Save a checkpoint" sub="Freezes the graph exactly as it is now (all three layers). You can return to it and compare it later; it can never be edited." onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending && <Spinner />}Save checkpoint</button></>}>
    <div className="field"><label htmlFor="ck-n">Note</label><input id="ck-n" className="inp" maxLength={500} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Before the second scenario" autoFocus /></div>
  </Modal>;
}
