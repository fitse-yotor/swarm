import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Box, Check, ChevronLeft, Download, Edit3, Filter, GitCompare, Info, Link2, List, Lock, Maximize, MessageSquare, Merge, Plus, RefreshCw,
  Scan, Settings2, Share2, Square, X, ZoomIn, ZoomOut } from "lucide-react";
import { api, type ClaimStatus, type EntityType, type Graph } from "../api";
import { useAuth } from "../auth";
import { Empty, ShapeIcon, StatusBadge, useToast } from "../components/ui";
import Graph3D from "../graph/Graph3D";
import SigmaCanvas, { type CanvasEdge, type CanvasHandle, type CanvasNode, type LabelMode, type Layout } from "../graph/SigmaCanvas";
import { load, store } from "../prefs";
import { COMM_COL, ETYPES, TYPE_KEYS, pct, typeColor } from "../vocab";
import { useTheme } from "../hooks";
import { useCase } from "./CaseDetail";
import { Inspector } from "./graph/Inspector";
import { AddEdgeModal, AddNodeModal, ApproveModal, AskPanel, CompareModal, ExportModal, MergeSelectionModal } from "./graph/Modals";

const ALL_STATUS: ClaimStatus[] = ["approved", "pending", "conflict", "manual", "rejected"];
const freshFilter = () => ({ types: new Set<EntityType>(TYPE_KEYS), rels: null as Set<string> | null, conf: [0, 1] as [number, number],
  status: new Set<ClaimStatus>(["approved", "pending", "conflict", "manual"]), docs: null as Set<string> | null, comm: "all", q: "" });
export type Filters = ReturnType<typeof freshFilter>;

export function useGraph(caseId: string, versionId: string | null) {
  return useQuery({ queryKey: ["graph", caseId, versionId], queryFn: () => api.get<Graph>(`/cases/${caseId}/graph${versionId ? `?version_id=${versionId}` : ""}`), retry: false });
}

export interface GraphCtx {
  g: Graph; caseId: string; refresh: () => Promise<void>; run: <T>(fn: () => Promise<T>, ok: string) => Promise<T | undefined>;
  select: (id: string | null) => void; selectEdge: (id: string | null) => void; canvas: React.RefObject<CanvasHandle | null>;
  focus: Set<string> | null; setFocus: (f: Set<string> | null) => void; isolateCommunity: (c: string) => void;
}

export default function GraphExplorer() {
  const { caseId = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const c = useCase(caseId);
  const vParam = sp.get("v");
  const graph = useGraph(caseId, vParam);
  const canvas = useRef<CanvasHandle>(null);

  const [F, setF] = useState<Filters>(freshFilter);
  const [sel, setSel] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<Set<string> | null>(null);
  const [layout, setLayout] = useState<Layout>(() => load("layout", "force"));
  const [colorBy, setColorBy] = useState<"type" | "community">("type");
  const [sizeBy, setSizeBy] = useState<"degree" | "confidence" | "uniform">("degree");
  const [labels, setLabels] = useState<LabelMode>("auto");
  const [full, setFull] = useState(false);
  const [rpanel, setRpanel] = useState<"inspect" | "filters" | "sources" | "view" | null>(null);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [isolate, setIsolate] = useState<string | null>(null);
  const [view3d, setView3d] = useState(() => load("view3d", false));
  const [modal, setModal] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const [tip, setTip] = useState<{ html: React.ReactNode; x: number; y: number } | null>(null);
  const theme = useTheme();

  const g = graph.data;
  useEffect(() => { store("layout", layout); }, [layout]);
  useEffect(() => { store("view3d", view3d); }, [view3d]);
  useEffect(() => { setSel(null); setSelEdge(null); setMulti(new Set()); setFocus(null); setIsolate(null); setF(f => ({ ...f, rels: null, docs: null, comm: "all" })); }, [g?.version.id]);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ["graph", caseId] });
    qc.invalidateQueries({ queryKey: ["evidence", caseId] });
    qc.invalidateQueries({ queryKey: ["history", caseId] });
    qc.invalidateQueries({ queryKey: ["versions", caseId] });
    qc.invalidateQueries({ queryKey: ["cases"] });
  }, [qc, caseId]);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok: string) => {
    try { const r = await fn(); await refresh(); if (ok) toast(ok, "ok"); return r; } catch (e) { toast((e as Error).message, "err"); }
  }, [refresh, toast]);

  const relTypes = useMemo(() => [...new Set((g?.edges ?? []).map(e => e.type))].sort(), [g]);
  const docIds = useMemo(() => [...new Set((g?.nodes ?? []).flatMap(n => n.doc_ids))], [g]);
  const commIdx = useMemo(() => Object.fromEntries((g?.communities ?? []).map((cm, i) => [cm.id, i])), [g]);

  const { canvasNodes, canvasEdges } = useMemo(() => {
    if (!g) return { canvasNodes: [] as CanvasNode[], canvasEdges: [] as CanvasEdge[] };
    const size = (n: Graph["nodes"][number]) => sizeBy === "uniform" ? 8 : sizeBy === "confidence" ? 4 + n.confidence * 10 : 6 + Math.sqrt(n.degree) * 3.4;
    return {
      canvasNodes: g.nodes.map(n => ({ id: n.id, label: n.name, type: n.type, status: n.status, size: size(n), community: n.community,
        fill: colorBy === "community" && n.community ? COMM_COL[(commIdx[n.community] ?? 0) % COMM_COL.length] : typeColor(n.type) })),
      canvasEdges: g.edges.map(e => ({ id: e.id, s: e.s, o: e.o, status: e.status, directed: e.directed, label: e.type })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g, sizeBy, colorBy, theme]);

  // Clicking a node isolates it: only that node and its direct neighbours stay, until another node is clicked (or "show all").
  const isoSet = useMemo(() => {
    if (!g || !isolate) return null;
    return new Set([isolate, ...g.edges.filter(e => e.s === isolate || e.o === isolate).flatMap(e => [e.s, e.o])]);
  }, [g, isolate]);
  const g3 = useMemo(() => ({ nodes: (g?.nodes ?? []).map(n => ({ id: n.id, name: n.name, type: n.type })),
    links: (g?.edges ?? []).map(e => ({ id: e.id, source: e.s, target: e.o, type: e.type })) }), [g]);

  const hidden = useMemo(() => {
    const h = new Set<string>();
    if (!g) return h;
    const rels = F.rels ?? new Set(relTypes), docs = F.docs ?? new Set(docIds);
    g.nodes.forEach(n => {
      const ok = F.types.has(n.type) && F.status.has(n.status) && n.confidence >= F.conf[0] - 1e-9 && n.confidence <= F.conf[1] + 1e-9
        && (!n.doc_ids.length || n.doc_ids.some(d => docs.has(d))) && (F.comm === "all" || n.community === F.comm) && (isoSet ? isoSet.has(n.id) : !focus || focus.has(n.id));
      if (!ok) h.add(n.id);
    });
    g.edges.forEach(e => { if (!rels.has(e.type) || !F.status.has(e.status) || e.confidence < F.conf[0] - 1e-9 || (isolate && e.s !== isolate && e.o !== isolate)) h.add(e.id); });
    return h;
  }, [g, F, relTypes, docIds, focus, isoSet, isolate]);

  const highlight = useMemo(() => {
    if (!g) return null;
    if (sel) return new Set([sel, ...g.edges.filter(e => (e.s === sel || e.o === sel) && !hidden.has(e.id)).flatMap(e => [e.s, e.o])]);
    if (selEdge) { const e = g.edges.find(x => x.id === selEdge); return e ? new Set([e.s, e.o]) : null; }
    if (F.q) { const q = F.q.toLowerCase(); const hits = g.nodes.filter(n => (n.name + " " + n.aliases.join(" ")).toLowerCase().includes(q)); return hits.length ? new Set(hits.map(n => n.id)) : null; }
    return null;
  }, [g, sel, selEdge, F.q, hidden]);

  const canvasState = useMemo(() => ({ hidden, selected: new Set([...multi, ...(sel ? [sel] : [])]), selEdge, highlight, labels }), [hidden, multi, sel, selEdge, highlight, labels]);

  const select = useCallback((id: string | null) => { setSel(id); setSelEdge(null); setMulti(new Set()); if (id) setRpanel("inspect"); }, []);
  const selectEdge = useCallback((id: string | null) => { setSelEdge(id); setSel(null); setMulti(new Set()); if (id) setRpanel("inspect"); }, []);
  const isolateNode = useCallback((id: string) => { setFocus(null); setIsolate(id); select(id); setTimeout(() => canvas.current?.fit(), 120); }, [select]);
  const expand = useCallback((id: string) => {
    if (!g) return;
    const nb = g.edges.filter(e => e.s === id || e.o === id).flatMap(e => [e.s, e.o]);
    setIsolate(null); setFocus(f => new Set([...(f ?? []), id, ...nb])); select(id); setTimeout(() => canvas.current?.fit(), 60);
  }, [g, select]);
  const fitSoon = () => setTimeout(() => canvas.current?.fit(), 60);
  // ?focus=<entity name> (from the 3D build view) selects that entity once the graph loads.
  const focusParam = sp.get("focus");
  useEffect(() => {
    if (!focusParam || !g) return;
    const n = g.nodes.find(x => x.name === focusParam || x.aliases.includes(focusParam));
    if (n) { select(n.id); setTimeout(() => canvas.current?.focus(n.id), 400); }
    sp.delete("focus"); setSp(sp, { replace: true });
  }, [focusParam, g, select, sp, setSp]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input,textarea,select") || modal) return;
      if (e.key === "Escape") { if (full) setFull(false); else { setSel(null); setSelEdge(null); setMulti(new Set()); } }
      if (e.key === "f" && !e.metaKey && !e.ctrlKey) canvas.current?.fit();
      if (e.key === "+" || e.key === "=") canvas.current?.zoom(1.25);
      if (e.key === "-") canvas.current?.zoom(0.8);
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [full, modal]);
  useEffect(() => { setTimeout(() => canvas.current?.fit(), 80); }, [full]);

  if (graph.isError) return <div className="page"><Empty icon={<Share2 />} title="This case has no graph yet" text={(graph.error as Error).message === "This case has no graph yet" ? "Add sources and build a knowledge graph to explore entities, relationships and evidence." : (graph.error as Error).message}>
    <Link className="btn pri" to={`/cases/${caseId}/documents`}>Add sources</Link></Empty></div>;
  if (!g) return <div className="center-fill">Loading graph…</div>;

  const locked = g.version.status === "approved";
  const ctx: GraphCtx = { g, caseId, refresh, run, select, selectEdge, canvas, focus, setFocus,
    isolateCommunity: cm => { setF({ ...F, comm: cm }); fitSoon(); } };
  const shownN = g.nodes.length - g.nodes.filter(n => hidden.has(n.id)).length;
  const shownE = g.edges.filter(e => !hidden.has(e.id) && !hidden.has(e.s) && !hidden.has(e.o)).length;
  const present = new Set(g.nodes.map(n => n.type));
  const cnt = (t: string) => g.nodes.filter(n => n.type === t).length;
  const q = F.q.toLowerCase();
  const hits = q ? g.nodes.filter(n => (n.name + " " + n.aliases.join(" ")).toLowerCase().includes(q)).slice(0, 8) : [];
  const rels = F.rels ?? new Set(relTypes), docs = F.docs ?? new Set(docIds);
  const toggle = <T,>(s: Set<T>, v: T) => { const n = new Set(s); n.has(v) ? n.delete(v) : n.add(v); return n; };
  const pickVersion = (id: string) => { sp.set("v", id); setSp(sp, { replace: true }); };

  const filtersPanel = <>
    <div className="sec"><label htmlFor="gq" className="sr">Search entities</label><input id="gq" className="inp" placeholder="Search entities and aliases" value={F.q} onChange={e => setF({ ...F, q: e.target.value })} autoComplete="off" />
      {hits.length > 0 && <div className="mt8">{hits.map(n => <button key={n.id} className="ent-row" onClick={() => { if (isolate) setIsolate(n.id); else if (focus && !focus.has(n.id)) setFocus(new Set([...focus, n.id])); select(n.id); canvas.current?.focus(n.id); }}>
        <ShapeIcon type={n.type} /><span className="grow trunc">{n.name}</span><span className="xs dim">{ETYPES[n.type].label}</span></button>)}</div>}
      {q && !hits.length && <p className="xs dim mt8">No entities match.</p>}</div>
    <div className="sec"><div className="sec-t">Entity types</div>{TYPE_KEYS.filter(cnt).map(t => <label key={t} className="fl-item"><input type="checkbox" checked={F.types.has(t)} onChange={() => setF({ ...F, types: toggle(F.types, t) })} /><ShapeIcon type={t} />{ETYPES[t].label}<span className="n">{cnt(t)}</span></label>)}</div>
    <div className="sec"><div className="sec-t">Relationships <button className="btn ghost sm" style={{ marginLeft: "auto", height: 20 }} onClick={() => setF({ ...F, rels: rels.size === relTypes.length ? new Set() : null })}>{rels.size === relTypes.length ? "None" : "All"}</button></div>
      <div style={{ maxHeight: 180, overflow: "auto" }}>{relTypes.map(r => <label key={r} className="fl-item"><input type="checkbox" checked={rels.has(r)} onChange={() => setF({ ...F, rels: toggle(rels, r) })} /><span className="small trunc">{r}</span><span className="n">{g.edges.filter(e => e.type === r).length}</span></label>)}</div></div>
    <div className="sec"><div className="sec-t">Confidence <span className="dim" style={{ marginLeft: "auto", fontWeight: 400 }}>{pct(F.conf[0])} – {pct(F.conf[1])}</span></div>
      <div className="row"><input type="range" min={0} max={100} value={F.conf[0] * 100} aria-label="Minimum confidence" onChange={e => setF({ ...F, conf: [Math.min(+e.target.value / 100, F.conf[1]), F.conf[1]] })} />
        <input type="range" min={0} max={100} value={F.conf[1] * 100} aria-label="Maximum confidence" onChange={e => setF({ ...F, conf: [F.conf[0], Math.max(+e.target.value / 100, F.conf[0])] })} /></div></div>
    <div className="sec"><div className="sec-t">Evidence status</div>{ALL_STATUS.map(s => <label key={s} className="fl-item"><input type="checkbox" checked={F.status.has(s)} onChange={() => setF({ ...F, status: toggle(F.status, s) })} /><StatusBadge status={s} />
      <span className="n">{g.nodes.filter(n => n.status === s).length + g.edges.filter(e => e.status === s).length}</span></label>)}</div>
    <div className="sec"><div className="sec-t">Community</div><select className="sel" value={F.comm} aria-label="Community filter" onChange={e => { setF({ ...F, comm: e.target.value }); fitSoon(); }}>
      <option value="all">All communities ({g.communities.length})</option>{g.communities.map(cm => <option key={cm.id} value={cm.id}>{cm.name} · {cm.size}</option>)}</select>
      <p className="xs dim mt8">{g.community_method}</p></div>
    <div className="sec"><button className="btn sm" style={{ width: "100%" }} onClick={() => { setF(freshFilter()); setFocus(null); setIsolate(null); fitSoon(); }}>Reset filters</button></div>
  </>;

  const srcNodes = srcDoc ? g.nodes.filter(n => n.doc_ids.includes(srcDoc)) : [];
  const sourcesPanel = srcDoc ? <>
    <div className="sec"><button className="btn ghost sm" onClick={() => setSrcDoc(null)}><ChevronLeft />All sources</button>
      <h3 className="mt8" style={{ wordBreak: "break-word" }}>{g.documents[srcDoc] ?? srcDoc}</h3>
      <p className="xs muted mt8">{srcNodes.length} entities cite this document.</p>
      <Link className="btn sm mt8" to={`/cases/${caseId}/documents?doc=${srcDoc}`}><BookOpen />Open document</Link></div>
    <div className="sec"><div className="sec-t">Entities from this source</div>
      {srcNodes.map(n => <button key={n.id} className="ent-row" onClick={() => isolateNode(n.id)}><ShapeIcon type={n.type} /><span className="grow trunc">{n.name}</span><span className="xs dim">{n.degree}</span></button>)}</div>
  </> : <>
    <div className="sec"><div className="sec-t">Source documents</div>
      {docIds.length ? docIds.map(d => <div key={d} className="row" style={{ padding: "4px 0" }}>
        <input type="checkbox" aria-label={`Show entities from ${g.documents[d] ?? d}`} checked={docs.has(d)} onChange={() => setF({ ...F, docs: toggle(docs, d) })} />
        <button className="ent-row grow" style={{ margin: 0 }} onClick={() => setSrcDoc(d)}><BookOpen size={14} /><span className="grow trunc">{g.documents[d] ?? d}</span>
          <span className="xs dim">{g.nodes.filter(n => n.doc_ids.includes(d)).length}</span></button></div>) : <p className="xs dim">No linked sources.</p>}
      <p className="xs dim mt8">Tick to filter the graph by source; click a source to see the entities it supports.</p></div>
  </>;

  const viewPanel = <div className="sec"><div className="sec-t">Layers &amp; importance</div>
    <div className="field mb8"><label>Color by</label><div className="seg">{(["type", "community"] as const).map(x => <button key={x} className={colorBy === x ? "on" : ""} onClick={() => setColorBy(x)}>{x[0].toUpperCase() + x.slice(1)}</button>)}</div></div>
    <div className="field mb8"><label>Node size</label><div className="seg">{([["degree", "Connections"], ["confidence", "Confidence"], ["uniform", "Uniform"]] as const).map(([x, l]) => <button key={x} className={sizeBy === x ? "on" : ""} onClick={() => setSizeBy(x)}>{l}</button>)}</div></div>
    <div className="field"><label>Labels</label><div className="seg">{(["auto", "all", "none"] as const).map(x => <button key={x} className={labels === x ? "on" : ""} onClick={() => setLabels(x)}>{x[0].toUpperCase() + x.slice(1)}</button>)}</div></div></div>;

  const railBtn = (id: NonNullable<typeof rpanel>, label: string, icon: React.ReactNode, badge?: React.ReactNode) =>
    <button key={id} className={rpanel === id ? "on" : ""} aria-pressed={rpanel === id} aria-label={label} title={label} onClick={() => setRpanel(rpanel === id ? null : id)}>{icon}{badge != null && <i className="rail-n">{badge}</i>}</button>;
  const hiddenN = g.nodes.length - shownN;
  const panelTitle = { inspect: "Inspector", filters: "Filters", sources: "Sources", view: "View options" };

  return <div className="gx-wrap" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
    <div className="gx gx2" style={{ flex: 1 }}>
      {/* ---------- canvas ---------- */}
      <section className={`gx-center ${full ? "full" : ""}`} aria-label="Graph canvas">
        {view3d
          ? <Graph3D nodes={g3.nodes} links={g3.links} live={false} theme={theme} labels={labels !== "none"} hidden={hidden} isolate={isolate} pin={false}
              onPick={(id) => isolateNode(id)} />
          : <SigmaCanvas ref={canvas} nodes={canvasNodes} edges={canvasEdges} state={canvasState} layout={layout} positionsKey={g.version.id} theme={theme}
          ariaLabel={`Knowledge graph ${g.version.label} for ${c.data?.title ?? "case"}: ${shownN} entities, ${shownE} relationships. Use the filter panel's entity search for a keyboard-accessible list.`}
          onNode={(id, add) => { if (add) { const m = new Set(multi); if (sel) m.add(sel); m.has(id) ? m.delete(id) : m.add(id); setMulti(m); setSel(null); setSelEdge(null); } else isolateNode(id); }}
          onEdge={selectEdge} onBlank={() => { setSel(null); setSelEdge(null); setMulti(new Set()); }} onDouble={expand}
          onHover={h => {
            if (!h) return setTip(null);
            if (h.node) { const n = g.nodes.find(x => x.id === h.node)!; setTip({ x: h.x, y: h.y, html: <><div className="row" style={{ gap: 6 }}><ShapeIcon type={n.type} /><b>{n.name}</b></div><div className="xs muted mt8">{ETYPES[n.type].label} · {n.degree} connections · {pct(n.confidence)}</div></> }); }
            else if (h.edge) { const e = g.edges.find(x => x.id === h.edge)!; const nm = (id: string) => g.nodes.find(n => n.id === id)?.name; setTip({ x: h.x, y: h.y, html: <><div className="small"><b>{nm(e.s)}</b> <span className="muted">{e.type}</span> <b>{nm(e.o)}</b></div><div className="xs muted mt8">{pct(e.confidence)} confidence · {e.evidence_ids.length} evidence · {e.status}</div></> }); }
          }} />}
        <div className="gx-toolbar">
          <div className={`ver-chip ${locked ? "locked" : ""}`}>{locked ? <Lock size={13} style={{ color: "var(--ok)" }} /> : <Edit3 size={13} style={{ color: "var(--tx3)" }} />}
            <select aria-label="Graph version" value={g.version.id} onChange={e => pickVersion(e.target.value)} style={{ border: 0, background: "none", fontWeight: 600, cursor: "pointer" }}>
              {g.versions.map(v => <option key={v.id} value={v.id}>{v.label} · {v.status}</option>)}</select>
            <button className="btn ghost sm" title="Compare versions" aria-label="Compare versions" onClick={() => setModal("compare")}><GitCompare /></button>
            {locked ? can("graph.review") && <button className="btn sm" onClick={() => run(() => api.post<{ id: string }>(`/cases/${caseId}/graph/drafts?from_version=${g.version.id}`), "Draft created").then(v => v && pickVersion(v.id))}>New draft</button>
              : can("graph.approve") && <button className="btn sm ok" onClick={() => setModal("approve")}><Check />Approve</button>}</div>
          <div className="tb" role="group" aria-label="Dimension">
            <button className={!view3d ? "on" : ""} title="2D view" aria-label="2D view" aria-pressed={!view3d} onClick={() => setView3d(false)}><Square /></button>
            <button className={view3d ? "on" : ""} title="3D view" aria-label="3D view" aria-pressed={view3d} onClick={() => setView3d(true)}><Box /></button></div>
          <div className="tb" role="toolbar" aria-label="View">
            {!view3d && <><button title="Zoom in (+)" aria-label="Zoom in" onClick={() => canvas.current?.zoom(1.25)}><ZoomIn /></button>
            <button title="Zoom out (−)" aria-label="Zoom out" onClick={() => canvas.current?.zoom(0.8)}><ZoomOut /></button>
            <button title="Fit to view (F)" aria-label="Fit graph" onClick={() => canvas.current?.fit()}><Scan /></button>
            <select aria-label="Layout" title="Layout" value={layout} onChange={e => { const l = e.target.value as Layout; setLayout(l); canvas.current?.relayout(l); }}>
              <option value="force">ForceAtlas2</option><option value="clustered">Clustered</option><option value="circular">By type</option></select>
            <button title="Reset layout and unpin all" aria-label="Reset layout" onClick={() => { canvas.current?.relayout(layout, true); toast("Layout reset and pins cleared"); }}><RefreshCw /></button></>}
            <button className={labels === "all" ? "on" : ""} title={`Labels: ${labels}`} aria-label="Cycle labels" onClick={() => setLabels(({ auto: "all", all: "none", none: "auto" } as const)[labels])}><List /></button>
            <button className={full ? "on" : ""} title="Fullscreen (Esc to exit)" aria-label="Fullscreen" onClick={() => setFull(!full)}><Maximize /></button>
            <button title="Export image or data" aria-label="Export" onClick={() => setModal("export")}><Download /></button>
            {can("chat.use") && <button className={ask ? "on" : ""} title="Ask the graph (GraphRAG)" aria-label="Ask the graph" onClick={() => setAsk(!ask)}><MessageSquare /></button>}</div>
          {g.editable && <div className="tb"><button title="Add analyst-verified entity" aria-label="Add entity" onClick={() => setModal("addNode")}><Plus /></button>
            <button title="Add analyst-verified relationship" aria-label="Add relationship" onClick={() => setModal("addEdge")}><Link2 /></button></div>}
          {isolate && <button className="btn sm" style={{ boxShadow: "0 4px 16px rgba(0,0,0,.18)" }} onClick={() => { setIsolate(null); fitSoon(); }}><X />Showing {g.nodes.find(n => n.id === isolate)?.name} and {Math.max((isoSet?.size ?? 1) - 1, 0)} connections — show all</button>}
          {!isolate && focus && <button className="btn sm" style={{ boxShadow: "0 4px 16px rgba(0,0,0,.18)" }} onClick={() => { setFocus(null); fitSoon(); }}><X />Showing {focus.size} — show all</button>}
        </div>
        <div className={`gx-tip ${tip ? "show" : ""}`} style={tip ? { left: Math.min(tip.x + 14, 9999), top: tip.y + 14 } : undefined}>{tip?.html}</div>
        {multi.size > 1 && <div className="gx-multi">{multi.size} selected<button className="btn sm" onClick={() => { setFocus(new Set(multi)); fitSoon(); }}>Show only these</button>
          {g.editable && <><button className="btn sm" onClick={() => setModal("mergeSel")}><Merge />Merge</button>
            <button className="btn sm ok" onClick={() => run(() => api.post(`/cases/${caseId}/graph/versions/${g.version.id}/bulk-status`, { node_ids: [...multi], status: "approved" }), `Approved ${multi.size} entities`)}>Approve all</button></>}
          <button className="btn ghost sm icon" aria-label="Clear selection" onClick={() => setMulti(new Set())}><X /></button></div>}
        <div className="gx-legend">
          {TYPE_KEYS.filter(t => present.has(t)).map(t => <button key={t} className={`lg ${F.types.has(t) ? "" : "off"}`} aria-pressed={F.types.has(t)} onClick={() => setF({ ...F, types: toggle(F.types, t) })}><ShapeIcon type={t} size={11} />{ETYPES[t].label}</button>)}
          <div className="lines">
            <span><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="var(--tx2)" strokeWidth="2" /></svg>Verified</span>
            <span><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="var(--tx2)" strokeOpacity=".6" strokeWidth="1.4" /></svg>Pending</span>
            <span><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="var(--warn)" strokeWidth="1.6" /></svg>Conflict</span>
            <span><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="var(--acc)" strokeWidth="1.6" /></svg>Analyst</span>
            <span><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="var(--err)" strokeOpacity=".7" strokeWidth="1.2" /></svg>Rejected</span></div></div>
        <div className="gx-stats">{shownN} of {g.nodes.length} entities · {shownE} of {g.edges.length} relationships</div>
        {ask && <AskPanel ctx={ctx} onClose={() => setAsk(false)} />}
      </section>

      {/* ---------- right icon rail + slide-out panel ---------- */}
      {rpanel && <aside className="gx-panel" aria-label={panelTitle[rpanel]}>
        <div className="gx-panel-h"><b className="grow">{panelTitle[rpanel]}</b><button className="btn ghost sm icon" aria-label="Close panel" onClick={() => setRpanel(null)}><X /></button></div>
        <div className="gx-panel-b">
          {rpanel === "inspect" && <Inspector ctx={ctx} sel={sel} selEdge={selEdge} caseTitle={c.data?.title ?? ""} onExpand={expand} onModal={setModal} />}
          {rpanel === "filters" && filtersPanel}
          {rpanel === "sources" && sourcesPanel}
          {rpanel === "view" && viewPanel}
        </div></aside>}
      <nav className="gx-rail" aria-label="Graph tools">
        {railBtn("inspect", "Inspector — details and evidence of the selection", <Info />, sel || selEdge ? 1 : undefined)}
        {railBtn("filters", "Filters — search, types, relationships, status", <Filter />, hiddenN > 0 && !isolate ? hiddenN : undefined)}
        {railBtn("sources", "Sources — documents behind the graph", <BookOpen />, docIds.length)}
        {railBtn("view", "View options — colour, size, labels", <Settings2 />)}
      </nav>
    </div>
    {modal === "addNode" && <AddNodeModal ctx={ctx} onClose={() => setModal(null)} />}
    {modal === "addEdge" && <AddEdgeModal ctx={ctx} subject={sel} onClose={() => setModal(null)} />}
    {modal === "compare" && <CompareModal ctx={ctx} onClose={() => setModal(null)} />}
    {modal === "approve" && <ApproveModal ctx={ctx} onClose={() => setModal(null)} onDone={id => id && pickVersion(id)} />}
    {modal === "export" && <ExportModal ctx={ctx} caseTitle={c.data?.title ?? "graph"} onClose={() => setModal(null)} />}
    {modal === "mergeSel" && <MergeSelectionModal ctx={ctx} ids={[...multi]} onClose={() => setModal(null)} onDone={id => { setMulti(new Set()); select(id); }} />}
  </div>;
}
