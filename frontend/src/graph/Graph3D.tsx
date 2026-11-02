import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
import SpriteText from "three-spritetext";
import { ETYPES } from "../vocab";
import { cssVar, typeColor } from "../vocab";

/** `group` is a cluster key (community, stance camp…); `layer` separates the original graph from what is drawn on it. */
export interface G3Node { id: string; name: string; type: string; info?: string; root?: boolean; group?: string; layer?: string }
export interface G3Link { source: string; target: string; type: string; id?: string; kind?: string; layer?: string }
// Node kinds used by reaction graphs; entity types fall back to the ontology colours.
const EXTRA_COLORS: Record<string, string> = { persona: "#F59E0B", actor: "#94A3B8", post: "#3B82F6", comment: "#10B981", repost: "#8B5CF6" };
const colorOf = (t: string) => EXTRA_COLORS[t] ?? typeColor(t);
// Original-graph relations between actors keep their meaning in the colour: allies green, opponents red.
const KIND_COLORS: Record<string, string> = { ally: "#10B981", opponent: "#EF4444" };
const EMPTY = new Set<string>();
type N = G3Node & { x?: number; y?: number; z?: number; born: number };
type L = { source: string | N; target: string | N; type: string; born: number; id?: string; kind?: string; layer?: string };
type Rel = { dir: "out" | "in"; type: string; other: string };
type Card = { kind: "node"; node: N; rels: Rel[]; x: number; y: number } | { kind: "link"; s: string; t: string; type: string; x: number; y: number };

const endId = (e: string | N) => (typeof e === "string" ? e : e.id);
const label = (t: string) => ETYPES[t as keyof typeof ETYPES]?.label ?? t[0].toUpperCase() + t.slice(1);

/**
 * Three.js force graph that grows as data arrives. New nodes and links are queued and added a few
 * per frame, so a build that finishes in seconds still reads as the graph assembling. Hover a node
 * or link for details; click a node to pin its details and highlight its neighbourhood.
 */
export default function Graph3D({ nodes, links, live, theme, labels = true, nodeHref, hidden, isolate, onPick, pin = true, colorByGroup = false, gather = false,
  groupColors, groupLabels, labelFilter }: {
  nodes: G3Node[]; links: G3Link[]; live: boolean; theme: string; labels?: boolean; nodeHref?: (n: G3Node) => string;
  /** Colour nodes by `group` instead of by type. */ colorByGroup?: boolean;
  /** Pull each group together into a cluster and label it. */ gather?: boolean;
  groupColors?: Record<string, string>; groupLabels?: Record<string, string>;
  /** Which nodes keep a permanent name label (others show it when hovered). Default: all. */ labelFilter?: (n: G3Node) => boolean;
  /** Node/link ids to hide (filters). */ hidden?: Set<string>;
  /** Show only this node and its direct connections (the page owns the state). */ isolate?: string | null;
  /** Called when a node is clicked. With pin=false the page shows the details itself. */ onPick?: (id: string) => void; pin?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fg = useRef<ForceGraph3DInstance | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [pinned, setPinned] = useState<{ node: N; rels: Rel[] } | null>(null);
  const S = useRef({ have: new Map<string, N>(), haveLinks: new Set<string>(), qN: [] as G3Node[], qL: [] as G3Link[],
    nodes: [] as N[], links: [] as L[], live, angle: 0, labels, focus: null as Set<string> | null, focusLinks: null as Set<L> | null,
    mouse: { x: 0, y: 0 }, pinnedId: null as string | null, hidden: EMPTY, isolate: null as string | null,
    onPick: undefined as ((id: string) => void) | undefined, pin: true,
    colorByGroup: false, gather: false, groupColors: {} as Record<string, string>, groupLabels: {} as Record<string, string>,
    labelFilter: undefined as ((n: G3Node) => boolean) | undefined }).current;
  S.live = live;
  S.labels = labels;
  S.hidden = hidden ?? EMPTY;
  S.isolate = isolate ?? null;
  S.onPick = onPick;
  S.pin = pin;
  S.colorByGroup = colorByGroup;
  S.gather = gather;
  S.groupColors = groupColors ?? {};
  S.groupLabels = groupLabels ?? {};
  S.labelFilter = labelFilter;

  const relsOf = (id: string): Rel[] => S.links.flatMap((l): Rel[] => {
    const s = endId(l.source), t = endId(l.target);
    return s === id ? [{ dir: "out" as const, type: l.type, other: S.have.get(t)?.name ?? t }]
      : t === id ? [{ dir: "in" as const, type: l.type, other: S.have.get(s)?.name ?? s }] : [];
  });
  const setFocus = (id: string | null) => {
    if (!id) { S.focus = null; S.focusLinks = null; }
    else {
      S.focus = new Set([id]); S.focusLinks = new Set();
      for (const l of S.links) {
        const s = endId(l.source), t = endId(l.target);
        if (s === id || t === id) { S.focus.add(s); S.focus.add(t); S.focusLinks.add(l); }
      }
    }
    restyle();
  };
  // Re-applying accessors makes three-forcegraph rebuild materials (colors, sprites) with current state and theme.
  const restyle = () => {
    const g = fg.current;
    if (!g) return;
    const light = document.documentElement.dataset.theme === "light";
    const dim = (n: N) => !!S.focus && !S.focus.has(n.id);
    g.backgroundColor(cssVar("--canvas") || (light ? "#FAFBFD" : "#0A0F1D"))
      .nodeVisibility(n => !S.hidden.has((n as N).id))
      .linkVisibility(l => {
        const a = endId((l as L).source), b = endId((l as L).target);
        if (S.hidden.has(a) || S.hidden.has(b) || ((l as L).id && S.hidden.has((l as L).id!))) return false;
        return !S.isolate || a === S.isolate || b === S.isolate;  // isolate: only the clicked node's own connections
      })
      .nodeColor(n => {
        const node = n as N;
        if (dim(node)) return light ? "#d7dce4" : "#2a3242";
        return (S.colorByGroup && node.group && S.groupColors[node.group]) || colorOf(node.type);
      })
      .linkColor(l => (S.focusLinks?.has(l as L) ? cssVar("--acc") : KIND_COLORS[(l as L).kind ?? ""] ?? (light ? "#334155" : "#64748B")))
      .linkOpacity(light ? 0.85 : 0.4)
      .linkWidth(l => (S.focusLinks?.has(l as L) ? 1.8 : Date.now() - (l as L).born < 2500 ? 1.2 : light ? 1 : 0.4))
      .nodeThreeObject(n => {
        const node = n as N;
        const show = node.type === "document" || (S.labels && (!S.focus || S.focus.has(node.id)) && (!S.labelFilter || S.labelFilter(node) || !!S.focus));
        if (!show) return undefined as never;
        const t = new SpriteText(node.name.length > 28 ? node.name.slice(0, 26) + "…" : node.name, node.type === "document" ? 4.2 : 2.8,
          light ? "#1e293b" : "#e5e7eb");
        t.fontWeight = node.type === "document" || S.focus?.has(node.id) ? "700" : "500";
        if (light) { t.backgroundColor = "rgba(255,255,255,.72)"; t.padding = 1; t.borderRadius = 2; }
        t.position.y = node.type === "document" ? 10 : 6;
        return t;
      });
  };

  // Mount once.
  useEffect(() => {
    const g = new ForceGraph3D(host.current!, { controlType: "orbit" })
      .showNavInfo(false)
      .nodeRelSize(4)
      .nodeVal(n => ((n as N).root ? 7 : (n as N).type === "document" ? 6 : (n as N).type === "persona" ? 3.4 : 1.4 + Math.min(4, relsOfCount((n as N).id) * 0.35)))
      .nodeOpacity(0.95)
      .nodeResolution(14)
      .nodeLabel(() => "")  // custom hover card instead of the built-in tooltip
      .linkLabel(() => "")
      .nodeThreeObjectExtend(true)
      .linkDirectionalParticles(l => (S.live && Date.now() - (l as L).born < 3000 ? 2 : 0))
      .linkDirectionalParticleSpeed(0.012)
      .linkDirectionalParticleWidth(1.6)
      .linkDirectionalArrowLength(l => ((l as L).type === "MENTIONED_IN" ? 0 : 2.2))
      .linkDirectionalArrowRelPos(1)
      .d3VelocityDecay(0.3)
      .warmupTicks(0)
      .cooldownTicks(300)
      .onNodeHover(n => {
        host.current!.style.cursor = n ? "pointer" : "";
        if (!n) { setCard(null); if (!S.pinnedId) setFocus(null); return; }
        const node = n as N;
        if (!S.pinnedId) setFocus(node.id);
        setCard({ kind: "node", node, rels: relsOf(node.id), ...S.mouse });
      })
      .onLinkHover(l => {
        if (!l) { setCard(null); return; }
        const link = l as L;
        setCard({ kind: "link", s: S.have.get(endId(link.source))?.name ?? endId(link.source), t: S.have.get(endId(link.target))?.name ?? endId(link.target),
          type: link.type, ...S.mouse });
      })
      .onNodeClick(n => {
        const node = n as N;
        S.onPick?.(node.id);
        if (!S.pin) {  // the page shows details and decides what stays visible
          const d = 90, r = 1 + d / Math.hypot(node.x ?? 1, node.y ?? 1, node.z ?? 1);
          g.cameraPosition({ x: (node.x ?? 0) * r, y: (node.y ?? 0) * r, z: (node.z ?? 0) * r }, node as { x: number; y: number; z: number }, 700);
          return;
        }
        S.pinnedId = node.id; setFocus(node.id); setPinned({ node, rels: relsOf(node.id) });
        const d = 90, r = 1 + d / Math.hypot(node.x ?? 1, node.y ?? 1, node.z ?? 1);
        g.cameraPosition({ x: (node.x ?? 0) * r, y: (node.y ?? 0) * r, z: (node.z ?? 0) * r }, node as { x: number; y: number; z: number }, 900);
      })
      .onBackgroundClick(() => { if (!S.pin) return; S.pinnedId = null; setPinned(null); setFocus(null); });
    const relsOfCount = (id: string) => S.links.reduce((k, l) => k + (endId(l.source) === id || endId(l.target) === id ? 1 : 0), 0);
    (g.d3Force("charge") as unknown as { strength: (v: number) => void } | undefined)?.strength(-28);

    // Cluster layout: each node is pulled toward the centre of its own group, so groups read as separate clumps.
    type Mover = N & { vx?: number; vy?: number; vz?: number };
    const centres = () => {
      const c = new Map<string, { x: number; y: number; z: number; n: number }>();
      for (const n of S.nodes) {
        if (!n.group) continue;
        const e = c.get(n.group) ?? { x: 0, y: 0, z: 0, n: 0 };
        e.x += n.x ?? 0; e.y += n.y ?? 0; e.z += n.z ?? 0; e.n++;
        c.set(n.group, e);
      }
      return c;
    };
    // Each group gets its own anchor, spread over a sphere (golden-angle spiral) so clusters stay apart from any viewing angle
    // even when many links cross between them.
    const anchors = () => {
      const keys = [...new Set(S.nodes.map(n => n.group).filter((x): x is string => !!x))].sort();
      const r = keys.length < 2 ? 0 : 50 + 14 * Math.sqrt(S.nodes.length);
      return new Map(keys.map((k, i) => {
        const y = 1 - (2 * i + 1) / keys.length, ring = Math.sqrt(Math.max(0, 1 - y * y)), th = i * 2.399963;
        return [k, { x: r * ring * Math.cos(th), y: r * y, z: r * ring * Math.sin(th) }];
      }));
    };
    const cluster = Object.assign((alpha: number) => {
      if (!S.gather) return;
      const a = anchors();
      const k = 0.05 + 0.25 * alpha;
      for (const n of S.nodes as Mover[]) {
        if (typeof n !== "object") continue;
        const t = n.group ? a.get(n.group) : undefined;
        if (!t) continue;
        n.vx = (n.vx ?? 0) + (t.x - (n.x ?? 0)) * k;
        n.vy = (n.vy ?? 0) + (t.y - (n.y ?? 0)) * k;
        n.vz = (n.vz ?? 0) + (t.z - (n.z ?? 0)) * k;
      }
    }, { initialize: () => undefined });
    g.d3Force("cluster", cluster as never);
    // A floating label above each cluster while clusters are gathered.
    const tags = new Map<string, SpriteText>();
    g.onEngineTick(() => {
      const scene = g.scene();
      const c = S.gather ? centres() : new Map<string, { x: number; y: number; z: number; n: number }>();
      for (const [key, t] of tags) if (!c.has(key) || c.get(key)!.n < 2) t.visible = false;
      for (const [key, e] of c) {
        if (e.n < 2) continue;
        let t = tags.get(key);
        const text = `${S.groupLabels[key] ?? key} · ${e.n}`;
        if (!t) { t = new SpriteText(text, 4.2, "#fff"); t.fontWeight = "700"; t.padding = 2; t.borderRadius = 3; scene.add(t); tags.set(key, t); }
        else if (t.text !== text) t.text = text;
        t.backgroundColor = S.groupColors[key] ?? "#64748B";
        t.visible = true;
        let spread = 0;
        for (const n of S.nodes) if (n.group === key) spread = Math.max(spread, Math.hypot((n.x ?? 0) - e.x / e.n, (n.y ?? 0) - e.y / e.n, (n.z ?? 0) - e.z / e.n));
        t.position.set(e.x / e.n, e.y / e.n + spread + 8, e.z / e.n);
      }
    });
    g.onEngineStop(() => { if (!S.live) g.zoomToFit(800, 30); });
    g.graphData({ nodes: [], links: [] });
    g.cameraPosition({ x: 0, y: 0, z: 320 });
    fg.current = g;
    if (import.meta.env.DEV) (window as unknown as { __graph3d?: unknown }).__graph3d = g;  // lets browser tests find node coordinates
    restyle();

    const el = host.current!;
    const move = (e: PointerEvent) => { const r = el.getBoundingClientRect(); S.mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; setCard(c => (c ? { ...c, ...S.mouse } : c)); };
    el.addEventListener("pointermove", move);
    const ro = new ResizeObserver(([e]) => { g.width(e.contentRect.width); g.height(e.contentRect.height); });
    ro.observe(el);

    // Drain queues: a handful of nodes per tick, then any links whose ends now exist.
    const pump = window.setInterval(() => {
      if (!S.qN.length && !S.qL.length) return;
      let changed = false;
      const now = Date.now();
      for (const n of S.qN.splice(0, S.live ? 4 : 40)) {
        if (S.have.has(n.id)) continue;
        const anchor = S.qL.find(l => (l.source === n.id && S.have.has(l.target)) || (l.target === n.id && S.have.has(l.source)));
        const near = anchor ? S.have.get(anchor.source === n.id ? anchor.target : anchor.source) : undefined;
        const jitter = () => (Math.random() - 0.5) * 30;
        const node: N = { ...n, born: now, x: (near?.x ?? 0) + jitter(), y: (near?.y ?? 0) + jitter(), z: (near?.z ?? 0) + jitter() };
        S.have.set(n.id, node); S.nodes.push(node); changed = true;
      }
      const rest: G3Link[] = [];
      for (const l of S.qL) {
        const key = `${l.source}|${l.target}|${l.type}`;
        if (S.haveLinks.has(key)) continue;
        if (S.have.has(l.source) && S.have.has(l.target)) { S.haveLinks.add(key); S.links.push({ ...l, born: now }); changed = true; }
        else rest.push(l);
      }
      S.qL = rest;
      if (changed) g.graphData({ nodes: S.nodes, links: S.links });
    }, 90);

    // Slow orbit while building; stops once the user drags the view.
    let userMoved = false;
    const stopOrbit = () => { userMoved = true; };
    el.addEventListener("pointerdown", stopOrbit);
    const orbit = window.setInterval(() => {
      if (userMoved || !S.live) return;
      S.angle += 0.004;
      const dist = Math.max(220, 90 + Math.sqrt(S.nodes.length) * 34);
      g.cameraPosition({ x: dist * Math.sin(S.angle), z: dist * Math.cos(S.angle) });
    }, 30);

    return () => {
      window.clearInterval(pump); window.clearInterval(orbit); ro.disconnect();
      el.removeEventListener("pointermove", move); el.removeEventListener("pointerdown", stopOrbit);
      g._destructor(); fg.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Queue anything new; a node set that drops existing ids is a reset (e.g. live preview -> final graph).
  useEffect(() => {
    const ids = new Set(nodes.map(n => n.id));
    const stale = [...S.have.keys()].filter(id => !ids.has(id));
    if (stale.length) {
      stale.forEach(id => S.have.delete(id));
      S.nodes = S.nodes.filter(n => ids.has(n.id));
      S.links = S.links.filter(l => ids.has(endId(l.source)) && ids.has(endId(l.target)));
      S.haveLinks = new Set(S.links.map(l => `${endId(l.source)}|${endId(l.target)}|${l.type}`));
      fg.current?.graphData({ nodes: S.nodes, links: S.links });
    }
    let regrouped = false;  // e.g. live preview grouped by type, then by community once the build finishes
    for (const n of nodes) {
      const h = S.have.get(n.id);
      if (h && h.group !== n.group) { h.group = n.group; regrouped = true; }
    }
    if (regrouped) { restyle(); fg.current?.d3ReheatSimulation(); }
    S.qN.push(...nodes.filter(n => !S.have.has(n.id) && !S.qN.some(q => q.id === n.id)));
    const key = (l: G3Link) => `${l.source}|${l.target}|${l.type}`;
    const queued = new Set(S.qL.map(key));
    S.qL.push(...links.filter(l => !S.haveLinks.has(key(l)) && !queued.has(key(l))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, links]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { restyle(); }, [theme, labels]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { restyle(); fg.current?.d3ReheatSimulation(); }, [colorByGroup, gather, groupColors]);
  // Filters or a new isolated node: re-apply visibility, then frame what is left.
  useEffect(() => {
    restyle();
    const t = setTimeout(() => fg.current?.zoomToFit(700, 130, n => !S.hidden.has((n as N).id)), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, isolate]);
  useEffect(() => { if (!live) setTimeout(() => fg.current?.zoomToFit(900, 30), 2500); }, [live]);

  const relList = (rels: Rel[], max: number) => <ul className="g3-rels">{rels.slice(0, max).map((r, i) =>
    <li key={i}><span className="dim">{r.dir === "out" ? "→" : "←"}</span> <b>{r.type.replace(/_/g, " ").toLowerCase()}</b> {r.other}</li>)}
    {rels.length > max && <li className="dim">+{rels.length - max} more</li>}</ul>;

  return <>
    <div ref={host} style={{ position: "absolute", inset: 0 }} role="img" aria-label="3D knowledge graph — hover nodes for details, click to pin" />
    {card && <div className="g3-tip" style={{ left: Math.min(card.x + 16, (host.current?.clientWidth ?? 9999) - 300), top: card.y + 16 }}>
      {card.kind === "node" ? <>
        <div className="row" style={{ gap: 6 }}><i className="g3-dot" style={{ background: colorOf(card.node.type) }} /><b>{card.node.name}</b></div>
        <div className="xs muted mt8">{label(card.node.type)} · {card.rels.length} connection{card.rels.length === 1 ? "" : "s"}</div>
        {card.node.info && <p className="xs mt8" style={{ color: "var(--tx2)", lineHeight: 1.5 }}>{card.node.info.slice(0, 260)}</p>}
        {card.rels.length > 0 && relList(card.rels, 5)}
        <div className="xs dim mt8">Click to pin details</div></>
        : <div className="small"><b>{card.s}</b> <span className="muted">{card.type.replace(/_/g, " ").toLowerCase()}</span> <b>{card.t}</b></div>}
    </div>}
    {pin && pinned && <div className="g3-pin">
      <div className="row"><i className="g3-dot" style={{ background: colorOf(pinned.node.type) }} /><b className="grow">{pinned.node.name}</b>
        <button className="btn ghost sm icon" aria-label="Close details" onClick={() => { S.pinnedId = null; setPinned(null); setFocus(null); }}><X /></button></div>
      <div className="xs muted mt8">{label(pinned.node.type)} · {pinned.rels.length} connections</div>
      {pinned.node.info && <p className="xs mt8" style={{ color: "var(--tx2)", lineHeight: 1.5 }}>{pinned.node.info}</p>}
      {pinned.rels.length ? relList(pinned.rels, 12) : <p className="xs dim mt8">No relationships yet.</p>}
      {nodeHref && pinned.node.type !== "document" && <Link className="btn sm mt8" to={nodeHref(pinned.node)}>Open evidence in graph explorer</Link>}
    </div>}
  </>;
}
