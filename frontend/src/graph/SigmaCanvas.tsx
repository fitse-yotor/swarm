import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { circlepack } from "graphology-layout";
import Sigma from "sigma";
import { animateNodes } from "sigma/utils";
import type { Settings } from "sigma/settings";
import type { NodeDisplayData, PartialButFor } from "sigma/types";
import { createNodeImageProgram } from "@sigma/node-image";
import { downloadAsPNG } from "@sigma/export-image";
import type { ClaimStatus, EntityType } from "../api";
import { load, store } from "../prefs";
import { ETYPES, TYPE_KEYS, cssVar, type Shape } from "../vocab";
import { glyph, withAlpha, type GlyphPalette } from "./shapes";

export interface CanvasNode { id: string; label: string; type: EntityType; status: ClaimStatus; size: number; fill: string; community: string | null }
export interface CanvasEdge { id: string; s: string; o: string; status: ClaimStatus; directed: boolean; label: string }
export type Layout = "force" | "clustered" | "circular";
export type LabelMode = "auto" | "all" | "none";

export interface CanvasState {
  hidden: Set<string>; selected: Set<string>; selEdge: string | null; highlight: Set<string> | null; labels: LabelMode;
}
export interface CanvasHandle {
  zoom: (f: number) => void; fit: () => void; focus: (id: string) => void; relayout: (kind: Layout, reset?: boolean) => void;
  togglePin: (id: string) => boolean; isPinned: (id: string) => boolean; exportPng: (name: string) => void;
}
interface Props {
  nodes: CanvasNode[]; edges: CanvasEdge[]; state: CanvasState; layout: Layout; positionsKey: string; ariaLabel: string; theme: string;
  onNode: (id: string, additive: boolean) => void; onEdge: (id: string) => void; onBlank: () => void; onDouble: (id: string) => void;
  onHover: (h: { node?: string; edge?: string; x: number; y: number } | null) => void;
}

type Pal = GlyphPalette & { tx: string; tx3: string; ok: string; canvas: string; font: string };
const readPal = (): Pal => ({ bg: cssVar("--canvas"), canvas: cssVar("--canvas"), acc: cssVar("--acc"), warn: cssVar("--warn"), err: cssVar("--err"),
  ok: cssVar("--ok"), tx: cssVar("--tx"), tx2: cssVar("--tx2"), tx3: cssVar("--tx3"), font: getComputedStyle(document.body).fontFamily });
type Pos = Record<string, { x: number; y: number; pinned?: boolean }>;

const SavedPos = (key: string): Pos => load<Pos>(`pos.${key}`, {});

const SigmaCanvas = forwardRef<CanvasHandle, Props>(function SigmaCanvas(p, ref) {
  const host = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef(new Graph({ multi: true, type: "directed" }));
  const live = useRef({ props: p, pal: readPal(), hover: null as string | null, hoverEdge: null as string | null, dragging: null as string | null, moved: false });
  live.current.props = p;

  const savePositions = () => {
    const g = graphRef.current, out: Pos = {};
    g.forEachNode((id, a) => { out[id] = { x: a.x, y: a.y, pinned: !!a.fixed }; });
    store(`pos.${live.current.props.positionsKey}`, out);
  };

  const runLayout = (kind: Layout, animate = true, reset = false) => {
    const g = graphRef.current;
    if (!g.order) return;
    if (reset) g.forEachNode(id => g.setNodeAttribute(id, "fixed", false));
    const before: Pos = {};
    g.forEachNode((id, a) => { before[id] = { x: a.x, y: a.y }; });
    const targets: Record<string, { x: number; y: number }> = {};
    if (kind === "circular") {
      const order = [...g.nodes()].sort((a, b) => TYPE_KEYS.indexOf(g.getNodeAttribute(a, "etype")) - TYPE_KEYS.indexOf(g.getNodeAttribute(b, "etype")));
      const R = Math.max(160, order.length * 9);
      order.forEach((id, i) => { const a = (i / order.length) * Math.PI * 2 - Math.PI / 2; targets[id] = { x: Math.cos(a) * R, y: Math.sin(a) * R }; });
    } else {
      if (kind === "clustered") circlepack.assign(g, { hierarchyAttributes: ["community"], scale: 30 });
      const settings = { ...forceAtlas2.inferSettings(g), gravity: 1, scalingRatio: kind === "clustered" ? 4 : 10, barnesHutOptimize: g.order > 300 };
      forceAtlas2.assign(g, { iterations: kind === "clustered" ? 60 : 300, settings });
      g.forEachNode((id, a) => { targets[id] = { x: a.x, y: a.y }; });
    }
    g.forEachNode((id, a) => {
      if (a.fixed) targets[id] = { x: before[id].x, y: before[id].y };
      g.mergeNodeAttributes(id, before[id]);
    });
    const done = () => { savePositions(); sigmaRef.current?.getCamera().animatedReset({ duration: 300 }); };
    if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) animateNodes(g, targets, { duration: 450 }, done);
    else { g.forEachNode(id => g.mergeNodeAttributes(id, targets[id])); done(); }
  };

  // ---------- mount sigma once ----------
  useEffect(() => {
    const g = graphRef.current;
    const L = live.current;
    const drawLabel = (ctx: CanvasRenderingContext2D, d: PartialButFor<NodeDisplayData, "x" | "y" | "size" | "label" | "color">, s: Settings, strong = false) => {
      if (!d.label) return;
      ctx.font = `${strong ? 600 : 500} ${s.labelSize}px ${L.pal.font}`;
      const w = ctx.measureText(d.label).width + 8, x = d.x, y = d.y + d.size + 3;
      ctx.globalAlpha = 0.85; ctx.fillStyle = L.pal.canvas; ctx.fillRect(x - w / 2, y - 1, w, s.labelSize + 5); ctx.globalAlpha = 1;
      ctx.fillStyle = strong ? L.pal.tx : L.pal.tx2; ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText(d.label, x, y + 1); ctx.textAlign = "left";
    };
    const NodeGlyph = createNodeImageProgram({ drawingMode: "background", keepWithinCircle: false, padding: 0, size: { mode: "force", value: 128 },
      drawLabel: (c, d, s) => drawLabel(c, d, s), drawHover: (c, d, s) => drawLabel(c, d, s, true) });

    const sigma = new Sigma(g, host.current!, {
      nodeProgramClasses: { glyph: NodeGlyph }, defaultNodeType: "glyph", defaultEdgeType: "arrow",
      renderEdgeLabels: false, enableEdgeEvents: true, zIndex: true, labelSize: 12, labelDensity: 0.8, labelGridCellSize: 90,
      labelRenderedSizeThreshold: 9, minCameraRatio: 0.05, maxCameraRatio: 8, allowInvalidContainer: true,
      defaultDrawNodeLabel: (c, d, s) => drawLabel(c, d, s), defaultDrawNodeHover: (c, d, s) => drawLabel(c, d, s, true),
      nodeReducer: (id, a) => {
        const { state } = L.props;
        const sel = state.selected.has(id), hov = L.hover === id;
        const dim = !!state.highlight && !state.highlight.has(id) && !sel;
        const label = state.labels === "none" && !sel && !hov ? "" : dim ? "" : a.label;
        return { ...a, hidden: state.hidden.has(id), color: "rgba(0,0,0,0)", label,
          image: glyph(ETYPES[a.etype as EntityType].shape as Shape, a.fill, a.status, { dim, selected: sel, pal: L.pal }),
          forceLabel: sel || hov || (state.labels === "all" && !dim) || (!!state.highlight && !dim), zIndex: sel ? 3 : dim ? 0 : 1,
          size: hov || sel ? a.size * 1.12 : a.size };
      },
      edgeReducer: (id, a) => {
        const { state } = L.props;
        const [s, o] = g.extremities(id);
        const hidden = state.hidden.has(s) || state.hidden.has(o) || state.hidden.has(id);
        const sel = state.selEdge === id, hov = L.hoverEdge === id;
        const dim = !!state.highlight && !(state.highlight.has(s) && state.highlight.has(o));
        // On the light canvas the dim grey used for dark mode almost disappears: use the darker text tone, higher opacity, thicker lines.
        const light = document.documentElement.dataset.theme === "light";
        const neutral = light ? L.pal.tx2 : L.pal.tx3;
        const base = ({ approved: neutral, manual: L.pal.acc, conflict: L.pal.warn, rejected: L.pal.err, pending: neutral } as Record<string, string>)[a.status] ?? neutral;
        const alpha = sel || hov ? 1 : dim ? 0.08 : a.status === "pending" ? (light ? 0.7 : 0.45) : a.status === "rejected" ? (light ? 0.75 : 0.55) : (light ? 0.95 : 0.8);
        return { ...a, hidden, color: sel ? L.pal.acc : withAlpha(base, alpha), size: sel ? 3 : hov ? 2.4 : a.status === "approved" || a.status === "manual" ? (light ? 2 : 1.6) : (light ? 1.5 : 1.1),
          zIndex: sel ? 2 : dim ? 0 : 1 };
      },
    });
    sigmaRef.current = sigma;
    if (import.meta.env.DEV) (window as unknown as { __sigma?: unknown }).__sigma = sigma;  // lets browser tests find node coordinates

    sigma.on("clickNode", ({ node, event }) => {
      if (L.moved) return;
      const o = event.original as MouseEvent;
      L.props.onNode(node, o.shiftKey || o.metaKey || o.ctrlKey);
    });
    sigma.on("doubleClickNode", e => { e.preventSigmaDefault(); L.props.onDouble(e.node); });
    sigma.on("clickEdge", ({ edge }) => L.props.onEdge(edge));
    sigma.on("clickStage", () => { if (!L.moved) L.props.onBlank(); });
    const vp = (e: { event: { x: number; y: number } }) => ({ x: e.event.x, y: e.event.y });
    sigma.on("enterNode", e => { L.hover = e.node; host.current!.style.cursor = "pointer"; L.props.onHover({ node: e.node, ...vp(e) }); sigma.refresh({ skipIndexation: true }); });
    sigma.on("leaveNode", () => { L.hover = null; host.current!.style.cursor = ""; L.props.onHover(null); sigma.refresh({ skipIndexation: true }); });
    sigma.on("enterEdge", e => { L.hoverEdge = e.edge; host.current!.style.cursor = "pointer"; L.props.onHover({ edge: e.edge, ...vp(e) }); sigma.refresh({ skipIndexation: true }); });
    sigma.on("leaveEdge", () => { L.hoverEdge = null; host.current!.style.cursor = ""; L.props.onHover(null); sigma.refresh({ skipIndexation: true }); });

    // Drag to move; a moved node is pinned so layouts leave it in place.
    sigma.on("downNode", e => { L.dragging = e.node; L.moved = false; });
    sigma.on("downStage", () => { L.moved = false; });
    sigma.getMouseCaptor().on("mousemovebody", e => {
      if (!L.dragging) return;
      const pos = sigma.viewportToGraph(e);
      g.mergeNodeAttributes(L.dragging, { x: pos.x, y: pos.y, fixed: true });
      L.moved = true;
      e.preventSigmaDefault(); e.original.preventDefault(); e.original.stopPropagation();
    });
    const up = () => { if (L.dragging && L.moved) savePositions(); L.dragging = null; setTimeout(() => { L.moved = false; }, 0); };
    sigma.getMouseCaptor().on("mouseup", up);
    // The canvas resizes when the side panel opens or closes; Sigma only listens to window resizes by itself.
    const ro = new ResizeObserver(() => { sigma.resize(); sigma.refresh({ skipIndexation: true }); });
    ro.observe(host.current!);
    return () => { ro.disconnect(); sigma.kill(); sigmaRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- sync data ----------
  useEffect(() => {
    const g = graphRef.current;
    const saved = SavedPos(p.positionsKey);
    const keep = new Set(p.nodes.map(n => n.id));
    g.forEachNode(id => { if (!keep.has(id)) g.dropNode(id); });
    let fresh = 0;
    p.nodes.forEach((n, i) => {
      const attrs = { label: n.label, etype: n.type, status: n.status, size: n.size, fill: n.fill, community: n.community ?? "none" };
      if (g.hasNode(n.id)) g.mergeNodeAttributes(n.id, attrs);
      else {
        const s = saved[n.id];
        const a = i * 2.399, rr = 40 * Math.sqrt(i + 1);
        if (!s) fresh++;
        g.addNode(n.id, { ...attrs, x: s?.x ?? Math.cos(a) * rr, y: s?.y ?? Math.sin(a) * rr, fixed: !!s?.pinned });
      }
    });
    g.clearEdges();
    p.edges.forEach(e => { if (g.hasNode(e.s) && g.hasNode(e.o))
      g.addEdgeWithKey(e.id, e.s, e.o, { status: e.status, type: e.directed ? "arrow" : "line", label: e.label }); });
    if (fresh) runLayout(p.layout, false);
    sigmaRef.current?.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.nodes, p.edges, p.positionsKey]);

  // ---------- visual state ----------
  useEffect(() => { live.current.pal = readPal(); sigmaRef.current?.refresh(); }, [p.theme]);
  useEffect(() => { sigmaRef.current?.refresh({ skipIndexation: true }); }, [p.state]);

  useImperativeHandle(ref, () => ({
    zoom: f => { const c = sigmaRef.current?.getCamera(); if (f > 1) c?.animatedZoom({ duration: 200, factor: f }); else c?.animatedUnzoom({ duration: 200, factor: 1 / f }); },
    fit: () => {
      const s = sigmaRef.current, g = graphRef.current, hidden = live.current.props.state.hidden;
      if (!s) return;
      const xs: number[] = [], ys: number[] = [];
      g.forEachNode((id, a) => { if (!hidden.has(id)) { xs.push(a.x); ys.push(a.y); } });
      if (xs.length > 1 && hidden.size) s.setCustomBBox({ x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)] });
      else s.setCustomBBox(null);
      s.getCamera().animatedReset({ duration: 300 });
    },
    focus: id => {
      const s = sigmaRef.current; const d = s?.getNodeDisplayData(id);
      if (s && d) s.getCamera().animate({ x: d.x, y: d.y, ratio: Math.min(s.getCamera().ratio, 0.6) }, { duration: 400 });
    },
    relayout: (kind, reset = false) => runLayout(kind, true, reset),
    togglePin: id => { const g = graphRef.current; const v = !g.getNodeAttribute(id, "fixed"); g.setNodeAttribute(id, "fixed", v); savePositions(); return v; },
    isPinned: id => graphRef.current.hasNode(id) && !!graphRef.current.getNodeAttribute(id, "fixed"),
    exportPng: name => { const s = sigmaRef.current; if (s) downloadAsPNG(s, { fileName: name, backgroundColor: live.current.pal.canvas }); },
  }));

  return <div ref={host} className="sigma-host" role="img" aria-label={p.ariaLabel} />;
});

export default SigmaCanvas;
