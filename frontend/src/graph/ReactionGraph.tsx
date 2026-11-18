// Reactions as a live 2D graph: actor → reaction hypothesis → graph entities it relies on.
import { useMemo, useRef, useState } from "react";
import { Scan, ZoomIn, ZoomOut } from "lucide-react";
import type { Reaction, ReactionCategory } from "../api";
import { useTheme } from "../hooks";
import { cssVar, typeColor } from "../vocab";
import LiveGraph, { type LiveHandle, type LiveLink, type LiveNode } from "./LiveGraph";

export const CAT_COLOR: Record<ReactionCategory, string> = { support: "--sup", opposition: "--opp", concern: "--warn", neutrality: "--neu", negotiation: "--steel",
  public_communication: "--organization", policy_response: "--policy", operational_response: "--agent" };

export default function ReactionGraph({ items, labels, onPick }: { items: Reaction[]; labels: Record<ReactionCategory, string>; onPick: (id: string) => void }) {
  const theme = useTheme();
  const ref = useRef<LiveHandle>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [cluster, setCluster] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number; html: React.ReactNode } | null>(null);
  const byId = useMemo(() => new Map(items.map(r => [r.id, r])), [items]);

  const { nodes, links } = useMemo(() => {
    const ns = new Map<string, LiveNode>(), ls: LiveLink[] = [];
    const shape = (t: string) => (t === "organization" ? "square" : t === "country" ? "diamond" : "circle") as LiveNode["shape"];
    for (const r of items) {
      const aid = "a:" + r.actor_id;
      if (!ns.has(aid)) ns.set(aid, { id: aid, label: r.actor_name, color: typeColor(r.actor_type), size: 12, shape: shape(r.actor_type), group: r.category, sub: `${r.actor_type} · actor` });
      const c = cssVar(CAT_COLOR[r.category]) || "#8C9AAB";
      ns.set("r:" + r.id, { id: "r:" + r.id, label: r.title, color: c, size: 5 + r.confidence * 6, shape: "hex", group: r.category,
        ring: r.status === "selected" ? cssVar("--ok") : r.status === "excluded" ? cssVar("--err") : undefined,
        sub: `${labels[r.category]} · ${Math.round(r.confidence * 100)}% · ${r.status}` });
      ls.push({ id: `l:${r.id}`, source: aid, target: "r:" + r.id, label: labels[r.category].toUpperCase(), color: c, width: 1.6, dashed: r.status === "excluded" });
      for (const x of r.related) {
        const eid = "e:" + x.id;
        if (!ns.has(eid)) ns.set(eid, { id: eid, label: x.name, color: cssVar("--document") || "#8C9AAB", size: 5, group: r.category, sub: "graph entity" });
        ls.push({ id: `l:${r.id}:${x.id}`, source: "r:" + r.id, target: eid, label: x.relation || "RELATED_TO", dashed: true, width: 0.8 });
      }
    }
    return { nodes: [...ns.values()], links: ls };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, theme]);

  const highlight = useMemo(() => {
    if (!sel) return null;
    return new Set([sel, ...links.filter(l => l.source === sel || l.target === sel).flatMap(l => [l.source, l.target])]);
  }, [sel, links]);
  const cats = [...new Set(items.map(r => r.category))];

  return <div className="rx-graph">
    <LiveGraph ref={ref} nodes={nodes} links={links} highlight={highlight} selected={new Set(sel ? [sel] : [])} theme={theme} cluster={cluster} labels="auto"
      ariaLabel={`Reaction graph: ${items.length} hypotheses from ${nodes.filter(n => n.id.startsWith("a:")).length} actors`}
      onNode={id => { setSel(id); ref.current?.focus(id); }} onDouble={id => { if (id.startsWith("r:")) onPick(id.slice(2)); }} onBlank={() => setSel(null)}
      onHover={h => {
        if (!h?.node) return setTip(null);
        const r = h.node.startsWith("r:") ? byId.get(h.node.slice(2)) : null, n = nodes.find(x => x.id === h.node);
        setTip({ x: h.x, y: h.y, html: r ? <><b>{r.title}</b><div className="xs muted mt8">{r.actor_name} · {labels[r.category]} · {Math.round(r.confidence * 100)}% · {r.status}</div>
          <div className="xs mt8" style={{ maxWidth: 300 }}>{r.description.slice(0, 180)}{r.description.length > 180 ? "…" : ""}</div><div className="xs dim mt8">Double-click for evidence and reasoning</div></>
          : <><b>{n?.label}</b><div className="xs muted mt8">{n?.sub}</div></> });
      }} />
    <div className="rx-graph-tools tb"><button title="Zoom in" aria-label="Zoom in" onClick={() => ref.current?.zoom(1.25)}><ZoomIn /></button>
      <button title="Zoom out" aria-label="Zoom out" onClick={() => ref.current?.zoom(0.8)}><ZoomOut /></button>
      <button title="Fit" aria-label="Fit graph" onClick={() => ref.current?.fit()}><Scan /></button>
      <button className={cluster ? "on" : ""} aria-pressed={cluster} onClick={() => setCluster(!cluster)} title="Group by category" style={{ width: "auto", padding: "0 10px", fontSize: 12 }}>Group by category</button></div>
    <div className="rx-graph-legend">{cats.map(c => <span key={c}><i style={{ background: `var(${CAT_COLOR[c]})` }} />{labels[c]}</span>)}
      <span><i className="sq" style={{ background: "var(--document)" }} />Graph entity</span><span className="dim">Hexagon = hypothesis · size = confidence · green ring = selected</span></div>
    <div className={`gx-tip ${tip ? "show" : ""}`} style={tip ? { left: tip.x + 14, top: tip.y + 14 } : undefined}>{tip?.html}</div>
  </div>;
}
