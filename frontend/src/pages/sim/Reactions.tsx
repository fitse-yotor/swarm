import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import { api, type Agent, type ReactionGraph, type SimEvent, type TriggerResult } from "../../api";
import { useToast } from "../../components/ui";
import { StepCard } from "../../components/Stage";
import Graph3D, { type G3Link, type G3Node } from "../../graph/Graph3D";
import { useTheme } from "../../hooks";

export type Scope = { kind: "agents" } | { kind: "agent"; id: string } | { kind: "post"; id: string };
const snip = (t: string, n = 60) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const KINDS = [["agents", "Whole run"], ["agent", "One persona"], ["post", "One post"]] as const;
const LEGEND: [string, string][] = [["persona", "#F59E0B"], ["actor", "#94A3B8"], ["post", "#3B82F6"], ["comment", "#10B981"], ["repost", "#8B5CF6"]];

/** The reactions to posts, drawn as a 3D graph: personas, posts, comments and reposts connected by who did what to whom. */
export function ReactionPane({ simId, scope, setScope, agents, posts }: {
  simId: string; scope: Scope; setScope: (s: Scope) => void; agents: Agent[]; posts: SimEvent[];
}) {
  const theme = useTheme();
  const q = scope.kind === "post" ? `?post_id=${scope.id}` : scope.kind === "agent" ? `?agent_id=${scope.id}` : "";
  const g = useQuery({ queryKey: ["reaction", simId, scope], queryFn: () => api.get<ReactionGraph>(`/simulations/${simId}/reaction-graph${q}`) });
  const speakers = agents.filter(a => a.speaks !== false);
  const data = useMemo(() => {
    const rg = g.data;
    if (!rg) return { nodes: [] as G3Node[], links: [] as G3Link[] };
    return {
      nodes: rg.nodes.map(n => ({ id: n.id, name: n.name, type: n.type, root: n.root,
        info: n.text ? `${n.author} · ${n.platform} · round ${n.round} · ${n.likes ?? 0} likes, ${n.reposts ?? 0} reposts, ${n.replies ?? 0} replies — “${n.text}”`
          : `${n.synthetic ? "Synthetic persona" : "Real actor"} · final stance ${(n.stance ?? 0) >= 0 ? "+" : ""}${(n.stance ?? 0).toFixed(2)}` })),
      links: rg.links.map(l => ({ source: l.source, target: l.target, type: l.type })),
    };
  }, [g.data]);
  const rootPosts = posts.filter(p => p.agent_id !== "src");

  return <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
    <div className="react-bar">
      <div className="viewseg" role="group" aria-label="Reaction graph scope">{KINDS.map(([k, l]) => <button key={k} className={scope.kind === k ? "on" : ""} aria-pressed={scope.kind === k}
        onClick={() => setScope(k === "agents" ? { kind: "agents" } : k === "agent" ? { kind: "agent", id: speakers[0]?.id ?? "" } : { kind: "post", id: rootPosts[0]?.id ?? "" })}>{l}</button>)}</div>
      {scope.kind === "agent" && <select className="sel" aria-label="Persona" style={{ maxWidth: 280 }} value={scope.id} onChange={e => setScope({ kind: "agent", id: e.target.value })}>
        {speakers.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
      {scope.kind === "post" && <select className="sel" aria-label="Post" style={{ maxWidth: 360 }} value={scope.id} onChange={e => setScope({ kind: "post", id: e.target.value })}>
        {rootPosts.map(p => <option key={p.id} value={p.id}>{p.agent_name.split(" (")[0].slice(0, 24)}: {snip(p.content, 50)} (R{p.round})</option>)}</select>}
      <span className="xs dim" style={{ marginLeft: "auto" }}>{g.data ? `${g.data.nodes.length} nodes · ${g.data.links.length} links` : ""}</span>
    </div>
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
      {g.isLoading && <div className="center-fill"><span className="spinner" /></div>}
      {g.data && !g.data.nodes.length && <div className="center-fill"><p className="small muted" style={{ maxWidth: "40ch", textAlign: "center" }}>
        {scope.kind === "post" ? "Nobody reacted to this post yet. Trigger a reaction from the panel on the right." : "Nothing to draw for this selection yet."}</p></div>}
      <Graph3D key={`${simId}-${scope.kind}-${"id" in scope ? scope.id : ""}`} nodes={data.nodes} links={data.links} live={false} theme={theme} />
      <div className="legend-card" style={{ left: 12, bottom: 12 }}><h5>Reaction graph</h5><div className="lg-grid">
        {LEGEND.map(([t, c]) => <span key={t} className="lg"><i style={{ background: c }} />{t === "actor" ? "real actor" : t}</span>)}</div>
        <div className="xs dim mt8">Hover for the text · click to pin · drag to orbit · scroll to zoom</div></div>
    </div>
  </div>;
}

const ACTIONS = [["CREATE_POST", "Post"], ["CREATE_COMMENT", "Comment"], ["REPOST", "Repost"], ["LIKE_POST", "Like"], ["DISLIKE_POST", "Dislike (forum)"]] as const;

/** Make one persona act inside a finished run, optionally letting the others react. */
export function TriggerCard({ simId, agents, posts, preset, onDone, n }: {
  simId: string; agents: Agent[]; posts: SimEvent[]; preset: { target?: string; tick: number }; onDone: (r: TriggerResult) => void; n: number;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const speakers = agents.filter(a => a.speaks !== false);
  const [f, setF] = useState({ agent_id: speakers[0]?.id ?? "", action: "CREATE_COMMENT" as string, platform: "microblog", target_id: "", content: "", react: true, use_llm: false });
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<TriggerResult | null>(null);
  const [seen, setSeen] = useState(0);
  if (preset.tick !== seen) { setSeen(preset.tick); if (preset.target) setF(x => ({ ...x, target_id: preset.target!, action: x.action === "CREATE_POST" ? "CREATE_COMMENT" : x.action })); }
  const needsTarget = f.action !== "CREATE_POST";
  const targets = posts.filter(p => p.agent_id !== f.agent_id && (f.action !== "DISLIKE_POST" || p.platform === "forum"));
  const target = posts.find(p => p.id === f.target_id);

  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<TriggerResult>(`/simulations/${simId}/actions`, { ...f, target_id: needsTarget ? f.target_id : null });
      setLast(r); onDone(r);
      qc.invalidateQueries({ queryKey: ["simEvents", simId] }); qc.invalidateQueries({ queryKey: ["reaction", simId] });
      toast(`${r.events[0].agent_name.split(" (")[0]}: ${ACTIONS.find(a => a[0] === f.action)?.[1].toLowerCase()} done${r.events.length > 1 ? ` · ${r.events.length - 1} reactions` : ""}`, "ok");
    } catch (e) { toast((e as Error).message, "err"); }
    setBusy(false);
  };
  const verb: Record<string, string> = { CREATE_POST: "posted", CREATE_COMMENT: "commented", REPOST: "reposted", LIKE_POST: "liked", DISLIKE_POST: "disliked" };

  return <StepCard n={n} title="Trigger a persona" state="run" badge="Interactive" id="trigger" endpoint={`POST /api/v1/simulations/${simId}/actions`}
    desc="Make a synthetic persona post, comment, repost, like or dislike inside this run, then watch who reacts in the reaction graph. Real actors stay context-only.">
    <div className="col gap12 mt12">
      <div className="field"><label htmlFor="tg-a">Persona</label><select id="tg-a" className="sel" value={f.agent_id} onChange={e => setF({ ...f, agent_id: e.target.value })}>
        {speakers.map(a => <option key={a.id} value={a.id}>{a.name}{a.synthetic ? " · synthetic" : ""}</option>)}</select></div>
      <div className="form-grid">
        <div className="field"><label htmlFor="tg-x">Action</label><select id="tg-x" className="sel" value={f.action} onChange={e => setF({ ...f, action: e.target.value })}>
          {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        {!needsTarget && <div className="field"><label htmlFor="tg-p">Platform</label><select id="tg-p" className="sel" value={f.platform} onChange={e => setF({ ...f, platform: e.target.value })}>
          <option value="microblog">Microblog</option><option value="forum">Forum</option></select></div>}
      </div>
      {needsTarget && <div className="field"><label htmlFor="tg-t">Post to {f.action === "CREATE_COMMENT" ? "comment on" : f.action === "REPOST" ? "repost" : f.action === "LIKE_POST" ? "like" : "dislike"}</label>
        <select id="tg-t" className="sel" value={f.target_id} onChange={e => setF({ ...f, target_id: e.target.value })}>
          <option value="">Choose a post…</option>{targets.slice(0, 120).map(p => <option key={p.id} value={p.id}>{p.agent_name.split(" (")[0].slice(0, 22)}: {snip(p.content, 52)} · {p.platform} R{p.round}</option>)}</select>
        {target && <span className="hint">“{snip(target.content, 140)}” — {target.likes} likes, {target.reposts} reposts, {target.replies} replies</span>}</div>}
      {(f.action === "CREATE_POST" || f.action === "CREATE_COMMENT") && <div className="field"><label htmlFor="tg-c">Text <span className="dim">(leave empty to generate)</span></label>
        <textarea id="tg-c" className="inp" rows={3} value={f.content} maxLength={1000} onChange={e => setF({ ...f, content: e.target.value })} placeholder="Typed text is posted as written, labelled as analyst-triggered." /></div>}
      {(f.action === "CREATE_POST" || f.action === "CREATE_COMMENT" || f.action === "REPOST") && <label className="chk"><input type="checkbox" checked={f.react} onChange={e => setF({ ...f, react: e.target.checked })} />Let the other personas react (comment, repost, like — by stance closeness)</label>}
      {(f.action === "CREATE_POST" || f.action === "CREATE_COMMENT") && !f.content.trim() && <label className="chk"><input type="checkbox" checked={f.use_llm} onChange={e => setF({ ...f, use_llm: e.target.checked })} />Write with the local model (15–40 s) instead of a template</label>}
      <div className="cs-actions" style={{ marginTop: 0 }}><button className="btn pri" disabled={busy || !f.agent_id || (needsTarget && !f.target_id)} onClick={go}><Zap />{busy ? "Working…" : "Trigger"}</button></div>
    </div>
    {last && <div className="mt12"><div className="cs-label" style={{ marginTop: 0 }}>Result</div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        <li><b>{last.events[0].agent_name}</b> {verb[last.events[0].action]}{last.events[0].content ? <>: “{snip(last.events[0].content, 100)}”</> : null}</li>
        {last.target && <li>Target now has {last.target.likes} likes, <b>{last.target.reposts} reposts</b>, {last.target.replies} replies</li>}
        {last.events.slice(1).map(e => <li key={e.id}>{e.agent_name.split(" (")[0]} {verb[e.action]}{e.content && e.action === "CREATE_COMMENT" ? <>: “{snip(e.content, 70)}”</> : null}</li>)}</ul></div>}
  </StepCard>;
}
