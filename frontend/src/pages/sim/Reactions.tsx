import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, Zap } from "lucide-react";
import { api, type Agent, type ReactionGraph, type SimEvent, type TriggerResponse, type TriggerResult } from "../../api";
import { useToast } from "../../components/ui";
import { StepCard } from "../../components/Stage";
import Graph3D, { type G3Link, type G3Node } from "../../graph/Graph3D";
import { useTheme } from "../../hooks";
import { CAMP_COLORS, CAMP_LABELS, STYLE_LABEL, campOf } from "../../vocab";

/** overlay = the original actor network with posts and reactions drawn on top; the others show reactions alone. */
export type Scope = { kind: "overlay"; post?: string; agent?: string } | { kind: "agents" } | { kind: "agent"; id: string } | { kind: "post"; id: string };
const snip = (t: string, n = 60) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const short = (n: string) => n.split(" (")[0];
const KINDS = [["overlay", "On the graph"], ["agents", "Whole run"], ["agent", "One persona"], ["post", "One post"]] as const;
const TYPE_LEGEND: [string, string][] = [["persona", "#F59E0B"], ["actor", "#94A3B8"], ["post", "#3B82F6"], ["comment", "#10B981"], ["repost", "#8B5CF6"]];
const label = (p: string) => p[0].toUpperCase() + p.slice(1);

function queryFor(scope: Scope): string {
  if (scope.kind === "overlay") return scope.post ? `/overlay-graph?post_id=${scope.post}` : scope.agent ? `/overlay-graph?agent_id=${scope.agent}` : "/overlay-graph";
  if (scope.kind === "post") return `/reaction-graph?post_id=${scope.id}`;
  if (scope.kind === "agent") return `/reaction-graph?agent_id=${scope.id}`;
  return "/reaction-graph";
}

/** Reactions to posts as a 3D graph. "On the graph" keeps the original actors and their ally / opponent links visible underneath. */
export function ReactionPane({ simId, scope, setScope, agents, posts }: {
  simId: string; scope: Scope; setScope: (s: Scope) => void; agents: Agent[]; posts: SimEvent[];
}) {
  const theme = useTheme();
  const [byCamp, setByCamp] = useState(false);
  const [gather, setGather] = useState(false);
  const g = useQuery({ queryKey: ["reaction", simId, scope], queryFn: () => api.get<ReactionGraph>(`/simulations/${simId}${queryFor(scope)}`) });
  const speakers = agents.filter(a => a.speaks !== false);
  const rootPosts = posts.filter(p => p.agent_id !== "src" && !p.target_id);
  const data = useMemo(() => {
    const rg = g.data;
    if (!rg) return { nodes: [] as G3Node[], links: [] as G3Link[] };
    const focus = new Set(rg.focus ?? []);
    return {
      nodes: rg.nodes.map(n => {
        const a = n.actions;
        const mine = a ? ` · posted ${a.posts ?? 0}, commented ${a.comments ?? 0}, reposted ${a.reposts ?? 0}, liked ${a.likes ?? 0}` : "";
        return { id: n.id, name: n.name, type: n.type, root: n.root || focus.has(n.id), layer: n.layer, group: campOf(n.stance ?? 0),
          info: n.text ? `${n.author} · ${n.platform} · round ${n.round} · ${n.likes ?? 0} likes, ${n.reposts ?? 0} reposts, ${n.replies ?? 0} replies — “${n.text}”`
            : `${n.profile ? `${n.profile} · ` : ""}${n.synthetic ? "Synthetic persona" : "Real actor"} · final stance ${(n.stance ?? 0) >= 0 ? "+" : ""}${(n.stance ?? 0).toFixed(2)}${mine}` };
      }),
      links: rg.links.map(l => ({ source: l.source, target: l.target, type: l.type, kind: l.kind, layer: l.layer })),
    };
  }, [g.data]);
  const counts = useMemo(() => Object.fromEntries(Object.keys(CAMP_COLORS).map(k => [k, data.nodes.filter(n => n.group === k).length])), [data.nodes]);
  const overlay = scope.kind === "overlay";
  const focusValue = scope.kind === "overlay" ? (scope.post ? `post:${scope.post}` : scope.agent ? `agent:${scope.agent}` : "") : "";

  return <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
    <div className="react-bar">
      <div className="viewseg" role="group" aria-label="Graph scope">{KINDS.map(([k, l]) => <button key={k} className={scope.kind === k ? "on" : ""} aria-pressed={scope.kind === k}
        onClick={() => setScope(k === "overlay" ? { kind: "overlay" } : k === "agents" ? { kind: "agents" } : k === "agent" ? { kind: "agent", id: speakers[0]?.id ?? "" } : { kind: "post", id: rootPosts[0]?.id ?? "" })}>{l}</button>)}</div>
      {overlay && <select className="sel" aria-label="Focus" style={{ width: 280, maxWidth: "40%", flex: "0 1 280px" }} value={focusValue}
        onChange={e => { const [k, id] = e.target.value.split(":"); setScope(k === "post" ? { kind: "overlay", post: id } : k === "agent" ? { kind: "overlay", agent: id } : { kind: "overlay" }); }}>
        <option value="">Most engaged threads</option>
        {scope.kind === "overlay" && scope.post && !rootPosts.some(p => p.id === scope.post) && <option value={`post:${scope.post}`}>The thread you just triggered</option>}
        <optgroup label="One thread">{rootPosts.slice(0, 80).map(p => <option key={p.id} value={`post:${p.id}`}>{short(p.agent_name).slice(0, 22)}: {snip(p.content, 44)} (R{p.round})</option>)}</optgroup>
        <optgroup label="One persona">{speakers.map(a => <option key={a.id} value={`agent:${a.id}`}>{short(a.name)}</option>)}</optgroup></select>}
      {scope.kind === "agent" && <select className="sel" aria-label="Persona" style={{ width: 280, maxWidth: "40%", flex: "0 1 280px" }} value={scope.id} onChange={e => setScope({ kind: "agent", id: e.target.value })}>
        {speakers.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
      {scope.kind === "post" && <select className="sel" aria-label="Post" style={{ width: 340, maxWidth: "45%", flex: "0 1 340px" }} value={scope.id} onChange={e => setScope({ kind: "post", id: e.target.value })}>
        {rootPosts.map(p => <option key={p.id} value={p.id}>{short(p.agent_name).slice(0, 24)}: {snip(p.content, 50)} (R{p.round})</option>)}</select>}
      <div className="viewseg" role="group" aria-label="Colour"><button className={!byCamp ? "on" : ""} aria-pressed={!byCamp} onClick={() => setByCamp(false)}>Type</button>
        <button className={byCamp ? "on" : ""} aria-pressed={byCamp} onClick={() => setByCamp(true)}>Camp</button></div>
      <button className={`pbtn ${gather ? "on" : ""}`} aria-pressed={gather} onClick={() => { setGather(!gather); if (!gather) setByCamp(true); }} title="Pull supporters, neutrals and opponents into separate clusters"><Layers />Cluster</button>
      <span className="xs dim" style={{ marginLeft: "auto", whiteSpace: "nowrap", flex: "none" }}>{g.data ? `${g.data.nodes.length} nodes · ${g.data.links.length} links` : ""}</span>
    </div>
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
      {g.isLoading && <div className="center-fill"><span className="spinner" /></div>}
      {g.isError && <div className="center-fill"><p className="small muted" style={{ maxWidth: "40ch", textAlign: "center" }}>{(g.error as Error).message}</p></div>}
      {g.data && !g.data.nodes.length && <div className="center-fill"><p className="small muted" style={{ maxWidth: "40ch", textAlign: "center" }}>
        {scope.kind === "post" ? "Nobody reacted to this post yet. Trigger a reaction from the panel on the right." : "Nothing to draw for this selection yet."}</p></div>}
      <Graph3D key={`${simId}-${JSON.stringify(scope)}`} nodes={data.nodes} links={data.links} live={false} theme={theme}
        colorByGroup={byCamp} gather={gather} groupColors={CAMP_COLORS} groupLabels={CAMP_LABELS}
        labelFilter={overlay ? n => n.layer !== "interaction" : undefined} />
      <div className="legend-card" style={{ left: 12, bottom: 12 }}>
        {byCamp ? <><h5>Camp (final stance)</h5><div className="lg-grid">{Object.entries(CAMP_COLORS).map(([k, c]) => <span key={k} className="lg"><i style={{ background: c }} />{CAMP_LABELS[k]} <span className="dim">{counts[k] ?? 0}</span></span>)}</div></>
          : <><h5>{overlay ? "Original graph + reactions" : "Reaction graph"}</h5><div className="lg-grid">
            {TYPE_LEGEND.map(([t, c]) => <span key={t} className="lg"><i style={{ background: c }} />{t === "actor" ? "real actor" : t}</span>)}</div></>}
        {overlay && <div className="xs dim mt8"><span style={{ color: CAMP_COLORS.support }}>━</span> ally · <span style={{ color: CAMP_COLORS.oppose }}>━</span> opponent (from the knowledge graph)</div>}
        <div className="xs dim mt8">Hover for details · click to pin · drag to orbit · scroll to zoom</div></div>
    </div>
  </div>;
}

const ACTIONS = [["CREATE_POST", "Post"], ["CREATE_COMMENT", "Comment"], ["REPOST", "Repost"], ["LIKE_POST", "Like"], ["DISLIKE_POST", "Dislike (forum)"]] as const;
const DECISION_BADGE: Record<TriggerResponse["decision"], string> = { replied: "b-acc", liked: "b-ok", reposted: "b-ok", disliked: "b-err", ignored: "" };

/** Make one persona act inside a finished run, and see how the post's author and everyone else answer. */
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
  if (preset.tick !== seen) {
    setSeen(preset.tick);
    if (preset.target) {
      const owner = posts.find(p => p.id === preset.target)?.agent_id;
      setF(x => ({ ...x, target_id: preset.target!, action: x.action === "CREATE_POST" ? "CREATE_COMMENT" : x.action,
        agent_id: x.agent_id === owner ? (speakers.find(a => a.id !== owner)?.id ?? x.agent_id) : x.agent_id }));
    }
  }
  const needsTarget = f.action !== "CREATE_POST";
  const targets = posts.filter(p => p.agent_id !== f.agent_id && (f.action !== "DISLIKE_POST" || p.platform === "forum"));
  const target = posts.find(p => p.id === f.target_id);
  const owner = target ? agents.find(a => a.id === target.agent_id) : undefined;
  const ob = owner?.behavior;

  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<TriggerResult>(`/simulations/${simId}/actions`, { ...f, target_id: needsTarget ? f.target_id : null });
      setLast(r); onDone(r);
      qc.invalidateQueries({ queryKey: ["simEvents", simId] }); qc.invalidateQueries({ queryKey: ["reaction", simId] });
      const answer = r.responses?.find(x => x.role === "author");
      toast(answer ? `${short(answer.agent_name)} ${answer.decision === "ignored" ? "did not answer" : answer.decision}` : `${short(r.events[0].agent_name)}: ${ACTIONS.find(a => a[0] === f.action)?.[1].toLowerCase()} done`, "ok");
    } catch (e) { toast((e as Error).message, "err"); }
    setBusy(false);
  };
  const verb: Record<string, string> = { CREATE_POST: "posted", CREATE_COMMENT: "commented", REPOST: "reposted", LIKE_POST: "liked", DISLIKE_POST: "disliked" };
  const author = last?.responses?.find(x => x.role === "author");
  const others = (last?.responses ?? []).filter(x => x.role === "bystander");
  const textOf = (id: string | null) => last?.events.find(e => e.id === id)?.content;

  return <StepCard n={n} title="Trigger a persona" state="run" badge="Interactive" id="trigger" endpoint={`POST /api/v1/simulations/${simId}/actions`}
    desc="Pick a post and make a persona comment on it, repost it or like it. The post's author answers from their own behaviour profile, others react from theirs, and the graph shows the thread on top of the original network.">
    <div className="col gap12 mt12">
      <div className="field"><label htmlFor="tg-a">Who acts</label><select id="tg-a" className="sel" value={f.agent_id} onChange={e => setF({ ...f, agent_id: e.target.value })}>
        {speakers.map(a => <option key={a.id} value={a.id}>{a.name}{a.synthetic ? " · synthetic" : ""}</option>)}</select></div>
      <div className="form-grid">
        <div className="field"><label htmlFor="tg-x">Action</label><select id="tg-x" className="sel" value={f.action} onChange={e => setF({ ...f, action: e.target.value })}>
          {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        {!needsTarget && <div className="field"><label htmlFor="tg-p">Platform</label><select id="tg-p" className="sel" value={f.platform} onChange={e => setF({ ...f, platform: e.target.value })}>
          <option value="microblog">Microblog</option><option value="forum">Forum</option></select></div>}
      </div>
      {needsTarget && <div className="field"><label htmlFor="tg-t">Post to {f.action === "CREATE_COMMENT" ? "comment on" : f.action === "REPOST" ? "repost" : f.action === "LIKE_POST" ? "like" : "dislike"}</label>
        <select id="tg-t" className="sel" value={f.target_id} onChange={e => setF({ ...f, target_id: e.target.value })}>
          <option value="">Choose a post…</option>{targets.slice(0, 120).map(p => <option key={p.id} value={p.id}>{short(p.agent_name).slice(0, 22)}: {snip(p.content, 52)} · {p.platform} R{p.round}</option>)}</select>
        {target && <span className="hint">“{snip(target.content, 140)}” — {target.likes} likes, {target.reposts} reposts, {target.replies} replies</span>}
        {target && ob && f.action === "CREATE_COMMENT" && <span className="hint"><b>{short(target.agent_name)}</b> is a {label(ob.preset)}: answers {Math.round(ob.responsiveness * 100)}% of comments. {STYLE_LABEL[ob.reply_style]}.</span>}</div>}
      {(f.action === "CREATE_POST" || f.action === "CREATE_COMMENT") && <div className="field"><label htmlFor="tg-c">Text <span className="dim">(leave empty to generate)</span></label>
        <textarea id="tg-c" className="inp" rows={3} value={f.content} maxLength={1000} onChange={e => setF({ ...f, content: e.target.value })} placeholder="Typed text is posted as written, labelled as analyst-triggered." /></div>}
      {(f.action === "CREATE_POST" || f.action === "CREATE_COMMENT" || f.action === "REPOST") && <label className="chk"><input type="checkbox" checked={f.react} onChange={e => setF({ ...f, react: e.target.checked })} />Let the post's author and the other personas respond</label>}
      {(f.action === "CREATE_POST" || f.action === "CREATE_COMMENT") && !f.content.trim() && <label className="chk"><input type="checkbox" checked={f.use_llm} onChange={e => setF({ ...f, use_llm: e.target.checked })} />Write with the local model (15–40 s) instead of a template</label>}
      <div className="cs-actions" style={{ marginTop: 0 }}><button className="btn pri" disabled={busy || !f.agent_id || (needsTarget && !f.target_id)} onClick={go}><Zap />{busy ? "Working…" : "Trigger"}</button></div>
    </div>
    {last && <div className="mt12" aria-live="polite"><div className="cs-label" style={{ marginTop: 0 }}>What happened</div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        <li><b>{short(last.events[0].agent_name)}</b> {verb[last.events[0].action]}{last.events[0].content ? <>: “{snip(last.events[0].content, 100)}”</> : null}</li>
        {last.target && <li>The post now has {last.target.likes} likes, {last.target.reposts} reposts, {last.target.replies} replies</li>}</ul>
      {author && <div className="resp mt8"><div className="row"><b className="small grow">{short(author.agent_name)} <span className="dim">· post's author · {author.profile}</span></b>
        <span className={`badge ${DECISION_BADGE[author.decision]}`}><i />{author.decision === "ignored" ? "did not answer" : author.decision}</span></div>
        {textOf(author.event_id) && <p className="small" style={{ margin: "6px 0 0" }}>“{snip(textOf(author.event_id)!, 160)}”</p>}
        <p className="xs dim" style={{ margin: "4px 0 0" }}>{author.reason}</p></div>}
      {others.length > 0 && <details className="mt8" open><summary className="xs dim" style={{ cursor: "pointer" }}>{others.length} other persona{others.length > 1 ? "s" : ""} reacted</summary>
        <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>{others.map(o => <li key={o.agent_id}><b>{short(o.agent_name)}</b> <span className={`badge ${DECISION_BADGE[o.decision]}`}>{o.decision}</span>
          {textOf(o.event_id) && <> “{snip(textOf(o.event_id)!, 70)}”</>}<div className="xs dim">{o.reason}</div></li>)}</ul></details>}
    </div>}
  </StepCard>;
}
