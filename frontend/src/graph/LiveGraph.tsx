// Live 2D graph (force-graph on canvas): physics you can drag, hover to light up a node's neighbourhood with
// moving particles along its relationships, click to focus, double-click to expand, right-click to pin.
// Used by the Graph explorer ("Live" view) and the Reactions graph.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import ForceGraph from "force-graph";
import { forceCollide, forceX, forceY } from "d3-force-3d";
import { cssVar } from "../vocab";

export type LiveShape = "circle" | "square" | "diamond" | "hex";
export interface LiveNode { id: string; label: string; color: string; size: number; shape?: LiveShape; group?: string | null; sub?: string; ring?: string }
export interface LiveLink { id: string; source: string; target: string; label: string; color?: string; dashed?: boolean; width?: number }
export interface LiveHandle {
  zoom: (f: number) => void; fit: () => void; focus: (id: string) => void; relayout: (kind?: string, reset?: boolean) => void;
  togglePin: (id: string) => boolean; isPinned: (id: string) => boolean; exportPng: (name: string) => void;
}
interface Props {
  nodes: LiveNode[]; links: LiveLink[]; hidden?: Set<string>; highlight?: Set<string> | null; selected?: Set<string>; selEdge?: string | null;
  labels?: "auto" | "all" | "none"; theme: string; cluster?: boolean; ariaLabel: string;
  onNode?: (id: string, additive: boolean) => void; onDouble?: (id: string) => void; onEdge?: (id: string) => void; onBlank?: () => void;
  onHover?: (h: { node?: string; edge?: string; x: number; y: number } | null) => void;
}

type N = LiveNode & { x?: number; y?: number; fx?: number; fy?: number; deg?: number };
type L = Omit<LiveLink, "source" | "target"> & { source: string | N; target: string | N; curve?: number };
const idOf = (v: string | N) => (typeof v === "string" ? v : v.id);

function path(ctx: CanvasRenderingContext2D, shape: LiveShape, x: number, y: number, r: number) {
  ctx.beginPath();
  if (shape === "square") ctx.roundRect(x - r * 0.88, y - r * 0.88, r * 1.76, r * 1.76, r * 0.35);
  else if (shape === "diamond") { ctx.moveTo(x, y - r * 1.15); ctx.lineTo(x + r * 1.15, y); ctx.lineTo(x, y + r * 1.15); ctx.lineTo(x - r * 1.15, y); ctx.closePath(); }
  else if (shape === "hex") { for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i - Math.PI / 6; ctx[i ? "lineTo" : "moveTo"](x + r * 1.05 * Math.cos(a), y + r * 1.05 * Math.sin(a)); } ctx.closePath(); }
  else ctx.arc(x, y, r, 0, Math.PI * 2);
}

const LiveGraph = forwardRef<LiveHandle, Props>(function LiveGraph(p, ref) {
  const host = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraph<N, L> | null>(null);
  const objs = useRef(new Map<string, N>());
  const live = useRef({ p, hover: null as string | null, hoverNb: null as Set<string> | null, hoverLink: null as string | null, lastClick: { id: "", t: 0 },
    pal: { tx: "", tx2: "", tx3: "", surf: "", hi: "", font: "", light: false }, t0: performance.now(), touched: false, fits: 0 });
  live.current.p = p;

  const readPal = () => {
    live.current.pal = { tx: cssVar("--tx"), tx2: cssVar("--tx2"), tx3: cssVar("--tx3"), surf: cssVar("--surf"), hi: cssVar("--hi") || "#D4A574",
      font: getComputedStyle(document.body).fontFamily, light: document.documentElement.dataset.theme === "light" };
  };

  // ---------- mount once ----------
  useEffect(() => {
    readPal();
    const L0 = live.current;
    const fg = new ForceGraph<N, L>(host.current!);
    fgRef.current = fg;
    const lit = (id: string) => {
      const { p: pp, hoverNb } = L0;
      if (hoverNb) return hoverNb.has(id);
      if (pp.highlight) return pp.highlight.has(id) || !!pp.selected?.has(id);
      return true;
    };
    const linkLit = (l: L) => {
      const s = idOf(l.source), t = idOf(l.target);
      if (L0.hoverLink === l.id || L0.p.selEdge === l.id) return true;
      if (L0.hover) return s === L0.hover || t === L0.hover;
      const sel = L0.p.selected;
      if (sel && sel.size) return sel.has(s) || sel.has(t);
      return false;
    };
    const dimmed = (l: L) => (!!L0.hoverNb || !!L0.p.highlight) && !(lit(idOf(l.source)) && lit(idOf(l.target)));

    fg.backgroundColor("rgba(0,0,0,0)")
      .autoPauseRedraw(false)
      .nodeId("id").linkSource("source").linkTarget("target")
      .nodeVisibility(n => !L0.p.hidden?.has(n.id))
      .linkVisibility(l => !(L0.p.hidden?.has(l.id) || L0.p.hidden?.has(idOf(l.source)) || L0.p.hidden?.has(idOf(l.target))))
      .nodeRelSize(1).nodeVal(n => n.size * n.size)
      .nodeCanvasObject((n, ctx, scale) => {
        const { pal, p: pp } = L0;
        const x = n.x ?? 0, y = n.y ?? 0, sel = !!pp.selected?.has(n.id), hov = L0.hover === n.id, on = lit(n.id);
        const r = n.size * (hov || sel ? 1.18 : 1);
        ctx.globalAlpha = on ? 1 : 0.13;
        // halo: soft glow on hover / selection, a slow pulse on selected nodes
        if ((hov || sel) && on) {
          const pulse = sel ? 1 + 0.25 * Math.sin((performance.now() - L0.t0) / 320) : 1;
          ctx.beginPath(); ctx.arc(x, y, r * 2.1 * pulse, 0, Math.PI * 2);
          const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 2.1 * pulse);
          g.addColorStop(0, n.color + "66"); g.addColorStop(1, n.color + "00"); ctx.fillStyle = g; ctx.fill();
        }
        path(ctx, n.shape ?? "circle", x, y, r);
        ctx.fillStyle = n.color; ctx.fill();
        ctx.lineWidth = Math.max(1.2, 2 / scale); ctx.strokeStyle = n.ring ?? pal.surf; ctx.stroke();
        if (n.fx != null) { ctx.beginPath(); ctx.arc(x + r * 0.75, y - r * 0.75, Math.max(1.6, 2.4 / scale), 0, Math.PI * 2); ctx.fillStyle = pal.hi; ctx.fill(); }
        if (sel) { path(ctx, n.shape ?? "circle", x, y, r + 3.5 / scale); ctx.lineWidth = 2.2 / scale; ctx.strokeStyle = pal.hi; ctx.stroke(); }
        // labels: always for hover / selection / lit neighbourhood; by zoom level otherwise
        const mode = pp.labels ?? "auto";
        const small = pp.nodes.length <= 80;
        const show = mode !== "none" && on && (hov || sel || mode === "all" || (L0.hoverNb && on) || (!!pp.highlight && on) || scale * n.size > (small ? 6 : 13));
        if (show || hov || sel) {
          const fs = Math.max(10 / scale, 3.2), text = n.label.length > 34 ? n.label.slice(0, 32) + "…" : n.label;
          ctx.font = `${hov || sel ? 600 : 500} ${fs}px ${pal.font}`;
          const w = ctx.measureText(text).width, ty = y + r + fs * 0.4;
          ctx.fillStyle = pal.surf; ctx.globalAlpha = (on ? 0.82 : 0.1);
          ctx.beginPath(); ctx.roundRect(x - w / 2 - fs * 0.35, ty - fs * 0.15, w + fs * 0.7, fs * 1.3, fs * 0.3); ctx.fill();
          ctx.globalAlpha = on ? 1 : 0.13; ctx.fillStyle = hov || sel ? pal.tx : pal.tx2; ctx.textAlign = "center"; ctx.textBaseline = "top";
          ctx.fillText(text, x, ty);
          if (n.sub && (hov || sel)) { ctx.font = `400 ${fs * 0.82}px ${pal.font}`; ctx.fillStyle = pal.tx3; ctx.fillText(n.sub, x, ty + fs * 1.25); }
        }
        ctx.globalAlpha = 1;
      })
      .nodePointerAreaPaint((n, color, ctx) => { path(ctx, n.shape ?? "circle", n.x ?? 0, n.y ?? 0, n.size + 2); ctx.fillStyle = color; ctx.fill(); })
      .linkColor(l => { const c = l.color ?? (L0.pal.light ? L0.pal.tx3 : L0.pal.tx3); return dimmed(l) ? c + "18" : linkLit(l) ? L0.pal.hi : c + (L0.pal.light ? "aa" : "88"); })
      .linkWidth(l => (linkLit(l) ? 2.4 : l.width ?? 1))
      .linkLineDash(l => (l.dashed ? [4, 3] : null))
      .linkCurvature(l => l.curve ?? 0)
      .linkDirectionalArrowLength(l => (dimmed(l) ? 0 : 4)).linkDirectionalArrowRelPos(0.92)
      .linkDirectionalArrowColor(l => (linkLit(l) ? L0.pal.hi : (l.color ?? L0.pal.tx3)))
      .linkDirectionalParticles(l => (linkLit(l) ? 3 : 0)).linkDirectionalParticleWidth(3.2).linkDirectionalParticleSpeed(0.007)
      .linkDirectionalParticleColor(() => L0.pal.hi)
      .linkCanvasObjectMode(() => "after")
      .linkCanvasObject((l, ctx, scale) => {
        if (!linkLit(l) || typeof l.source === "string" || typeof l.target === "string") return;
        const s = l.source as N, t = l.target as N, fs = Math.max(9 / scale, 2.6);
        const mx = ((s.x ?? 0) + (t.x ?? 0)) / 2, my = ((s.y ?? 0) + (t.y ?? 0)) / 2;
        ctx.font = `600 ${fs}px ${L0.pal.font}`; const w = ctx.measureText(l.label).width;
        ctx.fillStyle = L0.pal.surf; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.roundRect(mx - w / 2 - fs * 0.4, my - fs * 0.7, w + fs * 0.8, fs * 1.4, fs * 0.35); ctx.fill();
        ctx.globalAlpha = 1; ctx.fillStyle = L0.pal.hi; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(l.label, mx, my);
      })
      .onNodeHover(n => {
        L0.hover = n?.id ?? null;
        if (n) {
          const nb = new Set([n.id]);
          fg.graphData().links.forEach(l => { const s = idOf(l.source), t = idOf(l.target); if (s === n.id) nb.add(t); if (t === n.id) nb.add(s); });
          L0.hoverNb = nb;
        } else L0.hoverNb = null;
        host.current!.style.cursor = n ? "pointer" : "grab";
        if (n && L0.p.onHover) { const c = fg.graph2ScreenCoords(n.x ?? 0, n.y ?? 0); L0.p.onHover({ node: n.id, x: c.x, y: c.y }); } else if (!n) L0.p.onHover?.(null);
      })
      .onLinkHover(l => {
        L0.hoverLink = l?.id ?? null;
        if (l && L0.p.onHover && typeof l.source !== "string" && typeof l.target !== "string") {
          const s = l.source as N, t = l.target as N; const c = fg.graph2ScreenCoords(((s.x ?? 0) + (t.x ?? 0)) / 2, ((s.y ?? 0) + (t.y ?? 0)) / 2);
          L0.p.onHover({ edge: l.id, x: c.x, y: c.y });
        } else if (!l && !L0.hover) L0.p.onHover?.(null);
      })
      .onNodeClick((n, e) => {
        const now = performance.now();
        if (L0.lastClick.id === n.id && now - L0.lastClick.t < 320) { L0.lastClick = { id: "", t: 0 }; L0.p.onDouble?.(n.id); return; }
        L0.lastClick = { id: n.id, t: now };
        L0.p.onNode?.(n.id, e.shiftKey || e.metaKey || e.ctrlKey);
      })
      .onNodeRightClick(n => { if (n.fx != null) { n.fx = undefined; n.fy = undefined; } else { n.fx = n.x; n.fy = n.y; } fg.d3ReheatSimulation(); })
      .onNodeDragEnd(n => { n.fx = n.x; n.fy = n.y; L0.touched = true; })
      .onLinkClick(l => L0.p.onEdge?.(l.id))
      .onBackgroundClick(() => L0.p.onBlank?.())
      .cooldownTicks(220).d3VelocityDecay(0.32).warmupTicks(30);
    fg.d3Force("charge")?.strength?.(-140);
    fg.d3Force("collide", forceCollide((n: N) => n.size + 6).strength(0.9));
    const ro = new ResizeObserver(() => { const el = host.current; if (el) fg.width(el.clientWidth).height(el.clientHeight); });
    ro.observe(host.current!);
    // Keep the whole graph in view while it settles, until the user zooms, pans or drags.
    const touch = () => { L0.touched = true; };
    host.current!.addEventListener("wheel", touch, { passive: true });
    host.current!.addEventListener("pointerdown", touch);
    fg.onEngineStop(() => { if (!L0.touched && L0.fits < 4) { L0.fits++; fg.zoomToFit(500, 50, n => !L0.p.hidden?.has(n.id)); } });
    return () => { ro.disconnect(); fg.pauseAnimation(); fg._destructor(); fgRef.current = null; };
  }, []);

  // ---------- data: reuse node objects so filters and refreshes do not restart the layout ----------
  useEffect(() => {
    const fg = fgRef.current; if (!fg) return;
    const m = objs.current, next = new Map<string, N>();
    const nodes = p.nodes.map(n => { const o = m.get(n.id) ?? ({} as N); Object.assign(o, n); next.set(n.id, o); return o; });
    objs.current = next;
    const pairs = new Map<string, number>();
    const links: L[] = p.links.filter(l => next.has(l.source) && next.has(l.target)).map(l => {
      const k = [l.source, l.target].sort().join("|"), i = pairs.get(k) ?? 0; pairs.set(k, i + 1);
      return { ...l, curve: i === 0 ? 0 : (i % 2 ? 1 : -1) * 0.18 * Math.ceil(i / 2) };
    });
    const fresh = nodes.some(n => n.x == null);
    fg.graphData({ nodes, links });
    if (fresh) { live.current.fits = 0; fg.d3ReheatSimulation(); }
  }, [p.nodes, p.links]);

  // ---------- cluster by group (communities / categories) ----------
  useEffect(() => {
    const fg = fgRef.current; if (!fg) return;
    // Without grouping, a gentle pull to the centre keeps disconnected parts of the graph together.
    if (!p.cluster) { fg.d3Force("gx", forceX(0).strength(0.045)); fg.d3Force("gy", forceY(0).strength(0.045)); live.current.fits = 0; fg.d3ReheatSimulation(); return; }
    const groups = [...new Set(p.nodes.map(n => n.group ?? "_"))], R = 30 + groups.length * 22;
    const pos = Object.fromEntries(groups.map((g, i) => [g, { x: Math.cos((i / groups.length) * 2 * Math.PI) * R, y: Math.sin((i / groups.length) * 2 * Math.PI) * R }]));
    fg.d3Force("gx", forceX((n: N) => pos[n.group ?? "_"].x).strength(0.08));
    fg.d3Force("gy", forceY((n: N) => pos[n.group ?? "_"].y).strength(0.08));
    live.current.fits = 0; fg.d3ReheatSimulation();
  }, [p.cluster, p.nodes]);

  useEffect(() => { readPal(); }, [p.theme]);

  useImperativeHandle(ref, () => ({
    zoom: f => { const fg = fgRef.current; if (fg) fg.zoom(fg.zoom() * f, 250); },
    fit: () => fgRef.current?.zoomToFit(450, 60, n => !live.current.p.hidden?.has(n.id)),
    focus: id => { const fg = fgRef.current, n = objs.current.get(id); if (fg && n?.x != null) { fg.centerAt(n.x, n.y, 500); fg.zoom(Math.max(fg.zoom(), 2.2), 500); } },
    relayout: (_k, reset) => { const fg = fgRef.current; if (!fg) return; if (reset) objs.current.forEach(n => { n.fx = undefined; n.fy = undefined; }); fg.d3ReheatSimulation(); },
    togglePin: id => { const n = objs.current.get(id); if (!n) return false; if (n.fx != null) { n.fx = undefined; n.fy = undefined; } else { n.fx = n.x; n.fy = n.y; } return n.fx != null; },
    isPinned: id => objs.current.get(id)?.fx != null,
    exportPng: name => { const c = host.current?.querySelector("canvas"); if (!c) return; const a = document.createElement("a"); a.href = c.toDataURL("image/png"); a.download = `${name}.png`; a.click(); },
  }), []);

  return <div ref={host} className="live-graph" role="img" aria-label={p.ariaLabel} />;
});

export default LiveGraph;
